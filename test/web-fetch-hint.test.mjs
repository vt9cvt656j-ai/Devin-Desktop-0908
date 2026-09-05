import test from "node:test";
import assert from "node:assert/strict";
import { webFetchNextStep } from "../src/agent/web-fetch-hint.js";

test("404/410：说清是地址不存在，给 site: 检索词，GitHub 域另给 github_search；不再劝换工具重抓", () => {
  const t = webFetchNextStep("HTTP 404", "https://docs.example.com/v2/guide/getting-started.html");
  assert.match(t, /地址不存在/);
  assert.match(t, /site:docs\.example\.com guide getting started/);
  assert.doesNotMatch(t, /github_search/);
  const g = webFetchNextStep("HTTP 410", "https://github.com/foo/bar/blob/main/README.md");
  assert.match(g, /github_search/);
  assert.match(g, /HTTP 410是服务端明确回的/);
});

test("401 / DNS / 超时各有各的下一步；其它原因返回空串让调用方沿用通用文案", () => {
  assert.match(webFetchNextStep("HTTP 401", "https://api.x.io/me"), /Authorization/);
  assert.match(webFetchNextStep("DNS 解析失败: no such host", "https://exampel.com/a"), /exampel\.com/);
  assert.match(webFetchNextStep("operation timed out", "https://x.io"), /重试一次/);
  assert.equal(webFetchNextStep("HTTP 500", "https://x.io"), "");
  assert.equal(webFetchNextStep("HTTP 403 (反爬拦截，无头浏览器也未能获取内容)", "https://x.io"), "");
  assert.equal(webFetchNextStep("", ""), "");
});

test("URL 不合法也不抛", () => {
  assert.match(webFetchNextStep("HTTP 404", "not a url"), /<路径里的词>/);
});
