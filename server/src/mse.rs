//! MSE-1 — 请求与响应的应用层加密（Mr.day Sealed Envelope v1）。
//!
//! 协议规范在 `docs/MSE.md`，那份是权威定义；这里是它的服务端实现。客户端在
//! `web-shared/mse.ts`，两边的字节级一致性由 `testdata/mse-vectors.json` 钉死。
//!
//! # 它挡住了谁
//!
//! TLS 在 Cloudflare 终结一次、在 nginx 再终结一次。也就是说**今天**每一个请求体、
//! 每一个响应体、每一个 query string，都以明文经过至少两个我们不拥有的进程，还会落进
//! access log。装了企业根证书的机器上，中间人看到的同样是明文。这一层之后它们看到的
//! 是一坨定长结构的密文。
//!
//! 配上密钥固定（客户端构建时写死 kid），它连**主动**中间人也挡：客户端不认识对面的
//! 静态公钥就直接拒绝，而且 `require` 模式下没有明文回退路径可走。
//!
//! # 它挡不住谁
//!
//! 挡不住运行客户端的那个人。浏览器必须拿到会话密钥才能把数据画出来，DevTools 里看到的
//! 就是解密后的对象。这不是算法强度的问题，是端点归属的问题。真的不能给用户看的字段，
//! 唯一可靠的做法是**不下发** —— 那是改 handler 返回什么，不是改怎么加密。
//!
//! 也不挡流量形状：method、path、status、时间和大致长度仍然可见，而且是故意的。nginx
//! 按 path 路由和限速（`/api/auth/` 那条挡 bcrypt 爆破的限速是真防护，不能丢），
//! 按状态码统计错误率是发现故障的方式。要拿可观测性换这一点的部署可以开
//! `MSE_MASK_STATUS=1`。
//!
//! # 套件
//!
//! `MSE1-P384-HKDF-SHA384-AES256GCM`：ECDH P-384 + HKDF-SHA-384 + AES-256-GCM。
//! 这是 CNSA 1.0（NSA Suite B 的 TOP SECRET 档）指定的组合，也是 WebCrypto 和
//! RustCrypto 都原生支持的组合 —— 所以前端包里不需要塞任何第三方密码学代码，
//! 而「不塞第三方密码学库」本身就是一条安全性质。
//!
//! 形状上等价于 HPKE base mode（RFC 9180）：DHKEM(P-384) 打到一把静态接收方公钥，
//! HKDF 派生双向流量密钥，AES-GCM 逐条消息封装。没有任何自创构造。

use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64U};
use base64::Engine;
use hkdf::Hkdf;
use p384::ecdh::diffie_hellman;
use p384::pkcs8::{DecodePrivateKey, DecodePublicKey, EncodePublicKey};
use p384::{PublicKey, SecretKey};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha384};
use zeroize::Zeroize;

use crate::config::Config;
use crate::AppState;

pub const SUITE: &str = "MSE1-P384-HKDF-SHA384-AES256GCM";
pub const SEALED_CT: &str = "application/mse-sealed";
/// 信封第一个字节。协议要换构造时靠它区分，而不是靠猜长度。
const FORMAT_VERSION: u8 = 1;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
/// GET/HEAD 没有 body（fetch 也不允许给它们带 body），封好的 query 只能走头部。
/// nginx 默认 `large_client_header_buffers 4 8k`，留一半余量。
const MAX_Q_HEADER: usize = 4096;

// 头部名字集中在这里。散在各处写字符串字面量，改一个名字就会漏掉一处，而漏掉的那一处
// 表现为「偶尔解不开」，是最难查的一类故障。
pub const H_V: &str = "x-mse-v";
pub const H_KID: &str = "x-mse-kid";
pub const H_EPK: &str = "x-mse-epk";
pub const H_SID: &str = "x-mse-sid";
pub const H_SEQ: &str = "x-mse-seq";
pub const H_TS: &str = "x-mse-ts";
pub const H_Q: &str = "x-mse-q";
pub const H_STREAM: &str = "x-mse-stream";

/// 跨源必须显式暴露，否则浏览器把这些头对脚本藏起来 —— 官网在 mrday.one，网关在
/// code.mrday.one，藏起来的结果是官网每一个请求都解不开。见 main.rs 的 CorsLayer。
pub const EXPOSED_HEADERS: [&str; 5] = [H_V, H_SID, H_SEQ, H_STREAM, "x-mse-downgrade"];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /// 中间件短路。带 MSE 头的请求收 503 —— 静默当明文处理会让客户端以为自己加密了。
    Off,
    /// 密文和明文都收。密文请求一定回密文响应。灰度期唯一安全的档位。
    Optional,
    /// 受保护路由上的明文请求一律拒绝。
    Required,
}

impl Mode {
    fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "off" | "0" | "false" => Mode::Off,
            "required" | "require" | "strict" => Mode::Required,
            _ => Mode::Optional,
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Mode::Off => "off",
            Mode::Optional => "optional",
            Mode::Required => "required",
        }
    }
}

/// 一把静态服务端密钥，以及它的公钥 SPKI 和由公钥算出来的 kid。
///
/// kid 从公钥算，不是配的：配出来的 id 可以和密钥对不上，而对不上的表现是客户端把
/// 请求封给一把服务端没有的密钥，然后所有人一起 409。
pub struct StaticKey {
    secret: SecretKey,
    spki: Vec<u8>,
    kid: String,
}

impl StaticKey {
    /// PKCS#8 和 SEC1 两种 DER 都收。
    ///
    /// 只收 PKCS#8 是个真会绊倒人的坑：OpenSSL 3.6 的
    /// `genpkey -algorithm EC -outform DER` 吐出来的是 **SEC1**
    /// （`SEQUENCE { INTEGER 1, OCTET STRING ... }`），不是 PKCS#8
    /// （`SEQUENCE { INTEGER 0, AlgorithmIdentifier, OCTET STRING }`），
    /// 要再过一道 `openssl pkcs8 -topk8` 才是。第一次真机启动就是撞在这上面：
    /// 报的是「ASN.1 tag 不对」，而运维手里那条命令看上去完全正常。
    ///
    /// 两种都认，代价是一次多余的解析尝试，换来的是运维用任何一条合理命令生成的密钥
    /// 都能直接用。
    fn from_der_b64(raw: &str) -> anyhow::Result<Self> {
        let der = B64
            .decode(raw.trim())
            .map_err(|e| anyhow::anyhow!("不是合法 base64：{e}"))?;
        let secret = SecretKey::from_pkcs8_der(&der)
            .or_else(|_| SecretKey::from_sec1_der(&der))
            .map_err(|e| {
                anyhow::anyhow!("既不是 P-384 的 PKCS#8 私钥，也不是 SEC1 私钥：{e}")
            })?;
        Ok(Self::from_secret(secret))
    }

    fn from_secret(secret: SecretKey) -> Self {
        let spki = secret
            .public_key()
            .to_public_key_der()
            .expect("P-384 公钥一定能编成 SPKI")
            .as_bytes()
            .to_vec();
        let kid = kid_of(&spki);
        Self { secret, spki, kid }
    }

    fn pub_b64u(&self) -> String {
        B64U.encode(&self.spki)
    }

    /// 用静态私钥做 ECDSA-P384-SHA384 签名，输出 96 字节的 r||s（固定长，非 DER）。
    ///
    /// 用 r||s 而不是 DER：浏览器 WebCrypto 的 ECDSA verify 只认这种定长编码。
    /// `sign` 内部会先用 SHA-384 摘要 msg，客户端 verify 时也用 SHA-384，两边对齐。
    fn sign(&self, msg: &[u8]) -> Vec<u8> {
        use p384::ecdsa::signature::Signer;
        use p384::ecdsa::{Signature, SigningKey};
        let sk = SigningKey::from(&self.secret);
        let sig: Signature = sk.sign(msg);
        sig.to_bytes().to_vec()
    }
}

/// 服务端的**临时**密钥：会轮换，私钥用完即弃。前向保密就靠它。
///
/// 现在静态密钥只做一件事——**签名**这把临时公钥，让客户端确认对面是真服务器（挡主动
/// 中间人）。真正参与 ECDH 的是临时私钥。于是：偷到静态私钥也解不了任何流量（它从没
/// 握过 DH 秘密），而临时私钥每 `ephemeral_ttl` 轮换、旧的丢弃——录下来的历史流量在
/// 临时私钥被丢弃之后，连活着的服务器自己都再也解不开。
///
/// 老客户端（没法自动更新的桌面端）仍然封给静态密钥、走老的静态 ECDH 路径，没有前向
/// 保密但继续可用。见 derive。
struct Ephemeral {
    secret: SecretKey,
    spki: Vec<u8>,
    id: String,
    created_at: u64,
    /// 静态密钥对 `EPH_SIG_CTX || spki || exp_ms(be)` 的签名。客户端拿固定的静态公钥
    /// 验它，从而信任这把临时公钥。
    sig: Vec<u8>,
    exp_ms: i64,
}

/// 签名消息的域分隔前缀。绑死用途，别让这个签名在别处被重用。
const EPH_SIG_CTX: &[u8] = b"MSE-EPH-v1\0";

/// kid = base64url(SHA-384(SPKI))[..24]。24 个 base64 字符 = 144 bit，碰撞不是问题，
/// 而且短到能原样写进构建参数里。
fn kid_of(spki: &[u8]) -> String {
    let digest = Sha384::digest(spki);
    B64U.encode(digest)[..24].to_string()
}

/// 派生结果的进程内缓存。**只在内存里**：会话密钥不进 Redis、不进 AOF、不落盘。
///
/// 缓存未命中不是失败 —— 每个请求都带着 epk，服务端随时能重新推。重启、第二个实例、
/// 缓存淘汰，代价都只是多跑一次 ECDH。
struct Cached {
    k_c2s: [u8; 32],
    k_s2c: [u8; 32],
    /// 用来确认 sid 确实是这把 epk 算出来的，防止拿别人的 sid 蹭缓存。
    epk_spki: Vec<u8>,
    expires_at: u64,
}

