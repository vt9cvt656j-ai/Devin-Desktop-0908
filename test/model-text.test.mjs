// 给模型看的文本裁剪（src/agent/model-text.js）的真往返：头尾保留、报错行豁免、词法压缩、ANSI 剥离。
import assert from "node:assert/strict";
import test from "node:test";
import {
  _lexCompress, _IMPORTANT_LINE, _smartCompress, _stripAnsi, _headTailModelText, _foldAssistantText, _hasErrorLine, _clipPreservingErrors,
} from "../src/agent/model-text.js";

test("_headTailModelText：预算内原样；超预算头 45% 尾 55%，总长正好等于预算，标记说清是二次省略", () => {
  assert.equal(_headTailModelText("short", 300), "short");
  assert.equal(_headTailModelText("abc", 0), "");
  const src = "H".repeat(500) + "T".repeat(500);
  const out = _headTailModelText(src, 300);
  assert.equal(out.length, 300);
  assert.ok(out.startsWith("HHH") && out.endsWith("TTT"));
  assert.match(out, /再次\*\*省略过：原始结果共 1000 字/);
});

test("_foldAssistantText：折模型自己的旧回复，尾部（结论）多给，措辞不叫模型去重取", () => {
  const src = "A".repeat(500) + "Z".repeat(500);
  const out = _foldAssistantText(src, 400);
  assert.equal(out.length, 400);
  assert.match(out, /早先的回复太长/);
  assert.ok(!/重取/.test(out), "这段文本没有任何工具能取回，标记不能叫模型去重取");
  assert.ok((out.match(/Z/g) || []).length > (out.match(/A/g) || []).length, "结论在尾部，尾部要多于头部");
});

test("_hasErrorLine / _IMPORTANT_LINE：编译报错、测试失败主标记、TAP、errno 都算", () => {
  for (const line of ["Error: boom", "--- FAIL: TestX", "not ok 1 - foo", "ENOENT: no such file", "✕ renders", "3 failed, 2 passed"]) {
    assert.equal(_hasErrorLine(line), true, line);
  }
  assert.equal(_hasErrorLine("all green, 12 passed"), false);
  assert.equal(_IMPORTANT_LINE.test("TypeError: x is not a function"), true);
  assert.equal(_IMPORTANT_LINE.test("compiled successfully"), false);
});

test("_clipPreservingErrors：被裁掉中段里的报错行以豁免块追回，且不超预算；预算内原样；报错已在首尾时不重复", () => {
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i} of the log output here`);
  lines[150] = "Error: boom at src/x.js:12";
  const text = lines.join("\n");
  const out = _clipPreservingErrors(text, 1200);
  assert.ok(out.length <= 1200, `超预算：${out.length}`);
  assert.match(out, /〔截断豁免·错误关键行/);
  assert.ok(out.includes("Error: boom at src/x.js:12"));
  assert.equal(_clipPreservingErrors("tiny", 1200), "tiny");
  const plain = Array.from({ length: 300 }, (_, i) => `line ${i} of the log output here`);
  const headErr = ["Error: first line already visible", ...plain.slice(1)].join("\n");
  assert.ok(!/截断豁免/.test(_clipPreservingErrors(headErr, 1200)), "首尾本来就带着的报错不该再抄一遍");
});

test("_lexCompress：去尾空白、折叠 ≥3 次重复行；_smartCompress 超预算时保住 head/tail 和报错行", () => {
  assert.equal(_lexCompress("a  \nb\nb\nb\nb\nc"), "a\nb\n…（上一行重复了 4 次，已折叠）\nc");
  const many = Array.from({ length: 100 }, (_, i) => (i === 50 ? "error: something broke here" : `row ${i} fine`)).join("\n");
  const out = _smartCompress(many, 300);
  assert.ok(out.startsWith("row 0 fine"));
  assert.ok(out.endsWith("row 99 fine"));
  assert.ok(out.includes("error: something broke here"));
  assert.match(out, /行省略/);
  assert.equal(_smartCompress("x\ny", 300), "x\ny");
});

test("_stripAnsi：颜色和私有序列都剥掉，正文保留", () => {
  const ESC = String.fromCharCode(27);   // 写成字符码：源码里放真的控制字节会被各种工具吞掉或藏起来
  assert.equal(_stripAnsi(`${ESC}[31mred${ESC}[0m text ${ESC}[?25l`), "red text ");
  assert.equal(_stripAnsi(null), "");
});
