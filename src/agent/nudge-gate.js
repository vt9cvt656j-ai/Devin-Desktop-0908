// harness 提醒总闸的豁免名单。
//
// 那道开关（localStorage 的 michael-ide.harness-nudges）量的是「harness 的**劝诫**
// 有没有用」——它只该挡劝诫。下面这些不是劝诫，关掉它们会把别的机制一起打断，
// A/B 量到的就不再是开关自己：
//
//   · steer —— 用户自己的实时插话，根本不是 harness 在说话。
//   · researchFirst / probeLoop / directionCheck / dynamicToolRoute —— 这四条的**旁边**
//     都跟着一句 _applyToolPayloadWindow：工具已经装进这一轮的窗口了。只挡消息的话，
//     模型会看到工具数组里凭空多出 web_search / package_search 却没有任何理由，
//     那不是"少了一条提醒"，是动态工具编排整条哑掉。
//
// 单独成模块而不是写在 main.js 里，是为了源码和测试**共用同一份**：
// 测试自己再抄一遍的话，改了源码不改测试也照样全绿（本仓库栽过好几次）。
/** 这一轮已经往工具窗口里装了东西的那几条——消息是它们的说明书，缺了就是白装。 */
export const TOOL_WINDOW_NUDGES = ["researchFirst", "probeLoop", "directionCheck", "dynamicToolRoute"];
/** 不是 harness 在说话，是用户自己的话。 */
export const USER_VOICE_NUDGES = ["steer"];

export const NUDGE_GATE_EXEMPT = new Set([...USER_VOICE_NUDGES, ...TOOL_WINDOW_NUDGES]);