impl Drop for Cached {
    fn drop(&mut self) {
        self.k_c2s.zeroize();
        self.k_s2c.zeroize();
    }
}

pub struct Mse {
    /// `[0]` 是当前密钥，其余是轮换宽限期内仍然接受的旧密钥。
    keys: Vec<StaticKey>,
    pub mode: Mode,
    session_ttl: u64,
    max_skew_ms: i64,
    max_bytes: usize,
    replay_fail_open: bool,
    mask_status: bool,
    cache: RwLock<HashMap<String, Cached>>,
    /// 轮换的临时密钥环，最新的在末尾。前向保密的核心，见 Ephemeral。
    ephemerals: RwLock<Vec<Ephemeral>>,
    ephemeral_ttl: u64,
}

impl Mse {
    pub fn new(cfg: &Config) -> anyhow::Result<Self> {
        let mut keys: Vec<StaticKey> = Vec::new();
        if !cfg.mse_server_key.trim().is_empty() {
            keys.push(
                StaticKey::from_der_b64(&cfg.mse_server_key)
                    .map_err(|e| anyhow::anyhow!("MSE_SERVER_KEY {e}"))?,
            );
        }
        if !cfg.mse_server_key_prev.trim().is_empty() {
            keys.push(
                StaticKey::from_der_b64(&cfg.mse_server_key_prev)
                    .map_err(|e| anyhow::anyhow!("MSE_SERVER_KEY_PREV {e}"))?,
            );
        }
        let mode = Mode::parse(&cfg.mse_mode);

        if keys.is_empty() {
            // 现造一把也能跑：客户端每次都来取公钥。但**固定密钥就没法用了**，而固定
            // 密钥正是从「挡住被动中间人」升级到「挡住主动中间人」的那一步；而且每次
            // 重启所有客户端会话全部作废。所以这条是警告，不是提示。
            let secret = SecretKey::random(&mut rand::rngs::OsRng);
            let key = StaticKey::from_secret(secret);
            tracing::warn!(
                kid = %key.kid,
                "MSE_SERVER_KEY 没配，已临时生成一把。密钥固定失效，且每次重启都会换。\
                 生成一把持久的：openssl genpkey -algorithm EC \
                 -pkeyopt ec_paramgen_curve:P-384 | openssl pkcs8 -topk8 -nocrypt \
                 -outform DER | openssl base64 -A"
            );
            keys.push(key);
        }

        // 两把密钥配成同一把是配置事故：轮换看起来做了，实际什么都没换，旧客户端在
        // 你以为已经完成轮换之后仍然全都连得上。
        if keys.len() == 2 && keys[0].kid == keys[1].kid {
            anyhow::bail!("MSE_SERVER_KEY 和 MSE_SERVER_KEY_PREV 是同一把密钥，轮换没有发生");
        }

        tracing::info!(
            mode = mode.as_str(),
            suite = SUITE,
            kid = %keys[0].kid,
            prev = keys.get(1).map(|k| k.kid.as_str()).unwrap_or("-"),
            "MSE 已装载"
        );

        Ok(Self {
            keys,
            mode,
            session_ttl: cfg.mse_session_ttl_secs,
            max_skew_ms: cfg.mse_max_skew_ms,
            max_bytes: cfg.mse_max_sealed_bytes,
            replay_fail_open: cfg.mse_replay_fail_open,
            mask_status: cfg.mse_mask_status,
            cache: RwLock::new(HashMap::new()),
            ephemerals: RwLock::new(Vec::new()),
            ephemeral_ttl: cfg.mse_ephemeral_ttl_secs,
        })
    }

    fn current(&self) -> &StaticKey {
        &self.keys[0]
    }

    fn by_kid(&self, kid: &str) -> Option<&StaticKey> {
        self.keys.iter().find(|k| k.kid == kid)
    }

    /// 当前对外通告的临时密钥。过期就地轮换一把，顺手清掉太老的。
    ///
    /// 返回 `(id, pub_b64u, exp_ms, sig_b64u)`。签名由**当前静态密钥**背书，客户端拿固定
    /// 的静态公钥验它——这就是信任链：钉住的静态密钥 → 签名 → 临时密钥 → ECDH。
    ///
    /// 保留策略：一把临时密钥在 `ephemeral_ttl` 内是「当前」（发给新会话），之后仍留在
    /// 环里 `session_ttl` 那么久，好让**已经**用它建了会话、但派生缓存恰好被淘汰的客户端
    /// 还能重新派生。再老就丢弃——丢弃临时私钥正是前向保密：那之前的流量，连活着的服务器
    /// 自己都再也解不开。
    fn current_ephemeral(&self) -> (String, String, i64, String) {
        let now = unix_secs();

        // 快路径：已有一把还在「当前」窗口内的，直接用。
        if let Ok(ring) = self.ephemerals.read() {
            if let Some(e) = ring.last() {
                if now < e.created_at + self.ephemeral_ttl {
                    return (e.id.clone(), B64U.encode(&e.spki), e.exp_ms, B64U.encode(&e.sig));
                }
            }
        }

        // 慢路径：造一把新的，由当前静态密钥签名。
        let mut w = match self.ephemerals.write() {
            Ok(w) => w,
            // 锁中毒时退回静态密钥：pubkey 里不带 eph，客户端就走静态路径（无前向保密
            // 但能用），好过整条 pubkey 挂掉。
            Err(_) => return self.static_as_pseudo_eph(),
        };
        // 再查一次：可能刚才有别的线程已经轮换好了（double-checked）。
        if let Some(e) = w.last() {
            if now < e.created_at + self.ephemeral_ttl {
                return (e.id.clone(), B64U.encode(&e.spki), e.exp_ms, B64U.encode(&e.sig));
            }
        }

        let secret = SecretKey::random(&mut rand::rngs::OsRng);
        let spki = secret
            .public_key()
            .to_public_key_der()
            .expect("P-384 公钥一定能编成 SPKI")
            .as_bytes()
            .to_vec();
        let id = kid_of(&spki);
        // exp 覆盖「当前窗口 + 一条会话」的可用寿命：客户端在这段时间内都可以拿它建/续会话。
        let exp_ms = unix_millis() + ((self.ephemeral_ttl + self.session_ttl) as i64) * 1000;

        // 签名对象：域前缀 + 临时公钥 SPKI + 过期毫秒（大端）。客户端逐字节重建再验。
        let mut msg = Vec::with_capacity(EPH_SIG_CTX.len() + spki.len() + 8);
        msg.extend_from_slice(EPH_SIG_CTX);
        msg.extend_from_slice(&spki);
        msg.extend_from_slice(&exp_ms.to_be_bytes());
        let sig = self.current().sign(&msg);

        let out = (id.clone(), B64U.encode(&spki), exp_ms, B64U.encode(&sig));

        // 清掉太老的：留 `ephemeral_ttl + session_ttl`，覆盖最长可能还在引用它的会话。
        let keep_after = now.saturating_sub(self.ephemeral_ttl + self.session_ttl);
        w.retain(|e| e.created_at >= keep_after);
        w.push(Ephemeral { secret, spki, id, created_at: now, sig, exp_ms });
        out
    }

    /// 锁中毒时的退路：把静态密钥当「伪临时」通告，签名为空。客户端验签会失败 → 回退
    /// 到静态路径（封给静态 kid）。等于「本次没有前向保密」，但服务照常。
    fn static_as_pseudo_eph(&self) -> (String, String, i64, String) {
        let k = self.current();
        (k.kid.clone(), k.pub_b64u(), 0, String::new())
    }

