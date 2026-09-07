/**
 * 用户在输入框里敲 `/技能名 参数` 触发技能——纯逻辑这一半。
 *
 * 判据照旧：外部自由变量为零，只吃字符串和技能对象数组、只吐结构。挂到 composer 上、
 * 写进会话记忆、画气泡那一半在 main.js。
 *
 * 为什么要有这条路：Agent Skills 规范里 `disable-model-invocation: true` 的技能**不进模型
 * 目录**（省的是每一轮都要付的上下文开销），于是它们只剩一个入口——人敲名字。没有这个入口，
 * 这一类技能装了等于没装：mattpocock/skills 三十个里一半是这种（grill-me / implement /
 * wayfinder / handoff 全是一行「去调 X」的路由壳，靠人敲）。
 */

/** 第一个 token 是 `/名字`，后面（可选）是参数；只认消息开头，不认行中。 */
const SLASH_RE = /^\/([A-Za-z0-9][\w.-]{0,79})(?:\s+([\s\S]*))?$/;

/** 和 main.js `_findSkillByName` 同一种归一化：大小写、空格、下划线、斜杠、连字符都不算差异。 */
export function normalizeSkillName(value) {
  return String(value || "").toLowerCase().replace(/[\s_/-]+/g, "");
}

/**
 * `/handoff 明天先做部署` → { name: "handoff", args: "明天先做部署" }；不是这个形状回 null。
 *
 * `/Users/me/x.txt` 这种路径也会解析出 name="Users"——那不是 bug：解析只负责切词，
 * 要不要当技能由 findSlashSkill 用**精确**匹配决定，路径段几乎不可能撞上一个技能名。
 */
export function parseSlashInvocation(text) {
  const raw = String(text || "");
  const m = raw.match(SLASH_RE);
  if (!m) return null;
  return { name: m[1], args: String(m[2] || "").trim() };
}

/**
 * 按名字找技能——**只做精确（归一化后）匹配**，不做包含匹配。
 *
 * read_skill 那条路允许包含匹配是因为模型照着目录抄名字、偶尔抄错半截；这里是人敲的，
 * 敲错了就该当普通消息发出去，而不是替他猜一个技能来跑。
 */
export function findSlashSkill(skills, token) {
  const q = normalizeSkillName(token);
  if (!q) return null;
  for (const s of Array.isArray(skills) ? skills : []) {
    if (s && normalizeSkillName(s.name) === q) return s;
  }
  return null;
}

/**
 * 把参数灌进正文：`$ARGUMENTS` 逐处替换；正文没写占位符而用户给了参数，就把参数附在末尾
 * ——技能作者没预留位置，不等于用户那句话可以丢。
 */
export function expandSkillArguments(body, args) {
  const text = String(body || "");
  const a = String(args || "").trim();
  if (/\$ARGUMENTS\b/.test(text)) return text.replace(/\$ARGUMENTS\b/g, a);
  return a ? `${text.trimEnd()}\n\n用户给这次调用的参数：${a}` : text;
}

/**
 * 发给模型的那条用户消息。
 *
 * 开头先说清「这是用户敲 /名字 调出来的技能指令」——不戴这层，模型会把一整段第二人称的
 * 指令当成用户在跟它闲聊；资源基准目录必须在前面，理由和 read_skill 那条一样：正文里的
 * `scripts/x.sh`、`tests.md` 都是相对 SKILL.md 所在目录说的。
 */
export function buildSlashInvocationMessage(skill, args, { home = "" } = {}) {
  const name = String(skill?.name || "技能").trim();
  const a = String(args || "").trim();
  const dir = String(home || skill?.baseDir || "").trim();
  const lines = [
    `用户通过 /${name} 调用了技能「${name}」${a ? `，并给了参数：${a}` : ""}。下面是这个技能的完整指令，按它执行；指令里让你「调用 Skill 工具」读别的技能时，用 read_skill 按名字读。`,
  ];
  if (dir) lines.push(`资源基准目录：${dir}（指令里的相对路径都相对它）`);
  lines.push("---", expandSkillArguments(skill?.prompt || "", a));
  return lines.join("\n");
}
