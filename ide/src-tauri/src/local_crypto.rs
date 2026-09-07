//! 本地数据落盘加密（conversation at rest）。
//!
//! 对话记录是用户最敏感的数据——消息内容、推理过程、代码上下文全在里面。
//! 这一层保护 SQLite 数据库文件在磁盘上的存储形式。
//!
//! # 密钥管理
//!
//! - 首次运行自动生成 256 位随机密钥，存入 `{app_data_dir}/lck.bin`
//! - 密钥文件只有 32 字节原始二进制（不做 base64，减少暴露面）
//! - macOS 上文件权限设为 0600（仅当前用户可读）
//!
//! # 格式
//!
//! 加密后的字段内容：
//! ```text
//! lc1:<base64url(nonce ‖ ciphertext ‖ tag)>
//! ```
//! - AES-256-GCM，12 字节 nonce，128 位 tag
//! - AAD = 表名（如 `"events"` / `"chunks"` / `"sessions"` / `"state"`）

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use aes_gcm::aead::rand_core::{OsRng, RngCore};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64U;
use base64::Engine;
use std::path::PathBuf;
use std::sync::OnceLock;
use zeroize::Zeroizing;

const PREFIX: &str = "lc1:";
const NONCE_LEN: usize = 12;

static KEY: OnceLock<Zeroizing<[u8; 32]>> = OnceLock::new();

pub fn init(app_data_dir: &std::path::Path) -> Result<(), String> {
    let key_path = app_data_dir.join("lck.bin");
    let key = if key_path.exists() {
        load_key(&key_path)?
    } else {
        generate_and_store_key(&key_path)?
    };
    let _ = KEY.set(key);
    Ok(())
}

pub fn enabled() -> bool {
    KEY.get().is_some()
}

fn get_key() -> Result<&'static Zeroizing<[u8; 32]>, String> {
    KEY.get().ok_or_else(|| "local_crypto: 密钥未初始化".to_string())
}

fn load_key(path: &PathBuf) -> Result<Zeroizing<[u8; 32]>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("local_crypto: 读密钥文件失败: {e}"))?;
    if bytes.len() != 32 {
        return Err(format!(
            "local_crypto: 密钥文件大小是 {} 字节，应为 32",
            bytes.len()
        ));
    }
    let mut arr = Zeroizing::new([0u8; 32]);
    arr.copy_from_slice(&bytes);
    Ok(arr)
}

fn generate_and_store_key(path: &PathBuf) -> Result<Zeroizing<[u8; 32]>, String> {
    let mut key = Zeroizing::new([0u8; 32]);
    OsRng.fill_bytes(&mut *key);

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("local_crypto: 创建密钥目录失败: {e}"))?;
    }
    std::fs::write(path, &*key).map_err(|e| format!("local_crypto: 写密钥文件失败: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(path, perms)
            .map_err(|e| format!("local_crypto: 设置密钥权限失败: {e}"))?;
    }
    Ok(key)
}

/// 加密一个字段值。`table` 用作 AAD 防止跨表搬运。
pub fn seal(plaintext: &str, table: &str) -> Result<String, String> {
    let key = get_key()?;
    let cipher =
        Aes256Gcm::new_from_slice(&**key).map_err(|e| format!("local_crypto: AES 初始化: {e}"))?;

    let mut nonce_bytes = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);

    let ct = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: plaintext.as_bytes(),
                aad: table.as_bytes(),
            },
        )
        .map_err(|e| format!("local_crypto: 加密失败: {e}"))?;

    let mut envelope = Vec::with_capacity(NONCE_LEN + ct.len());
    envelope.extend_from_slice(&nonce_bytes);
    envelope.extend_from_slice(&ct);
    Ok(format!("{PREFIX}{}", B64U.encode(envelope)))
}

/// 解密一个字段值。没有 `lc1:` 前缀的原样返回（兼容未加密的旧数据）。
pub fn open(stored: &str, table: &str) -> Result<String, String> {
    if !stored.starts_with(PREFIX) {
        return Ok(stored.to_string());
    }
    let key = get_key()?;
    let cipher =
        Aes256Gcm::new_from_slice(&**key).map_err(|e| format!("local_crypto: AES 初始化: {e}"))?;

    let raw = B64U
        .decode(&stored[PREFIX.len()..])
        .map_err(|_| "local_crypto: 密文 base64 不合法".to_string())?;
    if raw.len() < NONCE_LEN + 16 {
        return Err("local_crypto: 密文太短".to_string());
    }
    let (nonce, ct) = raw.split_at(NONCE_LEN);
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ct,
                aad: table.as_bytes(),
            },
        )
        .map_err(|_| "local_crypto: 解密失败——密钥不对或数据损坏".to_string())?;
    String::from_utf8(plaintext).map_err(|_| "local_crypto: 解密后不是有效 UTF-8".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set_test_key() {
        let _ = KEY.set(Zeroizing::new([0x77u8; 32]));
    }

    #[test]
    fn roundtrip() {
        set_test_key();
        let plain = r#"{"role":"assistant","content":"Hello world"}"#;
        let sealed = seal(plain, "events").unwrap();
        assert!(sealed.starts_with(PREFIX));
        assert!(!sealed.contains(plain));
        let opened = open(&sealed, "events").unwrap();
        assert_eq!(opened, plain);
    }

    #[test]
    fn plaintext_passthrough() {
        set_test_key();
        let plain = r#"{"role":"user","content":"hi"}"#;
        let result = open(plain, "events").unwrap();
        assert_eq!(result, plain);
    }

    #[test]
    fn wrong_table_fails() {
        set_test_key();
        let sealed = seal("secret", "events").unwrap();
        let result = open(&sealed, "chunks");
        assert!(result.is_err());
    }

    #[test]
    fn random_nonce_produces_different_ciphertext() {
        set_test_key();
        let plain = "same content";
        let a = seal(plain, "events").unwrap();
        let b = seal(plain, "events").unwrap();
        assert_ne!(a, b);
    }
}
