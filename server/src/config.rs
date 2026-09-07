use anyhow::Context;

/// All runtime configuration comes from the environment (a `.env` file in dev,
/// real env vars / Docker secrets in prod). Nothing is hardcoded.
#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub redis_url: String,
    pub jwt_secret: String,
    pub bind_addr: String,
    pub db_max_connections: u32,
    /// michael-compression 总开关，**默认关闭**。
    ///
    /// 关着的时候：不做任何压缩，`/api/me` 也把 michael_compression 报成 null。
    /// 两件事必须由同一个开关控制 —— 客户端一旦从 /api/me 看到档位，就会**关掉
    /// 自己的本地压缩**（认为网关接管了）。只报档位却不真压，等于两边都不压，
    /// 长对话直接撞穿模型原生窗口。
    pub compression_enabled: bool,
    pub code_ttl_secs: u64,
    pub jwt_ttl_secs: i64,
    pub smtp_user: String,
    pub smtp_pass: String,
    pub smtp_host: String,
    pub brevo_api_key: String,
    pub mail_from: String,
    pub mail_from_name: String,
    /// Where this service answers from the public internet. Used to build links that are
    /// followed from outside it — an unsubscribe link in an email being the first — which
    /// cannot be relative and cannot point at a container's own hostname.
    pub public_base: String,
    // Speech-to-text (voice input) upstream — OpenAI-compatible /audio/transcriptions.
    // Defaults to Groq's free Whisper-large-v3. Key from GROQ_API_KEY (or TRANSCRIBE_API_KEY).
    pub transcribe_api_key: String,
    pub transcribe_url: String,
    pub transcribe_model: String,
    pub ide_update_manifest_url: String,
    pub ide_update_public_base: String,
    pub ide_release_github_token: String,
    pub ide_release_github_repo: String,
    pub ide_release_github_workflow: String,

    /// OAuth apps for linking code hosts. Registered by the operator under their own
    /// GitHub / GitLab account, because the app belongs to that identity and the secret
    /// is theirs. Empty only removes the one-click OAuth button — linking by personal
    /// access token needs nothing registered and is always available, so the card never
    /// ends up with a dead button.
    pub github_client_id: String,
    pub github_client_secret: String,
    pub gitlab_client_id: String,
    pub gitlab_client_secret: String,

    /// OAuth apps for *signing in*, which are deliberately not the ones above.
    ///
    /// Two reasons they cannot be shared. A GitHub OAuth app has one registered callback
    /// URL, and these flows land on different paths. More importantly the linking app asks
    /// for `repo` — full read/write to every private repository — because that is what
    /// browsing your own repositories needs. Reusing it here would put that consent screen
    /// in front of someone who only wants to log in, which is both alarming and far more
    /// access than signing in requires.
    ///
    /// Empty means the provider button stays off. There are no defaults: the app belongs
    /// to the operator's identity and the secret is theirs.
    pub github_login_client_id: String,
    pub github_login_client_secret: String,
    pub google_client_id: String,
    pub google_client_secret: String,

    /// MSE-1 应用层加密。协议见 docs/MSE.md，实现见 mse.rs。
    ///
    /// `mse_mode` 默认 `optional`（收密文也收明文），而且**必须**是这个默认值：
    /// 已经装在用户机器上的桌面端没法自动更新，一上来就 `required` 等于把它们全部
    /// 锁在外面。灰度顺序写在 docs/MSE.md §11。
    pub mse_mode: String,
    /// base64 的 P-384 PKCS#8 私钥。留空则每次启动现生成一把 —— 能跑，但密钥固定
    /// 失效（那是挡住主动中间人的那一步），且重启就换。
    pub mse_server_key: String,
    /// 轮换宽限期里仍然接受的上一把密钥。
    pub mse_server_key_prev: String,
    pub mse_session_ttl_secs: u64,
    /// 前向保密：服务器临时密钥的轮换周期（秒）。默认 600（10 分钟）。越短，一旦服务器
    /// 内存被读，能倒推的历史流量窗口越小；但太短会让 pubkey 回源更频繁。静态密钥被偷
    /// 不受影响——它只签名不做 ECDH。见 mse.rs 的 Ephemeral。
    pub mse_ephemeral_ttl_secs: u64,
    pub mse_max_skew_ms: i64,
    pub mse_max_sealed_bytes: usize,
    /// Redis 答不上来时是否放行重放检查。默认否 —— 放行等于在 Redis 抖动的那几秒里
    /// 给「兑换码」和「提现」开一个重放窗口。
    pub mse_replay_fail_open: bool,
    /// 把加密响应的外层状态码一律写成 200，真实状态码只留在密文里。默认关：开了之后
    /// 按状态码统计错误率的监控会全瞎，这个取舍要由部署方自己做。
    pub mse_mask_status: bool,
}

