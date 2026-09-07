// 自动化「这一轮要不要跑」的判据：浏览器 / CDP / 桌面自动化 / 截图只在用户需要时才动手。
//
// 所有者 2026-09-07 的原话：「写完了网站你非要跑全自动化，用户也没提及」。事故的来路不是模型
// 犯傻，是 harness 自己在推：design_verification 模块要求「首次交付前跑完桌面+手机矩阵」、
// 交付事实块每轮追加「这一版还没人在浏览器里看过」、browser 的描述末尾写着「交付前用 viewport
// 查桌面和手机」、结局卡片再挂一枚「在界面上验一遍」——四处都不问用户要没要。
//
// 这里是唯一的判据来源。三档：
//   requested  —— 用户要求打开 / 查看 / 测试 / 操作页面或应用，或裁决声明了自动化 / 抓包；
//   diagnostic —— 用户报告了运行时或显示问题（报错、白屏、错位…），或裁决标了项目级排查：
//                 允许模型去看页面 / 屏幕以定位，但没有「交付矩阵」那套义务；
//   none       —— 纯写代码 / 改功能 / 问答 / 调研：不起浏览器、不截图、不读屏，交付后把
//                 「要不要在浏览器里检查」留给用户决定。
// 判据是**用户原话 + 裁决声明**，不是模型在循环里的自述；IDE 自己续上的一轮（后台通知）
// 沿用上一轮的档位，实时监听发起的那一轮固定是 diagnostic（它就是为一个已经发生的问题来的）。

/** 走自动化那条路的调用类型（_mapToolCall 的 type）。open / mytabs 不算：一个是交给用户自己的浏览器看，一个只读标题。 */
export const AUTOMATION_CALL_TYPES = new Set(["browser", "automation", "readscreen", "uiclick", "screenshot"]);

export const AUTOMATION_LEVELS = Object.freeze(["none", "diagnostic", "requested"]);

// 用户明确要求「看 / 跑 / 测 / 操作」的说法。宁可漏判也别把「做一个预览功能」这种需求当成要求预览：
// 所以「预览 / 运行 / 测试」都要带上动作语气（看一下 / 跑一下 / 帮我），裸名词不算。
const REQUEST_RE = new RegExp([
  "浏览器", "自动化", "抓包", "爬(?:取|虫|一下)", "截(?:个|张|一张)?图", "录屏",
  "帮我(?:点|打开|操作|登录|登陆|填|抓|下载|运行|跑|测|看看|试试|打开)",
  "打开(?:它|一下|页面|网页|网站|软件|应用|程序|app|这个)",
  "操作(?:一下)?(?:软件|应用|电脑|桌面|页面|网页|窗口|它)",
  "(?:点|按)(?:一下|击)", "登录一下", "登陆一下",
  "看(?:一)?(?:下|看|眼)(?:页面|效果|界面|网页|网站|成品|结果|实际)",
  "(?:跑|运行|启动)(?:一)?(?:下|遍)", "测(?:一下|一遍|试一下|测看)", "验收", "自测", "实测",
  "检查(?:一下)?(?:页面|界面|效果|网页|显示)", "(?:在|用)浏览器", "给我看(?:看|一下)",
  "open (?:it|the (?:page|site|app|browser)|a browser)", "in (?:the|a) browser", "test (?:it|this|the)",
  "run (?:it|the (?:app|site|server|project))", "check (?:it|the page|the ui|the site)", "screenshot",
  "click", "log ?in", "sign ?in", "scrape", "automat", "verify (?:it|the|in)", "see (?:it|how it looks)", "take a look",
].join("|"), "i");

// 用户报告了一个只有在运行时 / 界面上才看得见的问题：允许去看，但只是为了定位。
const DIAG_RE = new RegExp([
  "报错", "出错", "错误", "异常", "崩(?:溃|了)", "闪退", "卡(?:住|死)", "白屏", "黑屏", "不显示", "显示不",
  "看不到", "不出来", "没反应", "点不动", "点不了", "打不开", "加载不", "溢出", "错位", "挤在", "重叠", "遮住",
  "样式(?:不对|乱|错)", "布局(?:乱|不对|错)", "变形", "看起来(?:不|很|有)", "丑", "难看", "不对劲", "失败了", "跑不起来",
  "failed", "failing", "\\berror\\b", "exception", "crash", "broken", "doesn'?t work", "does not work", "not working",
  "not showing", "nothing happens", "blank (?:page|screen)", "overflow", "misaligned", "looks (?:wrong|off|bad)", "\\bbug\\b",
].join("|"), "i");

