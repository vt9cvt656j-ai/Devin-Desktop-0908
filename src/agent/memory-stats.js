// 记忆系统的计数器 —— 回答「这套记忆到底有没有在干活」。
//
// 2026-09-05 那次审计要跑四个脚本、翻三个文件才知道：反思通道从没写过一条、71% 的笔记
// 从没被命中、39% 的轮次注入的全是无关常驻。这些数本该在产品里就能看到。
// 这里只做一件事：按键累加，落 localStorage（键很少、写得很轻），记忆中心读出来展示。
// 不做判断、不做建议 —— 它是读数，不是结论。
//
// 键的约定（写入点自己负责起名，这里不校验）：
//   capture.core.accepted / capture.core.rejected   用户原话进核心
//   reflect.opened / reflect.accepted                收尾反思开闸 / 真写进来
//   core.added / core.dup / core.rejected            核心写入
//   retrieve.kg.hit / retrieve.kg.empty              KG 块有相关命中 / 没有
//   retrieve.ep.hit / retrieve.ep.empty              情景经验命中 / 没有
//   retrieve.wf.hit / retrieve.wf.empty              工作流命中 / 没有
//   render.core                                      核心块非空渲染次数

export const MEMORY_STATS_KEY = "michael-ide.memory-stats";
let _storage = null;
let _cache = null;

export function configureMemoryStats(deps = {}) {
  if (deps.storage && typeof deps.storage.getItem === "function") _storage = deps.storage;
  _cache = null;
}
function load() {
  if (_cache) return _cache;
  let obj = {};
  try { const raw = _storage ? _storage.getItem(MEMORY_STATS_KEY) : null; if (raw) obj = JSON.parse(raw) || {}; } catch { obj = {}; }
  if (!obj || typeof obj !== "object") obj = {};
  _cache = obj;
  return obj;
}
/** 累加。任何异常都吞掉：计数器不许把发消息那条路打断。 */
export function memStat(key, n = 1) {
  try {
    const k = String(key || "").slice(0, 60);
    if (!k) return;
    const s = load();
    s[k] = (Number(s[k]) || 0) + (Number(n) || 1);
    s.__updated = Date.now();
    if (_storage) _storage.setItem(MEMORY_STATS_KEY, JSON.stringify(s));
  } catch {}
}
/** 快照（拷贝）。 */
export function memStats() {
  const s = load();
  const out = {};
  for (const [k, v] of Object.entries(s)) if (!k.startsWith("__")) out[k] = Number(v) || 0;
  return out;
}
