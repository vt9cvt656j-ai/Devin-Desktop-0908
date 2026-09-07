// ============================================
// 发件 Worker:验证码 + 系统通知 + 售后模板
// 后端:Cloudflare Email Sending(免费层 1000封/天)
// ============================================

import { renderCodeTemplate, renderNotifyTemplate } from "./templates";

export interface Env {
  /** Cloudflare Email Sending 绑定(wrangler.jsonc 里 send_email 配置) */
  EMAIL: SendEmail;
  /** KV:存验证码(5分钟过期) */
  VERIFICATION_CODES: KVNamespace;
  /** KV:存发送频率限制 */
  RATE_LIMIT?: KVNamespace;
  /** API 密钥(调用方需要带这个) */
  API_KEY: string;
  /** 发件人姓名 */
  FROM_NAME: string;
  /** 发件人邮箱(必须是 Cloudflare 验证过的域名下) */
  FROM_EMAIL: string;
  /** 应用名称 */
  APP_NAME?: string;
}

// ============================================
// 工具函数
// ============================================

/** 生成 6 位数字验证码 */
function generateCode(): string {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 1000000).padStart(6, "0");
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email) && email.length <= 254;
}

/** 频率限制:同邮箱 60 秒内只允许 1 次 */
async function checkRateLimit(env: Env, key: string): Promise<{ allowed: boolean; retryAfter?: number }> {
  if (!env.RATE_LIMIT) return { allowed: true };
  const k = `rl:${key}`;
  const exists = await env.RATE_LIMIT.get(k);
  if (exists) {
    const ttl = await env.RATE_LIMIT.getTtl(k);
    return { allowed: false, retryAfter: Math.max(1, ttl) };
  }
  await env.RATE_LIMIT.put(k, "1", { expirationTtl: 60 });
  return { allowed: true };
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

function authenticate(request: Request, env: Env): boolean {
  const auth = request.headers.get("Authorization") || "";
  const key = auth.replace(/^Bearer\s+/i, "");
  return key === env.API_KEY;
}

// ============================================
// 路由处理
// ============================================

async function handleSendCode(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { email?: string } | null;
  const email = body?.email?.trim().toLowerCase();

  if (!email || !isValidEmail(email)) {
    return jsonResponse({ success: false, code: "INVALID_EMAIL", message: "邮箱格式错误" }, 400);
  }

  const rl = await checkRateLimit(env, email);
  if (!rl.allowed) {
    return jsonResponse(
      { success: false, code: "RATE_LIMIT", message: `请求过于频繁,请 ${rl.retryAfter} 秒后重试` },
      429
    );
  }

  const code = generateCode();
  await env.VERIFICATION_CODES.put(`code:${email}`, code, { expirationTtl: 300 });

  const { html, text } = renderCodeTemplate({ code, expireMinutes: 5, appName: env.APP_NAME });

  try {
    await env.EMAIL.send({
      from: `${env.FROM_NAME} <${env.FROM_EMAIL}>`,
      to: email,
      subject: `您的验证码: ${code}`,
      html,
      text,
    });
    return jsonResponse({ success: true, message: "验证码已发送", expiresIn: 300 });
  } catch (err: any) {
    console.error("Send code error:", err);
    return jsonResponse({ success: false, code: "SEND_FAILED", message: err?.message || "邮件发送失败" }, 500);
  }
}

async function handleVerifyCode(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { email?: string; code?: string } | null;
  const email = body?.email?.trim().toLowerCase();
  const code = body?.code?.trim();

  if (!email || !code) {
    return jsonResponse({ success: false, code: "INVALID_PARAMS", message: "参数错误" }, 400);
  }

  const stored = await env.VERIFICATION_CODES.get(`code:${email}`);
  if (!stored) {
    return jsonResponse({ success: false, code: "CODE_EXPIRED", message: "验证码已过期或不存在" }, 400);
  }
  if (stored !== code) {
    return jsonResponse({ success: false, code: "CODE_MISMATCH", message: "验证码错误" }, 400);
  }

  await env.VERIFICATION_CODES.delete(`code:${email}`);

  const token = crypto.randomUUID();
  await env.VERIFICATION_CODES.put(`verified:${email}`, token, { expirationTtl: 600 });

  return jsonResponse({ success: true, message: "验证成功", token, expiresIn: 600 });
}

async function handleNotify(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    to?: string | string[];
    title?: string;
    content?: string;
    ctaUrl?: string;
    ctaText?: string;
    footer?: string;
  } | null;

  const { to, title, content, ctaUrl, ctaText, footer } = body || {};

  if (!to || !title || !content) {
    return jsonResponse({ success: false, code: "INVALID_PARAMS", message: "to/title/content 必填" }, 400);
  }

  const recipients = Array.isArray(to) ? to : [to];
  if (recipients.length > 50) {
    return jsonResponse({ success: false, code: "TOO_MANY_RECIPIENTS", message: "单次最多 50 个收件人" }, 400);
  }
  for (const r of recipients) {
    if (!isValidEmail(r)) {
      return jsonResponse({ success: false, code: "INVALID_EMAIL", message: `邮箱格式错误: ${r}` }, 400);
    }
  }

  const { html, text } = renderNotifyTemplate({ title, content, ctaUrl, ctaText, footer, appName: env.APP_NAME });

  try {
    await env.EMAIL.send({
      from: `${env.FROM_NAME} <${env.FROM_EMAIL}>`,
      to: recipients,
      subject: title,
      html,
      text,
    });
    return jsonResponse({ success: true, message: "通知已发送", recipients: recipients.length });
  } catch (err: any) {
    console.error("Send notify error:", err);
    return jsonResponse({ success: false, code: "SEND_FAILED", message: err?.message || "发送失败" }, 500);
  }
}

