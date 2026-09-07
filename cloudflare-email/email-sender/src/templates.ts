// ============================================
// 邮件模板库
// ============================================

export interface CodeTemplateParams {
  code: string;
  expireMinutes?: number;
  appName?: string;
}

export interface NotifyTemplateParams {
  title: string;
  content: string;
  ctaUrl?: string;
  ctaText?: string;
  footer?: string;
  appName?: string;
}

/** 通用邮件外壳 */
function wrapHtml(title: string, body: string, footer?: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.05);max-width:100%;">
        <tr><td style="background:linear-gradient(135deg,#0f172a 0%,#334155 100%);padding:28px 32px;">
          <h1 style="margin:0;color:#fff;font-size:20px;font-weight:600;letter-spacing:0.5px;">${title}</h1>
        </td></tr>
        <tr><td style="padding:36px 32px;font-size:15px;line-height:1.7;color:#334155;">
          ${body}
        </td></tr>
        <tr><td style="padding:20px 32px;background:#fafafa;border-top:1px solid #eee;color:#94a3b8;font-size:12px;text-align:center;">
          ${footer || "本邮件由系统自动发送,请勿直接回复"}
        </td></tr>
      </table>
      <div style="margin-top:16px;font-size:11px;color:#94a3b8;">Mrday · Powered by Cloudflare Email</div>
    </td></tr>
  </table>
</body>
</html>`;
}

/** 验证码模板 */
export function renderCodeTemplate(p: CodeTemplateParams): { html: string; text: string } {
  const expire = p.expireMinutes ?? 5;
  const app = p.appName ?? "Mrday";

  const html = wrapHtml(
    "邮箱验证码",
    `
      <p style="margin:0 0 16px;">您好,</p>
      <p style="margin:0 0 24px;">您正在进行身份验证,验证码如下:</p>
      <div style="background:#f1f5f9;border:1px dashed #cbd5e1;border-radius:8px;padding:24px;text-align:center;margin:24px 0;">
        <div style="font-size:36px;font-weight:700;letter-spacing:10px;color:#0f172a;font-family:'SF Mono',Consolas,Monaco,monospace;">${p.code}</div>
      </div>
      <p style="margin:24px 0 8px;color:#64748b;font-size:13px;">验证码有效期 <b style="color:#0f172a;">${expire} 分钟</b>,请尽快使用。</p>
      <p style="margin:8px 0;color:#64748b;font-size:13px;">如非本人操作,请忽略此邮件。</p>
    `,
    `${app} · 验证码服务`
  );

  const text = `【${app}】您的验证码为: ${p.code}（${expire} 分钟内有效）。如非本人操作请忽略。`;

  return { html, text };
}

/** 通用通知模板 */
export function renderNotifyTemplate(p: NotifyTemplateParams): { html: string; text: string } {
  const app = p.appName ?? "Mrday";
  const ctaBlock = p.ctaUrl
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0 8px;"><tr><td align="center">
        <a href="${p.ctaUrl}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:13px 36px;border-radius:6px;font-weight:600;font-size:14px;">${p.ctaText || "查看详情"}</a>
      </td></tr></table>
      <p style="text-align:center;margin:12px 0 0;font-size:12px;color:#94a3b8;">或复制链接: <a href="${p.ctaUrl}" style="color:#0f172a;">${p.ctaUrl}</a></p>`
    : "";

  const html = wrapHtml(
    p.title,
    `${p.content}${ctaBlock}`,
    p.footer
  );

  const text = `${p.title}\n\n${p.content.replace(/<[^>]+>/g, "")}${p.ctaUrl ? `\n\n查看详情: ${p.ctaUrl}` : ""}`;

  return { html, text };
}
