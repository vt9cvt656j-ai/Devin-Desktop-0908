// 自动保存的 CAS 写入：只送旧全文的 sha256，不送旧全文本身。
//
// 原来一次 invoke 里塞「磁盘旧全文 + 新全文」两份原文 —— 5MB 的文件约等于 8.6MB JSON，
// 还要按 JSON 规则转义再解析，光序列化就比写盘贵。而这条路挂在打字停顿上。
//
// 这个文件守两件事，都是**行为**：
//   ① 有哈希命令时走哈希、并把返回的 sha 缓存起来（下一轮连算都不用算）；
//   ② 后端没有这个命令时**必须**退回全文 CAS，而 [CONFLICT] 这类真结论不许被当成
//      「命令不存在」吞掉 —— 吞掉就等于拿旧全文再比一次，比中了就把别人的改动覆盖掉。
import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./helpers/source.mjs";

function mkBackend({ hashed = true, onHashed, onFull } = {}) {
  const calls = [];
  return {
    calls,
    hashedCasAvailable: () => hashed,
    writeTextFileIfUnchangedHashed: async (p, sha, content) => {
      calls.push({ kind: "hashed", p, sha, bytes: content.length });
      if (onHashed) return onHashed(p, sha, content);
      return "newsha";
    },
    writeTextFileIfUnchanged: async (p, expected, content) => {
      calls.push({ kind: "full", p, expectedBytes: expected.length, bytes: content.length });
      if (onFull) return onFull(p, expected, content);
    },
  };
}
// 真 sha256：注入进去当作 _sha256HexOrNull，省得在测试里拉 WebCrypto。
const fakeSha = async (text) => "sha-of-" + text.length + "-" + (text.charCodeAt(0) || 0);

function mkCas(backend, { unsupported = false } = {}) {
  return load("_casWriteEditorFile", {
    backend,
    _hashedCasUnsupported: unsupported,
    _sha256HexOrNull: fakeSha,
  });
}

test("有哈希命令时只送哈希，不送旧全文", async () => {
  const backend = mkBackend();
  const cas = mkCas(backend);
  const expected = "x".repeat(5_000_000);
  const res = await cas("/a.txt", {}, expected, "new content");
  assert.equal(backend.calls.length, 1);
  assert.equal(backend.calls[0].kind, "hashed", "还在走全文 CAS");
  assert.equal(backend.calls[0].sha, await fakeSha(expected));
  assert.equal(res.sha256, "newsha", "后端回的 sha 要带回去给调用方缓存");
});

test("上一轮缓存的 sha 还对得上时，不重新算哈希", async () => {
  const backend = mkBackend();
  let computed = 0;
  const cas = load("_casWriteEditorFile", {
    backend, _hashedCasUnsupported: false,
    _sha256HexOrNull: async (t) => { computed++; return "sha-" + t.length; },
  });
  const expected = "hello world";
  await cas("/a.txt", { _diskSha256: "cached-sha", _diskShaContent: expected }, expected, "new");
  assert.equal(computed, 0, "缓存命中还去算了一遍哈希");
  assert.equal(backend.calls[0].sha, "cached-sha");
});

test("缓存的 sha 和当前内容对不上就重算——不许拿旧哈希去 CAS", async () => {
  const backend = mkBackend();
  const cas = mkCas(backend);
  // 判据是「_diskShaContent 是否等于此刻的 expected」，让内容自证；
  // 靠人工在各处重设 diskContent 时记得清缓存，漏一处就是一次莫名其妙的「保存失败」。
  await cas("/a.txt", { _diskSha256: "stale", _diskShaContent: "别的内容" }, "真内容", "new");
  assert.equal(backend.calls[0].sha, await fakeSha("真内容"), "用了过期的哈希");
});

test("后端没有这个命令：降级走全文 CAS，并且只降一次", async () => {
  let tries = 0;
  const backend = mkBackend({ onHashed: () => { tries++; throw new Error("unknown command: write_text_file_if_unchanged_hashed"); } });
  const cas = mkCas(backend);
  const r1 = await cas("/a.txt", {}, "old", "new");
  assert.equal(r1.sha256, null);
  assert.ok(backend.calls.some((c) => c.kind === "full"), "没退回全文 CAS");
  assert.equal(tries, 1);
});

test("[CONFLICT] 是真结论，必须原样抛——吞掉它会覆盖别人的改动", async () => {
  const backend = mkBackend({ onHashed: () => { throw new Error("[CONFLICT] file changed after it was read"); } });
  const cas = mkCas(backend);
  await assert.rejects(() => cas("/a.txt", {}, "old", "new"), /CONFLICT/);
  assert.ok(!backend.calls.some((c) => c.kind === "full"),
    "冲突被当成降级信号吞掉了：接着拿旧全文再比一次，比中就把别人的改动覆盖掉");
});

test("算不出哈希（网页壳没有 crypto.subtle）时退回全文 CAS，不能把保存判死", async () => {
  const backend = mkBackend();
  const cas = load("_casWriteEditorFile", {
    backend, _hashedCasUnsupported: false, _sha256HexOrNull: async () => null,
  });
  const res = await cas("/a.txt", {}, "old", "new");
  assert.equal(backend.calls[0].kind, "full");
  assert.equal(res.sha256, null);
});

test("远程/旧壳（hashedCasAvailable 为假）直接走全文 CAS", async () => {
  const backend = mkBackend({ hashed: false });
  const cas = mkCas(backend);
  await cas("/a.txt", {}, "old", "new");
  assert.equal(backend.calls[0].kind, "full");
});
