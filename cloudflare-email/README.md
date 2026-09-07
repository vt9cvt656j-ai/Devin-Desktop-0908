# Mrday Cloudflare Email 配置

为域名 `mrday.one` 部署的邮件收发系统,全 Cloudflare 平台,**0 费用**。

## 🎯 你已经搞定的部分

- ✅ 域名 `mrday.one` 接入 Cloudflare
- ✅ Email Routing 已启用 + 4 条规则活跃
- ✅ Email Sending 已启用,**每日 1000 封免费额度**
- ✅ catch-all 已转发到 `1993509601@qq.com`

**收件已经能用了**,无需额外配置。客户发到 `support@mrday.one` 的邮件会自动转到你的 QQ 邮箱。

---

## 📁 项目结构(只用来做发件)

```
cloudflare-email/
├── email-sender/                # 发件 Worker(验证码/通知/售后)
│   ├── src/
│   │   ├── index.ts             # 主入口(4 个 API)
│   │   └── templates.ts         # 邮件模板
│   ├── wrangler.jsonc
│   ├── package.json
│   └── tsconfig.json
└── README.md
```

## 🚀 部署发件 Worker(3 条命令)

```powershell
# 1. 进入项目并安装依赖
cd d:\Software\Devin-Desktop\cloudflare-email\email-sender
npm install

# 2. 创建 KV 命名空间
npx wrangler kv namespace create VERIFICATION_CODES
npx wrangler kv namespace create RATE_LIMIT
# 把输出的 id 填到 wrangler.jsonc 的 kv_namespaces 里

# 3. 设置 API Key(自己设个密码,前端调用要带)
npx wrangler secret put API_KEY

# 4. 部署
npx wrangler deploy
```

部署成功后会输出 URL,例如:
```
https://mrday-email-sender.<你的子域>.workers.dev
```

## 🧪 测试

**发验证码:**
```powershell
$headers = @{
  "Authorization" = "Bearer 你的API_KEY"
  "Content-Type" = "application/json"
}
$body = @{ email = "1993509601@qq.com" } | ConvertTo-Json

Invoke-RestMethod -Method Post `
  -Uri "https://mrday-email-sender.<你的子域>.workers.dev/api/send-code" `
  -Headers $headers `
  -Body $body
```

**发系统通知:**
```powershell
$body = @{
  to      = "1993509601@qq.com"
  title   = "订单已发货"
  content = "<p>订单 <b>#12345</b> 已发货</p>"
  ctaUrl  = "https://mrday.one/orders/12345"
  ctaText = "查看订单"
} | ConvertTo-Json

Invoke-RestMethod -Method Post `
  -Uri "https://mrday-email-sender.<你的子域>.workers.dev/api/notify" `
  -Headers $headers `
  -Body $body
```

## 📞 4 个 API

| 接口 | 用途 |
|---|---|
| `POST /api/send-code` | 发验证码(5分钟过期) |
| `POST /api/verify-code` | 校验验证码,返回一次性 token |
| `POST /api/notify` | 系统通知(订单/密码提醒等) |
| `POST /api/support-reply` | 客服主动回复客户 |

## 📞 前端调用示例

```javascript
const API_BASE = 'https://mrday-email-sender.<你的子域>.workers.dev';
const API_KEY = '你的API_KEY';

async function sendCode(email) {
  const res = await fetch(`${API_BASE}/api/send-code`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email }),
  });
  return res.json();
}

async function verifyCode(email, code) {
  const res = await fetch(`${API_BASE}/api/verify-code`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, code }),
  });
  return res.json();
}

async function notify(to, title, content) {
  const res = await fetch(`${API_BASE}/api/notify`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to, title, content }),
  });
  return res.json();
}
```

## ⚠️ 注意事项

- 每日配额 1000 封(看 Cloudflare 控制台 → Email Service → 发送额度)
- 邮件相关 DNS 记录**必须关代理**(云朵灰色)
- API Key 不要提交到 Git

## 🆘 排错

- **发件返回 401**: 检查 `Authorization: Bearer xxx` 中的 key 是否正确
- **邮件发不出去**: Cloudflare 控制台 → Email Service → Logs 看错误
- **配额用完**: 控制台 → Email Service → 等第二天,或升级 Workers Paid(10万/月)