// 自适应块 —— 系统提示里那一段字节稳定的用户档案：核心记忆 + 非默认旋钮 + 理解规则。
//
// 从 main.js 搬出来（尺寸闸，见 test/main-size-budget.test.mjs）。函数名原样保留：
// 测试按名抠取 `_adaptivePromptBlock` / `_adaptiveKnobLines`，并按名注入下面这几个依赖。
// 四个 main.js 事实（读档案、旋钮文案、默认值、当前根）由 configureAdaptiveBlock 注入；
// 注入名故意不和 main.js 里的 const 同名 —— 源码断言把 main.js 和模块拼成一份文本解析，
// 同名 const 会撞「重复声明」。
//
// 2026-09-05 起这个块承担两件事，顺序固定：
//   ① **核心记忆**（用户层 + 本项目）—— 每轮必带的约束。渲染是内容的纯函数（无时间戳/计数），
//      所以能坐在系统提示里；走网关时随这个块进 clientBlocks，两条线路都到得了模型。
//   ② 五个旋钮 —— **只写非默认的那几行**。原来每轮固定塞六行「回答风格：直接真实……用户
//      熟练度：自动判断」；实测用户从没保存过档案（localStorage 里没有这个键），那六行两个
//      月来每轮都是默认值，对模型零信息、对每轮几百字固定成本。
import { renderCoreBlock } from "./core-memory.js";
import { memStat } from "./memory-stats.js";

let _apLoadProfile = () => ({ enabled: true });
let _apOptionLabel = (_group, value) => String(value || "");
let _apDefaults = { tone: "direct", detail: "balanced", autonomy: "proactive", skill: "auto", intentMode: "infer" };
let _apRoot = () => "";

export function configureAdaptiveBlock(deps = {}) {
  if (typeof deps.loadProfile === "function") _apLoadProfile = deps.loadProfile;
  if (typeof deps.optionLabel === "function") _apOptionLabel = deps.optionLabel;
  if (deps.defaults && typeof deps.defaults === "object") _apDefaults = deps.defaults;
  if (typeof deps.root === "function") _apRoot = deps.root;
}

export function _adaptiveKnobLines(profile) {
  const out = [];
  const d = _apDefaults;
  if (profile.tone !== d.tone) out.push(`回答风格：${_apOptionLabel("tone", profile.tone)}。${profile.tone === "warm" ? "（只影响措辞和解释密度，不影响结论：坏消息仍然先说、不稀释；用户说错了仍然当面说。）" : ""}`);
  if (profile.detail !== d.detail) out.push(`细节密度：${_apOptionLabel("detail", profile.detail)}。`);
  if (profile.autonomy !== d.autonomy) out.push(`执行节奏：${_apOptionLabel("autonomy", profile.autonomy)}。`);
  if (profile.skill !== d.skill) out.push(`用户熟练度：${_apOptionLabel("skill", profile.skill)}。`);
  if (profile.intentMode !== d.intentMode) out.push(`意图识别：${_apOptionLabel("intentMode", profile.intentMode)}。`);
  return out.length ? out.join("\n") + "\n" : "";
}

export function _adaptiveCoreBlock() {
  try {
    const root = String(_apRoot() || "").replace(/\/+$/, "");
    const text = renderCoreBlock("") + (root ? renderCoreBlock(root) : "");
    if (text) memStat("render.core");
    return text;
  } catch { return ""; }
}

export function _adaptivePromptBlock() {
  const profile = _apLoadProfile();
  if (profile.enabled === false) return "";
  const memory = "";
  const core = _adaptiveCoreBlock();
  const knobs = _adaptiveKnobLines(profile);
  return `${core}\n\n【自适应用户档案】已开启。你要逐步贴近用户的真实工作方式，但这些只是偏好，不覆盖本轮明确指令；若本轮指令冲突，以用户本轮为准。
${knobs}自适应理解规则：
- 用户表达很短、很乱、带情绪，或只说“啊 / ？？ / 继续 / 这个 / 不是这个 / 没懂 / 怎么回事”时，先结合最近对话、当前 UI/截图、刚完成或失败的动作、打开文件和任务状态推断他精确指的是什么；置信高就直接处理，并用一句话说明你依据哪条上下文判断。
- 用户明显不懂技术或概念时，自动降到新手可理解的说法：先说结论和下一步，再补最少必要解释；不要甩术语、不要让用户自己翻文档。
- 用户纠正你（例如“不是这个”“要中文”“不要改界面”“别打包”）时，把它当成强自适应信号；后续同类任务优先遵守。若是跨项目长期偏好，并且当前模式有 remember 工具，可记为 global 偏好。**但这一条只对口味类纠正成立**（语言、风格、范围、要不要做某一步）。如果这次纠正本身断言了一个技术事实（版本、API 行为、某段代码怎么执行），先按真实性纪律用证据核对：证据相反就在第一句说清并给出文件:行或真实输出，然后照他的决定做——但不要把这条错误主张写进记忆，否则它会在此后每一轮被当成事实注入。
- 只有上下文仍不足以唯一判断时，才问；问题必须给 2-3 个具体候选，不要泛泛问“你想做什么”。${memory}`;
}
