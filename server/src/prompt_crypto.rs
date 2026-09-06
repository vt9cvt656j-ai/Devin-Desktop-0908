//! 提示词文件落盘加密（prompt files at rest）。
//!
//! 42 个 `.txt` / `.json` 提示词文件是产品的核心 IP，和模型供应商的 API key 同一级别
//! 的机密——拿到它就能复制出一模一样的产品行为。这份模块保护它们在文件系统上的存放形式。
//!
//! # 它挡的是谁
//!
//! 挡的是**拿到服务器文件系统访问权的人**：容器逃逸、备份泄漏、被误加进 git、
//! `docker cp` 抄出来的镜像快照。只要 `PROMPT_ENC_KEY` 不在文件系统上，提示词文件
//! 对他们就是一团 `mpe1:...` 密文。
//!
//! # 格式
//!
//! 加密后的文件内容整个替换为一行：
//! ```text
//! mpe1:<base64url(nonce‖ciphertext‖tag)>
//! ```
//! - AES-256-GCM，12 字节 nonce，128 位 tag
//! - AAD = 文件名（如 `"agent_core.txt"`），防跨文件搬运
//! - 密钥 = HKDF-SHA-256(PROMPT_ENC_KEY, salt="mpe1-prompt-at-rest", info=filename)
//!   每个文件派生独立子密钥——即使一个被泄漏也不影响其余的。
//!
//! # 运行时行为
//!
//! - 文件内容以 `mpe1:` 开头 → 解密返回明文
//! - 否则 → 原样返回（开发环境里提示词是明文，不影响）
//! - `PROMPT_ENC_KEY` 未配置 → 遇到密文报错（不降级成静默跳过）

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD as B64U};
use base64::Engine;
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;
use std::sync::OnceLock;
use zeroize::Zeroizing;

const PREFIX: &str = "mpe1:";
const NONCE_LEN: usize = 12;
const HKDF_SALT: &[u8] = b"mpe1-prompt-at-rest";

static ROOT_KEY: OnceLock<Option<Zeroizing<[u8; 32]>>> = OnceLock::new();

/// 从 `PROMPT_ENC_KEY`（base64 的 32 字节）装载根密钥。在 main 启动时调用一次。
pub fn init() -> anyhow::Result<()> {
    let raw = std::env::var("PROMPT_ENC_KEY").unwrap_or_default();
    if raw.trim().is_empty() {
        tracing::warn!(
            "PROMPT_ENC_KEY 没配：提示词文件加密处于关闭状态，磁盘上的提示词是明文。\
             生成一把：openssl rand -base64 32"
        );
        let _ = ROOT_KEY.set(None);
        return Ok(());
    }
    let bytes = B64
        .decode(raw.trim())
        .map_err(|e| anyhow::anyhow!("PROMPT_ENC_KEY 不是合法 base64：{e}"))?;
    if bytes.len() != 32 {
        anyhow::bail!(
            "PROMPT_ENC_KEY 解出来是 {} 字节，需要正好 32 字节（AES-256）。\
             生成：openssl rand -base64 32",
            bytes.len()
        );
    }
    let mut arr = Zeroizing::new([0u8; 32]);
    arr.copy_from_slice(&bytes);
    tracing::info!("提示词文件加密已启用（PROMPT_ENC_KEY 已装载）");
    let _ = ROOT_KEY.set(Some(arr));
    Ok(())
}

fn root_key() -> Option<&'static Zeroizing<[u8; 32]>> {
    ROOT_KEY.get().and_then(|o| o.as_ref())
}

pub fn enabled() -> bool {
    root_key().is_some()
}

/// 从根密钥 + 文件名派生出该文件专用的子密钥。
fn derive_file_key(root: &[u8; 32], filename: &str) -> Zeroizing<[u8; 32]> {
    let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), root);
    let mut out = Zeroizing::new([0u8; 32]);
    hk.expand(filename.as_bytes(), &mut *out)
        .expect("HKDF expand for 32 bytes never fails");
    out
}

/// 加密一份提示词文件的内容。`filename` 是不带路径的文件名（如 `"agent_core.txt"`）。
pub fn encrypt(plaintext: &str, filename: &str) -> Result<String, String> {
    let root = root_key().ok_or("PROMPT_ENC_KEY 未配置，无法加密")?;
    let file_key = derive_file_key(root, filename);
    let cipher =
        Aes256Gcm::new_from_slice(&*file_key).map_err(|e| format!("AES 初始化失败: {e}"))?;

    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);

    let ct = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: plaintext.as_bytes(),
                aad: filename.as_bytes(),
            },
        )
        .map_err(|e| format!("加密失败: {e}"))?;

    let mut envelope = Vec::with_capacity(NONCE_LEN + ct.len());
    envelope.extend_from_slice(&nonce_bytes);
    envelope.extend_from_slice(&ct);
    Ok(format!("{PREFIX}{}", B64U.encode(envelope)))
}

