/**
 * 一个 GitHub 仓库里装哪些技能——纯逻辑这一半。
 *
 * 只吃仓库树（`git/trees?recursive=1` 的结果）和可选的 `.claude-plugin/plugin.json`，
 * 吐一份安装计划。拉树、抓文件、落盘那一半在 main.js（_skillInstallFromRepo）。
 *
 * 为什么要有这份计划：原来的挑选规则是「根目录优先，其次同名目录，否则第一个」——对
 * 一个 SKILL.md 的仓库是对的，对 mattpocock/skills 这种 `skills/<桶>/<名字>/` 三十个技能的
 * 仓库，装下来只有按字母序排第一的那一个，用户看到的是"装成功了"，装的却不是他要的。
 *
 * 判据分三档，按可信度排：
 *   plugin → 仓库自带 `.claude-plugin/plugin.json`，作者写明了要发布哪些（Claude Code 插件
 *            就装这份清单，`in-progress/` `deprecated/` 之类作者不想发的自然不在里面）；
 *   single → 整棵树只有一处 SKILL.md（根上或某个目录），装它；
 *   scan   → 多处 SKILL.md 又没有清单，全装，但跳过名叫 deprecated 的目录。
 */

const SKILL_MD_RE = /(^|\/)SKILL\.md$/;

/** 树里所有含 SKILL.md 的目录；根目录记为 ""。 */
export function skillDirsFromTree(tree) {
  const out = [];
  for (const t of tree?.tree || []) {
    const p = String(t?.path || "");
    if (t?.type === "blob" && SKILL_MD_RE.test(p)) {
      out.push(p === "SKILL.md" ? "" : p.slice(0, p.length - "/SKILL.md".length));
    }
  }
  return out;
}

/** `./skills/engineering/tdd/` → `skills/engineering/tdd` */
function cleanDir(v) {
  return String(v || "").trim().replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
}

function leaf(dir) {
  const parts = cleanDir(dir).split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

/**
 * 同名冲突（两个目录都叫 `research`）：后来的那个带上父目录名，`research` 和 `misc-research`，
 * 而不是静默覆盖——覆盖了用户看不出来，会以为装了两个其实只剩一个。
 */
function uniqueNames(items) {
  const used = new Set();
  return items.map((it) => {
    let name = it.name;
    if (used.has(name)) {
      const parts = cleanDir(it.dir).split("/").filter(Boolean);
      const parent = parts.length >= 2 ? parts[parts.length - 2] : "";
      const alt = parent ? `${parent}-${name}` : name;
      name = used.has(alt) ? `${alt}-${used.size + 1}` : alt;
    }
    used.add(name);
    return { ...it, name };
  });
}

/**
 * @param tree      GitHub 递归树
 * @param opts.pluginJson  解析好的 `.claude-plugin/plugin.json`（没有就 null）
 * @param opts.repoName    仓库名，single 模式下根目录技能的名字
 * @param opts.maxSkills   scan 模式的上限；超出的记进 skipped，不静默丢
 * @returns { mode, skills: [{dir, name}], skipped: [{dir, why}] }
 */
export function planSkillPackInstall(tree, { pluginJson = null, repoName = "", maxSkills = 40 } = {}) {
  const dirs = skillDirsFromTree(tree);
  const has = new Set(dirs);
  const skipped = [];

  const declared = Array.isArray(pluginJson?.skills) ? pluginJson.skills : null;
  if (declared && declared.length) {
    const skills = [];
    for (const raw of declared) {
      const dir = cleanDir(raw);
      if (!dir) continue;
      if (!has.has(dir)) { skipped.push({ dir, why: "清单里有，仓库里没有 SKILL.md" }); continue; }
      skills.push({ dir, name: leaf(dir) });
    }
    if (skills.length) return { mode: "plugin", skills: uniqueNames(skills), skipped };
    // 清单一个都对不上——退回按树扫，别因为作者的清单写坏了就一个都不装。
  }

  if (!dirs.length) return { mode: "none", skills: [], skipped };
  if (has.has("")) {
    return { mode: "single", skills: [{ dir: "", name: leaf(repoName) || "skill" }], skipped };
  }
  if (dirs.length === 1) {
    return { mode: "single", skills: [{ dir: dirs[0], name: leaf(dirs[0]) }], skipped };
  }

  const kept = [];
  for (const dir of dirs) {
    if (dir.split("/").some((seg) => seg.toLowerCase() === "deprecated")) {
      skipped.push({ dir, why: "在 deprecated 目录下" });
      continue;
    }
    kept.push({ dir, name: leaf(dir) });
  }
  kept.sort((a, b) => a.dir.localeCompare(b.dir));
  const limit = Math.max(1, Number(maxSkills) || 40);
  for (const extra of kept.slice(limit)) skipped.push({ dir: extra.dir, why: `超过单次安装上限 ${limit} 个` });
  return { mode: "scan", skills: uniqueNames(kept.slice(0, limit)), skipped };
}