/// 显式写 1/true/yes/on 才算开。其余一律关（fail-closed）。
fn flag(key: &str, default: &str) -> bool {
    matches!(
        opt(key, default).trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

/// JWT 密钥是整套鉴权的根：拿到它就能签一张 `role: "admin"` 的令牌，而 Claims 提取器
/// 只会去数据库确认这个用户还在、role 是什么 —— 签名一旦能伪造，后面所有检查都白搭。
///
/// `.env.example` 里带着一个占位串，只要有一次部署忘了替换，这台机器就是敞开的。
/// 与其在运行时无声地敞着，不如让进程根本起不来。
fn jwt_secret() -> anyhow::Result<String> {
    const PLACEHOLDERS: [&str; 4] = [
        "change-me",
        "changeme",
        "your-secret-here",
        "replace-with-a-long-random-string",
    ];
    let v = req("JWT_SECRET")?;
    let t = v.trim();
    if t.len() < 32 {
        anyhow::bail!(
            "JWT_SECRET 太短（{} 字节）。它能签发管理员令牌，至少要 32 字节的随机串。\n\
             生成一个：openssl rand -hex 32",
            t.len()
        );
    }
    let lower = t.to_ascii_lowercase();
    if PLACEHOLDERS.iter().any(|p| lower.contains(p)) {
        anyhow::bail!(
            "JWT_SECRET 还是 .env.example 里的占位值。任何人都能用它伪造管理员令牌。\n\
             换成一个真随机串：openssl rand -hex 32"
        );
    }
    Ok(v)
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        Ok(Self {
            database_url: req("DATABASE_URL")?,
            redis_url: opt("REDIS_URL", "redis://127.0.0.1:6379"),
            jwt_secret: jwt_secret()?,
            bind_addr: opt("BIND_ADDR", "0.0.0.0:8080"),
            db_max_connections: opt("DB_MAX_CONNECTIONS", "50").parse().unwrap_or(50),
            // 显式写 1/true 才开。缺省缺失都按关处理（fail-closed）。
            compression_enabled: matches!(
                opt("MICHAEL_COMPRESSION_ENABLED", "0").trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            ),
            code_ttl_secs: opt("CODE_TTL_SECS", "600").parse().unwrap_or(600),
            jwt_ttl_secs: opt("JWT_TTL_SECS", "2592000").parse().unwrap_or(2_592_000), // 30d
            smtp_user: std::env::var("QQ_SMTP_USER").unwrap_or_default(),
            smtp_pass: std::env::var("QQ_SMTP_PASS").unwrap_or_default(),
            smtp_host: opt("SMTP_HOST", "smtp.qq.com"),
            brevo_api_key: std::env::var("BREVO_API_KEY").unwrap_or_default(),
            mail_from: std::env::var("MAIL_FROM")
                .unwrap_or_else(|_| std::env::var("QQ_SMTP_USER").unwrap_or_default()),
            mail_from_name: opt("MAIL_FROM_NAME", "Michael"),
            public_base: opt("PUBLIC_BASE", "https://code.mrday.one"),
            transcribe_api_key: std::env::var("GROQ_API_KEY")
                .or_else(|_| std::env::var("TRANSCRIBE_API_KEY"))
                .unwrap_or_default(),
            transcribe_url: opt(
                "TRANSCRIBE_URL",
                "https://api.groq.com/openai/v1/audio/transcriptions",
            ),
            transcribe_model: opt("TRANSCRIBE_MODEL", "whisper-large-v3"),
            ide_update_manifest_url: opt(
                "IDE_UPDATE_MANIFEST_URL",
                "https://github.com/fendoushaonian/Devin-Desktop/releases/latest/download/latest.json",
            ),
            // 私有仓库的安装包由网关代下载；清单里的下载地址重写到这个公网基址。
            ide_update_public_base: opt("IDE_UPDATE_PUBLIC_BASE", "https://code.mrday.one"),
            ide_release_github_token: std::env::var("IDE_RELEASE_GITHUB_TOKEN")
                .unwrap_or_default(),
            ide_release_github_repo: opt(
                "IDE_RELEASE_GITHUB_REPO",
                "fendoushaonian/Devin-Desktop",
            ),
            ide_release_github_workflow: opt(
                "IDE_RELEASE_GITHUB_WORKFLOW",
                "ide-package.yml",
            ),
            // No defaults on purpose: a placeholder client id would produce a working
            // button that lands the person on a provider error page.
            github_client_id: std::env::var("GITHUB_CLIENT_ID").unwrap_or_default(),
            github_client_secret: std::env::var("GITHUB_CLIENT_SECRET").unwrap_or_default(),
            gitlab_client_id: std::env::var("GITLAB_CLIENT_ID").unwrap_or_default(),
            gitlab_client_secret: std::env::var("GITLAB_CLIENT_SECRET").unwrap_or_default(),
            github_login_client_id: std::env::var("GITHUB_LOGIN_CLIENT_ID").unwrap_or_default(),
            github_login_client_secret: std::env::var("GITHUB_LOGIN_CLIENT_SECRET")
                .unwrap_or_default(),
            google_client_id: std::env::var("GOOGLE_CLIENT_ID").unwrap_or_default(),
            google_client_secret: std::env::var("GOOGLE_CLIENT_SECRET").unwrap_or_default(),

            mse_mode: opt("MSE_MODE", "optional"),
            mse_server_key: std::env::var("MSE_SERVER_KEY").unwrap_or_default(),
            mse_server_key_prev: std::env::var("MSE_SERVER_KEY_PREV").unwrap_or_default(),
            mse_session_ttl_secs: opt("MSE_SESSION_TTL_SECS", "1800").parse().unwrap_or(1800),
            mse_ephemeral_ttl_secs: opt("MSE_EPHEMERAL_TTL_SECS", "600").parse().unwrap_or(600),
            mse_max_skew_ms: opt("MSE_MAX_SKEW_MS", "120000").parse().unwrap_or(120_000),
            // 64 MiB。这个数是从 /api/deploy 倒推的，不是随手取的整数：
            //
            // 非 JSON 的 body（deploy 传的是原始归档）在信封里要 base64，35 MiB 会涨到
            // 约 46.7 MiB。上限设成 36 MiB 的话，超过 27 MiB 的部署包就会被加密层挡下来
            // —— 而且报错出现在一个和「包太大」毫无关系的地方。64 MiB 留足余量，同时仍然
            // 低于 nginx 的 client_max_body_size 55m（真正的外层闸门在那里）。
            //
            // JSON body 不受影响：它以对象形态放进信封的 `b` 字段，不过 base64。
            mse_max_sealed_bytes: opt("MSE_MAX_SEALED_BYTES", "67108864")
                .parse()
                .unwrap_or(67_108_864),
            mse_replay_fail_open: flag("MSE_REPLAY_FAIL_OPEN", "0"),
            mse_mask_status: flag("MSE_MASK_STATUS", "0"),
        })
    }

    pub fn smtp_enabled(&self) -> bool {
        !self.smtp_user.is_empty() && !self.smtp_pass.is_empty()
    }

    /// Whether outbound mail can actually be sent (via the Brevo HTTP API over 443).
    pub fn mail_enabled(&self) -> bool {
        !self.brevo_api_key.is_empty() && !self.mail_from.is_empty()
    }
}

fn req(key: &str) -> anyhow::Result<String> {
    std::env::var(key).with_context(|| format!("missing required env var {key}"))
}

fn opt(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}
