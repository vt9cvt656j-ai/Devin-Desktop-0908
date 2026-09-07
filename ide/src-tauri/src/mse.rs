//! MSE-1 客户端 —— 桌面端的请求与响应应用层加密。
//!
//! 协议与 `server/src/mse.rs` 逐字节一致。字节级兼容性已由 web 客户端（web-shared/mse.ts）
//! 的向量测试覆盖，这份实现遵循完全相同的构造。
//!
//! 桌面端之前是明文 HTTPS 直连网关。加了这一层之后，即使 TLS 终结在 nginx 或某个
//! 中间代理上，请求体和响应体也只是一坨密文。

use std::sync::RwLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64U;
use base64::Engine;
use hkdf::Hkdf;
use p384::ecdh::diffie_hellman;
use p384::elliptic_curve::rand_core::{OsRng as CryptoOsRng, RngCore as CryptoRngCore};
use p384::pkcs8::{DecodePublicKey, EncodePublicKey};
use p384::{PublicKey, SecretKey};
use sha2::{Digest, Sha384};
use zeroize::Zeroize;

const FORMAT_VERSION: u8 = 1;
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;

const H_V: &str = "x-mse-v";
const H_KID: &str = "x-mse-kid";
const H_EPK: &str = "x-mse-epk";
const H_SID: &str = "x-mse-sid";
const H_SEQ: &str = "x-mse-seq";
const H_TS: &str = "x-mse-ts";
const H_STREAM: &str = "x-mse-stream";

/// 客户端会话状态。整个 App 生命周期内共享一个实例。
pub struct MseClient {
    sessions: RwLock<Sessions>,
    /// 允许的服务端 kid 列表（pin）。为空时接受任何 kid。
    pinned_kids: Vec<String>,
}

/// 当前会话，外加最近**退役**的几份。
///
/// 为什么要留退役的：会话是全局一份，而一条 SSE 流会跑几分钟。这期间只要有别的东西换掉
/// 会话——保活循环发现过期后重建（ai.rs 的 `start_gateway_transport_warmup`）、另一个并发
/// 请求吃到 409 rekey 后 `invalidate` + `establish`——在途那条流剩下的每一帧就都用新会话的
/// 密钥和 sid 去解，AAD 和密钥双双对不上，于是「MSE: 帧解密失败: MSE: 解密失败」，一整轮
/// 几分钟的回答当场作废。帧是服务端用**收到请求时那个会话**封的，所以客户端必须按响应头
/// 里的 sid 回到那一份，而不是拿"此刻的"那一份去猜。
///
/// 留几份就够：轮换本身很少（TTL 半小时级 / 409），而在途的流最多也就几条。退役的密钥是
/// 已经用过的会话密钥、仍在同一个进程内存里，界限没有变宽；Session 的 Drop 照旧 zeroize。
#[derive(Default)]
struct Sessions {
    current: Option<Session>,
    retired: Vec<Session>,
}

/// 最多留几份退役会话。
const RETIRED_KEEP: usize = 4;

impl Sessions {
    /// 换上新会话，旧的转入退役队列（**不是丢掉**）。
    fn install(&mut self, next: Session) {
        if let Some(prev) = self.current.take() {
            self.retired.insert(0, prev);
            self.retired.truncate(RETIRED_KEEP);
        }
        self.current = Some(next);
    }

    /// 作废当前会话（服务端 409）。同样转入退役队列：此刻在途的流还得靠它解帧。
    fn retire_current(&mut self) {
        if let Some(prev) = self.current.take() {
            self.retired.insert(0, prev);
            self.retired.truncate(RETIRED_KEEP);
        }
    }

    /// 按 sid 找会话。`None` = 对端没告诉我们 sid（老网关），退回当前那一份。
    fn find(&self, sid: Option<&str>) -> Option<&Session> {
        match sid {
            None => self.current.as_ref(),
            Some(want) => self
                .current
                .as_ref()
                .filter(|s| s.sid == want)
                .or_else(|| self.retired.iter().find(|s| s.sid == want)),
        }
    }
}

