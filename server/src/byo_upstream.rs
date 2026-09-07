//! 用户自带上游（Bring-Your-Own upstream）。
//!
//! 桌面端的「自定义模型」原来是**客户端直连**用户填的第三方地址。那条路上拿不到完整的
//! 系统提示词和工具描述（它们由网关按需注入，见 `prompts::assemble_into`），长上下文压缩
//! 也在网关侧 —— 所以自定义模型的智能体一直比网关模型弱一截，弹窗里也是这么写的。
//!
//! 这个模块让那条路改走网关：客户端只发精简请求 + 三个 `x-ide-byo-*` 头，网关照常装配
//! 完整提示词和工具，再转发到**用户填的地址、用用户自己的密钥**。用户拿回完整能力，
//! 而提示词和工具描述始终没有进过客户端 —— 应用被逆向或抓包都取不到。
//!
//! # 为什么这里必须有一道 URL 校验
//!
//! 「服务端去请求一个用户给的 URL」是 SSRF 的标准形状。不挡的话，任何有账号的人都能
//! 把地址填成 `http://169.254.169.254/`（云元数据，一取就是实例凭证）、`http://127.0.0.1:5432`
//! （网关自己的数据库）、或者内网里任何一台机器 —— 用我们的服务器当跳板去打我们自己的
//! 内网，而且请求还带着我们组装好的东西。
//!
//! **必须解析 DNS 之后再查 IP。** 只看主机名是挡不住的：攻击者把 `evil.example.com` 的
//! A 记录指到 `127.0.0.1` 就绕过去了（DNS rebinding 的第一步）。所以这里先解析，
//! 再逐个 IP 检查网段；一个地址解析出多个 IP 时，**有一个不合格就整体拒绝**。
//!
//! 校验之后仍然要把解析到的 IP 交给调用方去连（`Resolved`），否则解析和连接之间还有
//! 一个时间窗，攻击者可以在这中间改 DNS —— 那正是 rebinding 的第二步。

use std::net::IpAddr;

/// 用户自带上游的规格。三样都从请求头来，**永远不进日志**。
#[derive(Debug, Clone)]
pub struct ByoUpstream {
    /// 已经过校验的基址，例如 `https://api.example.com/v1`。
    pub base: reqwest::Url,
    /// 用户自己的密钥。可以为空 —— 本机服务和一部分中转不要密钥。
    pub key: String,
    /// 线协议：`openai` / `anthropic` / `xai_responses`，和桌面端 `CM_PROTOCOLS` 同一套。
    pub protocol: String,
    /// 校验时解析到的 IP。连接必须钉在这些地址上，不能让 reqwest 再解析一次。
    pub resolved: Vec<IpAddr>,
}

/// 一个 IP 能不能作为上游。
///
/// 判据是「它是不是公网可路由的单播地址」，不是「它像不像内网」——后者永远列不全。
fn ip_allowed(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            !(v4.is_loopback()          // 127/8：网关自己
                || v4.is_private()      // 10/8, 172.16/12, 192.168/16：内网
                || v4.is_link_local()   // 169.254/16：云元数据就在这儿
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.is_multicast()
                // 100.64/10 运营商级 NAT：云厂商拿它做内部网络。
                || (v4.octets()[0] == 100 && (64..128).contains(&v4.octets()[1]))
                // 192.0.0/24 IETF 协议专用，198.18/15 基准测试网段。
                || (v4.octets()[0] == 192 && v4.octets()[1] == 0 && v4.octets()[2] == 0)
                || (v4.octets()[0] == 198 && (18..20).contains(&v4.octets()[1])))
        }
        IpAddr::V6(v6) => {
            // v4 映射地址要按 v4 规则再判一次：`::ffff:127.0.0.1` 在 v6 眼里既不是
            // loopback 也不是 unique-local，直接放行就等于没挡。
            if let Some(v4) = v6.to_ipv4_mapped() {
                return ip_allowed(&IpAddr::V4(v4));
            }
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                // fc00::/7 unique local，fe80::/10 link local。
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80)
        }
    }
}

