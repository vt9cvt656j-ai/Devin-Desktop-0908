/**
 * 子智能体的**角色策略**：每个角色多拿哪些工具、能跑几轮。
 *
 * 从 main.js 抽出来的第二块。选它的判据和第一块（mainlink）一样：**边界干净**——
 * 纯数据 + 纯函数，没有 DOM、没有模块级可变状态，唯一的外部依赖（用户自声明的角色表，
 * 它要读工具注册表）改成从参数传。
 *
 * 参照 Claude Code：subagent 的 `tools:` 和 `maxTurns` 是**每个 agent 自己声明**的，
 * 角色 = 提示词 + 工具集 + 轮数，不是只有提示词。这个文件就是那份声明。
 *
 * 搬出来之后，原本靠「从 main.js 源码抠函数文本再 new Function」跑的那几组测试
 * 可以直接 import 产品代码——抠源码验得到行为，验不到「这个函数在真实调用链上还在不在」。
 */

// Role → the specialist capabilities that role genuinely needs beyond the shared read
// set — the actual "flexible use of multiple roles" tool matrix, not just prompt text.
// Before this, every role got the identical toolset and only the SYSTEM PROMPT differed:
// a `design` worker and a `database` worker were handed the same tools, so "design" could
// not open a browser to check its UI and "database" could not query a db. The model
// DECLARES the role in run_worker/run_subagent; the harness gives it the matching tools.
//
// Every name below is produced by _buildAgentToolSchemas(true) and every type is a real
// mapper type — both verified — because a tool NAME must survive the _allow filter AND its
// TYPE must be in the child's _execTypes or the dispatcher rejects it. Side-effect tools
// (browser can eval/upload, db/http reach outside the workspace) go ONLY to write workers;
// a read-only child stays on the read+web set, preserving the deliberate read-only browser
// exclusion. Unknown roles get nothing extra (the base set already covers general work).
export const ROLE_CAPABILITIES = {
  frontend: { tools: ["browser", "generate_image"], types: ["browser", "genimage"] },
  design:   { tools: ["browser", "generate_image"], types: ["browser", "genimage"] },
  backend:  { tools: ["db_query", "http_request"],  types: ["db", "http"] },
  database: { tools: ["db_query"],                  types: ["db"] },
  devops:   { tools: ["docker_compose_up"],         types: ["docker_compose_up"] },
  security: { tools: ["http_request"],              types: ["http"] },
  test:     { tools: ["browser"],                   types: ["browser"] },
};
// **只读子体的角色矩阵。**
//
// 上面那张 _ROLE_CAPABILITIES 只对 write worker 生效，而 run_subagent /
// spawn_multiple_agents 派出去的**全部**子体 write=false —— 于是 architect / product /
// research / frontend / backend / database / security / test / devops / design / docs
// 这 11 个角色拿到的工具**逐字相同**，角色的全部效力就是一段人格文字。
//
// 真正咬人的是工具 schema 在替它撒谎：那 11 个名字被列成可选的
// "read-only specialist perspective"，主智能体据此以为派一个 design 角色去看页面可行，
// 而只读子体连 browser 都没有；backend 角色没有 db_query。
//
// 参照 Claude Code 的做法：每个 agent 类型有自己的 `tools:` 白名单，角色 = 提示词 + 工具集，
// 不是只有提示词。这里给只读角色配上**只读语义下真的用得上**的那几件，并在派发闸上按
// 调用二次把关（和 git / gh / MCP 那三条同一个形状：单 type 多行为，type 放行后逐次判）。
//
// 基础只读集已经很宽（read/search/lsp/diag/logs/screenshot/read_screen/ui_extract/
// view_image/probe_env/git 只读/gh 只读/各种检索），所以这里只补基础集**没有**的那几件。
// 补不出东西的角色（architect / product / research / devops / docs）不列——
// 它们的差异本来就在视角而不在工具，硬凑等于又造一份假清单。
// **每个角色的轮数预算。** 参照 Claude Code：subagent 的 `maxTurns` / `model` / `effort`
// 是**每个 agent 自己在 frontmatter 里声明**的，而不是全局一个常数。
//
// 这里只调轮数，不动模型和推理档——后两样会改变计费口径，得单独作为一次产品决定来做。
// 轮数是纯预算：给得少了子体查不完就被截断（那份中间状态对父体几乎没用，钱照付），
// 给得多了慢角色会占着并发槽。所以按**这个角色实际要走几步**给：
//   · 调研/架构/安全这类要顺着线索一路读下去的，基准不够用；
//   · 文档/产品这类目标明确、读几个文件就能下结论的，给基准就够。
// 没列的角色走基准值。上限 40 是硬顶：再多说明任务该拆，不该靠加轮数硬扛。
export const ROLE_TURN_BUDGET = {
  research: 28,   // 顺线索一路读，最容易撞上限
  architect: 26,  // 要把调用链走完才能谈结构
  security: 26,   // 要顺着数据流一路查到边界
  backend: 24,
  frontend: 22,
  database: 22,
  test: 22,
  devops: 20,
  design: 20,
  product: 16,    // 目标明确，读几个文件就该下结论
  docs: 16,
};