struct Session {
    kid: String,
    sid: String,
    epk_b64u: String,
    k_c2s: [u8; 32],
    k_s2c: [u8; 32],
    seq: u64,
    server_time_offset: i64,
    expires_at: u64,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.k_c2s.zeroize();
        self.k_s2c.zeroize();
    }
}

#[derive(serde::Deserialize)]
struct PubkeyResponse {
    kid: String,
    #[serde(rename = "pub")]
    pub_key: String,
    #[serde(default)]
    eph: Option<EphKey>,
    #[serde(default)]
    session_ttl: Option<u64>,
    #[serde(default)]
    server_time: Option<i64>,
}

#[derive(serde::Deserialize)]
struct EphKey {
    id: String,
    #[serde(rename = "pub")]
    pub_key: String,
}

/// 封好的请求内层 JSON。
#[derive(serde::Serialize)]
struct SealedRequest<'a> {
    q: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    b: Option<&'a serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    h: Option<std::collections::HashMap<String, String>>,
}

/// 服务端密文响应内层 JSON。
#[derive(serde::Deserialize)]
struct SealedResponse {
    s: u16,
    #[serde(default)]
    b: Option<serde_json::Value>,
    #[serde(default)]
    raw: Option<String>,
    ct: String,
    #[serde(default)]
    h: std::collections::HashMap<String, String>,
}

impl MseClient {
    pub fn new(pinned_kids: Vec<String>) -> Self {
        Self {
            sessions: RwLock::new(Sessions::default()),
            pinned_kids,
        }
    }

    /// 拿网关的公钥建立会话。
    pub async fn establish(
        &self,
        client: &reqwest::Client,
        gateway_base: &str,
    ) -> Result<(), String> {
        let url = format!("{}/api/crypto/pubkey", gateway_base.trim_end_matches('/'));
        let resp = client
            .get(&url)
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| format!("MSE pubkey fetch: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("MSE pubkey: HTTP {}", resp.status()));
        }
        let pk: PubkeyResponse = resp
            .json()
            .await
            .map_err(|e| format!("MSE pubkey parse: {e}"))?;

        // pin 校验：如果客户端钉了 kid，对面必须是其中之一。
        let target_kid;
        let target_pub_b64;

        if let Some(eph) = &pk.eph {
            target_kid = &eph.id;
            target_pub_b64 = &eph.pub_key;
        } else {
            target_kid = &pk.kid;
            target_pub_b64 = &pk.pub_key;
        }

        if !self.pinned_kids.is_empty() && !self.pinned_kids.contains(&pk.kid) {
            return Err(format!(
                "MSE: 服务端 kid {} 不在 pin 列表里",
                pk.kid
            ));
        }

        let server_pub_der = B64U
            .decode(target_pub_b64)
            .map_err(|_| "MSE: 服务端公钥 base64url 不合法")?;
        let server_pub = PublicKey::from_public_key_der(&server_pub_der)
            .map_err(|_| "MSE: 服务端公钥不是合法 P-384 SPKI")?;

        let eph_secret = SecretKey::random(&mut CryptoOsRng);
        let eph_pub = eph_secret.public_key();
        let eph_pub_der = eph_pub
            .to_public_key_der()
            .map_err(|_| "MSE: 编码 EPK 失败")?
            .to_vec();
        let epk_b64u = B64U.encode(&eph_pub_der);

        let mut z = diffie_hellman(eph_secret.to_nonzero_scalar(), server_pub.as_affine())
            .raw_secret_bytes()
            .to_vec();

        let sid = sid_of(&eph_pub_der);

        let mut tx = Sha384::new();
        tx.update(&eph_pub_der);
        tx.update(&server_pub_der);
        let tx = tx.finalize();

        let hk = Hkdf::<Sha384>::new(None, &z);
        let mut k_c2s = [0u8; 32];
        let mut k_s2c = [0u8; 32];
        hk.expand(&info_for("c2s", target_kid, &tx), &mut k_c2s)
            .map_err(|_| "MSE: HKDF c2s 失败")?;
        hk.expand(&info_for("s2c", target_kid, &tx), &mut k_s2c)
            .map_err(|_| "MSE: HKDF s2c 失败")?;
        z.zeroize();

        let now_ms = unix_millis();
        let server_time_offset = pk.server_time.unwrap_or(now_ms) - now_ms;
        let ttl = pk.session_ttl.unwrap_or(1800);

        let session = Session {
            kid: target_kid.clone(),
            sid,
            epk_b64u,
            k_c2s,
            k_s2c,
            seq: 0,
            server_time_offset,
            expires_at: unix_secs() + ttl.saturating_sub(30),
        };

        if let Ok(mut guard) = self.sessions.write() {
            guard.install(session);
        }
        Ok(())
    }

