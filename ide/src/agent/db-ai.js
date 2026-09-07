/**
 * 工作台里的 AI 助手：把「表结构 + 任务」拼成一次模型调用的消息，以及从回复里抠出 SQL。
 * 只拼消息、不发请求——发请求走调用方现成的计费通道（用户当前选的模型）。
 */

const MODE_TEXT = {
  generate: "根据需求写出一条可以直接执行的 SQL。",
  explain: "用中文解释这条 SQL 做了什么、每一步在哪张表上发生、可能的性能风险。",
  fix: "这条 SQL 执行失败了。指出原因，并给出修正后的 SQL。",
  optimize: "在不改变结果的前提下优化这条 SQL：指出问题，并给出改写后的 SQL 与建议的索引。",
};

/** 表结构摘要（控制在预算内，列太多的表截断）。 */
export function schemaDigest(tables, { maxTables = 40, maxCols = 40, budget = 6000 } = {}) {
  const lines = [];
  let used = 0;
  for (const t of (tables || []).slice(0, maxTables)) {
    if (!t?.name) continue;
    const cols = Array.isArray(t.columns) ? t.columns : [];
    const colText = cols.slice(0, maxCols).map((c) => (typeof c === "string" ? c : `${c?.name}${c?.type ? " " + c.type : ""}${c?.pk ? " PK" : ""}`)).join(", ");
    const line = `${t.table_type === "view" ? "VIEW" : "TABLE"} ${t.name}${colText ? ` (${colText}${cols.length > maxCols ? ", …" : ""})` : ""}`;
    if (used + line.length > budget) { lines.push("…（更多表省略）"); break; }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

export function buildSqlAssistMessages({ mode = "generate", driver = "mysql", dialectLabel = "", tables = [], task = "", sql = "", error = "" } = {}) {
  const m = MODE_TEXT[mode] ? mode : "generate";
  const digest = schemaDigest(tables);
  const system = [
    `你是 ${dialectLabel || driver} 数据库专家，在一个数据库工作台里回答。`,
    "只针对给出的表结构作答；结构里没有的表和列不要假设存在。",
    "回复里的 SQL 一律放在 ```sql 代码块中，且只放一条可直接执行的语句（需要多条时用分号分隔在同一个代码块内）。",
    "解释用中文、简短；不要寒暄。",
  ].join("\n");
  const parts = [];
  if (digest) parts.push(`【表结构】\n${digest}`);
  if (sql) parts.push(`【SQL】\n${sql}`);
  if (error) parts.push(`【错误】\n${error}`);
  if (task) parts.push(`【需求】\n${task}`);
  parts.push(`【任务】\n${MODE_TEXT[m]}`);
  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n\n") },
  ];
}

/** 从模型回复里抠 SQL：优先 ```sql 代码块，其次任意代码块，最后按语句开头猜。 */
export function extractSqlFromReply(text) {
  const s = String(text || "");
  const fenced = /```(?:sql|SQL|mysql|postgres(?:ql)?|sqlite)?\s*\n([\s\S]*?)```/.exec(s);
  if (fenced && fenced[1].trim()) return fenced[1].trim();
  const any = /```[a-zA-Z]*\s*\n([\s\S]*?)```/.exec(s);
  if (any && any[1].trim()) return any[1].trim();
  const m = /\b(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|DROP|EXPLAIN)\b[\s\S]*$/i.exec(s);
  return m ? m[0].trim() : "";
}

/** 回复里 SQL 之外的说明文字（去掉代码块）。 */
export function explanationFromReply(text) {
  return String(text || "").replace(/```[\s\S]*?```/g, "").trim();
}
