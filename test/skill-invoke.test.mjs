// `/技能名 参数`：用户手动触发技能——纯逻辑那一半的行为测试。
//
// 这条入口以前不存在。Agent Skills 规范里 `disable-model-invocation: true` 的技能不进模型目录，
// 只剩「人敲名字」一条路；mattpocock/skills 三十个里一半是这种路由壳（grill-me 全文一行
// 「去调 grilling」）。没有这条入口它们装了等于没装。
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSlashInvocation, findSlashSkill,
  expandSkillArguments, buildSlashInvocationMessage, normalizeSkillName,
} from "../src/agent/skill-invoke.js";
import { parseSkillDocument } from "../src/agent/skill-doc.js";

const SKILLS = [
  { name: "grill-me", desc: "A relentless interview", prompt: 'Call the Skill tool with "grilling".', baseDir: "/home/u/.mrdayone/skills/grill-me", userInvoked: true },
  { name: "grilling", desc: "Interview the user relentlessly", prompt: "Ask questions until every branch is resolved.", baseDir: "/home/u/.mrdayone/skills/grilling" },
  { name: "handoff", desc: "Compact the conversation", prompt: "Write a handoff for: $ARGUMENTS\nSave it to tmp.", baseDir: "/home/u/.mrdayone/skills/handoff", userInvoked: true, argumentHint: "What will the next session be used for?" },
  { name: "tdd", desc: "Test-driven development", prompt: "Red → green.", baseDir: "/home/u/.mrdayone/skills/tdd" },
];

test("只认消息开头的 /名字，后面的整段是参数", () => {
  assert.deepEqual(parseSlashInvocation("/handoff 明天先做部署"), { name: "handoff", args: "明天先做部署" });
  assert.deepEqual(parseSlashInvocation("/grill-me"), { name: "grill-me", args: "" });
  assert.deepEqual(parseSlashInvocation("/tdd\n第一条：登录要能失败"), { name: "tdd", args: "第一条：登录要能失败" });
  assert.equal(parseSlashInvocation("帮我看看 /tdd 这个"), null, "行中的斜杠不是命令");
  assert.equal(parseSlashInvocation("//注释"), null);
  assert.equal(parseSlashInvocation(""), null);
});

test("按名字找技能只做精确匹配：敲错了就当普通消息，不替用户猜", () => {
  assert.equal(findSlashSkill(SKILLS, "grill-me")?.name, "grill-me");
  assert.equal(findSlashSkill(SKILLS, "Grill_Me")?.name, "grill-me", "大小写/分隔符不算差异");
  assert.equal(findSlashSkill(SKILLS, "grill"), null, "包含匹配会把 /grill 猜成 grill-me 或 grilling，不许");
  assert.equal(findSlashSkill(SKILLS, "Users"), null, "路径 /Users/x 的首段不该命中任何技能");
});

test("用户可触发的技能也能被 / 找到——它们本来就只有这一条入口", () => {
  const hit = findSlashSkill(SKILLS, "handoff");
  assert.ok(hit?.userInvoked, "handoff 是 disable-model-invocation 的，必须能被 / 触发");
});

test("$ARGUMENTS 逐处替换；作者没留占位符时参数附在末尾，不丢", () => {
  assert.equal(expandSkillArguments("Do $ARGUMENTS now. Again: $ARGUMENTS", "X"), "Do X now. Again: X");
  assert.equal(expandSkillArguments("Do $ARGUMENTS now.", ""), "Do  now.", "没给参数就替成空");
  assert.match(expandSkillArguments("No placeholder here.", "明天部署"), /用户给这次调用的参数：明天部署$/);
  assert.equal(expandSkillArguments("No placeholder here.", ""), "No placeholder here.");
});

test("发给模型的消息：先说清是 / 调出来的、资源目录在前、正文在后", () => {
  const msg = buildSlashInvocationMessage(SKILLS[2], "明天先做部署");
  const lines = msg.split("\n");
  assert.match(lines[0], /\/handoff/, "开头要点名是哪条命令");
  assert.match(lines[0], /明天先做部署/, "参数要在开头就可见");
  assert.match(lines[1], /^资源基准目录：\/home\/u\/\.mrdayone\/skills\/handoff/, "资源目录必须在正文前面");
  assert.match(msg, /Write a handoff for: 明天先做部署/, "$ARGUMENTS 要替换进正文");
  assert.match(msg, /read_skill/, "要告诉模型「Skill 工具」在这里叫 read_skill——不然 Skill(\"grilling\") 会落空");
});

test("没参数时不写「参数：」，别让模型去找一个不存在的参数", () => {
  const msg = buildSlashInvocationMessage(SKILLS[0], "");
  assert.doesNotMatch(msg.split("\n")[0], /参数/);
  assert.match(msg, /Call the Skill tool with "grilling"/);
});

test("frontmatter 里的 disable-model-invocation / argument-hint 能被解析出来", () => {
  const doc = parseSkillDocument(
    '---\nname: handoff\ndescription: Compact the current conversation.\nargument-hint: "What will the next session be used for?"\ndisable-model-invocation: true\n---\n\nWrite a handoff.',
    "/home/u/.mrdayone/skills/handoff/SKILL.md",
  );
  assert.equal(doc.userInvoked, true);
  assert.equal(doc.argumentHint, "What will the next session be used for?");
  assert.equal(doc.prompt, "Write a handoff.", "frontmatter 仍然剥掉");
  const plain = parseSkillDocument("---\nname: tdd\ndescription: TDD.\n---\nRed → green.", "/x/tdd/SKILL.md");
  assert.equal("userInvoked" in plain, false, "没写就不带这个字段，和 tools 一样");
  assert.equal("argumentHint" in plain, false);
  const off = parseSkillDocument("---\nname: a\ndisable-model-invocation: false\n---\nbody", "/x/a/SKILL.md");
  assert.equal("userInvoked" in off, false, "写了 false 等于没写");
});

test("归一化和 main.js 里 _findSkillByName 的口径一致", () => {
  assert.equal(normalizeSkillName("UI/UX Pro Max"), "uiuxpromax");
  assert.equal(normalizeSkillName("grill_me"), normalizeSkillName("grill-me"));
});