    /// 会话是否可用且未过期。
    pub fn is_active(&self) -> bool {
        self.sessions
            .read()
            .ok()
            .and_then(|g| g.current.as_ref().map(|s| s.expires_at > unix_secs()))
            .unwrap_or(false)
    }

    /// 服务端返回 409 rekey 时作废当前会话，下一次请求重新握手。
    ///
    /// **转入退役而不是丢掉**：此刻可能有别的流正在用它解帧，丢了那条流就整段废掉。
    pub fn invalidate(&self) {
        if let Ok(mut guard) = self.sessions.write() {
            guard.retire_current();
        }
    }

    /// 这条流的帧解得开吗（sid 来自响应头 `x-mse-sid`）。
    ///
    /// 调用方据此决定「按密文解」还是「报错」，**不要**再拿 `is_active()` 判：会话在请求
    /// 发出到响应回来之间被换掉时它照样为真，于是拿新密钥去解旧帧，一样失败；反过来被
    /// `invalidate()` 清空时它为假，调用方会把密文当明文 JSON 解析，然后静默丢掉整条流。
    pub fn can_open_sse(&self, sid: Option<&str>) -> bool {
        self.sessions
            .read()
            .ok()
            .map(|g| g.find(sid).is_some())
            .unwrap_or(false)
    }

    /// 封装一个 POST 请求。返回 (headers, sealed_body)。
    pub fn seal_request(
        &self,
        method: &str,
        path: &str,
        body: &serde_json::Value,
        extra_headers: Option<std::collections::HashMap<String, String>>,
    ) -> Result<(Vec<(String, String)>, Vec<u8>), String> {
        let mut guard = self.sessions.write().map_err(|_| "MSE: 锁中毒")?;
        let session = guard.current.as_mut().ok_or("MSE: 会话未建立")?;

        if session.expires_at <= unix_secs() {
            return Err("MSE: 会话过期".to_string());
        }

        session.seq += 1;
        let seq = session.seq;
        let ts = unix_millis() + session.server_time_offset;

        let inner = SealedRequest {
            q: "",
            b: Some(body),
            h: extra_headers,
        };
        let plaintext =
            serde_json::to_vec(&inner).map_err(|e| format!("MSE: 序列化请求失败: {e}"))?;

        let aad = aad_req(&session.sid, seq, ts, method, path);
        let envelope = seal(&session.k_c2s, &aad, &plaintext)?;

        let headers = vec![
            (H_V.to_string(), "1".to_string()),
            (H_KID.to_string(), session.kid.clone()),
            (H_EPK.to_string(), session.epk_b64u.clone()),
            (H_SID.to_string(), session.sid.clone()),
            (H_SEQ.to_string(), seq.to_string()),
            (H_TS.to_string(), ts.to_string()),
            (H_STREAM.to_string(), "1".to_string()),
        ];

        Ok((headers, envelope))
    }