    /// ECDH + HKDF。命中缓存就不再做点乘。
    ///
    /// 缓存以 sid 为键，但每次都拿请求带来的 epk 重算一遍 sid 做比对：sid 是 epk 的
    /// 哈希，对不上就说明有人拿着别人的 sid 来蹭一条已经派生好的会话。
    fn derive(&self, kid: &str, epk_spki: &[u8], sid: &str) -> Result<([u8; 32], [u8; 32]), MseErr> {
        if sid != sid_of(epk_spki) {
            return Err(MseErr::malformed("sid 与 epk 对不上"));
        }
        let now = unix_secs();

        if let Ok(cache) = self.cache.read() {
            if let Some(hit) = cache.get(sid) {
                // 普通比较即可：epk 是公开值（它每个请求都明文发在头里），这里没有
                // 秘密可供时序侧信道泄露。比对它是为了防缓存投毒 —— 拿别人的 sid 来
                // 蹭一条已经派生好的会话。
                if hit.expires_at > now && hit.epk_spki == epk_spki {
                    return Ok((hit.k_c2s, hit.k_s2c));
                }
            }
        }

        let peer = PublicKey::from_public_key_der(epk_spki)
            .map_err(|_| MseErr::malformed("epk 不是合法的 P-384 SPKI 公钥"))?;

        // 服务端这一侧的 ECDH 私钥：先看是不是静态密钥（老客户端封给它，无前向保密），
        // 否则查临时密钥环（新客户端封给临时公钥，有前向保密）。都不匹配 → 让客户端
        // 重新取公钥（可能是临时密钥已经轮换过去、或服务端重启了）。
        let (mut z, server_spki) = if let Some(key) = self.by_kid(kid) {
            let shared = diffie_hellman(key.secret.to_nonzero_scalar(), peer.as_affine());
            (shared.raw_secret_bytes().to_vec(), key.spki.clone())
        } else {
            // ECDH 在读锁内做完，只把 z 和 spki 带出锁，绝不把临时私钥的引用泄到锁外。
            self.ephemerals
                .read()
                .ok()
                .and_then(|ring| {
                    ring.iter().rev().find(|e| e.id == kid).map(|e| {
                        let shared =
                            diffie_hellman(e.secret.to_nonzero_scalar(), peer.as_affine());
                        (shared.raw_secret_bytes().to_vec(), e.spki.clone())
                    })
                })
                .ok_or_else(MseErr::rekey)?
        };

        // transcript 绑定：server_spki 是**真正做了 ECDH 的那把**（静态或临时）。换掉它
        // 不会得到一条能用的会话，只会得到一把不同的密钥 —— 失败在解密，而不是悄悄成功。
        let mut tx = Sha384::new();
        tx.update(epk_spki);
        tx.update(&server_spki);
        let tx = tx.finalize();

        let hk = Hkdf::<Sha384>::new(None, &z);
        let mut k_c2s = [0u8; 32];
        let mut k_s2c = [0u8; 32];
        hk.expand(&info_for("c2s", kid, &tx), &mut k_c2s)
            .map_err(|_| MseErr::internal("HKDF c2s"))?;
        hk.expand(&info_for("s2c", kid, &tx), &mut k_s2c)
            .map_err(|_| MseErr::internal("HKDF s2c"))?;
        z.zeroize();

        if let Ok(mut cache) = self.cache.write() {
            /*
             * 硬上限，不只是「顺手扫一遍过期项」。
             *
             * 只扫过期是不够的：建一条会话不需要凭据（公钥是公开的），`location /`
             * 上刻意没有限速（那是中转本身的路径），而每一条新的临时公钥都会插入一个
             * 新条目、`expires_at` 是 now + 1800。也就是说洪水攻击期间**一条都不会
             * 过期**，扫描什么也腾不出来，map 就一直涨到进程被 OOM 杀掉。
             *
             * 4096 条约合 1 MB。装不下就先扫过期，还满就丢掉最快到期的四分之一。
             * 丢错了也没有后果 —— 缓存未命中只是多跑一次 ECDH，不是失败。
             */
            const CACHE_CAP: usize = 4096;
            if cache.len() >= CACHE_CAP {
                cache.retain(|_, v| v.expires_at > now);
                if cache.len() >= CACHE_CAP {
                    let mut by_age: Vec<(String, u64)> = cache
                        .iter()
                        .map(|(k, v)| (k.clone(), v.expires_at))
                        .collect();
                    by_age.sort_unstable_by_key(|(_, e)| *e);
                    for (k, _) in by_age.iter().take(CACHE_CAP / 4) {
                        cache.remove(k);
                    }
                }
            }
            cache.insert(
                sid.to_string(),
                Cached {
                    k_c2s,
                    k_s2c,
                    epk_spki: epk_spki.to_vec(),
                    expires_at: now + self.session_ttl,
                },
            );
        }
        Ok((k_c2s, k_s2c))
    }
}

fn info_for(dir: &str, kid: &str, tx: &[u8]) -> Vec<u8> {
    let mut info = Vec::with_capacity(32 + kid.len() + tx.len());
    info.extend_from_slice(b"MSE1/v1|");
    info.extend_from_slice(dir.as_bytes());
    info.push(b'|');
    info.extend_from_slice(kid.as_bytes());
    info.push(b'|');
    info.extend_from_slice(tx);
    info
}

/// sid = base64url(SHA-384(epk_spki)[..18])。确定性的，所以服务端不需要发号，
/// 也不需要为「这个 sid 是谁的」保存任何状态。
fn sid_of(epk_spki: &[u8]) -> String {
    let digest = Sha384::digest(epk_spki);
    B64U.encode(&digest[..18])
}

fn unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs()
}

fn unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as i64
}

// ---------------------------------------------------------------------------
// AEAD
// ---------------------------------------------------------------------------

/// `0x01 || nonce(12) || ciphertext||tag(16)`。
fn seal(key: &[u8; 32], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, MseErr> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| MseErr::internal("AES key"))?;
    let mut nonce = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| MseErr::internal("AES-GCM seal"))?;
    let mut out = Vec::with_capacity(1 + NONCE_LEN + ct.len());
    out.push(FORMAT_VERSION);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

fn open(key: &[u8; 32], aad: &[u8], envelope: &[u8]) -> Result<Vec<u8>, MseErr> {
    if envelope.len() < 1 + NONCE_LEN + TAG_LEN {
        return Err(MseErr::malformed("信封太短"));
    }
    if envelope[0] != FORMAT_VERSION {
        return Err(MseErr::malformed("信封版本不认识"));
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| MseErr::internal("AES key"))?;
    cipher
        .decrypt(
            Nonce::from_slice(&envelope[1..1 + NONCE_LEN]),
            Payload {
                msg: &envelope[1 + NONCE_LEN..],
                aad,
            },
        )
        // 解不开只报一句话。区分「tag 不对」和「明文不是 JSON」等于给攻击者一个
        // 预言机，而对我们自己没有任何诊断价值 —— 两种都只可能是密钥不对或被改过。
        .map_err(|_| MseErr::rekey_reason("解密失败"))
}

fn aad_req(sid: &str, seq: u64, ts: i64, method: &Method, path: &str) -> Vec<u8> {
    join_nul(&[
        b"MSE1/req",
        sid.as_bytes(),
        seq.to_string().as_bytes(),
        ts.to_string().as_bytes(),
        method.as_str().as_bytes(),
        path.as_bytes(),
    ])
}

/// 响应 AAD 里**不含状态码**。
///
/// 状态码在密文内层的 `s` 字段里，本来就被 GCM 的 tag 保护着，客户端也只认那一个。
/// 把它再放进 AAD 只会制造一个矛盾：`MSE_MASK_STATUS=1` 时外层被改写成 200，客户端
/// 看不到真实状态码，也就拼不出解密所需的 AAD —— 一开这个开关全线解不开。
fn aad_res(sid: &str, seq: u64, path: &str) -> Vec<u8> {
    join_nul(&[
        b"MSE1/res",
        sid.as_bytes(),
        seq.to_string().as_bytes(),
        path.as_bytes(),
    ])
}

fn aad_sse(sid: &str, seq: u64, frame: u64) -> Vec<u8> {
    join_nul(&[
        b"MSE1/sse",
        sid.as_bytes(),
        seq.to_string().as_bytes(),
        frame.to_string().as_bytes(),
    ])
}

/// `\0` 分隔。用分隔符而不是直接拼接，是为了让字段边界无法平移 —— 否则
/// `sid="a", seq=12` 和 `sid="a1", seq=2` 会算出同一段 AAD。
fn join_nul(parts: &[&[u8]]) -> Vec<u8> {
    let mut out = Vec::new();
    for (i, p) in parts.iter().enumerate() {
        if i > 0 {
            out.push(0);
        }
        out.extend_from_slice(p);
    }
    out
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/// MSE 层的失败**永远回明文 JSON**。
///
/// 这条不能商量：客户端的密码学状态坏掉时（密钥轮换了、时钟偏了、序号撞了），它恰好
/// 就是解不开密文的那一刻。此时再把原因也加密，客户端只能看到一堆解不开的字节，
/// 除了死循环重试没有别的路。
#[derive(Debug)]
pub struct MseErr {
    status: StatusCode,
    code: &'static str,
    msg: String,
}

impl MseErr {
    fn rekey() -> Self {
        Self::rekey_reason("这把服务端密钥已经不在了，请重新取公钥")
    }
    fn rekey_reason(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code: "rekey",
            msg: msg.into(),
        }
    }
    fn malformed(msg: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "malformed",
            msg: msg.into(),
        }
    }
    fn replay() -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code: "replay",
            msg: "这个序号已经用过".into(),
        }
    }
    fn skew() -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code: "skew",
            msg: "时间戳超出允许偏差".into(),
        }
    }
    fn required() -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "required",
            msg: "这条路由只接受加密请求".into(),
        }
    }
    fn unavailable() -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "unavailable",
            msg: "本部署未启用 MSE".into(),
        }
    }
    fn internal(what: &str) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal",
            // 具体是哪一步只进日志。对外统一一句话。
            msg: {
                tracing::error!(step = what, "MSE 内部错误");
                "加密层内部错误".into()
            },
        }
    }
}

impl IntoResponse for MseErr {
    fn into_response(self) -> Response {
        let mut body = json!({ "error": self.msg, "mse": self.code });
        // 时钟偏了的客户端需要一个能对齐的基准，否则它每一次重试都会以同样的偏差
        // 再失败一次。把服务端时间一起给它。
        if self.code == "skew" {
            body["server_time"] = json!(unix_millis());
        }
        (self.status, Json(body)).into_response()
    }
}

// ---------------------------------------------------------------------------
// 引导端点
// ---------------------------------------------------------------------------

/// `GET /api/crypto/pubkey` —— 永远明文，永远可达。
pub async fn pubkey(State(st): State<AppState>) -> Response {
    let m = &st.mse;
    let cur = m.current();
    // 当前临时密钥：客户端拿它做 ECDH（前向保密），拿静态公钥验它的签名。
    let (eph_id, eph_pub, eph_exp, eph_sig) = m.current_ephemeral();
    let body = json!({
        "v": 1,
        "suite": SUITE,
        // 静态密钥：仍然是信任锚（客户端 pin 的就是它的 kid），但它现在**只签名不做
        // ECDH**（老客户端除外）。见 mse.rs 的 Ephemeral。
        "kid": cur.kid,
        "pub": cur.pub_b64u(),
        "prev": m.keys.get(1).map(|k| json!({ "kid": k.kid, "pub": k.pub_b64u() })),
        // 临时密钥：sig 是**静态密钥**对 (EPH_SIG_CTX || pub || exp_be) 的 ECDSA-P384
        // 签名。客户端验签通过就用 pub 做 ECDH——偷到静态私钥也解不了流量，因为它从没
        // 握过 DH 秘密。sig 为空表示服务端暂时给不出（锁中毒兜底），客户端回退静态路径。
        "eph": (!eph_sig.is_empty()).then(|| json!({
            "id": eph_id,
            "pub": eph_pub,
            "exp": eph_exp,
            "sig": eph_sig,
        })),
        "mode": m.mode.as_str(),
        "session_ttl": m.session_ttl,
        "max_skew_ms": m.max_skew_ms,
        // 客户端拿它算出本地时钟偏移，之后每个请求都补上。少了这一条，一台时钟不准的
        // 机器会在每一个请求上撞 skew，而且永远自己纠正不过来。
        "server_time": unix_millis(),
    });
    (
        // 缓存 60s（不是 300s）：临时密钥每 ephemeral_ttl 轮换，缓存太久会让客户端拿到
        // 偏旧的一把。60s 远小于轮换周期，客户端总能较快跟上，而每源每分钟一次回源也不重。
        [(header::CACHE_CONTROL, "public, max-age=60")],
        Json(body),
    )
        .into_response()
}

