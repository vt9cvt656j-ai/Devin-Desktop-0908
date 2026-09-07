/**
 * 「构建/测试到底红没红、绿证据算不算数」这两条**执行事实判据**。
 *
 * # 为什么搬出来
 *
 * 它们是整套「已完成」判断的地基：一个发红灯（还有失败的验证命令没修）、一个发绿灯
 * （这一版代码真的被验证过）。判据必须两侧完全一致，否则就有一条最省事的过关路径——
 * 这件事已经出过一次事故，注释里记着。
 *
 * 而它们住在 main.js 里的时候**一条测试都没有**：`_evidenceCertifies` 的版本钉
 * （`implementationVersion !== implOps`，防的是「一次 npm test 替后面十二次编辑作证」
 * 那个单调 bug）、`_freshBuildFailure` 的按命令键控（防的是「另一条无关命令的绿替红作证」）、
 * 退出码 127/126 不算构建失败——三条都是踩过的坑，三条都没人守。
 *
 * 两个都是纯函数：只读传进来的 run/记录和一个数字，无 DOM、无模块级状态。
 */

export function freshBuildFailure(run, implOps) {
  const ev = run && Array.isArray(run._executionEvidence) ? run._executionEvidence : [];
  const settled = new Set();
  let newestFailure = null;
  for (let i = ev.length - 1; i >= 0; i--) {
    const e = ev[i];
    if (!e) continue;
    // 判据必须和 `_evidenceCertifies`（发绿灯那一侧）**完全一致**，否则就有一条最省事的
    // 过关路径。原来这里额外要求 `e.purpose === "verify"`，而绿灯那侧只看
    // `verifierRecognized`、不看 purpose。于是模型跑 `npm test` 不声明 purpose：
    //   过了 → 拿满验证学分；挂了 → 这里直接 continue 跳过，照常宣布完成。
    // 「不填 purpose + 跑一条失败的测试」因此成了全系统最省事的收尾方式。
    //
    // 现在两侧都只认执行期盖上的 `verifierRecognized`。放宽的风险是：模型为了别的目的
    // 跑了一条被识别为验证器的命令（比如 `npm run build` 只为产出资源）而它失败了，
    // 于是这里会拦。但一个失败的 build 本来就不该收尾——拦对了。
    if (e.verifierRecognized !== true) continue;
    if (e.implementationVersion !== implOps) continue; // only the current artifact may drive another fix pass
    if (e.timedOut === true) continue;
    if (typeof e.exitCode !== "number") continue;
    // 验证器**自己没起来**不是代码坏了的证据。
    //
    // agent_engineering.txt:32 逐字写着：「A verifier that cannot run is NOT evidence the code is
    // broken, and is not a reason to wrap up. Exit 127/126 (command not found), a missing
    // dependency, or a missing environment asserts nothing about the code」——而这道红构建门
    // 照单把 127 当成「构建/测试没过，代码现在跑不起来」推给模型，逼它去修一个根本没被
    // 检查过的代码。用户现场就撞过：`vhs demo.tape` 连着两次退出 127（工具没装），
    // 而门给的指示是「先读真实错误、定位并修掉根因」——根因是没装 vhs，不在代码里。
    //
    // 判据用退出码 + 运行器级的「找不到」，不看代码里的报错文本：命令没找到是**执行事实**，
    // 而正文里出现 "not found" 完全可能是被测代码自己打印的。
    //
    // 字段名必须是 `stdout` / `stderr`。这里原来读的是 `e.output || e.tail`，而执行证据记录
    // （`_executionEvidenceFromTool`）产出的字段只有 stdout/stderr —— **这两个名字一个都不存在**，
    // 于是整条文本腿恒等于空串、恒不匹配，只剩退出码 127/126 那一半在工作。
    // 后果正是这段注释上面描述的那一幕，只是换了个出口：一堆"验证器自己没起来"的失败走的是
    // 退出码 1（`npm ERR! Missing script: "test"`、`pytest: 没装但被 sh -c 包了一层`、
    // `Unknown command`），它们全部被判成红构建，把一个已经做完的任务推进两轮无意义的返修，
    // 还盖上 build_failing。
    const _runnerText = `${String(e.stderr || "")}\n${String(e.stdout || "")}`.slice(0, 400);
    const _cannotRun = e.exitCode === 127 || e.exitCode === 126
      || /^(?:[^\n]{0,80}?:\s*)?(?:command not found|not found|no such file or directory)\b/im.test(_runnerText)
      // 包管理器/运行器自己说"这个脚本我没有"——同样是执行事实，不是代码的证词。
      || /\bnpm ERR! Missing script\b|\bno such (?:script|task|target)\b|\bUnknown command\b/i.test(_runnerText);
    if (_cannotRun) continue;
    // last-write-wins 是**按命令**算的，不是全局的。
    //
    // 全局版的原意没错：「跑一次红 → 改好 → 再跑同一条命令绿」之后，那条更早的红不该
    // 再把门打开。但它遇到任何一条绿就整体收工，于是**另一条无关的命令**也能替红的作证：
    // 模型跑 `npm test` 挂了（退出 1），接着跑 `npx tsc --noEmit` 过了（退出 0），倒序扫描
    // 先撞上 tsc、返回 null，整轮判成 success——失败的测试连提都不会被提起。
    // 这正是"说自己解决了、实际没解决"里最难发现的一种：每一步都有真实执行证据。
    //
    // 一条绿只能替它自己作证。同一条命令的更晚记录压住更早的；不同命令各算各的，
    // 只要还有任何一条命令最近一次是红的，这道门就得开。
    const key = `${e.cwd || ""}\u0000${String(e.command || "").replace(/\s+/g, " ").trim()}`;
    if (settled.has(key)) continue; // 这条命令更晚的那次已经裁决过了
    settled.add(key);
    // 倒序扫描，所以第一条没被压住的红就是"最近一次失败"。继续扫完，别的命令可能也红。
    if (e.exitCode !== 0 && !newestFailure) newestFailure = e;
  }
  return newestFailure;
}