    /// 解封一个非流式响应。
    pub fn open_response(
        &self,
        path: &str,
        resp_headers: &reqwest::header::HeaderMap,
        body: &[u8],
    ) -> Result<(u16, serde_json::Value), String> {
        let guard = self.sessions.read().map_err(|_| "MSE: 锁中毒")?;
        // 按响应自己报的 sid 找会话：并发的重新握手会换掉 current，拿它解旧响应必然失败。
        let sid = resp_headers.get(H_SID).and_then(|v| v.to_str().ok());
        let session = guard
            .find(sid)
            .ok_or_else(|| session_gone_msg("响应", sid))?;

        let seq: u64 = resp_headers
            .get(H_SEQ)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
            .unwrap_or(session.seq);

        let aad = aad_res(&session.sid, seq, path);
        let plaintext = open(&session.k_s2c, &aad, body)?;

        let inner: SealedResponse =
            serde_json::from_slice(&plaintext).map_err(|e| format!("MSE: 响应解码失败: {e}"))?;

        let body_val = inner.b.unwrap_or_else(|| {
            if let Some(raw) = &inner.raw {
                if let Ok(decoded) = B64U.decode(raw) {
                    if let Ok(val) = serde_json::from_slice(&decoded) {
                        return val;
                    }
                }
            }
            serde_json::Value::Null
        });

        Ok((inner.s, body_val))
    }

    /// 解封 SSE 流的一帧。帧号从 0 递增。
    ///
    /// `req_seq` 是本次请求在 `seal_request` 时分配的序号（服务端通过 `x-mse-seq`
    /// 响应头回传）。不能用 `session.seq` 的实时值——并发请求会把它递增，导致 AAD
    /// 与服务端不匹配，解密失败。
    pub fn open_sse_frame(
        &self,
        sid: Option<&str>,
        frame_data: &str,
        frame_seq: u64,
        req_seq: u64,
    ) -> Result<Vec<u8>, String> {
        let guard = self.sessions.read().map_err(|_| "MSE: 锁中毒")?;
        // 帧是服务端用**收到这个请求时**那个会话封的。全局的 current 可能已经被保活循环或
        // 另一个请求的 409 rekey 换掉了，按 sid 回到原来那一份，而不是拿此刻这份去解。
        let session = guard.find(sid).ok_or_else(|| session_gone_msg("流", sid))?;

        let envelope = B64U
            .decode(frame_data.trim())
            .map_err(|_| "MSE: SSE 帧 base64url 不合法")?;

        let aad = aad_sse(&session.sid, req_seq, frame_seq);
        open(&session.k_s2c, &aad, &envelope)
    }

    /// 造一个会话装进去。只给测试用——真会话必须走 `establish` 的 ECDH。
    #[cfg(test)]
    fn install_test_session(&self, sid: &str, k_s2c: [u8; 32]) {
        let mut guard = self.sessions.write().unwrap();
        guard.install(Session {
            kid: "test-kid".into(),
            sid: sid.into(),
            epk_b64u: String::new(),
            k_c2s: [0u8; 32],
            k_s2c,
            seq: 0,
            server_time_offset: 0,
            expires_at: unix_secs() + 3600,
        });
    }

    /// 检测一个 SSE data 行是否是 EOS 标记。
    pub fn is_eos(plaintext: &[u8]) -> bool {
        plaintext == b"{\"__mse_eos\":true}"
    }
}

