/**
 * 子智能体一轮里的工具调用能不能**整批预先起跑**。
 *
 * 主循环早就有并发调度器（`_runOrderedToolSegments`：同段键的连续项 `Promise.all`），
 * 而子体走的是另一条完整的模型循环，里面是 `for (const tc of turn.toolCalls) { … await … }`
 * ——**严格串行**，全程没有一处并发。偏偏「一轮发三个 read」最常出现的就是子体：
 * research_project / design_research / run_worker / spawn_multiple_agents 全由它承载，
 * 而这些角色的活基本就是读和搜。三个互不依赖的读取排队跑，多出来的时间是白付的。
 *
 * ## 前缀语义：连续的纯读打头就并行，撞到第一个非纯读为止
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
 * 上一版是「整批成立才起跑」：`[read, read, read, git_status]` 因为最后一个 git 整批退回
 * 串行——而调研型子体一轮里最常见的正是这种形状（先读几份文件再看一眼 git）。改成前缀：
 * 从头数连续满足判据的那一段（≥ 2 个才值得并发）起跑，其余照旧走串行循环。
 * 卡片顺序不受影响：前缀那几张按声明顺序先建，后面的在串行循环里按序 append，和调用
 * 顺序仍然一致（整批时的那条理由对前缀同样成立）。
 *
 * 纯函数、无 DOM、无 IO —— 判据能在 Node 里做真往返，比在八万行里靠源码正则守它强。
 */

/** 有自己的执行分支、绝不能预先起跑的类型。 */
export const NEVER_PREFETCH = new Set(["cmd", "search_tools"]);

/**
 * @param {Array<{name?: string, parsedArgs?: unknown}>} toolCalls 这一轮的工具调用
 * @param {(name: string, args: unknown) => any} mapCall 把 (名字, 参数) 映射成 call 对象
 * @param {{readOnlyTypes: Set<string>, execTypes: string[]}} policy
 * @returns {any[] | null} 可起跑的**前缀**（≥ 2 个），按声明顺序映射好的 call 数组；否则 null。
 *   调用方只预起跑返回的这几个（下标 0..n-1），其余照旧串行。
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
    // 映射抛异常 / 认不出 / 非纯读 / 这一轮不许用：前缀到此为止，后面的交给串行循环。
    try { call = mapCall(tc?.name, tc?.parsedArgs); } catch { break; }
    if (!call || !call.type) break;
    if (NEVER_PREFETCH.has(call.type)) break;
    if (!readOnlyTypes.has(call.type)) break;
    if (!execTypes.includes(call.type)) break;
    mapped.push(call);
  }
  return mapped.length >= 2 ? mapped : null;
}
