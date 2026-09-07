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
    session: RwLock<Option<Session>>,
    /// 允许的服务端 kid 列表（pin）。为空时接受任何 kid。
    pinned_kids: Vec<String>,
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
            session: RwLock::new(None),
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

        if let Ok(mut guard) = self.session.write() {
            *guard = Some(session);
        }
        Ok(())
    }

    /// 会话是否可用且未过期。
    pub fn is_active(&self) -> bool {
        self.session
            .read()
            .ok()
            .and_then(|g| g.as_ref().map(|s| s.expires_at > unix_secs()))
            .unwrap_or(false)
    }

    /// 服务端返回 409 rekey 时清掉会话，下一次请求走明文。
    pub fn invalidate(&self) {
        if let Ok(mut guard) = self.session.write() {
            *guard = None;
        }
    }

    /// 封装一个 POST 请求。返回 (headers, sealed_body)。
    pub fn seal_request(
        &self,
        method: &str,
        path: &str,
        body: &serde_json::Value,
        extra_headers: Option<std::collections::HashMap<String, String>>,
    ) -> Result<(Vec<(String, String)>, Vec<u8>), String> {
        let mut guard = self.session.write().map_err(|_| "MSE: 锁中毒")?;
        let session = guard.as_mut().ok_or("MSE: 会话未建立")?;

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
        let guard = self.session.read().map_err(|_| "MSE: 锁中毒")?;
        let session = guard.as_ref().ok_or("MSE: 会话未建立")?;

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
        frame_data: &str,
        frame_seq: u64,
        req_seq: u64,
    ) -> Result<Vec<u8>, String> {
        let guard = self.session.read().map_err(|_| "MSE: 锁中毒")?;
        let session = guard.as_ref().ok_or("MSE: 会话未建立")?;

        let envelope = B64U
            .decode(frame_data.trim())
            .map_err(|_| "MSE: SSE 帧 base64url 不合法")?;

        let aad = aad_sse(&session.sid, req_seq, frame_seq);
        open(&session.k_s2c, &aad, &envelope)
    }

    /// 检测一个 SSE data 行是否是 EOS 标记。
    pub fn is_eos(plaintext: &[u8]) -> bool {
        plaintext == b"{\"__mse_eos\":true}"
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

    #[test]
    fn eos_detection() {
        assert!(MseClient::is_eos(b"{\"__mse_eos\":true}"));
        assert!(!MseClient::is_eos(b"{\"content\":\"hello\"}"));
    }
}