/// 找不到封这条数据的那个会话时说的话。分清「从来没建立」和「建立过但已经轮换掉了」——
/// 后者不是中间人，是本地会话在途中被换了，重试就能好。
fn session_gone_msg(what: &str, sid: Option<&str>) -> String {
    match sid {
        Some(sid) => format!(
            "MSE: 封这条{what}的会话（sid {}）已经不在本地了——会话在收到它之前被轮换或作废了。这不是篡改，重试一次即可。",
            sid.chars().take(12).collect::<String>()
        ),
        None => format!("MSE: 会话未建立，无法解开这条{what}"),
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

fn sid_of(epk_spki: &[u8]) -> String {
    let digest = Sha384::digest(epk_spki);
    B64U.encode(&digest[..18])
}

fn unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn seal(key: &[u8; 32], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| "MSE: AES key init 失败".to_string())?;
    let mut nonce = [0u8; NONCE_LEN];
    CryptoOsRng.fill_bytes(&mut nonce);
    let ct = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| "MSE: AES-GCM seal 失败".to_string())?;
    let mut out = Vec::with_capacity(1 + NONCE_LEN + ct.len());
    out.push(FORMAT_VERSION);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

fn open(key: &[u8; 32], aad: &[u8], envelope: &[u8]) -> Result<Vec<u8>, String> {
    if envelope.len() < 1 + NONCE_LEN + TAG_LEN {
        return Err("MSE: 信封太短".to_string());
    }
    if envelope[0] != FORMAT_VERSION {
        return Err("MSE: 信封版本不认识".to_string());
    }
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| "MSE: AES key init 失败".to_string())?;
    cipher
        .decrypt(
            Nonce::from_slice(&envelope[1..1 + NONCE_LEN]),
            Payload {
                msg: &envelope[1 + NONCE_LEN..],
                aad,
            },
        )
        .map_err(|_| "MSE: 解密失败".to_string())
}

