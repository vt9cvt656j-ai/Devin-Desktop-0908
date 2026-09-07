// 「这条 run_cmd 改了哪些文件」——把观测事实说给模型听。
//
// 执行器在命令前后各打一次文件监视器的点，拿到的是**绝对路径清单**，不是猜的
// （`_fsWatchDeltaSince` 返回 {changed, paths}）。这份清单 harness 自己一直在用：
// `_toolMutatesWorkspace`、`_commandWroteCode`、worker 写盘台账、idle-progress 四处。
// 但通往模型唯一读得到的 content 的路只有一条 —— 那句 `[可还原]`，而它被三道闸串着：
//
//   ① `purpose === "mutate"` 或命令被判成 workspace-write 才拍改动前快照。
//      于是 scaffold / install / verify / explore 一律拍不到 —— 而 `npm create vite`、
//      `cargo new`、`npx shadcn add`、`prettier --write` 全在这几档里。
//   ② 还要 `!_preCmdSnap.truncated`，而快照上限是 200 文件 / 2 MB，任何真实仓库都触顶。
//   ③ 还要 `result.code === 0` —— 命令失败但已经写了盘，这条腿直接关掉。
//
// 三道闸都是**「能不能撤销」**的前提，和**「改了哪些文件」**没有一点关系。后者跟着前者
// 一起消失，于是模型脚手架完一个项目，只收到 npm 的 stdout 和一句"已刷新文件树"，
// 接着 list_dir → list_dir → read_file 走三四个往返，去问执行器同一次调用里早就算出来的答案。
//
// 失败那一支更硬：`npm install` 装到一半报错，锁文件和 node_modules 已经变了，模型收到的
// 是「这条命令失败了」，没有任何一处说工作区已经不是原样 —— 「失败」和「什么都没发生」
// 又一次成了同一个返回值。

/** 绝对路径 → 相对工作区根的路径。拿不到根就原样返回。 */
function rel(p, root) {
  const s = String(p || "");
  const r = String(root || "");
  if (!s) return "";
  if (r && s.startsWith(r)) return s.slice(r.length).replace(/^[/\\]+/, "") || s;
  return s;
}

/**
 * @param paths  _fsWatchDeltaSince(...).paths（绝对路径）
 * @param root   工作区根
 * @param ok     命令是否成功退出。失败但已写盘时口径要变，否则「失败」和「没发生」不可区分。
 * @returns {{n:number, text:string}} n=0 时 text 为 ""
 */
export function changedPathsReport(paths, root = "", { max = 24, ok = true } = {}) {
  const list = [...new Set((Array.isArray(paths) ? paths : []).map((p) => rel(p, root)).filter(Boolean))];
  if (!list.length) return { n: 0, text: "" };
  const shown = list.slice(0, Math.max(1, max));
  const more = list.length - shown.length;
  // 成功和失败是两句不同的话。失败那句必须把"工作区已经变了"顶到最前面——模型下一步
  // 是重试还是回滚，取决于它知不知道这件事。
  const head = ok
    ? `这条命令改动了 ${list.length} 个文件（IDE 实测，不是推断）：`
    : `⚠️ 命令**失败了，但工作区已经被改过** ${list.length} 个文件——别按「什么都没发生」重试，先看清下面这些再决定继续还是回滚：`;
  return { n: list.length, text: `${head}\n${shown.join("\n")}${more > 0 ? `\n…还有 ${more} 个` : ""}` };
}