#[derive(Deserialize)]
pub struct HandshakeReq {
    #[serde(default)]
    kid: String,
    epk: String,
}

/// `POST /api/crypto/handshake` —— 可选。
///
/// 封装本身不需要握手：客户端拿到公钥就能自己推出密钥，第一个业务请求就可以是密文。
/// 这条存在的意义是预热服务端的派生缓存，并且给客户端一个明确的「我到底能不能和这个
/// 网关说上话」探针 —— 否则第一次失败会以业务请求的形态出现，难查得多。
pub async fn handshake(State(st): State<AppState>, Json(req): Json<HandshakeReq>) -> Response {
    let m = &st.mse;
    if m.mode == Mode::Off {
        return MseErr::unavailable().into_response();
    }
    let epk = match B64U.decode(req.epk.trim()) {
        Ok(v) => v,
        Err(_) => return MseErr::malformed("epk 不是合法 base64url").into_response(),
    };
    let kid = if req.kid.is_empty() {
        m.current().kid.clone()
    } else {
        req.kid
    };
    let sid = sid_of(&epk);
    if let Err(e) = m.derive(&kid, &epk, &sid) {
        return e.into_response();
    }
    Json(json!({
        "v": 1,
        "sid": sid,
        "kid": kid,
        "expires_in": m.session_ttl,
        "server_time": unix_millis(),
    }))
    .into_response()
}

// ---------------------------------------------------------------------------
// 路由策略
// ---------------------------------------------------------------------------

/// 永远不要求加密的路由。每一条都有一个不会变的理由 —— 见 docs/MSE.md §7。
///
/// 判定用 path 前缀/精确匹配，不用正则：这张表在每个请求上都要走一遍。
fn exempt(path: &str) -> bool {
    // 引导端点。给它加密是循环依赖。
    if path.starts_with("/api/crypto/") {
        return true;
    }
    // 没有载荷，而且探活的东西不是我们的客户端。
    if matches!(path, "/" | "/health" | "/api/logo.png") {
        return true;
    }
    // Stripe 自己签名自己发，发件人不归我们控制。
    if path == "/api/webhooks/stripe" {
        return true;
    }
    // 邮件里点进来的链接。
    if path == "/api/unsubscribe" {
        return true;
    }
    // nginx 的 auth_request 子请求。nginx 不会加密，这三条一旦要求加密，
    // 整个 /app/ /console/ /account/ 的门禁会全部 401。
    if matches!(
        path,
        "/api/authz" | "/api/admin/authz" | "/api/admin/ide-authz"
    ) {
        return true;
    }
    // provider 把浏览器**重定向**到这里，请求上没有我们的任何头。
    if path.starts_with("/api/auth/oauth/") && path.ends_with("/callback") {
        return true;
    }
    if path.starts_with("/api/integrations/") && path.ends_with("/callback") {
        return true;
    }
    // OpenAI 兼容面。第三方客户端按这份契约写代码，我们不能单方面改。
    if path.starts_with("/v1/")
        || path == "/chat/completions"
        || path == "/audio/transcriptions"
        || path == "/responses"
    {
        return true;
    }
    // WebSocket 升级。
    if path == "/ws" {
        return true;
    }
    // 更新器下载安装包：几十 MB 的二进制，而且下载它的东西不一定带得动这套协议。
    if path.starts_with("/api/ide/update/download/") {
        return true;
    }
    false
}

// ---------------------------------------------------------------------------
// 中间件
// ---------------------------------------------------------------------------

/// 信封内层允许带进来的请求头。**白名单，不是黑名单。**
///
/// 这一份存在的理由值得完整写下来。信封的 `h` 字段一度是无过滤地 `insert` 进请求头的，
/// 而建一条合法会话**不需要任何凭据** —— `/api/crypto/pubkey` 是公开的，服务端每个
/// 请求都从 `X-Mse-Epk` 重新派生，所以任何匿名者都能封出一个有效信封。于是：
///
///   {"h": {"x-real-ip": "1.2.3.4"}}
///
/// 就能覆盖 nginx 写进来的真实来源地址。而 `auth.rs` 的 `client_ip()` 优先读
/// `x-real-ip`，登录失败计数（`login_fail_ip:{ip}`，50 次/小时）和验证码发送限流
/// 都挂在它上面 —— 每个请求换一个 IP，两道闸门就都不存在了。`HeaderMap::insert` 还会
/// **替换**而不是追加，所以 nginx 附加的那一跳 `X-Forwarded-For` 会被整条抹掉。
///
/// 白名单里只有客户端真的会封的那四个：令牌，加三个地区信号（见 mse.ts 的
/// DEFAULT_SEAL_HEADERS）。新增条目之前先问一句：这个头有没有哪个 handler 拿它做
/// 安全判定？如果有，它就不能进来。
const SEALABLE_REQUEST_HEADERS: [&str; 4] = [
    "authorization",
    "x-ide-language",
    "x-ide-timezone",
    "x-ide-utc-offset-minutes",
];

/// 请求侧解出来的东西，响应侧要用同一套。
struct Ctx {
    sid: String,
    seq: u64,
    k_s2c: [u8; 32],
    path: String,
    /// 客户端显式写 `X-Mse-Stream: 0` 表示它读不了加密流；除此之外一律加密。
    seal_stream: bool,
}

pub async fn middleware(State(st): State<AppState>, req: Request, next: Next) -> Response {
    let m = &st.mse;
    let path = req.uri().path().to_string();
    let sealed_in = req.headers().get(H_SID).is_some();

    if m.mode == Mode::Off {
        // 带着 MSE 头进来却被当明文处理，是最坏的一种失败：客户端以为自己加密了。
        if sealed_in {
            return MseErr::unavailable().into_response();
        }
        return next.run(req).await;
    }

    if !sealed_in {
        if m.mode == Mode::Required && !exempt(&path) {
            return MseErr::required().into_response();
        }
        return next.run(req).await;
    }

    let (req, ctx) = match unseal_request(&st, req).await {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };

    let res = next.run(req).await;
    seal_response(&st, ctx, res).await
}

async fn unseal_request(st: &AppState, req: Request) -> Result<(Request, Ctx), MseErr> {
    let m = &st.mse;
    let (mut parts, body) = req.into_parts();
    let h = &parts.headers;

    let sid = str_header(h, H_SID).ok_or_else(|| MseErr::malformed("缺 X-Mse-Sid"))?;
    let kid = str_header(h, H_KID).ok_or_else(|| MseErr::malformed("缺 X-Mse-Kid"))?;
    let epk_b64 = str_header(h, H_EPK).ok_or_else(|| MseErr::malformed("缺 X-Mse-Epk"))?;
    let seq: u64 = str_header(h, H_SEQ)
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| MseErr::malformed("X-Mse-Seq 不是数字"))?;
    let ts: i64 = str_header(h, H_TS)
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| MseErr::malformed("X-Mse-Ts 不是数字"))?;
    let seal_stream = str_header(h, H_STREAM).as_deref() != Some("0");

    // 时间窗先判：它最便宜，而且过不了就没必要做 ECDH。
    if (unix_millis() - ts).abs() > m.max_skew_ms {
        return Err(MseErr::skew());
    }

    let epk = B64U
        .decode(epk_b64.trim())
        .map_err(|_| MseErr::malformed("X-Mse-Epk 不是合法 base64url"))?;
    let (k_c2s, k_s2c) = m.derive(&kid, &epk, &sid)?;

    // 信封：GET/HEAD 走头部（fetch 不允许给它们带 body），其余走 body。
    let envelope: Vec<u8> = match str_header(h, H_Q) {
        Some(q) => {
            if q.len() > MAX_Q_HEADER {
                return Err(MseErr::malformed("X-Mse-Q 过长"));
            }
            B64U.decode(q.trim())
                .map_err(|_| MseErr::malformed("X-Mse-Q 不是合法 base64url"))?
        }
        None => axum::body::to_bytes(body, m.max_bytes)
            .await
            .map_err(|_| MseErr::malformed("请求体过大或读取失败"))?
            .to_vec(),
    };

    let path = parts.uri.path().to_string();
    let aad = aad_req(&sid, seq, ts, &parts.method, &path);
    let plaintext = open(&k_c2s, &aad, &envelope)?;

    // 重放：解密通过之后才查。放在解密之后，是为了不让任何人靠塞垃圾信封去占满
    // Redis 里的重放键空间 —— 那些键的生存期是接受窗口，占满了就是拒绝服务。
    replay_guard(st, &sid, seq).await?;

    let inner: SealedRequest = serde_json::from_slice(&plaintext)
        .map_err(|_| MseErr::malformed("信封内容不是合法的 MSE 请求"))?;

    // query 从密文里出来，重新挂回 URI。nginx 的 access log 里那一段自此为空。
    let new_uri = rebuild_uri(&parts.uri, &inner.q)?;
    parts.uri = new_uri;

    // 还原 body 和 content-type。JSON 走 `b`，非 JSON（/api/deploy 传的是原始归档）
    // 走 `raw` + `ct`，两者互斥。
    let (bytes, ct): (Vec<u8>, Option<String>) = match (inner.b, inner.raw) {
        (Some(v), None) => (
            serde_json::to_vec(&v).map_err(|_| MseErr::internal("re-encode body"))?,
            Some("application/json".to_string()),
        ),
        (None, Some(raw)) => (
            B64U.decode(raw.trim())
                .or_else(|_| B64.decode(raw.trim()))
                .map_err(|_| MseErr::malformed("raw 不是合法 base64"))?,
            inner.ct,
        ),
        (None, None) => (Vec::new(), None),
        (Some(_), Some(_)) => return Err(MseErr::malformed("b 和 raw 不能同时出现")),
    };

    parts.headers.remove(header::CONTENT_TYPE);
    if let Some(ct) = ct {
        if let Ok(v) = HeaderValue::from_str(&ct) {
            parts.headers.insert(header::CONTENT_TYPE, v);
        }
    }
    // Content-Length 必须跟着换掉，否则下游按旧长度读，要么截断要么一直等。
    parts.headers.remove(header::CONTENT_LENGTH);
    if !bytes.is_empty() {
        parts
            .headers
            .insert(header::CONTENT_LENGTH, HeaderValue::from(bytes.len()));
    }
    // 内层带进来的头。**必须按白名单**，见 SEALABLE_REQUEST_HEADERS。
    for (k, v) in inner.h.unwrap_or_default() {
        let lower = k.to_ascii_lowercase();
        if !SEALABLE_REQUEST_HEADERS.contains(&lower.as_str()) {
            tracing::debug!(header = %lower, "MSE 信封里的头不在白名单，已忽略");
            continue;
        }
        if let (Ok(name), Ok(val)) = (
            HeaderName::from_bytes(lower.as_bytes()),
            HeaderValue::from_str(&v),
        ) {
            parts.headers.insert(name, val);
        }
    }

    let ctx = Ctx {
        sid,
        seq,
        k_s2c,
        path,
        seal_stream,
    };
    Ok((Request::from_parts(parts, Body::from(bytes)), ctx))
}