async function handleSupportReply(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    to?: string;
    ticketId?: string;
    subject?: string;
    content?: string;
  } | null;

  const { to, ticketId, subject, content } = body || {};

  if (!to || !subject || !content) {
    return jsonResponse({ success: false, code: "INVALID_PARAMS", message: "to/subject/content 必填" }, 400);
  }
  if (!isValidEmail(to)) {
    return jsonResponse({ success: false, code: "INVALID_EMAIL", message: "邮箱格式错误" }, 400);
  }

  const fullSubject = ticketId ? `[${ticketId}] ${subject}` : subject;
  const fromStr = `Mrday 客服 <support@mrday.one>`;

  const html = `<!DOCTYPE html>
<html lang="zh-CN"><body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 16px;"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.05);">
<tr><td style="background:linear-gradient(135deg,#0f172a,#334155);padding:20px 32px;color:#fff;font-size:18px;font-weight:600;">Mrday 客服回复</td></tr>
<tr><td style="padding:32px;font-size:15px;line-height:1.7;color:#334155;">${content}</td></tr>
${ticketId ? `<tr><td style="padding:12px 32px;background:#f8fafc;color:#64748b;font-size:12px;border-top:1px solid #e2e8f0;">工单号: <b>${ticketId}</b></td></tr>` : ""}
<tr><td style="padding:16px 32px;background:#fafafa;border-top:1px solid #eee;color:#94a3b8;font-size:12px;text-align:center;">Mrday 客服团队</td></tr>
</table></td></tr></table></body></html>`;

  try {
    await env.EMAIL.send({
      from: fromStr,
      to,
      subject: fullSubject,
      html,
      text: content.replace(/<[^>]+>/g, ""),
      headers: ticketId ? { "X-Ticket-Id": ticketId } : undefined,
    });
    return jsonResponse({ success: true, message: "售后邮件已发送" });
  } catch (err: any) {
    console.error("Send reply error:", err);
    return jsonResponse({ success: false, code: "SEND_FAILED", message: err?.message || "发送失败" }, 500);
  }
}

// ============================================
// 主入口
// ============================================

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // 健康检查:GET / 和 GET /health 接受任意方法
    if (url.pathname === "/" || url.pathname === "/health") {
      return jsonResponse({
        success: true,
        service: "mrday-email-sender",
        provider: "cloudflare-email-sending",
        daily_quota: 1000,
        endpoints: ["/api/send-code", "/api/verify-code", "/api/notify", "/api/support-reply"],
        version: "1.0.0",
        timestamp: new Date().toISOString(),
      });
    }

    if (request.method !== "POST") {
      return jsonResponse({ success: false, code: "METHOD_NOT_ALLOWED", message: "仅支持 POST" }, 405);
    }

    if (!authenticate(request, env)) {
      return jsonResponse({ success: false, code: "UNAUTHORIZED", message: "无效的 API Key" }, 401);
    }

    try {
      switch (url.pathname) {
        case "/api/send-code":
          return await handleSendCode(request, env);
        case "/api/verify-code":
          return await handleVerifyCode(request, env);
        case "/api/notify":
          return await handleNotify(request, env);
        case "/api/support-reply":
          return await handleSupportReply(request, env);
        default:
          return jsonResponse({ success: false, code: "NOT_FOUND", message: "接口不存在" }, 404);
      }
    } catch (err: any) {
      console.error("Worker error:", err);
      return jsonResponse({ success: false, code: "INTERNAL_ERROR", message: err?.message || "服务器错误" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;