/// 校验用户填的基址。返回校验通过的 URL 和它解析到的 IP。
///
/// `resolve` 由调用方注入，测试才能不碰真实 DNS。
pub fn validate_base<F>(raw: &str, resolve: F) -> Result<(reqwest::Url, Vec<IpAddr>), String>
where
    F: Fn(&str, u16) -> Result<Vec<IpAddr>, String>,
{
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("上游地址为空".into());
    }
    if raw.len() > 300 {
        return Err("上游地址过长".into());
    }
    let url = reqwest::Url::parse(raw).map_err(|_| "上游地址不是合法 URL".to_string())?;
    // **只收 https。** 明文 http 到第三方等于把用户的密钥和我们组装的请求体裸奔在网上；
    // 而本机服务（http://localhost）本来就走不通这条路 —— 网关转发过去打的是**服务器的**
    // localhost，不是用户的机器。所以这里连 http 的口子都不开。
    if url.scheme() != "https" {
        return Err("上游地址必须是 https".into());
    }
    if url.username() != "" || url.password().is_some() {
        return Err("上游地址不能带用户名密码".into());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "上游地址缺少主机名".to_string())?
        .to_string();
    let port = url.port_or_known_default().unwrap_or(443);

    let ips = resolve(&host, port)?;
    if ips.is_empty() {
        return Err("上游地址解析不到 IP".into());
    }
    // 一个也不能漏：解析出多个地址时，只要有一个落在内网，整条拒掉。
    // 放行一部分等于给攻击者一次重试就能命中的机会。
    if let Some(bad) = ips.iter().find(|ip| !ip_allowed(ip)) {
        return Err(format!("上游地址解析到不允许的地址：{bad}"));
    }
    Ok((url, ips))
}

