// 一个仓库装哪些技能：多技能仓库不能只装按字母序排第一的那一个。
//
// 老规则「根目录优先 → 同名目录 → 否则第一个」对单技能仓库是对的；对 mattpocock/skills
// 这种 skills/<桶>/<名字>/ 三十个技能的仓库，装下来只有 ask-matt 一个，界面却说装成功了。
import test from "node:test";
import assert from "node:assert/strict";
import { planSkillPackInstall, skillDirsFromTree } from "../src/agent/skill-pack.js";

const blob = (path) => ({ type: "blob", path });
const treeOf = (...paths) => ({ tree: paths.map(blob) });

test("单技能仓库：根上有 SKILL.md 就装根，名字取仓库名", () => {
  const plan = planSkillPackInstall(treeOf("SKILL.md", "README.md", "scripts/x.sh"), { repoName: "docx" });
  assert.equal(plan.mode, "single");
  assert.deepEqual(plan.skills, [{ dir: "", name: "docx" }]);
});

test("单技能仓库：唯一的 SKILL.md 在子目录里也装它", () => {
  const plan = planSkillPackInstall(treeOf("README.md", "skill/SKILL.md"), { repoName: "whatever" });
  assert.deepEqual(plan.skills, [{ dir: "skill", name: "skill" }]);
});

test("有 plugin.json 清单就按清单装——作者写明了要发布哪些", () => {
  const tree = treeOf(
    "skills/engineering/tdd/SKILL.md", "skills/engineering/tdd/tests.md",
    "skills/productivity/handoff/SKILL.md",
    "skills/in-progress/retro/SKILL.md",
    "skills/deprecated/old/SKILL.md",
    ".claude-plugin/plugin.json",
  );
  const pluginJson = { skills: ["./skills/engineering/tdd", "./skills/productivity/handoff", "./skills/engineering/missing"] };
  const plan = planSkillPackInstall(tree, { pluginJson });
  assert.equal(plan.mode, "plugin");
  assert.deepEqual(plan.skills.map((s) => s.name), ["tdd", "handoff"], "in-progress 和 deprecated 不在清单里就不装");
  assert.deepEqual(plan.skills.map((s) => s.dir), ["skills/engineering/tdd", "skills/productivity/handoff"]);
  assert.deepEqual(plan.skipped.map((s) => s.dir), ["skills/engineering/missing"], "清单里有、仓库里没有的要报出来，不静默");
});

test("多技能又没清单：全装，只跳过 deprecated，超上限的记进 skipped", () => {
  const tree = treeOf(
    "skills/a/SKILL.md", "skills/b/SKILL.md", "skills/c/SKILL.md",
    "skills/deprecated/z/SKILL.md",
  );
  const plan = planSkillPackInstall(tree, { maxSkills: 2 });
  assert.equal(plan.mode, "scan");
  assert.deepEqual(plan.skills.map((s) => s.name), ["a", "b"]);
  assert.deepEqual(plan.skipped.map((s) => s.dir).sort(), ["skills/c", "skills/deprecated/z"]);
  assert.ok(plan.skipped.find((s) => s.dir === "skills/c").why.includes("上限"), "被上限砍掉的要说清原因");
});

test("同名目录不覆盖：第二个带上父目录名", () => {
  const tree = treeOf("engineering/research/SKILL.md", "misc/research/SKILL.md");
  const plan = planSkillPackInstall(tree);
  assert.deepEqual(plan.skills.map((s) => s.name), ["research", "misc-research"]);
});

test("清单一个都对不上时退回按树扫，别一个都不装", () => {
  const tree = treeOf("skills/a/SKILL.md", "skills/b/SKILL.md");
  const plan = planSkillPackInstall(tree, { pluginJson: { skills: ["./nope"] } });
  assert.equal(plan.mode, "scan");
  assert.equal(plan.skills.length, 2);
});

test("没有任何 SKILL.md 就是 none", () => {
  assert.equal(planSkillPackInstall(treeOf("README.md")).mode, "none");
  assert.deepEqual(skillDirsFromTree({ tree: [] }), []);
});
