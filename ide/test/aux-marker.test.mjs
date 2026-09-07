// 辅助调用（意图裁决 / 快通道）向网关报身份：x-ide-aux。
//
// 网关据此关掉推理、不抬 max_tokens。生产 14 天实测：客户端把档位封到 low 之后，DeepSeek 平均
// 仍输出 3,211 token、Qwen 3,364、Grok 4,651、Omen 中位数卡在 4,996 的上限——JSON 本身只有
// 900 的上限。推理把预算烧光、正文零字，就是「裁决一半落不了地」的机制。老版客户端没有这个头，
// 网关按「有 run-id、无 mode、max_tokens ≤ 1024」三条认；新版显式带，判据不再靠猜。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fnSource, CODE } from "./helpers/source.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

test("请求头构建器把 ideAux 发成 x-ide-aux", () => {
  assert.match(CODE, /if \(config\.ideAux\) _h\["x-ide-aux"\] = String\(config\.ideAux\);/,
    "没有这个头，网关只能按三条启发式认辅助调用");
});

test("桌面端：ai.rs 把 ideAux 转成同一个头（桌面端的请求头全在 Rust 里造，JS 那个构建器管不到它）", () => {
  // 上线一小时的实测：桌面端的辅助调用到网关时没有 x-ide-aux，也没有 x-mide-client，
  // 网关只能按 max_tokens 猜；而客户端给声明有推理的模型加了 4096 余量，裁决在线路上是
  // 900+4096=4996——「≤1024 才算辅助调用」一次都没命中，deepseek-v4-pro 照样烧满 4996。
  // 显式头是唯一不用猜的判据，桌面端必须把它发出去。
  const tauri = readFileSync(join(HERE, "../src-tauri/src/ai.rs"), "utf8");
  assert.match(tauri, /pub ide_aux: Option<String>,/,
    "AiConfig 里没有 ideAux 这一位——serde 会把 JS 传过来的值静默丢掉");
  assert.match(tauri, /rb\.header\("x-ide-aux", aux\)/,
    "桌面端没发 x-ide-aux——网关只能按 max_tokens 猜，输入框预热那一发猜不出来");
});

test("意图裁决和快通道都报了身份，且紧挨着档位封顶那一行", () => {
  const intent = fnSource("_aiIntentProfile", { code: true });
  assert.match(intent, /intentConfig\.reasoningEffort = auxEffortFor\(config\);\s*intentConfig\.ideAux = "intent";/,
    "意图裁决没报 x-ide-aux");
  const fast = fnSource("_fastRoutingFlags", { code: true });
  assert.match(fast, /cfg\.reasoningEffort = auxEffortFor\(config\);\s*cfg\.ideAux = "fastroute";/,
    "快通道没报 x-ide-aux");
});

test("主循环那条不带 ideAux——它就是要用户选的推理档位", () => {
  const turn = fnSource("_agentModelTurn", { code: true });
  assert.doesNotMatch(turn, /ideAux/, "主循环被标成辅助调用，推理会被网关关掉");
});