export const ROLE_CAPABILITIES_READ = {
  // 看得见页面才谈得上前端/设计/测试视角。browser 只放行观察类动作（见下面派发闸）。
  frontend: { tools: ["browser", "visual_compare"], types: ["browser", "vizcompare"] },
  design:   { tools: ["browser", "visual_compare"], types: ["browser", "vizcompare"] },
  test:     { tools: ["browser"],                   types: ["browser"] },
  // 查得到数据才谈得上后端/数据库视角。只放行不改数据的查询（见下面派发闸）。
  backend:  { tools: ["db_query"],                  types: ["db"] },
  database: { tools: ["db_query"],                  types: ["db"] },
  // 安全视角要看得到真实流量：capture_flows 读的是**已经抓到的**请求，纯读取。
  security: { tools: ["capture_flows"],             types: ["capture_flows"] },
};

export function roleCapabilities(role, write, userRoleMap = null) {
  if (!write) {
    const key = String(role || "").trim().toLowerCase();
    const caps = ROLE_CAPABILITIES_READ[key];
    return caps ? { tools: [...caps.tools], types: [...caps.types] } : { tools: [], types: [] };
  }
  const key = String(role || "").trim().toLowerCase();
  // 用户声明优先：他为自己项目定义的 `data` 角色，比内置的同名角色更贴他的活。
  // 用户角色表要读工具注册表，那是 main.js 的东西——所以**从参数传进来**，
  // 模块本身不认识它。和 mainlink 把 store 当参数是同一个规矩：
  // 模块要能被测试拿一份干净的数据直接驱动，而不是去 stub 一个全局。
  const mine = userRoleMap ? userRoleMap.get(key) : null;
  if (mine) return { tools: [...mine.tools], types: [...mine.types] };
  /*
   * 可写矩阵是只读矩阵的**超集**，不是它的兄弟表。
   *
   * 两张表是分两次写的：ROLE_CAPABILITIES 先有，后来发现 run_subagent 派出去的子体
   * 全是 write=false、于是补了 ROLE_CAPABILITIES_READ ——补完没有回头并进可写那张。
   * 结果是反的：能动手修的那一档反而看不到证据。
   *   · frontend / design 的可写 worker 拿不到 visual_compare，
   *     而它才是那个改完 UI、需要比对改前改后截图的人；
   *   · security 的可写 worker 拿不到 capture_flows，
   *     而它才是那个要照着真实流量去改代码的人。
   * 两件工具都是纯读取（visual_compare 比图，capture_flows 读**已经抓到的**请求），
   * 没有任何安全理由把它们挡在写侧之外。
   *
   * 所以这里取并集，并且**判据写成不变量**：任何角色的可写工具集必须包含它的只读工具集。
   * 测试钉着这条，以后再往只读那张表加东西，不并进来就会红。
   */
  const spec = ROLE_CAPABILITIES[key];
  const read = ROLE_CAPABILITIES_READ[key];
  if (!spec && !read) return { tools: [], types: [] };
  return {
    tools: [...new Set([...(read?.tools || []), ...(spec?.tools || [])])],
    types: [...new Set([...(read?.types || []), ...(spec?.types || [])])],
  };
}

/**
 * 把「这个角色跑在哪个模型」的注记并进子智能体简报，**不动第 0 位的状态前缀**。
 *
 * 原来是无条件前置（`${note}\n\n${report}`）。而简报的状态前缀是被四处**锚在开头**的
 * 正则消费的：
 *   · job.status 分类两处 —— /^\[TIMEOUT\]/ → "timeout"、/^\[ERROR\]/ → "failed"；
 *   · generate_wiki 的落盘闸 —— `report && !/^\[ERROR\]/.test(report) && root`；
 *   · failDigest 那条 —— /^\[ERROR\]/。
 * 前置一条 `[role:…]` 之后，`/^\[/` 仍然为真（所以简报照常交出去，看不出异样），
 * 但 `/^\[ERROR\]/` 全部落空。后果是：**一个报错的子智能体被判成 done**，
 * await_subagent 和自动交付都打「完成」标签；而 wiki 那条更狠——报错正文被当成 wiki
 * 正文写进磁盘，dest 由模型给，传 README.md 就把 README 覆盖掉。
 *
 * 这正是同一段代码上面那条注释已经写明、却在三行之后自己踩进去的坑。
 * 有前缀时插到**首行之后**：状态前缀留在原位，父体照样第一眼看得见换没换模型。
 */
export function withRoleNote(report, note) {
  const body = String(report || "");
  const tag = String(note || "");
  if (!tag || !body || body.includes(tag)) return body;
  if (!/^\[/.test(body)) return `${tag}\n\n${body}`;
  const nl = body.indexOf("\n");
  return nl < 0 ? `${body}\n\n${tag}` : `${body.slice(0, nl)}\n${tag}${body.slice(nl)}`;
}