#[derive(Deserialize)]
struct SealedRequest {
    #[serde(default)]
    q: String,
    #[serde(default)]
    b: Option<Value>,
    #[serde(default)]
    raw: Option<String>,
    #[serde(default)]
    ct: Option<String>,
    #[serde(default)]
    h: Option<HashMap<String, String>>,
}

#[derive(Serialize)]
struct SealedResponse<'a> {
    s: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    b: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    raw: Option<String>,
    ct: &'a str,
    h: HashMap<String, String>,
}

fn rebuild_uri(uri: &Uri, query: &str) -> Result<Uri, MseErr> {
    let mut s = uri.path().to_string();
    if !query.is_empty() {
        s.push('?');
        s.push_str(query);
    }
    s.parse::<Uri>()
        .map_err(|_| MseErr::malformed("信封里的 query 拼不成合法 URI"))
}

fn str_header(h: &HeaderMap, name: &str) -> Option<String> {
    h.get(name)?.to_str().ok().map(|s| s.to_string())
}

/// 重放窗口。`SET key 1 NX PX (2×skew)` —— 存在即重放。
///
/// 键里没有任何秘密，只有 sid 和序号，所以写进 Redis（以及它的 AOF）是安全的；
/// 会话密钥从来不会到这里。每个请求一个小键，生存期就是接受窗口，过期自动消失。
async fn replay_guard(st: &AppState, sid: &str, seq: u64) -> Result<(), MseErr> {
    let m = &st.mse;
    let key = format!("mse:r:{sid}:{seq}");
    let ttl_ms = (m.max_skew_ms * 2).max(1000);
    let mut conn = st.redis.clone();
    let res: Result<Option<String>, _> = redis::cmd("SET")
        .arg(&key)
        .arg(1)
        .arg("NX")
        .arg("PX")
        .arg(ttl_ms)
        .query_async(&mut conn)
        .await;
    match res {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(MseErr::replay()),
        Err(e) => {
            // Redis 答不上来时默认拒绝。放行等于在 Redis 抖动的那几秒里开一个重放窗口，
            // 而这套系统里能被重放的请求包括「兑换码」和「提现」。
            tracing::error!(error = %e, "MSE 重放检查失败");
            if m.replay_fail_open {
                Ok(())
            } else {
                Err(MseErr::internal("replay store"))
            }
        }
    }
}

/// 响应侧头部里要保留下来、封进内层的那几个。其余一律丢掉 —— 头和 body 一样会泄密，
/// 而 handler 设的头基本都是给浏览器看的，加密之后浏览器也读不到了。
const FORWARD_RESPONSE_HEADERS: [&str; 3] = ["x-request-id", "retry-after", "x-ratelimit-remaining"];

/// `Set-Cookie` 是唯一必须留在**外层**的响应头。
///
/// cookie 只能由真实的网络响应来设置。客户端解密之后是在 JS 里 `new Response(...)`，
/// 而在 JS 里造出来的响应，哪怕带着 Set-Cookie，浏览器也不会存 —— 它根本没经过网络栈。
/// 所以把它封进密文等于把它扔掉：`/api/admin/session` 那一步换不到门禁 cookie，
/// 管理台登录会彻底失效，而且失败得毫无线索（请求 200，人还是进不去）。
///
/// 泄露面上这一条不亏：`mide_token` 本来就随每个同源请求以明文 cookie 头发出去
/// （nginx 的 auth_request 门禁要读它，删不掉）。把下发那一次藏起来、却让之后每一次
/// 携带都照旧可见，是纯粹的自欺。
fn forward_set_cookie(from: &HeaderMap, to: &mut HeaderMap) {
    // get_all：一个响应可以带多条 Set-Cookie，只取第一条会静默丢掉其余的。
    for v in from.get_all(header::SET_COOKIE) {
        to.append(header::SET_COOKIE, v.clone());
    }
}

async fn seal_response(st: &AppState, ctx: Ctx, res: Response) -> Response {
    let m = &st.mse;
    let (parts, body) = res.into_parts();
    let status = parts.status;
    let ct = parts
        .headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    // 3xx 带 Location：浏览器会自己跟过去，而跟过去那一跳不带我们的头。封了等于把
    // 重定向变成一段浏览器看不懂的字节。原样放行。
    if status.is_redirection() && parts.headers.contains_key(header::LOCATION) {
        let mut res = Response::from_parts(parts, body);
        mark_downgrade(res.headers_mut(), "redirect");
        return res;
    }

    // 101 Switching Protocols（WebSocket）——  body 是升级后的双向流，不能碰。
    if status == StatusCode::SWITCHING_PROTOCOLS {
        return Response::from_parts(parts, body);
    }

    if ct.starts_with("text/event-stream") {
        return if ctx.seal_stream {
            seal_stream(ctx, parts, body)
        } else {
            let mut res = Response::from_parts(parts, body);
            mark_downgrade(res.headers_mut(), "stream-opt-out");
            res
        };
    }

    let bytes = match axum::body::to_bytes(body, m.max_bytes).await {
        Ok(b) => b,
        Err(_) => {
            return MseErr::internal("响应体超过 MSE_MAX_SEALED_BYTES").into_response();
        }
    };

    // JSON 原样放进 `b`（客户端拿到的就是对象，不用二次解析）；其余走 base64 的 `raw`。
    let (b, raw) = if ct.starts_with("application/json") {
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(v) => (Some(v), None),
            // 声明是 JSON 却不是 JSON —— 照原样封过去，别在加密层制造第二个故障。
            Err(_) => (None, Some(B64U.encode(&bytes))),
        }
    } else if bytes.is_empty() {
        (None, None)
    } else {
        (None, Some(B64U.encode(&bytes)))
    };

    let mut h = HashMap::new();
    for name in FORWARD_RESPONSE_HEADERS {
        if let Some(v) = parts.headers.get(name).and_then(|v| v.to_str().ok()) {
            h.insert(name.to_string(), v.to_string());
        }
    }

    let inner = SealedResponse {
        s: status.as_u16(),
        b,
        raw,
        ct: &ct,
        h,
    };
    let plaintext = match serde_json::to_vec(&inner) {
        Ok(v) => v,
        Err(_) => return MseErr::internal("encode sealed response").into_response(),
    };

    let aad = aad_res(&ctx.sid, ctx.seq, &ctx.path);
    let envelope = match seal(&ctx.k_s2c, &aad, &plaintext) {
        Ok(v) => v,
        Err(e) => return e.into_response(),
    };

    // 外层状态码。
    //
    // **无正文状态（204/205/304）必须改成 200**，否则就是个致命 bug：这些状态按 HTTP
    // 规范不能带 body，而我们要把密文信封放进 body。浏览器（和 nginx/Cloudflare）会把
    // 204 上的 body 直接剥掉，客户端于是拿到一个空信封、解密抛错。真实状态码已经在
    // 密文内层的 `s` 字段里（客户端读它重建成 204），所以外层用 200 承载信封是安全的。
    //
    // 这正是管理台登录卡在「网络异常」的原因：/api/admin/session 成功时回 204，每一次
    // 成功登录都会踩中；而用假令牌测时回的是 401（带 body），所以一直没暴露出来。
    let outer = outer_status(status, m.mask_status);

    let mut res = Response::new(Body::from(envelope));
    *res.status_mut() = outer;
    let hm = res.headers_mut();
    hm.insert(header::CONTENT_TYPE, HeaderValue::from_static(SEALED_CT));
    hm.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    forward_set_cookie(&parts.headers, hm);
    stamp(hm, &ctx);
    res
}

/// 密文响应的外层状态码。
///
/// **无正文状态（204/205/304）必须回 200**：这些状态按 HTTP 规范不能带 body，而密文
/// 信封就在 body 里。浏览器（和 nginx/Cloudflare）会把 204 上的 body 剥掉，客户端于是
/// 拿到空信封、解密抛错——管理台登录卡「网络异常」正是这个（/api/admin/session 成功回
/// 204）。真实状态码在密文内层的 `s` 里，客户端读它重建，所以外层用 200 承载信封是安全的。
///
/// `mask_status` 开启时一切都回 200（拿可观测性换流量特征，见 MSE_MASK_STATUS）。
fn outer_status(status: StatusCode, mask_status: bool) -> StatusCode {
    let bodyless = matches!(
        status,
        StatusCode::NO_CONTENT | StatusCode::RESET_CONTENT | StatusCode::NOT_MODIFIED
    );
    if mask_status || bodyless {
        StatusCode::OK
    } else {
        status
    }
}

