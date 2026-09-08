import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "src/main.js"), "utf8");

/**
 * 读屏结果给模型的那份不许带缩进。
 *
 * 这不是省 token 的洁癖，是**能不能看见目标控件**的问题。下游 _toolMsgForModel 按字符切，
 * 而 _headTailModelText 挖的是中段——正文控件通常就在中段。实测同一批 500 个元素：
 * 缩进版 182 字符/元素，紧凑版 100 字符/元素，缩进白烧掉 82%，换来的全是被挖空的元素。
 *
 * 面板那份照旧缩进，那是给人看的——所以这里要钉的是「两份不是同一个」。
 */
test("读屏给模型的那份不带缩进，给人看的那份才带", () => {
  // 锚到锚，不切固定字数：原来是 `slice(at, at + 1200)`，而 content 那一行躺在第 1213 个
  // 字符上——正文往里加了一句注释，这条断言就落在窗口外，报的是"喂给模型的不是紧凑那份"
  // （功能好好的）。固定窗口切源码在这个仓库反复失效，一律改成锚到锚。
  const at = SRC.indexOf('const _rsPayload =');
  assert.ok(at > 0, "read_screen 的结果拼装找不到了");
  const end = SRC.indexOf("} catch (error) {", at);
  assert.ok(end > at, "read_screen 那段的结尾锚点没了");
  const body = SRC.slice(at, end);

  assert.ok(
    /const structured = JSON\.stringify\(_rsPayload\);/.test(body),
    "给模型的那份又带上缩进了——500 个元素会有九成被从中段挖掉",
  );
  assert.ok(
    /const structuredForView = JSON\.stringify\(_rsPayload, null, 2\);/.test(body),
    "给人看的那份不带缩进了，面板会变成一坨",
  );
  // 真正决定成败的是 content 里放的是哪一个。放错了上面两条都绿，功能照旧坏。
  // 不钉整行：这行结尾后来续上了标注图和"这是你正在开发的应用"两段，原来那个要求
  // `${structured}` 后面紧跟反引号的正则于是不匹配了，报的却是"喂给模型的不是紧凑那份"。
  // 判据只要两条：正文接的是 structured，且缩进那份一个字都没进去。
  assert.ok(
    /content: `read_screen 真实结果：\\n\$\{structured\}/.test(body),
    "喂给模型的不是紧凑那份",
  );
  const contentLine = body.slice(body.indexOf("return { type: \"readscreen\""));
  assert.ok(
    !contentLine.includes("structuredForView"),
    "缩进那份混进了给模型的 content——500 个元素会有九成被从中段挖掉",
  );
  assert.ok(
    /_escHtml\(structuredForView\.slice\(0, 24000\)\)/.test(body),
    "面板显示的不是缩进那份",
  );
});

/**
 * 读屏结果不许落进 8000 那一档。
 *
 * 8000 字符约等于 40 个元素。后端一次最多给 500 个，于是 Chrome / Electron 这类
 * 真实界面会被砍掉九成——而那恰恰是桌面自动化最常见的目标。模型看不到要点的控件，
 * 就去重读同一份被挖空的结果、转 OCR、或者猜坐标，每一次都再付一整轮往返。
 * 用户那句「桌面自动化很烂不好用」有一半是这么来的。
 */
test("读屏和 ui_extract 的结果不吃 8000 那一档", () => {
  const at = SRC.indexOf("const _cap =");
  assert.ok(at > 0, "_cap 分档不见了");
  const tiers = SRC.slice(at, SRC.indexOf("const rawMessage", at));

  assert.ok(
    /_rt === "readscreen" \|\| _rt === "uiextract" \? 30000/.test(tiers),
    "读屏结果又掉回 8000 档了——500 个元素只有约 40 个到得了模型",
  );
  // 分档是从上往下短路的：这一条必须排在兜底的 `: 8000` 前面，写在后面等于没写。
  const mine = tiers.indexOf('_rt === "readscreen"');
  const fallback = tiers.indexOf(": 8000");
  assert.ok(mine > 0 && fallback > 0, "分档结构变了，判据要跟着改");
  assert.ok(mine < fallback, "读屏那一档排在兜底 8000 后面，短路不到它");
});

/**
 * 紧凑序列化 + 那一档合起来，必须真的把「到达模型的元素数」抬上去。
 *
 * 上一版这条测试**一个字节 main.js 都没读**：它自己造 payload、自己写死 8000 和 30000，
 * 量的是我对算术的假设，不是代码。写法对而代码被改回去时它照样绿——那正是它声称要防的。
 *
 * 这一版把两个事实都**从源码里取**：档位的数字，和给模型那份到底带不带缩进。
 * 谁把档位调回 8000、或者把 JSON.stringify 加回 null,2，这条就会红。
 */
test("改完之后到达模型的元素数确实上去了（两个事实都从源码取）", () => {
  const tiers = SRC.slice(SRC.indexOf("const _cap ="), SRC.indexOf("const rawMessage"));
  const capMatch = tiers.match(/_rt === "readscreen" \|\| _rt === "uiextract" \? (\d+)/);
  assert.ok(capMatch, "读屏那一档不见了，取不到真实的字符预算");
  const cap = Number(capMatch[1]);

  const rs = SRC.slice(SRC.indexOf("const _rsPayload ="), SRC.indexOf("const _rsPayload =") + 1200);
  const modelLine = rs.match(/const structured = JSON\.stringify\(_rsPayload([^)]*)\);/);
  assert.ok(modelLine, "取不到给模型那份的序列化写法");
  const indented = modelLine[1].includes("null");

  const element = (i) => ({
    ref: i + 1, role: "Button", text: "打开设置面板",
    x: 120 + i, y: 340 + i, w: 88, h: 24, value: "", enabled: true,
  });
  const payload = {
    source: "ax",
    elements: Array.from({ length: 500 }, (_, i) => element(i)),
    limitations: [],
  };
  const text = indented ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
  // _headTailModelText 的实际形状：留一段头、一段尾，中间换成一个标记。
  const marker = 133;
  const head = Math.ceil((cap - marker) * 0.45);
  const tail = cap - marker - head;
  const reach = Math.floor((head + tail) / (text.length / 500));

  // 基线：改动前是缩进 + 8000 档，实测约 43 个。
  const before = Math.floor(
    ((Math.ceil((8000 - marker) * 0.45)) + (8000 - marker - Math.ceil((8000 - marker) * 0.45)))
      / (JSON.stringify(payload, null, 2).length / 500),
  );
  assert.ok(before < 60, `基线不对：改动前应该只有几十个元素能进，实际 ${before}`);
  assert.ok(
    reach > 250,
    `按源码里的真实写法算，只有 ${reach} 个元素到得了模型（基线 ${before}）。`
      + `档位=${cap}，给模型那份${indented ? "带" : "不带"}缩进——两处至少有一处被改回去了。`,
  );
});