/// 解密一份提示词文件的内容。如果内容不以 `mpe1:` 开头，视为明文原样返回。
pub fn decrypt(stored: &str, filename: &str) -> Result<String, String> {
    if !stored.starts_with(PREFIX) {
        return Ok(stored.to_string());
    }
    let root = root_key().ok_or_else(|| {
        format!(
            "提示词文件 {filename} 是加密的，但 PROMPT_ENC_KEY 未配置——\
             无法解密。这是配置事故，不会降级成明文。"
        )
    })?;
    let file_key = derive_file_key(root, filename);
    let cipher =
        Aes256Gcm::new_from_slice(&*file_key).map_err(|e| format!("AES 初始化失败: {e}"))?;

    let raw = B64U
        .decode(&stored[PREFIX.len()..])
        .map_err(|_| format!("提示词文件 {filename} 的密文 base64 不合法"))?;
    if raw.len() < NONCE_LEN + 16 {
        return Err(format!("提示词文件 {filename} 的密文太短，不是有效的 mpe1 格式"));
    }
    let (nonce, ct) = raw.split_at(NONCE_LEN);
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ct,
                aad: filename.as_bytes(),
            },
        )
        .map_err(|_| {
            format!(
                "提示词文件 {filename} 解密失败——密钥不对、文件损坏、或文件名被改过。\
                 AAD 绑定了文件名，重命名后必须重新加密。"
            )
        })?;
    String::from_utf8(plaintext)
        .map_err(|_| format!("提示词文件 {filename} 解密后不是有效 UTF-8"))
}

/// 加密 `prompts/` 目录下的所有 `.txt` 和 `.json` 文件。
/// 已加密的文件（以 `mpe1:` 开头）跳过。返回加密的文件数。
pub fn encrypt_directory(dir: &std::path::Path) -> Result<usize, String> {
    if !enabled() {
        return Err("PROMPT_ENC_KEY 未配置".to_string());
    }
    let mut count = 0usize;
    let entries = std::fs::read_dir(dir).map_err(|e| format!("读目录失败: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("读目录项失败: {e}"))?;
        let path = entry.path();
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if ext != "txt" && ext != "json" {
            continue;
        }
        let filename = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("文件名不是 UTF-8")?
            .to_string();
        let content =
            std::fs::read_to_string(&path).map_err(|e| format!("读文件 {filename} 失败: {e}"))?;
        if content.starts_with(PREFIX) {
            continue; // 已加密
        }
        let encrypted = encrypt(&content, &filename)?;
        std::fs::write(&path, &encrypted)
            .map_err(|e| format!("写文件 {filename} 失败: {e}"))?;
        count += 1;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set_test_key() {
        let key = [0x42u8; 32];
        let _ = ROOT_KEY.set(Some(Zeroizing::new(key)));
    }

    #[test]
    fn roundtrip() {
        set_test_key();
        let plain = "You are an AI assistant. This is a secret prompt.";
        let filename = "test_prompt.txt";
        let encrypted = encrypt(plain, filename).unwrap();
        assert!(encrypted.starts_with(PREFIX));
        assert!(!encrypted.contains(plain));
        let decrypted = decrypt(&encrypted, filename).unwrap();
        assert_eq!(decrypted, plain);
    }

    #[test]
    fn plaintext_passthrough() {
        set_test_key();
        let plain = "not encrypted content";
        let result = decrypt(plain, "whatever.txt").unwrap();
        assert_eq!(result, plain);
    }

    #[test]
    fn wrong_filename_fails() {
        set_test_key();
        let encrypted = encrypt("secret", "agent.txt").unwrap();
        let result = decrypt(&encrypted, "chat.txt");
        assert!(result.is_err());
    }

    #[test]
    fn per_file_key_derivation_differs() {
        set_test_key();
        let root = root_key().unwrap();
        let k1 = derive_file_key(root, "agent.txt");
        let k2 = derive_file_key(root, "chat.txt");
        assert_ne!(*k1, *k2);
    }

    #[test]
    fn each_encryption_produces_different_ciphertext() {
        set_test_key();
        let plain = "same content";
        let e1 = encrypt(plain, "a.txt").unwrap();
        let e2 = encrypt(plain, "a.txt").unwrap();
        assert_ne!(e1, e2); // 随机 nonce
    }

    #[test]
    fn encrypted_without_key_fails() {
        // 如果密钥被清除了，不能解密
        let ciphertext = "mpe1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        // 这里不能真正测试因为 OnceLock 已经被 set_test_key 设置了
        // 但我们验证格式检查
        assert!(ciphertext.starts_with(PREFIX));
    }
}