fn aad_req(sid: &str, seq: u64, ts: i64, method: &str, path: &str) -> Vec<u8> {
    join_nul(&[
        b"MSE1/req",
        sid.as_bytes(),
        seq.to_string().as_bytes(),
        ts.to_string().as_bytes(),
        method.as_bytes(),
        path.as_bytes(),
    ])
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_roundtrip() {
        let k = [7u8; 32];
        let aad = aad_req("sid", 1, 1_700_000_000_000, "POST", "/api/me");
        let env = seal(&k, &aad, b"hello").unwrap();
        assert_eq!(env[0], FORMAT_VERSION);
        assert_eq!(open(&k, &aad, &env).unwrap(), b"hello");
    }

    #[test]
    fn aad_binds_method_and_path() {
        let k = [7u8; 32];
        let env = seal(&k, &aad_req("s", 1, 1, "POST", "/api/redeem"), b"{}").unwrap();
        assert!(open(&k, &aad_req("s", 1, 1, "POST", "/api/withdraw"), &env).is_err());
        assert!(open(&k, &aad_req("s", 1, 1, "GET", "/api/redeem"), &env).is_err());
        assert!(open(&k, &aad_req("s", 2, 1, "POST", "/api/redeem"), &env).is_err());
    }

    #[test]
    fn nul_separator_prevents_field_shifting() {
        assert_ne!(join_nul(&[b"a", b"12"]), join_nul(&[b"a1", b"2"]));
    }

    #[test]
    fn sid_is_deterministic() {
        let spki = b"test-spki-data-for-sid";
        assert_eq!(sid_of(spki), sid_of(spki));
        assert_eq!(B64U.decode(sid_of(spki)).unwrap().len(), 18);
    }

    /// 造一帧服务端会发出来的东西：`base64url(seal(k_s2c, aad_sse(sid, req_seq, frame), block))`。
    fn server_frame(sid: &str, k: &[u8; 32], req_seq: u64, frame: u64, block: &[u8]) -> String {
        B64U.encode(seal(k, &aad_sse(sid, req_seq, frame), block).unwrap())
    }

    /// **这条是那个 bug 的落点。**
    ///
    /// 会话是全局一份，而一条流要跑几分钟。保活循环重建会话、或者另一个并发请求吃到 409 后
    /// invalidate+establish，都会在流跑到一半时把它换掉；换掉之后剩下的每一帧都拿新密钥、新
    /// sid 去解，于是「MSE: 帧解密失败: MSE: 解密失败」，一整轮几分钟的回答当场作废。
    /// 帧要按**封它的那个会话**（响应头 x-mse-sid）解，不是按"此刻的"那一份。
    #[test]
    fn a_rotation_mid_stream_does_not_break_the_frames_already_in_flight() {
        let c = MseClient::new(vec![]);
        let k_a = [11u8; 32];
        c.install_test_session("sid-A", k_a);
        let f0 = server_frame("sid-A", &k_a, 7, 0, b"data: {\"i\":0}\n\n");
        let f1 = server_frame("sid-A", &k_a, 7, 1, b"data: {\"i\":1}\n\n");
        assert_eq!(c.open_sse_frame(Some("sid-A"), &f0, 0, 7).unwrap(), b"data: {\"i\":0}\n\n");

        // 流跑到一半，别的东西把会话换了（409 rekey / 保活重建）。
        c.install_test_session("sid-B", [22u8; 32]);
        assert!(
            c.open_sse_frame(Some("sid-A"), &f1, 1, 7).is_ok(),
            "会话在流中途被换掉，剩下的帧就解不开了——这正是所有者截图里那条「MSE: 帧解密失败」"
        );

        // 409 作废当前会话也一样：在途那条流还得靠它。
        c.invalidate();
        assert!(c.open_sse_frame(Some("sid-A"), &f1, 1, 7).is_ok(), "invalidate 把在途的流一起废了");
    }

    /// 不按 sid 找就会拿错会话——这是修之前的行为，钉住它免得有人"顺手简化"回去。
    #[test]
    fn the_current_session_is_the_wrong_key_once_it_has_rotated() {
        let c = MseClient::new(vec![]);
        let k_a = [11u8; 32];
        c.install_test_session("sid-A", k_a);
        let f = server_frame("sid-A", &k_a, 1, 0, b"x");
        c.install_test_session("sid-B", [22u8; 32]);
        assert!(c.open_sse_frame(None, &f, 0, 1).is_err(), "None 该退回 current（新会话），解不开");
        assert!(c.open_sse_frame(Some("sid-A"), &f, 0, 1).is_ok());
    }

    /// 退役队列是有界的；超出之后要说清是"轮换掉了、重试即可"，不是"被篡改"。
    #[test]
    fn a_long_gone_session_says_it_rotated_not_that_someone_tampered() {
        let c = MseClient::new(vec![]);
        let k_a = [11u8; 32];
        c.install_test_session("sid-A", k_a);
        let f = server_frame("sid-A", &k_a, 1, 0, b"x");
        assert!(c.can_open_sse(Some("sid-A")));
        for i in 0..=RETIRED_KEEP {
            c.install_test_session(&format!("sid-{i}"), [33u8; 32]);
        }
        assert!(!c.can_open_sse(Some("sid-A")));
        let err = c.open_sse_frame(Some("sid-A"), &f, 0, 1).unwrap_err();
        assert!(err.contains("轮换"), "{err}");
        assert!(err.contains("重试"), "{err}");
        assert!(!err.contains("解密失败"), "别再报成解密失败——那读起来像被篡改：{err}");
    }

    /// AAD 里的帧号和请求号仍然管用：重排、跨请求重放都开不了。
    #[test]
    fn frames_are_still_bound_to_their_order_and_request() {
        let c = MseClient::new(vec![]);
        let k = [11u8; 32];
        c.install_test_session("sid-A", k);
        let f2 = server_frame("sid-A", &k, 7, 2, b"x");
        assert!(c.open_sse_frame(Some("sid-A"), &f2, 2, 7).is_ok());
        assert!(c.open_sse_frame(Some("sid-A"), &f2, 3, 7).is_err(), "帧号错位不该开得了");
        assert!(c.open_sse_frame(Some("sid-A"), &f2, 2, 8).is_err(), "换个请求号不该开得了");
    }

    #[test]
    fn eos_detection() {
        assert!(MseClient::is_eos(b"{\"__mse_eos\":true}"));
        assert!(!MseClient::is_eos(b"{\"content\":\"hello\"}"));
    }
}