fn stamp(hm: &mut HeaderMap, ctx: &Ctx) {
    hm.insert(H_V, HeaderValue::from_static("1"));
    if let Ok(v) = HeaderValue::from_str(&ctx.sid) {
        hm.insert(H_SID, v);
    }
    if let Ok(v) = HeaderValue::from_str(&ctx.seq.to_string()) {
        hm.insert(H_SEQ, v);
    }
}

/// 明确标注「这一条没加密，原因是」。静默降级是最危险的行为：客户端以为一切都封着。
fn mark_downgrade(hm: &mut HeaderMap, why: &'static str) {
    hm.insert("x-mse-downgrade", HeaderValue::from_static(why));
}

/// 逐帧封装 SSE。
///
/// 上游的每一个事件块（到 `\n\n` 为止）整块封成一行 `data: <base64url(信封)>`。
/// 帧序号进 AAD，所以中间人既不能重排也不能丢帧而不被发现。
///
/// 最后一帧封的是 `{"__mse_eos":true}`。没有它就结束的流 = 被截断了，客户端会报错而
/// 不是把半截答案当完整答案 —— 普通的 SSE 代理根本没法发现这件事。
fn seal_stream(ctx: Ctx, parts: axum::http::response::Parts, body: Body) -> Response {
    use futures_util::StreamExt;

    struct S {
        inner: axum::body::BodyDataStream,
        buf: Vec<u8>,
        ctx: Ctx,
        frame: u64,
        upstream_done: bool,
        finished: bool,
    }

    // ctx 马上要被 move 进闭包，而响应头还要用 sid/seq 盖章。先抄一份出来。
    let sid = ctx.sid.clone();
    let seq = ctx.seq;

    let state = S {
        inner: body.into_data_stream(),
        buf: Vec::new(),
        ctx,
        frame: 0,
        upstream_done: false,
        finished: false,
    };

    let stream = futures_util::stream::unfold(state, |mut s| async move {
        if s.finished {
            return None;
        }
        loop {
            // 缓冲里已经有完整事件块就先发它。
            if let Some(cut) = find_event_end(&s.buf) {
                let block: Vec<u8> = s.buf.drain(..cut).collect();
                // 封不上就**就地断流**（不发 EOS）：客户端读不到结束标记 = 知道这条流是断的。
                // 原来是发一行注释再照常 `frame += 1`——客户端看不见注释里的帧、自己的帧号不动，
                // 从那之后每一帧的 AAD 都错位一个，报的是「MSE: 帧解密失败: MSE: 解密失败」，
                // 读起来像被篡改，实际是这里悄悄跳了个号。旁边注释原本承诺的就是"报截断"。
                let Some(out) = seal_frame(&s.ctx, s.frame, &block) else {
                    return None;
                };
                s.frame += 1;
                return Some((out, s));
            }
            if s.upstream_done {
                // 收尾：残留的不完整块（上游没以空行结束）也要送出去，然后是 EOS。
                if !s.buf.is_empty() {
                    let block: Vec<u8> = std::mem::take(&mut s.buf);
                    let Some(out) = seal_frame(&s.ctx, s.frame, &block) else {
                        return None;
                    };
                    s.frame += 1;
                    return Some((out, s));
                }
                s.finished = true;
                // EOS 都封不上就别发：宁可让客户端判成截断，也别发一行它解不开的东西。
                let out = seal_frame(&s.ctx, s.frame, br#"{"__mse_eos":true}"#)?;
                return Some((out, s));
            }
            match s.inner.next().await {
                Some(Ok(chunk)) => s.buf.extend_from_slice(&chunk),
                // 上游断了：**不发** EOS 帧就是正确行为。客户端读不到结束标记，
                // 就知道这条流是断的，而不是把半截答案当成完整答案。
                Some(Err(_)) => return None,
                None => s.upstream_done = true,
            }
        }
    })
    .map(Ok::<_, std::io::Error>);

    let mut res = Response::new(Body::from_stream(stream));
    *res.status_mut() = parts.status;
    let hm = res.headers_mut();
    hm.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    hm.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    hm.insert(H_STREAM, HeaderValue::from_static("1"));
    forward_set_cookie(&parts.headers, hm);
    hm.insert(H_V, HeaderValue::from_static("1"));
    if let Ok(v) = HeaderValue::from_str(&sid) {
        hm.insert(H_SID, v);
    }
    if let Ok(v) = HeaderValue::from_str(&seq.to_string()) {
        hm.insert(H_SEQ, v);
    }
    res
}

/// 封一帧。封不上返回 `None` —— 调用方据此**断流**。
///
/// 不能发一行注释再把帧号加一：客户端只数它真正解开的帧，服务端多加的这一号会让之后
/// 每一帧的 AAD 都错位，症状是「MSE: 帧解密失败」，而真正发生的事是跳号。断流让客户端
/// 读不到 EOS，判成截断——那才是这里本来要给的信号。
fn seal_frame(ctx: &Ctx, frame: u64, block: &[u8]) -> Option<axum::body::Bytes> {
    let aad = aad_sse(&ctx.sid, ctx.seq, frame);
    match seal(&ctx.k_s2c, &aad, block) {
        Ok(env) => Some(axum::body::Bytes::from(format!(
            "data: {}\n\n",
            B64U.encode(env)
        ))),
        Err(_) => {
            tracing::error!("MSE: 帧 {frame} 封装失败，断流（客户端会判成截断）");
            None
        }
    }
}

/// 事件块结束位置（含结尾空行）。SSE 用空行分隔事件；`\r\n\r\n` 也要认，
/// 上游是别人的服务，不能假设它只用 `\n`。
fn find_event_end(buf: &[u8]) -> Option<usize> {
    let mut i = 0;
    while i + 1 < buf.len() {
        if buf[i] == b'\n' && buf[i + 1] == b'\n' {
            return Some(i + 2);
        }
        if i + 3 < buf.len() && &buf[i..i + 4] == b"\r\n\r\n" {
            return Some(i + 4);
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> StaticKey {
        StaticKey::from_secret(SecretKey::random(&mut rand::rngs::OsRng))
    }

    #[test]
    fn seal_open_roundtrip() {
        let k = [7u8; 32];
        let aad = aad_req("sid", 1, 1_700_000_000_000, &Method::POST, "/api/me");
        let env = seal(&k, &aad, b"hello").unwrap();
        assert_eq!(env[0], FORMAT_VERSION);
        assert_eq!(open(&k, &aad, &env).unwrap(), b"hello");
    }

    #[test]
    fn aad_binds_method_and_path() {
        let k = [7u8; 32];
        let env = seal(
            &k,
            &aad_req("s", 1, 1, &Method::POST, "/api/redeem"),
            b"{}",
        )
        .unwrap();
        // 同一个信封挪到另一条路由上必须打不开 —— 否则「兑换码」的请求可以被重放到
        // 任何别的 POST 上。
        assert!(open(&k, &aad_req("s", 1, 1, &Method::POST, "/api/withdraw"), &env).is_err());
        assert!(open(&k, &aad_req("s", 1, 1, &Method::GET, "/api/redeem"), &env).is_err());
        assert!(open(&k, &aad_req("s", 2, 1, &Method::POST, "/api/redeem"), &env).is_err());
    }

    #[test]
    fn nul_separator_prevents_field_shifting() {
        // "a"+"12" 和 "a1"+"2" 拼出来必须不同。
        assert_ne!(
            join_nul(&[b"a", b"12"]),
            join_nul(&[b"a1", b"2"])
        );
    }

    #[test]
    fn kid_and_sid_are_derived_not_assigned() {
        let k = test_key();
        assert_eq!(k.kid, kid_of(&k.spki));
        assert_eq!(k.kid.len(), 24);
        let sid = sid_of(&k.spki);
        assert_eq!(sid, sid_of(&k.spki));
        assert_eq!(B64U.decode(&sid).unwrap().len(), 18);
    }

    #[test]
    fn both_directions_get_different_keys() {
        let server = test_key();
        let client = SecretKey::random(&mut rand::rngs::OsRng);
        let epk = client
            .public_key()
            .to_public_key_der()
            .unwrap()
            .as_bytes()
            .to_vec();

        let shared = diffie_hellman(server.secret.to_nonzero_scalar(), client.public_key().as_affine());
        let mut tx = Sha384::new();
        tx.update(&epk);
        tx.update(&server.spki);
        let tx = tx.finalize();
        let hk = Hkdf::<Sha384>::new(None, shared.raw_secret_bytes());
        let (mut a, mut b) = ([0u8; 32], [0u8; 32]);
        hk.expand(&info_for("c2s", &server.kid, &tx), &mut a).unwrap();
        hk.expand(&info_for("s2c", &server.kid, &tx), &mut b).unwrap();
        // 方向密钥必须不同，否则一条响应可以被当成请求重放回去。
        assert_ne!(a, b);
    }

    #[test]
    fn ecdh_agrees_both_ways() {
        let server = SecretKey::random(&mut rand::rngs::OsRng);
        let client = SecretKey::random(&mut rand::rngs::OsRng);
        let s = diffie_hellman(server.to_nonzero_scalar(), client.public_key().as_affine());
        let c = diffie_hellman(client.to_nonzero_scalar(), server.public_key().as_affine());
        assert_eq!(s.raw_secret_bytes(), c.raw_secret_bytes());
        assert_eq!(s.raw_secret_bytes().len(), 48); // P-384
    }

    #[test]
    fn exemptions_cover_the_paths_that_cannot_seal() {
        // nginx 子请求、provider 回跳、Stripe webhook、OpenAI 兼容面。
        for p in [
            "/api/authz",
            "/api/admin/authz",
            "/api/admin/ide-authz",
            "/api/webhooks/stripe",
            "/api/auth/oauth/github/callback",
            "/api/integrations/gitlab/callback",
            "/v1/chat/completions",
            "/chat/completions",
            "/ws",
            "/health",
            "/api/crypto/pubkey",
            "/api/ide/update/download/v1/app.dmg",
        ] {
            assert!(exempt(p), "{p} 应当豁免");
        }
        // 业务面不能被误伤。
        for p in [
            "/api/me",
            "/api/redeem",
            "/api/billing/checkout",
            "/api/referral/withdraw",
            "/api/admin/users",
            "/api/models/gpt/chat",
        ] {
            assert!(!exempt(p), "{p} 不该豁免");
        }
    }

    #[test]
    fn sse_event_boundaries() {
        assert_eq!(find_event_end(b"data: 1\n\nrest"), Some(9));
        assert_eq!(find_event_end(b"data: 1\r\n\r\nrest"), Some(11));
        assert_eq!(find_event_end(b"data: incomplete"), None);
    }

    #[test]
    fn inner_headers_cannot_forge_the_client_ip() {
        // 这条测试守的是一个真实存在过的漏洞：`h` 里的头曾经无过滤地写进请求。
        //
        // 建一条会话不需要任何凭据，所以任何匿名者都能封一个
        // {"h":{"x-real-ip":"1.2.3.4"}}，而 auth.rs 的 client_ip() 优先读 x-real-ip，
        // 登录失败计数和验证码限流都挂在它上面 —— 每个请求换一个 IP，两道闸门就没了。
        for forged in [
            "x-real-ip",
            "x-forwarded-for",
            "x-forwarded-proto",
            "host",
            "cookie",
            "content-length",
        ] {
            assert!(
                !SEALABLE_REQUEST_HEADERS.contains(&forged),
                "{forged} 绝不能出现在白名单里"
            );
        }
        // 客户端真的会封的那几个必须在，否则令牌和地区信号送不进去。
        for real in [
            "authorization",
            "x-ide-language",
            "x-ide-timezone",
            "x-ide-utc-offset-minutes",
        ] {
            assert!(SEALABLE_REQUEST_HEADERS.contains(&real), "{real} 应当放行");
        }
    }

    #[test]
    fn both_pkcs8_and_sec1_keys_load() {
        // 真机第一次启动就死在这上面：OpenSSL 3.6 的
        // `genpkey -algorithm EC -outform DER` 给的是 SEC1，不是 PKCS#8，服务端当场
        // 拒绝启动，而运维手里那条命令看着完全正常。两种都要能读。
        use p384::pkcs8::EncodePrivateKey;
        let secret = SecretKey::random(&mut rand::rngs::OsRng);
        let want = StaticKey::from_secret(secret.clone()).kid;

        let pkcs8 = B64.encode(secret.to_pkcs8_der().unwrap().as_bytes());
        assert_eq!(StaticKey::from_der_b64(&pkcs8).unwrap().kid, want);

        let sec1_der: &[u8] = &secret.to_sec1_der().unwrap();
        let sec1 = B64.encode(sec1_der);
        assert_eq!(StaticKey::from_der_b64(&sec1).unwrap().kid, want);

        // 垃圾输入仍然要报错，别把「什么都收」变成「什么都不检查」。
        assert!(StaticKey::from_der_b64(&B64.encode(b"not a key")).is_err());
    }

    #[test]
    fn bodyless_statuses_seal_as_200_outer() {
        // 204/205/304 不能带 body，但密文信封就在 body 里。外层必须回 200 承载信封，
        // 否则浏览器剥掉 body、客户端解密空信封抛错 —— 管理台登录「网络异常」的真因。
        assert_eq!(outer_status(StatusCode::NO_CONTENT, false), StatusCode::OK);
        assert_eq!(outer_status(StatusCode::RESET_CONTENT, false), StatusCode::OK);
        assert_eq!(outer_status(StatusCode::NOT_MODIFIED, false), StatusCode::OK);
        // 有正文的状态原样保留（客户端只认内层 s，但外层如实反映便于观测）。
        assert_eq!(outer_status(StatusCode::OK, false), StatusCode::OK);
        assert_eq!(outer_status(StatusCode::UNAUTHORIZED, false), StatusCode::UNAUTHORIZED);
        assert_eq!(outer_status(StatusCode::BAD_REQUEST, false), StatusCode::BAD_REQUEST);
        // mask 档一切归 200。
        assert_eq!(outer_status(StatusCode::UNAUTHORIZED, true), StatusCode::OK);
    }

    #[test]
    fn set_cookie_survives_sealing() {
        // 封掉 Set-Cookie 等于扔掉它：客户端是在 JS 里 new Response(...)，浏览器不会
        // 从那里存 cookie。丢了的后果是 /api/admin/session 回 200 而管理台永远进不去。
        let mut from = HeaderMap::new();
        from.append(header::SET_COOKIE, HeaderValue::from_static("a=1; HttpOnly"));
        from.append(header::SET_COOKIE, HeaderValue::from_static("b=2; HttpOnly"));
        let mut to = HeaderMap::new();
        forward_set_cookie(&from, &mut to);
        // 两条都要在：一个响应可以带多条，只取第一条会静默丢掉其余的。
        let got: Vec<_> = to.get_all(header::SET_COOKIE).iter().collect();
        assert_eq!(got.len(), 2);
    }

    #[test]
    fn ephemeral_signature_verifies_against_the_static_key() {
        // 信任链的第一环：静态密钥签的临时密钥，必须能被静态**公钥**验过。
        // 这正是客户端做的事（用 pin 锚定的静态公钥验 eph 签名）。
        use p384::ecdsa::signature::Verifier;
        use p384::ecdsa::{Signature, VerifyingKey};

        let m = mse_with(test_key());
        let (_id, pub_b64, exp, sig_b64) = m.current_ephemeral();
        assert!(!sig_b64.is_empty(), "应当给出一把带签名的临时密钥");

        let eph_spki = B64U.decode(&pub_b64).unwrap();
        let sig_bytes = B64U.decode(&sig_b64).unwrap();
        assert_eq!(sig_bytes.len(), 96, "P-384 的 r||s 应当是 96 字节（WebCrypto 认这个）");

        // 重建被签的消息：EPH_SIG_CTX || eph_spki || exp_be
        let mut msg = Vec::new();
        msg.extend_from_slice(EPH_SIG_CTX);
        msg.extend_from_slice(&eph_spki);
        msg.extend_from_slice(&exp.to_be_bytes());

        let vk = VerifyingKey::from_public_key_der(&m.current().spki).unwrap();
        let sig = Signature::from_slice(&sig_bytes).unwrap();
        assert!(vk.verify(&msg, &sig).is_ok(), "静态公钥必须能验过这把临时密钥的签名");

        // 改一个字节就验不过（签名真的绑住了临时公钥）。
        let mut bad = msg.clone();
        bad[EPH_SIG_CTX.len()] ^= 1;
        assert!(vk.verify(&bad, &sig).is_err(), "篡改临时公钥后签名必须失效");
    }

    #[test]
    fn forward_secrecy_static_key_alone_cannot_derive_the_session() {
        // 前向保密的核心断言：会话密钥来自 ECDH(client_eph, **server_eph**)，静态密钥
        // 没参与。所以只握有静态私钥的攻击者算不出会话密钥 —— 这正是「将来偷到静态私钥
        // 也解不了历史流量」的根据。
        let m = mse_with(test_key());
        let (eph_id, eph_pub_b64, _exp, _sig) = m.current_ephemeral();
        let eph_spki = B64U.decode(&eph_pub_b64).unwrap();

        // 模拟客户端：一把临时密钥。
        let client = SecretKey::random(&mut rand::rngs::OsRng);
        let client_spki = client
            .public_key()
            .to_public_key_der()
            .unwrap()
            .as_bytes()
            .to_vec();
        let sid = sid_of(&client_spki);

        // 服务端按 eph_id 派生（走临时密钥环那条路）。
        let (k_c2s, _k_s2c) = m.derive(&eph_id, &client_spki, &sid).unwrap();

        // 客户端侧：z_eph = ECDH(client_priv, server_eph_pub)。
        let server_eph_pub = PublicKey::from_public_key_der(&eph_spki).unwrap();
        let z_eph = diffie_hellman(client.to_nonzero_scalar(), server_eph_pub.as_affine());

        // 用 z_eph 复算 k_c2s，应当和服务端一致（证明这条会话确实建立在临时密钥上）。
        let mut tx = Sha384::new();
        tx.update(&client_spki);
        tx.update(&eph_spki);
        let tx = tx.finalize();
        let hk = Hkdf::<Sha384>::new(None, z_eph.raw_secret_bytes());
        let mut expect = [0u8; 32];
        hk.expand(&info_for("c2s", &eph_id, &tx), &mut expect).unwrap();
        assert_eq!(k_c2s, expect, "会话密钥必须来自临时密钥的 ECDH");

        // 关键：拿**静态私钥**去 ECDH，得到的是完全不同的 z —— 攻击者据此算不出会话密钥。
        let z_static = diffie_hellman(
            m.current().secret.to_nonzero_scalar(),
            PublicKey::from_public_key_der(&client_spki).unwrap().as_affine(),
        );
        assert_ne!(
            z_eph.raw_secret_bytes(),
            z_static.raw_secret_bytes(),
            "静态密钥的 ECDH 结果若和临时密钥相同，前向保密就是假的",
        );
    }

    #[test]
    fn old_clients_sealing_to_the_static_kid_still_work() {
        // 向后兼容：封给静态 kid 的老客户端仍然能派生（无前向保密，但不掉线）。
        let m = mse_with(test_key());
        let static_kid = m.current().kid.clone();
        let client = SecretKey::random(&mut rand::rngs::OsRng);
        let client_spki = client
            .public_key()
            .to_public_key_der()
            .unwrap()
            .as_bytes()
            .to_vec();
        let sid = sid_of(&client_spki);
        assert!(
            m.derive(&static_kid, &client_spki, &sid).is_ok(),
            "封给静态 kid 的请求必须仍能派生，否则老桌面端全掉线",
        );
    }

    #[test]
    fn mode_defaults_to_optional() {
        // 灰度期唯一安全的档位。拼错的值不能悄悄变成 required，那会锁死所有老客户端。
        assert_eq!(Mode::parse(""), Mode::Optional);
        assert_eq!(Mode::parse("typo"), Mode::Optional);
        assert_eq!(Mode::parse("off"), Mode::Off);
        assert_eq!(Mode::parse("REQUIRED"), Mode::Required);
    }

    // -----------------------------------------------------------------------
    // 冻结向量：Rust 和 TypeScript 必须算出同一批字节
    //
    // 上面那些测试只证明「Rust 自己和自己对得上」—— 两边同时改错同一处，它们照样全绿。
    // 真正的风险是**跨语言的错位**：HKDF 的 info 少一个竖线、tx 里两个公钥的顺序反了、
    // AAD 用逗号而不是 \0 分隔 —— 这些在任何一侧单独看都自洽，合起来就是所有请求解不开。
    //
    // 所以这批值是用 node 的 WebCrypto 真跑出来的（见 testdata/mse-vectors.json 的 note），
    // 这里做的是「Rust 能不能复现同一批字节」。ide/test/mse-interop.test.mjs 拿同一个
    // 文件对 TS 那一侧做同样的事。这个文件永远不该被「更新一下让测试变绿」。
    // -----------------------------------------------------------------------

    const VECTORS: &str = include_str!("../testdata/mse-vectors.json");

    fn vectors() -> Value {
        serde_json::from_str(VECTORS).expect("testdata/mse-vectors.json 不是合法 JSON")
    }

    fn at<'a>(v: &'a Value, path: &str) -> &'a Value {
        let mut cur = v;
        for seg in path.split('.') {
            cur = cur
                .get(seg)
                .unwrap_or_else(|| panic!("向量里没有 {path}（缺的是 {seg}）"));
        }
        cur
    }

    fn text(v: &Value, path: &str) -> String {
        at(v, path)
            .as_str()
            .unwrap_or_else(|| panic!("{path} 不是字符串"))
            .to_string()
    }

    fn bytes_b64u(v: &Value, path: &str) -> Vec<u8> {
        B64U.decode(text(v, path))
            .unwrap_or_else(|_| panic!("{path} 不是合法 base64url"))
    }

    fn key32(v: &Value, path: &str) -> [u8; 32] {
        bytes_b64u(v, path)
            .try_into()
            .unwrap_or_else(|_| panic!("{path} 不是 32 字节"))
    }

    /// 拿冻结的那把静态密钥装一个 Mse 出来。走 `Mse::derive` 而不是在测试里重抄一遍
    /// 推导过程 —— 重抄的版本会跟着生产代码一起错，等于没测。
    fn mse_with(key: StaticKey) -> Mse {
        Mse {
            keys: vec![key],
            mode: Mode::Optional,
            session_ttl: 1800,
            max_skew_ms: 120_000,
            max_bytes: 1 << 20,
            replay_fail_open: false,
            mask_status: false,
            cache: RwLock::new(HashMap::new()),
            ephemerals: RwLock::new(Vec::new()),
            ephemeral_ttl: 600,
        }
    }

    #[test]
    fn frozen_vectors_pin_key_derivation() {
        let v = vectors();
        assert_eq!(text(&v, "suite"), SUITE);
        assert_eq!(at(&v, "format_version").as_u64(), Some(FORMAT_VERSION as u64));

        let server = StaticKey::from_der_b64(&text(&v, "keys.server_pkcs8_b64"))
            .expect("冻结的服务端 PKCS#8 应当能装载");
        // SPKI 是从私钥重算出来的，不是从文件里读的：对不上就说明 Rust 和 WebCrypto 对
        // 「同一把私钥的公钥编码」意见不同，而 kid 是它的哈希，会跟着一起错。
        assert_eq!(server.spki, bytes_b64u(&v, "keys.server_spki_b64u"), "服务端 SPKI 编码不一致");
        assert_eq!(server.kid, text(&v, "derived.kid"), "kid 不一致");
        assert_eq!(kid_of(&server.spki), text(&v, "derived.kid"));

        let epk_spki = bytes_b64u(&v, "keys.client_epk_spki_b64u");
        assert_eq!(sid_of(&epk_spki), text(&v, "derived.sid"), "sid 不一致");

        // 两个方向的 ECDH 都要落到同一个 z：服务端拿私钥打客户端公钥，客户端反过来。
        let peer = PublicKey::from_public_key_der(&epk_spki).expect("epk 应当是合法 SPKI");
        let z_server = diffie_hellman(server.secret.to_nonzero_scalar(), peer.as_affine());
        let z = bytes_b64u(&v, "derived.z_b64u");
        assert_eq!(z.len(), 48, "P-384 的共享秘密就是 48 字节");
        assert_eq!(z_server.raw_secret_bytes().as_slice(), z.as_slice(), "ECDH 输出不一致");

        let client_der = B64
            .decode(text(&v, "keys.client_epk_pkcs8_b64"))
            .expect("客户端 PKCS#8 不是合法 base64");
        let client = SecretKey::from_pkcs8_der(&client_der).expect("客户端 PKCS#8 应当能装载");
        let client_spki = client
            .public_key()
            .to_public_key_der()
            .unwrap()
            .as_bytes()
            .to_vec();
        assert_eq!(client_spki, epk_spki, "冻结的客户端私钥和它的 SPKI 对不上");
        let z_client = diffie_hellman(
            client.to_nonzero_scalar(),
            server.secret.public_key().as_affine(),
        );
        assert_eq!(z_client.raw_secret_bytes().as_slice(), z.as_slice());

        // transcript：SHA-384(客户端 SPKI || 服务端 SPKI)。顺序反了两边就再也谈不拢。
        let mut h = Sha384::new();
        h.update(&epk_spki);
        h.update(&server.spki);
        assert_eq!(h.finalize().as_slice(), bytes_b64u(&v, "derived.tx_b64u").as_slice(), "tx 不一致");

        let tx = bytes_b64u(&v, "derived.tx_b64u");
        assert_eq!(info_for("c2s", &server.kid, &tx), bytes_b64u(&v, "derived.info_c2s_b64u"));
        assert_eq!(info_for("s2c", &server.kid, &tx), bytes_b64u(&v, "derived.info_s2c_b64u"));

        let m = mse_with(server);
        let kid = text(&v, "derived.kid");
        let sid = text(&v, "derived.sid");
        let (c2s, s2c) = m.derive(&kid, &epk_spki, &sid).expect("冻结的会话应当能推导");
        assert_eq!(c2s, key32(&v, "derived.k_c2s_b64u"), "k_c2s 不一致");
        assert_eq!(s2c, key32(&v, "derived.k_s2c_b64u"), "k_s2c 不一致");

        // 第二次走的是缓存那条路。缓存命中和现算必须给出同一把密钥，否则会话中途换 key。
        let (c2s2, s2c2) = m.derive(&kid, &epk_spki, &sid).unwrap();
        assert_eq!((c2s, s2c), (c2s2, s2c2));
    }

    #[test]
    fn frozen_envelopes_open_with_frozen_aad() {
        let v = vectors();
        let c2s = key32(&v, "derived.k_c2s_b64u");
        let s2c = key32(&v, "derived.k_s2c_b64u");
        let sid = text(&v, "derived.sid");

        // 请求侧。AAD 先逐字节比一遍：它不参与密文，但拼错了就是所有请求解不开，
        // 而报出来的错只会是一句「解密失败」。
        let seq = at(&v, "request.aad.seq").as_u64().unwrap();
        let ts = at(&v, "request.aad.ts").as_i64().unwrap();
        let method = Method::from_bytes(text(&v, "request.aad.method").as_bytes()).unwrap();
        let path = text(&v, "request.aad.path");
        let aad = aad_req(&sid, seq, ts, &method, &path);
        assert_eq!(aad, bytes_b64u(&v, "request.aad_b64u"), "请求 AAD 拼法不一致");

        let env = bytes_b64u(&v, "request.envelope_b64u");
        assert_eq!(env[0], FORMAT_VERSION);
        assert_eq!(&env[1..1 + NONCE_LEN], bytes_b64u(&v, "request.nonce_b64u").as_slice());
        let pt = open(&c2s, &aad, &env).expect("冻结的请求信封应当能打开");
        assert_eq!(pt, bytes_b64u(&v, "request.plaintext_b64u"), "请求明文字节不一致");
        assert_eq!(
            String::from_utf8(pt).unwrap(),
            text(&v, "request.plaintext_utf8"),
            "UTF-8 解码不一致"
        );

        // 响应侧。AAD 里没有状态码，是有意的（见 aad_res 的注释）。
        let rseq = at(&v, "response.aad.seq").as_u64().unwrap();
        let rpath = text(&v, "response.aad.path");
        let raad = aad_res(&sid, rseq, &rpath);
        assert_eq!(raad, bytes_b64u(&v, "response.aad_b64u"), "响应 AAD 拼法不一致");

        let renv = bytes_b64u(&v, "response.envelope_b64u");
        let rpt = open(&s2c, &raad, &renv).expect("冻结的响应信封应当能打开");
        assert_eq!(rpt, bytes_b64u(&v, "response.plaintext_b64u"), "响应明文字节不一致");
        assert_eq!(
            String::from_utf8(rpt).unwrap(),
            text(&v, "response.plaintext_utf8")
        );

        // 方向分离在冻结数据上也要成立：用 s2c 去开请求必须失败，否则一条响应可以被
        // 原样重放成一个请求。
        assert!(open(&s2c, &aad, &env).is_err(), "请求信封不该被响应密钥打开");
        assert!(open(&c2s, &raad, &renv).is_err(), "响应信封不该被请求密钥打开");
    }
}
