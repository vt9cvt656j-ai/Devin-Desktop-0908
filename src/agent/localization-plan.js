// 从 main.js 搬出来的（撞行数闸时按仓库规矩先腾地方，不抬闸线）。
// parseProblems 由调用方注入：它住在 main.js，搬过来会把一大票别的东西一起拖过来。

export function _localizationPlan(command, output, run, parseProblems) {
  let problems = [];
  try { problems = parseProblems(String(output || ""), { command: String(command || "") }); } catch { return ""; }
  const errors = problems.filter((p) => p && p.severity !== "warning" && p.file && p.line);
  if (!errors.length) return "";

  // ── 分层收窄：先按文件归并，把每个文件的出错行收成一份阅读清单 ──
  const byFile = new Map();
  for (const p of errors) {
    const file = String(p.file);
    if (!byFile.has(file)) byFile.set(file, { file, lines: [], items: [] });
    const group = byFile.get(file);
    group.lines.push(p.line);
    group.items.push(p);
  }

  // ── 信号①：这一轮自己改过的文件 ──
  // 路径两侧都可能带 ./ 或不同前缀（编译器给的是相对包路径，写入记的是工作区相对路径），
  // 所以用尾部匹配而不是全等——否则这个信号永远命中不了，分层等于没做。
  const touched = run?._mutatedFiles instanceof Set ? [...run._mutatedFiles].map(String) : [];
  const sameFile = (a, b) => {
    const x = String(a).replace(/^\.\//, ""), y = String(b).replace(/^\.\//, "");
    return x === y || x.endsWith("/" + y) || y.endsWith("/" + x);
  };
  const editedThisRun = (file) => touched.some((t) => sameFile(t, file));

  // ── 信号②：undefined / 未声明 —— 改名没同步调用方的下游症状 ──
  const CASCADE_RE = /undefined|not declared|cannot find|no such|未定义|未声明|无法找到/i;
  const cascadeSymbols = [...new Set(errors
    .map((p) => /(?:undefined|not declared|cannot find)\s*:?\s*([A-Za-z_][A-Za-z0-9_]*)/i.exec(String(p.message || ""))?.[1])
    .filter(Boolean))];

  const root = [], cascade = [], rest = [];
  for (const group of byFile.values()) {
    if (editedThisRun(group.file)) root.push(group);
    else if (group.items.every((p) => CASCADE_RE.test(String(p.message || "")))) cascade.push(group);
    else rest.push(group);
  }

  const render = (group) => {
    const lines = [...new Set(group.lines)].sort((a, b) => a - b);
    const shown = lines.slice(0, 8).join("、") + (lines.length > 8 ? ` …共 ${lines.length} 处` : "");
    const first = String(group.items[0].message || "").slice(0, 110);
    return `  · ${group.file}（第 ${shown} 行）${group.items.length > 1 ? ` ${group.items.length} 条，首条：` : "："}${first}`;
  };

  const out = [`[LOCALIZED] 编译器已经把位置算好了 —— ${errors.length} 条错误，${byFile.size} 个文件。不要再 grep / 满仓找，直接按下面走。`];

  if (root.length) {
    out.push(`\n【根因优先】这些文件**是你这一轮改过的**，最可能是病灶：\n${root.map(render).join("\n")}`);
    if (cascade.length) {
      out.push(`\n【很可能是下游】这些文件你没动过，报的却是「未定义/找不到」${cascadeSymbols.length ? `（${cascadeSymbols.slice(0, 4).join("、")}）` : ""}：\n${cascade.map(render).join("\n")}`
        + `\n→ 这通常**不是独立的 bug**，而是上面那次改名/改签名没同步调用方。`
        + `**先把根因文件改对、然后重跑同一条命令**；这一组很可能自己就消失了。真要动它们之前，先用 find_symbol / lsp_references 把引用找齐，别在报错点逐个打补丁。`);
    }
  } else if (cascade.length) {
    out.push(`\n【符号找不到】${cascade.map(render).join("\n")}\n→ 先用 find_symbol / lsp_references 确认这些符号现在的真实定义位置和签名，再改调用方。`);
  }
  if (rest.length) out.push(`\n【其余】\n${rest.map(render).join("\n")}`);

  out.push(`\n【怎么做】① 只读上面点名的文件（read_file 只接受 path，没有行号参数——出错行是给你定位用的，读进来自己找）；`
    + `② 在**同一轮**里把能修的全部修完（同文件用 multi_edit，多文件就连着发多个编辑）；`
    + `③ 重跑同一条命令验证。不要一次只修一条、跑一次、再修下一条——上面这份清单已经完整，逐条来只是把一次修复摊成 ${errors.length} 个回合。`);
  return out.join("\n");
}
