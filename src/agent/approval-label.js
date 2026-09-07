/**
 * 审批弹框上那句话：标题 + 明细。
 *
 * # 为什么单独一个模块
 *
 * main.js 有一条尺寸闸，而这个函数是它里面**最干净的一大块**：166 行、一个 switch、
 * 除了传进来的 call 只碰一样外部东西（MCP 的快照表），没有 DOM、没有网络、没有模块级
 * 可变状态。判据照 mainlink / subagent-roles 那两次搬迁：唯一的外部依赖改成**从参数传**。
 *
 * # 为什么这些文案值得较真
 *
 * 一个没有信息的框（"执行该操作？"）只会让人闭着眼睛点同意——那时候这道门就只剩摩擦、
 * 不剩保护。所以每一个会弹框的工具都必须在这里有自己的文案，而且要把**代价最大的那件事**
 * 摆在明细里：会覆盖哪个文件、会往工作区铺什么、命令会重复跑多少次。
 * test/logic.test.mjs 里那条「每个会弹审批框的工具都得有自己的文案」正在钉这件事。
 */

export function approvalLabel(call, deps = {}) {
  const { mcpSnapshot } = deps;
  switch (call.type) {
    case "cmd": case "termtask": return { title: "运行命令？", detail: "$ " + (call.command || "") };
    case "write": return { title: "写入文件？", detail: call.path || "" };
    case "edit": case "multiedit": return { title: "修改文件？", detail: call.path || "" };
    case "delete": return { title: "删除（不可恢复）？", detail: call.path || "" };
    case "move": return { title: "移动 / 重命名？", detail: (call.path || "") + "  →  " + (call.to || "") };
    case "copy": return { title: "复制？", detail: (call.path || "") + "  →  " + (call.to || "") };
    case "mkdir": return { title: "新建目录？", detail: call.path || "" };
    // 只有带 _wiki 的那次落盘会走到这里（纯调研的 subagent 不弹框）。框上必须写清楚
    // **要覆盖哪个文件**——路径是模型给的，默认 PRODUCT_WIKI.md，但传 README.md 就
    // 把 README 覆盖掉；只写「执行该操作？」等于让用户闭着眼睛点。
    case "subagent": return {
      title: "把生成的 Wiki 写进工作区？（整份覆盖）",
      detail: (call.path || call.wikiDest || "PRODUCT_WIKI.md") + "\n\n这个路径由模型指定；写入是整份替换，不是追加。",
    };
    // 这两个是 2026-08-30 补登记的，补完就必须配文案——一个没有信息的框只会让人闭着
    // 眼睛点同意。worker 派的是**可写**子体（mode 被改写成 agent），框上要写清它能动哪些
    // 文件；background_monitor 只有 check_type=command 会走到这里，那一支是把模型给的
    // pattern 原样交给 shell、还按轮询节奏重复跑几十上百次，次数必须摆出来。
    case "worker": return {
      title: "派一个会写文件的子体？",
      detail: `${String(call.description || "实现子任务").slice(0, 160)}\n\n它以 agent 身份跑，会直接改工作区${Array.isArray(call.scope) && call.scope.length ? `（限定在：${call.scope.slice(0, 6).join("、")}）` : "（未限定范围）"}。`,
    };
    case "background_monitor": return {
      title: "让后台监控反复跑这条命令？",
      detail: `$ ${String(call.pattern || "").slice(0, 200)}\n\n它会每隔几秒重跑一次直到 exit 0 或超时，整个等待期内可能执行几十到上百次。`,
    };
    case "saveskill": return { title: "保存为技能？", detail: `${call.name || ""}\n${String(call.description || "").slice(0, 160)}\n→ ${call.path || ""}` };
    // learn_design 会往工作区**真的写两个文件**（一份设计体系说明、一份 token CSS），
    // 路径由被学的站点名派生。框上要把这两个落点摆出来——只写「执行该操作？」等于
    // 让用户闭着眼同意两次写盘。
    case "learndesign": {
      const _slug = String(call.name || call.url || "").replace(/^https?:\/\//, "").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "site";
      return {
        title: "学习这个站点的设计体系？（会往工作区写两个文件）",
        detail: `${call.url || ""}\n→ reference/${_slug}-design-system.md\n→ reference/${_slug}-tokens.css`,
      };
    }
    // 定时任务是一条**将来会在没人看着时被执行的常驻指令**。框上必须把两件事摆出来：
    // 什么时候跑、跑的时候会拿到哪句话。只写「新建定时任务？」等于让用户闭着眼点同意
    // 一件他事后才会看见后果的事。
    case "schedule": return {
      title: call.action === "add" ? "排一条定时任务？（到点会在没人看着时自己跑）" : "删掉这条定时任务？",
      detail: call.action === "add"
        ? `${call.everyMinutes > 0 ? `每 ${call.everyMinutes} 分钟` : `每天 ${call.at}`}\n\n到点时它会收到这句话：\n${String(call.prompt || "").slice(0, 400)}`
        : `#${call.id}`,
    };
    // MCP 服务就是一条任意命令行。框上必须把命令原文摆出来，否则用户等于闭着眼点同意。
    case "mcpconfig": return {
      title: call.action === "add" ? "把这个 MCP 服务写进你的配置？"
        : call.action === "remove" ? "从你的配置里删掉这个 MCP 服务？"
        : call.action === "enable" ? "启用这个 MCP 服务？" : "停用这个 MCP 服务？",
      detail: `${call.name || ""}${call.command ? `\n${call.command} ${(call.args || []).join(" ")}`.trimEnd() : ""}${call.url ? `\n${call.url}` : ""}${call.env && Object.keys(call.env).length ? `\nenv: ${Object.keys(call.env).join(", ")}` : ""}`,
    };
    case "format": return { title: "格式化文件？", detail: call.path || "" };
    case "automation": return { title: "桌面自动化？", detail: (call.method || "") + (call.params ? "  " + JSON.stringify(call.params).slice(0, 120) : "") };
    case "uiclick": return { title: "操作应用界面？", detail: `${call.action || "press"} ref=${Number.isInteger(call.ref) ? call.ref : "?"}` };
    // 代价最大的那件事要摆在明细里：connect 之后**所有**文件读写、删除、改名、搜索和
    // 命令都落在那台机器上，本机什么都不会变——弹框上不说清，用户点同意时以为只是"连一下"。
    case "remote": return String(call.op) === "connect"
      ? { title: "把读写和命令切到另一台机器？", detail: `${call.host || call.url || call.address || "(未给地址)"} —— 之后所有文件读写、删除、改名、搜索和命令都在那台机器上执行，本机不再变化；连接凭据会发给该地址` }
      : { title: "断开远程、切回本机？", detail: "之后的文件读写和命令回到本机执行" };
    case "download": return { title: "下载文件到工作区？", detail: (call.url || "") + "  →  " + (call.dest || "") };
    case "db": return { title: `执行数据库操作（${call.driver || "db"}）？`, detail: (call.query || "").slice(0, 300) };
    case "gh": return {
      title: call.op === "pr_create" ? "在 GitHub 上创建 Pull Request？" : "用你的账号在 GitHub 上发表评论？",
      detail: `${call.owner || ""}/${call.repo || ""}${call.number ? ` #${call.number}` : ""}\n${String(call.title || call.body || "").slice(0, 240)}`,
    };
    case "http": return { title: `发送 ${String(call.method || "GET").toUpperCase()} 请求？`, detail: String(call.url || "").slice(0, 300) };
    // 下面四个 2026-08-17 才进审批门。框上必须说清**这一次**要干什么：browser 的
    // "点一下链接"和"把 ~/.ssh/id_rsa 传上去"是同一个工具的两个 action，只写"浏览器操作？"
    // 等于让用户闭着眼睛点同意。
    case "browser": {
      const act = String(call.action || "");
      const what = {
        eval: "在页面里执行任意 JavaScript？",
        cookies: "读取该站点的全部 Cookie（含登录态）？",
        storage: "读取该站点的 localStorage？",
        upload: "把本机文件上传到该网页？",
        autofill: "替你填写表单并提交？",
        click: "在页面上点击？",
        type: "在页面里输入文字？",
        navigate: "打开网址？",
      }[act] || `浏览器操作（${act || "?"}）？`;
      const extra = act === "upload"
        ? (Array.isArray(call.paths) ? call.paths : [call.path]).filter(Boolean).join("\n")
        : String(call.script || call.text || call.selector || "").slice(0, 240);
      return { title: what, detail: [String(call.url || ""), extra].filter(Boolean).join("\n").slice(0, 400) };
    }
    case "docker_compose_up": return {
      title: "启动一整套容器（后台常驻）？",
      detail: `${call.path || "docker-compose.yml"}${Array.isArray(call.services) && call.services.length ? "\n服务：" + call.services.join(", ") : ""}`,
    };
    case "capture_replay": return {
      title: `重放请求：${String(call.method || "GET").toUpperCase()}？`,
      detail: String(call.url || "").slice(0, 300),
    };
    // 会弹框的只有 evaluate / continue：前者在真实栈帧里执行一段表达式（可以带副作用），
    // 后者放走一个停着的进程。框上必须写出是哪一种、表达式是什么，否则就是闭眼点同意。
    case "debug": return {
      title: call.op === "evaluate" ? "在调试器里求值这个表达式？" : "让被调试的进程继续跑？",
      detail: (call.op === "evaluate" ? String(call.expression || "") : "继续执行，等下一次停顿").slice(0, 300),
    };
    case "system": return {
      title: "操作系统 / 其它应用？",
      detail: `${call.action || call.op || "?"} ${String(call.app || call.target || call.item || "")}`.trim().slice(0, 300),
    };
    case "tor": return { title: "经 Tor 网络发送请求？", detail: String(call.url || "").slice(0, 300) };
    // 关键信息是「改不改系统代理」，不是工具名：改了的话整台机器的流量都会走本地
    // mitmproxy，接着还要用户 sudo 装一张根证书。这必须写进 detail。
    case "capture_start": return {
      title: call.systemProxy ? "修改系统代理并开始抓包？" : "开始抓包？",
      detail: call.systemProxy
        ? "整台机器的网络流量（浏览器 / 邮件 / 其他 App）都会经过本地代理，且需要安装根证书。"
        : `端口 ${call.port || "?"}`,
    };
    case "createproject": return { title: "新建项目目录并切换工作区？", detail: `~/MrDayOne/${call.name || call.path || ""}` };
    case "genimage": return { title: "生成图片并写入工作区？", detail: `${call.prompt || ""}\n→ ${call.name || call.path || "(自动命名)"}` };
    // office_write 新建 xlsx / docx / pptx；office_edit 默认覆盖原文件，另存时把两个路径都摆出来。
    case "office_write": return { title: "生成 Office 文档并写入工作区？", detail: `→ ${call.dest || ""}` };
    case "office_edit": return { title: "修改工作区里的 Office 文档？", detail: `${call.path || ""}${call.dest && call.dest !== call.path ? `\n→ ${call.dest}` : "（覆盖原文件）"}` };
    // visual_explain 和 genimage 走同一个后端，png 落在 <root>/.mrdayone-images/explain-*.png。
    case "explain": return { title: "生成讲解图片并写入工作区？", detail: String(call.concept || call.prompt || call.question || "").slice(0, 200) };
    // stop_demo 把录制结果写成 HTML，路径由模型给（允许绝对路径，只建不覆盖）。
    case "demostop": return { title: "把演示录像写成文件？", detail: `→ ${call.path || "(默认路径)"}` };
    case "generate_3d": case "generate_texture": case "generate_motion": case "auto_rig":
      return { title: "生成素材并写入工作区？", detail: `${call.type} · ${(call.prompt || call.name || "").slice(0, 200)}` };
    case "generate_sound": case "generate_music": case "generate_voice":
      return { title: "生成音频并写入工作区？", detail: `${call.type} · ${(call.prompt || call.text || "").slice(0, 200)}` };
    case "download_asset": return { title: "下载素材到工作区？", detail: `${call.url || ""}\n→ ${call.name || ""}` };
    case "game_scaffold": case "web_scaffold":
      // 这两个是直接铺一整棵项目树，最该说清会往哪儿写多少东西。
      return { title: "生成整套项目脚手架？", detail: `${call.type === "game_scaffold" ? "游戏" : "网站"} · ${call.engine || call.framework || ""} · ${call.name || ""}\n会在工作区里创建一整套目录和文件。` };
    // 这个框是用户**做决定**的地方，也是目前唯一告诉他"这次要干嘛"的地方——
    // 只给 服务/工具 两个名字，等于让人闭着眼睛点同意。带上服务自己写的能力说明
    // （已过 _mcpDescriptionBody 消毒；它是第三方文本，所以明说来源）。
    case "userfolder": {
      const d = call.userDef;
      return {
        title: "检索你接入的知识库？",
        detail: `${call.userName || "?"}（目录 ${d?.folder?.path || "?"}）`
          + (d?.source ? `\n声明来自：${d.source}` : ""),
      };
    }
    case "userhttp": {
      // 审批框里必须说清楚**这条声明是哪来的**：它可能来自 clone 来的仓库里的配置文件，
      // 而它能往任意 http(s) 地址发请求。只写工具名，用户无从判断该不该点同意。
      const d = call.userDef;
      return {
        title: "调用你接入的能力？",
        detail: `${call.userName || "?"}（${d?.http?.method || "GET"} ${d?.http?.url || "?"}）`
          + (d?.source ? `\n声明来自：${d.source}` : "")
          + (d?.description ? `\n用途：${String(d.description).slice(0, 160)}` : ""),
      };
    }
    case "mcp": {
      let d = "";
      try {
        const snap = typeof mcpSnapshot === "function"
          ? mcpSnapshot(String(call.mcpRoot || "").replace(/\/+$/, ""))
          : null;
        d = snap?.toolMap?.get?.(call.mcpName)?.descBody || "";
      } catch {}
      return { title: "执行 MCP 工具？", detail: `${call.server || "?"}/${call.tool || call.mcpName || "?"}`
        + (call.mcpReadOnly ? "\n服务声明：readOnlyHint=true（仅作提示，仍需授权）" : "")
        + (d ? `\n服务自述（第三方文本）：${String(d).slice(0, 200)}` : "") };
    }
    case "git": {
      const title = call.op === "clone" ? "克隆 Git 仓库？"
        : call.op === "push" ? "推送 Git 分支到远程？"
          : call.op === "pull" ? "拉取并合并远程分支？"
            : call.op === "commit" ? "创建 Git 提交？" : "执行 Git 写操作？";
      const detail = call.op === "clone" ? `${call.source || ""}\n→ ${call.target || ""}`
        : call.op === "commit" ? (call.message || "") : (call.branch || call.op || "");
      return { title, detail };
    }
    default: return { title: "执行该操作？", detail: call.path || call.type };
  }
}