// 「继续 / 好的」这类续话：档位沿用上一轮。
const CONTINUATION_RE = /^(?:继续|接着来?|好的?|可以|行|嗯|ok|okay|yes|go on|continue|next|下一步|然后呢|再来|do it|please|来吧)[。！!.\s]*$/i;

/**
 * 算这一轮的档位。
 * @param {object} o
 * @param {string} o.text        用户这一轮的原话
 * @param {object} [o.profile]   裁决画像（desktopAutomation / browserAutomation / browserGoal / capture / debugProject …）
 * @param {string} [o.prevLevel] 上一轮的档位（会话里记着）
 * @param {object} [o.notice]    IDE 自己续上的一轮（background_monitor / live_watch …）
 * @returns {{ level: "none"|"diagnostic"|"requested", reason: string }}
 */
export function automationNeed({ text = "", profile = null, prevLevel = "none", notice = null } = {}) {
  const t = String(text || "").trim();
  const p = profile && typeof profile === "object" ? profile : {};
  const prev = AUTOMATION_LEVELS.includes(prevLevel) ? prevLevel : "none";
  if (notice && typeof notice === "object") {
    if (String(notice.source || "") === "live_watch") return { level: "diagnostic", reason: "live_watch" };
    return { level: prev, reason: "continuation" };
  }
  if (p.desktopAutomation || p.browserAutomation || p.capture
      || (p.browserGoal && p.browserGoal !== "none") || p.deliverySurface === "automation") {
    return { level: "requested", reason: "declared" };
  }
  if (REQUEST_RE.test(t)) return { level: "requested", reason: "asked" };
  if (DIAG_RE.test(t)) return { level: "diagnostic", reason: "reported_problem" };
  if (p.debugProject) return { level: "diagnostic", reason: "declared_debug" };
  if (CONTINUATION_RE.test(t) && prev !== "none") return { level: prev, reason: "continuation" };
  return { level: "none", reason: "not_asked" };
}

/** 这个调用在这一档下能不能走。open / mytabs 永远能走。 */
export function automationAllowed(level, call) {
  const type = String(call?.type || "");
  if (!AUTOMATION_CALL_TYPES.has(type)) return true;
  if (level && level !== "none") return true;
  if (type === "browser") {
    const act = String(call?.action || "");
    if (act === "open" || act === "mytabs") return true;
  }
  return false;
}

/** 被拦下时给模型的回执：事实 + 出路，不劝诫。 */
export function automationBlockedReceipt(call, { devServerUrl = "" } = {}) {
  const type = String(call?.type || "");
  const what = type === "browser" ? `browser ${call?.action || ""}`.trim()
    : type === "automation" ? `computer ${call?.computer?.action || call?.method || ""}`.trim()
    : type === "readscreen" ? "read_screen"
    : type === "uiclick" ? "ui_click"
    : type === "screenshot" ? "screenshot"
    : type;
  return `[AUTOMATION_NOT_REQUESTED] 没有执行 ${what}。这一轮用户没有要求打开、查看、测试或操作页面 / 应用（原话里没有这类要求），也没有报告运行时或显示上的问题，所以不启动浏览器、截图或桌面自动化——那会在他的电脑上开窗口、占用他的浏览器。把活交付完、说清改了什么；要不要在浏览器里检查，由用户决定（结尾会给他一个「在浏览器里检查一下」的选项${devServerUrl ? `，地址 ${devServerUrl}` : ""}）。如果不看页面就没法完成用户明确要求的事，在回复里说明原因，让用户来定。`;
}

/** 结局卡片的那条建议：改过界面、又没被要求验，把选择权交回用户。 */
export function offerToVerifySuggestion({ devServerUrl = "", uiTouched = false } = {}) {
  if (!uiTouched) return null;
  const where = devServerUrl ? `（${devServerUrl}）` : "";
  return {
    label: "在浏览器里检查一下页面",
    send: `打开浏览器检查一下刚改的页面${where}：桌面和手机两个宽度各看一遍，有问题直接修。`,
  };
}