export /**
 * May this mutation of an EXISTING file proceed without current-version read evidence?
 *
 * Exactly two bypasses are legitimate, and neither is "the model sent a whole file":
 *
 *   - redacted write-back — the model DID read the current version, just a masked copy.
 *     Its placeholders are restored by _restoreRedactedPlaceholders, which returns null and
 *     refuses the write if restoration is not exact.
 *   - precise local edit — an exact, unique oldString anchor located in the current disk
 *     content is itself evidence the model is operating on the real bytes.
 *
 * A complete whole-file write is NOT a bypass. Undo-ability is not correctness: content
 * composed from the model's prior silently drops whatever the file already held. Callers
 * apply this only when the file exists; creating a new file needs no prior read.
 */
/**
 * Does this execution-evidence record certify the code as it stands at `implOps` edits?
 *
 * Two independent ways to fail:
 *
 *   - STALE. Evidence taken before the current edit count certifies a file that has since
 *     changed. That is the credit this gate exists to revoke.
 *   - RED. A command that failed is not verification, it is the opposite. Every positive
 *     test below matches on command SHAPE, so without the exit-status check a
 *     `npm run build` that exited non-zero certified the code it had just proven broken —
 *     the most direct route to delivering code that does not run.
 *
 * `ok` and `exitCode` are stamped at settle time from the structured tool result. A
 * record missing either field is intentionally not certification evidence; legacy or
 * restored history must be re-run instead of being treated as a green build.
 */
function evidenceCertifies(e, implOps) {
  if (!e || e.ok !== true) return false;
  // Two independent sources of certification, both grounded in OBSERVED execution:
  //   - `verification`: the IDE ran its own auto-verify pipeline.
  //   - `verifierRecognized`: the MODEL ran a command the IDE recognises as a verifier
  //     (`go test ./...`, `npm run build`, `cargo check`, …), stamped at settle time.
  // Only the first was honoured, so a model-run `go build` + `go test ./...` that genuinely
  // exited 0 earned NO credit: the outcome card said "build passed, tests passed" and
  // "no valid verification evidence" in the same breath, then told the user to go run a build
  // themselves. `verifierRecognized` was computed and stamped on every record and read by
  // nothing — while the code that grants credit already documented crediting exactly this
  // ("settlement stamped a recognized verifier and its structured evidence proves an explicit
  // exit 0"). This is that intent, implemented. Both paths still require a real exit 0 at the
  // current edit count, so a red or stale check certifies nothing.
  if (e.verification !== true && e.verifierRecognized !== true) return false;
  if (e.exitCode !== 0 || e.timedOut === true) return false;
  if (e.implementationVersion !== implOps) return false;
  return String(e.command || "").trim().length > 0;
}