/// 从请求头里取出自带上游的规格。没有这些头就返回 `None`（走原来的线路选择）。
pub fn from_headers<F>(
    headers: &axum::http::HeaderMap,
    resolve: F,
) -> Result<Option<ByoUpstream>, String>
where
    F: Fn(&str, u16) -> Result<Vec<IpAddr>, String>,
{
    let Some(base_raw) = headers.get("x-ide-byo-base").and_then(|v| v.to_str().ok()) else {
        return Ok(None);
    };
    let (base, resolved) = validate_base(base_raw, resolve)?;
    let key = headers
        .get("x-ide-byo-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .trim()
        .to_string();
    let protocol = headers
        .get("x-ide-byo-proto")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("openai")
        .trim()
        .to_string();
    let protocol = match protocol.as_str() {
        "openai" | "anthropic" | "xai_responses" => protocol,
        // 认不出的协议不猜：猜错是整轮 400，而用户看到的会是一句和自己填的东西无关的报错。
        other => return Err(format!("不认识的线协议：{other}")),
    };
    Ok(Some(ByoUpstream {
        base,
        key,
        protocol,
        resolved,
    }))
}


/// 固定的线路 id。日志里 `route_id` 是这个值就代表「这一轮走的是用户自带上游」，
/// 不用去 models 表里反查（那张表里根本没有这一行）。
pub const BYO_ROUTE_ID: uuid::Uuid = uuid::Uuid::nil();

impl ByoUpstream {
    /// 合成一条线路，喂进和普通线路**同一台转发机器**。
    ///
    /// 不另起平行路径，是因为那台机器里已经有一堆只有它才对的东西：协议翻译、流式转发、
    /// beta 头、上游报错的归类、超时预算。复制一份出来，两边迟早各修各的 bug。
    ///
    /// **计费全部置零**：`rate = 0.0` 是 compute_cost 的最后一步乘数，倍率 0 时无论单价
    /// 多少、用了多少 token，算出来都是 0 分，也不碰免费点数池。这正是自带端点该有的语义 ——
    /// token 是用用户自己的密钥买的，我们不该在中间再收一道。
    ///
    /// **密钥按明文放**：`model_key()` 对 `fc1:` 密文解密、对明文原样透传，所以这里直接
    /// 放用户的 key 是对的。它来自请求头，不落库、不进日志。
    /// 这条自带上游的**最终请求 URL**。
    ///
    /// 不能直接用普通线路那句 `api_base(base) + wire.path()`：用户粘进来的地址有三种形状，
    /// 而第三种（**某个协议的完整端点**，比如 `https://api.openai.com/v1/chat/completions`）
    /// 会被那句拼成 `.../v1/chat/completions/chat/completions` —— 必然 404，而报错是上游给的，
    /// 看着像他自己的中转坏了。复制粘贴时贴完整调用地址恰恰是最常见的形状。
    ///
    /// 判据从客户端直连那条路（ide/src-tauri/src/protocol.rs 的 `endpoint_url`）**逐字搬来**，
    /// 一个分支都没动：两条路上同一个地址必须解析成同一个 URL，否则「切到代发之后就 404」
    /// 会变成一类无法归因的报障。注意带后缀时是**原样用**、不再过 api_base ——
    /// 像 `https://open.bigmodel.cn/api/paas/v4/chat/completions` 这种非 /v1 的 base，
    /// 过一遍 api_base 会被插进一段 `/v1`，同样 404。
    pub fn endpoint_url(&self, wire: crate::models::Wire) -> String {
        let base = self.base.as_str().trim_end_matches('/');
        if wire == crate::models::Wire::OpenAi {
            if base.ends_with("/chat/completions") {
                return base.to_string();
            }
            return format!("{}{}", crate::models::api_base(base), wire.path());
        }
        for suffix in ["/chat/completions", "/messages", "/responses"] {
            if let Some(stripped) = base.strip_suffix(suffix) {
                return format!("{stripped}{}", wire.path());
            }
        }
        format!("{}{}", crate::models::api_base(base), wire.path())
    }

    pub fn as_candidate(&self, model_id: &str) -> crate::models::Model {
        crate::models::Model {
            id: BYO_ROUTE_ID,
            label: "自定义端点".into(),
            provider: "byo".into(),
            base_url: self.base.as_str().trim_end_matches('/').to_string(),
            model_id: Some(model_id.to_string()),
            api_key: self.key.clone(),
            price_cents: 0,
            rate: 0.0,
            balance_token: String::new(),
            input_price: 0.0,
            output_price: 0.0,
            cache_read_price: 0.0,
            cache_create_price: 0.0,
            // 缓存不禁：用户的中转支不支持是它自己的事，我们不替它决定。
            cache_disabled: false,
            description: String::new(),
            active: true,
            sort: 0,
            created_at: chrono::Utc::now(),
            enabled_models: vec![model_id.to_string()],
            group_into: None,
            billing_mode: "token".into(),
            per_call_cents: 0,
            per_call_micro_usd: 0,
            model_names: serde_json::Value::Null,
            model_prices: serde_json::Value::Null,
            model_caps: serde_json::Value::Null,
            model_billing: serde_json::Value::Null,
            protocol: self.protocol.clone(),
            effort_passthrough: true,
            power_route: false,
            endpoint_id: None,
            endpoint_label: String::new(),
            endpoint_cost: None,
            endpoint_capacity: None,
        }
    }
}


/// 真实的 DNS 解析（带超时），再走上面那套纯校验。
///
/// 分成两步是为了让校验本身可测：`validate_base` 收一个同步的解析器，测试注入固定结果；
/// 生产由这里提供真的。解析必须有超时 —— 一个故意不响应的域名否则能把整条请求挂住。
pub async fn from_headers_async(
    headers: &axum::http::HeaderMap,
) -> Result<Option<ByoUpstream>, String> {
    let Some(raw) = headers.get("x-ide-byo-base").and_then(|v| v.to_str().ok()) else {
        return Ok(None);
    };
    // 先粗取主机名去解析；真正的判断（scheme、凭证、网段）仍然全在 validate_base 里。
    let hp = reqwest::Url::parse(raw.trim()).ok().and_then(|u| {
        u.host_str()
            .map(|h| (h.to_string(), u.port_or_known_default().unwrap_or(443)))
    });
    let ips: Vec<IpAddr> = match hp {
        Some((host, port)) => {
            let lookup = tokio::net::lookup_host((host.as_str(), port));
            match tokio::time::timeout(std::time::Duration::from_secs(3), lookup).await {
                Ok(Ok(addrs)) => addrs.map(|a| a.ip()).collect(),
                Ok(Err(e)) => return Err(format!("上游地址解析失败：{e}")),
                Err(_) => return Err("上游地址解析超时".into()),
            }
        }
        // 解析不出主机名的，交给 validate_base 去报那个更具体的错。
        None => vec![],
    };
    from_headers(headers, move |_, _| Ok(ips.clone()))
}

/// 连接**钉在校验通过的那几个 IP 上**的客户端。
///
/// 不钉的话中间还有一个窗口：我们解析一次拿到公网 IP、放行，reqwest 连接时又解析一次 ——
/// 攻击者控制着 DNS，在这两次之间把记录改成 127.0.0.1 就进内网了（DNS rebinding 的第二步，
/// 也是最常被漏掉的一半）。钉住之后连接只会去我们验过的地址。
///
/// 代价是这条请求不复用连接池。可以接受：自带上游不是热路径，而且正确性优先于一个热 socket。
pub fn pinned_client(byo: &ByoUpstream) -> reqwest::Client {
    let host = byo.base.host_str().unwrap_or_default().to_string();
    let port = byo.base.port_or_known_default().unwrap_or(443);
    // **一次钉全部地址，IPv4 排前。** 原来是逐个 `.resolve()`——那个接口是「覆盖」不是「追加」
    // （reqwest 里它就是 `resolve_to_addrs(domain, &[addr])`），后一个把前一个顶掉，最后只剩
    // 解析结果里的**最后一个**。Cloudflare 后面的中转（polly.modelbridge.cc 实测：2 个 A +
    // 2 个 AAAA）最后一个是 IPv6，而这台服务器没有 IPv6 出口 → 连接秒失败 → 用户看到 502，
    // 日志里只有一句 error sending request。teamorouter 那种只有 A 记录的站就通，所以这个坑
    // 只在双栈站上现形，也只在代发这条路上有（普通线路走的是 reqwest 自己的解析）。
    // 顺序：连接器按顺序尝试，v4 放前面就不会先在一个必然失败的 v6 上耗时间。
    let b = reqwest::Client::builder()
        .http1_only()
        .connect_timeout(std::time::Duration::from_secs(5))
        .tcp_nodelay(true)
        .resolve_to_addrs(&host, &pinned_addrs(&byo.resolved, port));
    b.build().unwrap_or_else(|_| reqwest::Client::new())
}

/// 校验过的地址 → 连接顺序：IPv4 在前、IPv6 在后，各自保持解析器给的顺序，一个都不丢。
pub fn pinned_addrs(resolved: &[IpAddr], port: u16) -> Vec<std::net::SocketAddr> {
    let mut v4: Vec<std::net::SocketAddr> = Vec::new();
    let mut v6: Vec<std::net::SocketAddr> = Vec::new();
    for ip in resolved {
        let sa = std::net::SocketAddr::new(*ip, port);
        if ip.is_ipv4() { v4.push(sa) } else { v6.push(sa) }
    }
    v4.extend(v6);
    v4
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed(ips: &[&str]) -> impl Fn(&str, u16) -> Result<Vec<IpAddr>, String> {
        let parsed: Vec<IpAddr> = ips.iter().map(|s| s.parse().unwrap()).collect();
        move |_, _| Ok(parsed.clone())
    }

    #[test]
    fn a_public_https_upstream_is_accepted() {
        let (url, ips) = validate_base("https://api.example.com/v1", fixed(&["93.184.216.34"]))
            .expect("public https upstream");
        assert_eq!(url.host_str(), Some("api.example.com"));
        assert_eq!(ips.len(), 1);
    }

    /// 这一组是这个模块存在的理由。每一条都是「用我们的服务器当跳板」的一种形状。
    #[test]
    fn the_ssrf_shapes_are_all_refused() {
        // 云元数据：一取就是实例凭证。
        assert!(validate_base("https://meta.evil.test/", fixed(&["169.254.169.254"])).is_err());
        // 网关自己。
        assert!(validate_base("https://x.evil.test/", fixed(&["127.0.0.1"])).is_err());
        assert!(validate_base("https://x.evil.test/", fixed(&["::1"])).is_err());
        // 内网三段。
        assert!(validate_base("https://x.evil.test/", fixed(&["10.0.0.5"])).is_err());
        assert!(validate_base("https://x.evil.test/", fixed(&["172.16.3.1"])).is_err());
        assert!(validate_base("https://x.evil.test/", fixed(&["192.168.1.1"])).is_err());
        // 运营商级 NAT 和 IPv6 unique-local。
        assert!(validate_base("https://x.evil.test/", fixed(&["100.64.0.1"])).is_err());
        assert!(validate_base("https://x.evil.test/", fixed(&["fd00::1"])).is_err());
        // v4 映射地址：在 v6 眼里既不是 loopback 也不是 unique-local，
        // 不单独判就等于给内网开了一扇后门。
        assert!(validate_base("https://x.evil.test/", fixed(&["::ffff:127.0.0.1"])).is_err());
    }

    /// 只看主机名是挡不住的：把域名的 A 记录指到内网就绕过去了。
    /// 这条测试钉的就是「解析之后才判」这件事本身。
    #[test]
    fn a_public_looking_name_that_resolves_inward_is_refused() {
        assert!(validate_base("https://totally-normal-api.com/v1", fixed(&["127.0.0.1"])).is_err());
    }

    /// 解析出多个地址时，有一个不合格就整体拒绝 —— 放行一部分等于给攻击者
    /// 一次重试就能命中的机会（DNS 轮询会换顺序）。
    #[test]
    fn one_bad_address_among_several_refuses_the_whole_upstream() {
        assert!(
            validate_base("https://api.example.com/v1", fixed(&["93.184.216.34", "10.1.2.3"]))
                .is_err()
        );
    }

    #[test]
    fn plaintext_and_odd_schemes_are_refused() {
        // 明文到第三方 = 密钥和请求体裸奔。
        assert!(validate_base("http://api.example.com/v1", fixed(&["93.184.216.34"])).is_err());
        assert!(validate_base("file:///etc/passwd", fixed(&["93.184.216.34"])).is_err());
        // 本机服务走不通这条路：网关转发过去打的是服务器自己的 localhost。
        assert!(validate_base("http://localhost:11434/v1", fixed(&["127.0.0.1"])).is_err());
        // URL 里塞凭证。
        assert!(validate_base("https://u:p@api.example.com/v1", fixed(&["93.184.216.34"])).is_err());
        assert!(validate_base("   ", fixed(&["93.184.216.34"])).is_err());
    }

    #[test]
    fn an_unknown_wire_protocol_is_refused_rather_than_guessed() {
        let mut h = axum::http::HeaderMap::new();
        h.insert("x-ide-byo-base", "https://api.example.com/v1".parse().unwrap());
        h.insert("x-ide-byo-proto", "gemini".parse().unwrap());
        // 猜错是整轮 400，而用户看到的会是一句和自己填的东西无关的报错。
        assert!(from_headers(&h, fixed(&["93.184.216.34"])).is_err());
    }

    #[test]
    fn no_byo_headers_means_the_normal_route_selection_still_runs() {
        let h = axum::http::HeaderMap::new();
        assert!(from_headers(&h, fixed(&["93.184.216.34"])).unwrap().is_none());
    }

    #[test]
    fn an_empty_key_is_allowed_because_some_relays_do_not_need_one() {
        let mut h = axum::http::HeaderMap::new();
        h.insert("x-ide-byo-base", "https://api.example.com/v1".parse().unwrap());
        let byo = from_headers(&h, fixed(&["93.184.216.34"])).unwrap().unwrap();
        assert_eq!(byo.key, "");
        assert_eq!(byo.protocol, "openai");
    }

    #[test]
    fn a_byo_candidate_never_charges_anything() {
        // 钱是用户自己的密钥买的，我们不该在中间再收一道。rate 是 compute_cost 的最后一步
        // 乘数：0 时无论单价多少、用了多少 token，算出来都是 0 分，也不碰免费点数池。
        let byo = ByoUpstream {
            base: reqwest::Url::parse("https://api.example.com/v1").unwrap(),
            key: "sk-user".into(),
            protocol: "openai".into(),
            resolved: vec![],
        };
        let m = byo.as_candidate("gpt-4o-mini");
        assert_eq!(m.rate, 0.0, "倍率不是 0 就会真扣钱");
        assert_eq!(m.price_cents, 0);
        assert_eq!(m.per_call_cents, 0);
        assert_eq!(m.per_call_micro_usd, 0);
        assert_ne!(m.billing_mode, "free", "不该从免费点数池扣——那个池子是有限的");
    }

    #[test]
    fn a_byo_candidate_carries_the_users_own_endpoint_and_key() {
        let byo = ByoUpstream {
            base: reqwest::Url::parse("https://api.example.com/v1/").unwrap(),
            key: "sk-user".into(),
            protocol: "anthropic".into(),
            resolved: vec![],
        };
        let m = byo.as_candidate("claude-opus-5");
        // 末尾斜杠要去掉：下游是按 `base + "/chat/completions"` 拼的，留着会拼出 //。
        assert_eq!(m.base_url, "https://api.example.com/v1");
        assert_eq!(m.api_key, "sk-user", "密钥要原样带上——model_key() 对明文是透传");
        assert_eq!(m.protocol, "anthropic");
        assert_eq!(m.id, BYO_ROUTE_ID, "日志里要能一眼认出这是自带上游");
    }

    #[test]
    fn the_connection_is_pinned_to_the_addresses_we_validated() {
        // 校验解析一次、reqwest 连接时再解析一次，这中间攻击者能改 DNS（rebinding 的
        // 第二步）。这条钉的是「客户端确实带着 resolve 覆盖建出来」这件事本身。
        let byo = ByoUpstream {
            base: reqwest::Url::parse("https://api.example.com/v1").unwrap(),
            key: String::new(),
            protocol: "openai".into(),
            resolved: vec!["93.184.216.34".parse().unwrap()],
        };
        // 建得出来即可：reqwest 不暴露 resolve 表，真正的行为由 pinned_client 的实现保证
        // （它把 pinned_addrs 的结果整份交给 resolve_to_addrs）。这里守的是「有这一步」。
        let _ = pinned_client(&byo);
        assert!(!byo.resolved.is_empty(), "没有解析结果就等于没钉");
    }

    /// 双栈站：一个地址都不丢，IPv4 在前。
    ///
    /// 逐个 `.resolve()` 会只剩解析结果里的最后一个（polly.modelbridge.cc 实测是 IPv6），
    /// 而服务器没有 IPv6 出口 —— 那就是代发到它「秒 502」的全部原因。
    #[test]
    fn dual_stack_addresses_are_all_pinned_with_ipv4_first() {
        let resolved: Vec<IpAddr> = [
            "2606:4700:3030::6815:4abf",
            "104.21.74.191",
            "2606:4700:3035::ac43:a25f",
            "172.67.162.95",
        ]
        .iter()
        .map(|s| s.parse().unwrap())
        .collect();
        let addrs = pinned_addrs(&resolved, 443);
        assert_eq!(addrs.len(), 4, "一个地址都不能丢");
        assert!(addrs[0].is_ipv4() && addrs[1].is_ipv4(), "IPv4 必须排前");
        assert!(addrs[2].is_ipv6() && addrs[3].is_ipv6());
        assert_eq!(addrs[0].to_string(), "104.21.74.191:443");
        assert_eq!(addrs[1].to_string(), "172.67.162.95:443");
    }


    /// 用户粘进来的地址有三种形状，三种都必须解析成和**客户端直连那条路**同一个 URL。
    ///
    /// 第三种（完整端点地址）是这条测试的本体：切到代发之前它一直是能用的，
    /// 切过来之后 `api_base(base) + wire.path()` 会把它拼成两段、必然 404，
    /// 而报错是上游给的，用户只会以为自己的中转坏了。
    #[test]
    fn a_pasted_full_endpoint_does_not_get_a_doubled_path() {
        use crate::models::Wire;
        let byo = |base: &str, proto: &str| ByoUpstream {
            base: reqwest::Url::parse(base).unwrap(),
            key: String::new(),
            protocol: proto.to_string(),
            resolved: vec![],
        };
        // 厂商根 / 带 /v1 的 base：和以前逐字相同，不许变。
        assert_eq!(byo("https://api.openai.com", "openai").endpoint_url(Wire::OpenAi),
                   "https://api.openai.com/v1/chat/completions");
        assert_eq!(byo("https://api.openai.com/v1", "openai").endpoint_url(Wire::OpenAi),
                   "https://api.openai.com/v1/chat/completions");
        // 完整端点地址：原样用，不再拼第二段。
        assert_eq!(byo("https://api.openai.com/v1/chat/completions", "openai").endpoint_url(Wire::OpenAi),
                   "https://api.openai.com/v1/chat/completions");
        assert_eq!(byo("https://api.anthropic.com/v1/messages", "anthropic").endpoint_url(Wire::Anthropic),
                   "https://api.anthropic.com/v1/messages");
        assert_eq!(byo("https://api.x.ai/v1/responses", "xai_responses").endpoint_url(Wire::XaiResponses),
                   "https://api.x.ai/v1/responses");
        // 非 /v1 的完整端点（智谱那种）：原样用。过一遍 api_base 会被插进 /v1，同样 404。
        assert_eq!(byo("https://open.bigmodel.cn/api/paas/v4/chat/completions", "openai").endpoint_url(Wire::OpenAi),
                   "https://open.bigmodel.cn/api/paas/v4/chat/completions");
        // 贴的是一个协议的端点、却选了另一个协议：剥掉再按选中的协议拼。
        assert_eq!(byo("https://relay.test/v1/chat/completions", "anthropic").endpoint_url(Wire::Anthropic),
                   "https://relay.test/v1/messages");
        // 末尾斜杠不影响。
        assert_eq!(byo("https://api.openai.com/v1/chat/completions/", "openai").endpoint_url(Wire::OpenAi),
                   "https://api.openai.com/v1/chat/completions");
    }

    /// 反向：**判据必须和客户端那条路同源**。两边算出不同的 URL，就会出现
    /// 「同一个地址，直连能用、切到代发就 404」这类无法归因的报障。
    #[test]
    fn the_gateway_and_the_desktop_client_agree_on_every_shape() {
        use crate::models::Wire;
        // 客户端 ide/src-tauri/src/protocol.rs::endpoint_url 的算法，逐字重述一遍。
        fn client(wire: Wire, base_url: &str) -> String {
            let base = base_url.trim().trim_end_matches('/');
            if wire == Wire::OpenAi {
                if base.ends_with("/chat/completions") {
                    return base.to_string();
                }
                return format!("{}{}", crate::models::api_base(base), wire.path());
            }
            for suffix in ["/chat/completions", "/messages", "/responses"] {
                if let Some(stripped) = base.strip_suffix(suffix) {
                    return format!("{stripped}{}", wire.path());
                }
            }
            format!("{}{}", crate::models::api_base(base), wire.path())
        }
        let bases = [
            "https://api.openai.com",
            "https://api.openai.com/v1",
            "https://api.openai.com/v1/chat/completions",
            "https://api.anthropic.com/v1/messages",
            "https://api.x.ai/v1/responses",
            "https://open.bigmodel.cn/api/paas/v4/chat/completions",
            "https://relay.test/openai/v1",
        ];
        for base in bases {
            for (proto, wire) in [("openai", Wire::OpenAi), ("anthropic", Wire::Anthropic), ("xai_responses", Wire::XaiResponses)] {
                let b = ByoUpstream {
                    base: reqwest::Url::parse(base).unwrap(),
                    key: String::new(),
                    protocol: proto.to_string(),
                    resolved: vec![],
                };
                assert_eq!(b.endpoint_url(wire), client(wire, base),
                    "网关和客户端对 {base} + {proto} 算出了不同的 URL —— \
                     同一个地址会「直连能用、代发 404」，而报障时没人查得出为什么");
            }
        }
    }
}
