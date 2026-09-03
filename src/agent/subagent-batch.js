/**
 * 子智能体一轮里的工具调用能不能**整批预先起跑**。
 *
 * 主循环早就有并发调度器（`_runOrderedToolSegments`：同段键的连续项 `Promise.all`），
 * 而子体走的是另一条完整的模型循环，里面是 `for (const tc of turn.toolCalls) { … await … }`
 * ——**严格串行**，全程没有一处并发。偏偏「一轮发三个 read」最常出现的就是子体：
 * research_project / design_research / run_worker / spawn_multiple_agents 全由它承载，
 * 而这些角色的活基本就是读和搜。三个互不依赖的读取排队跑，多出来的时间是白付的。
 *
 * ## 为什么是「整批成立才起跑」，而不是「挑出只读的那几个起跑」
 *
 * 子体循环在真正执行之前有一道**逐次准入闸**：`git` 只放行只读 op、`mcp` 看服务自己
 * 声明的 readOnlyHint、`gh` 只放行读 op、`browser` 只放行观察类动作、`db` 只放行不改
 * 数据的查询、`userhttp` 看 userReadOnly。这些都是「单类型多行为」——**类型放行不等于
 * 这一次放行**。预先起跑发生在那道闸之前，所以任何可能被逐次拒掉的调用都绝不能起跑，
 * 否则就是"闸还没判，动作已经做了"。
 *
 * 判据因此取两个集合的交：`_READ_ONLY_TYPES`（本仓库认定的纯读类型，那几个"单类型多
 * 行为"的家族**不在**里面）∩ 子体这一轮实际允许的执行类型。再排除两个有自己分支的：
 * `cmd`（有命令白名单和 60 秒超时）和 `search_tools`（在循环更靠前的地方被单独应答）。
 *
 * 混批退回串行还有第二个理由：工具卡是在循环里按序 append 的，只给一部分预先建卡会让
 * 卡片出现顺序和调用顺序对不上。整批起跑时顺序完全一致，看不出区别。
 *
 * 纯函数、无 DOM、无 IO —— 判据能在 Node 里做真往返，比在八万行里靠源码正则守它强。
 */

/** 有自己的执行分支、绝不能预先起跑的类型。 */
export const NEVER_PREFETCH = new Set(["cmd", "search_tools"]);

/**
 * @param {Array<{name?: string, parsedArgs?: unknown}>} toolCalls 这一轮的工具调用
 * @param {(name: string, args: unknown) => any} mapCall 把 (名字, 参数) 映射成 call 对象
 * @param {{readOnlyTypes: Set<string>, execTypes: string[]}} policy
 * @returns {any[] | null} 整批可起跑时返回**按序**映射好的 call 数组；否则 null
 */
export function readOnlyBatch(toolCalls, mapCall, policy) {
  const list = Array.isArray(toolCalls) ? toolCalls : [];
  // 一个调用没有并发可言，别为它多走一遍映射。
  if (list.length < 2 || typeof mapCall !== "function") return null;
  const readOnlyTypes = policy?.readOnlyTypes;
  const execTypes = policy?.execTypes;
  if (!readOnlyTypes || typeof readOnlyTypes.has !== "function" || !Array.isArray(execTypes)) return null;

  const mapped = [];
  for (const tc of list) {
    let call = null;
    try { call = mapCall(tc?.name, tc?.parsedArgs); } catch { return null; }
    if (!call || !call.type) return null;
    if (NEVER_PREFETCH.has(call.type)) return null;
    if (!readOnlyTypes.has(call.type)) return null;
    if (!execTypes.includes(call.type)) return null;
    mapped.push(call);
  }
  return mapped;
}
