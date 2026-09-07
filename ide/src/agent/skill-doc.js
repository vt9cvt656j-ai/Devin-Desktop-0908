/**
 * 技能文档（Markdown + frontmatter）的解析。
 *
 * 从 main.js 抽出来的第八块。判据照旧：外部自由变量为零——只吃字符串、只吐结构，
 * 不碰文件系统、不碰 DOM、没有模块级可变状态。
 *
 * 搬它的直接原因是给 main.js 腾行数（尺寸闸撞线时先搬模块，不抬线）；而它本身也确实
 * 是「一个文件一件事」：一份技能文档进来，名字/描述/正文/元数据出去。
 */

export function parseSkillDocument(text, sourcePath) {
  const prompt = String(text || "").trim();
  if (!prompt) return null;
  const normalizedPath = String(sourcePath || "").replace(/\\/g, "/");
  const parts = normalizedPath.split("/").filter(Boolean);
  let name = parts.length > 1 ? parts[parts.length - 2] : "Skill";
  let desc = "";
  let tools = [];
  // Agent Skills 规范里另外两个键：
  //   disable-model-invocation: true → 只有用户敲 /名字 才触发，模型目录里不列（零上下文开销）；
  //   argument-hint → 选择器里提示 /名字 后面该跟什么。
  let userInvoked = false;
  let argumentHint = "";
  const frontmatter = prompt.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
  if (frontmatter) {
    /*
     * 逐行读是不够的——YAML 的折叠 / 保留标量会把值写在**后面几行**：
     *
     *     description: >-
     *       Use this skill when the user wants to create, read or edit
     *       Word documents.
     *
     * 老写法拿正则抠 `description:` 后面那截，抠到的是指示符本身 `">-"`；它非空，
     * 于是被当成描述赋值，连带下面那条「没写描述就退回一级标题」也永远不会触发。
     * 结果是技能清单里明晃晃列着一条 `- docx：>-`，模型据此判断这个技能干什么用——
     * 它什么也判断不出来。Anthropic 官方那批技能大量用这种写法，等于整批失效。
     */
    const lines = frontmatter[1].split("\n");
    const indentOf = (s) => (s.match(/^[ \t]*/) || [""])[0].length;
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^([ \t]*)(name|description|allowed-tools|allowedtools|disable-model-invocation|disablemodelinvocation|argument-hint|argumenthint)[ \t]*:[ \t]*(.*?)[ \t]*$/i);
      if (!match) continue;
      const keyIndent = match[1].length;
      const key = match[2].toLowerCase().replace(/-/g, "");
      let value = match[3];

      // 块标量的指示符可以带显式缩进位和行尾注释（`|2 # 说明`），所以要按形状认，
      // 不能拿六个固定字符串去比。
      const block = value.match(/^([>|])[+-]?\d*[ \t]*(?:#.*)?$/);
      if (block) {
        const folded = block[1] === ">";
        const body = [];
        for (let j = i + 1; j < lines.length; j++) {
          if (!lines[j].trim()) { body.push(""); continue; }
          // 续行必须比**这个键**缩进得更深才算它的；跟 0 比的话，嵌在 metadata: 下面的
          // 一个 description 会把后面所有内容都吞进来。
          if (indentOf(lines[j]) <= keyIndent) break;
          body.push(lines[j].trim());
          i = j;
        }
        while (body.length && !body[body.length - 1]) body.pop();
        // `>` 折成空格、`|` 保留换行。下游（技能清单）本来就会把空白压平，
        // 所以这里只要不丢词就够。
        value = folded ? body.join(" ") : body.join("\n");
      } else if (!value && key === "allowedtools") {
        // allowed-tools 还有一种列表写法：键后面空着，下面几行是 `- 工具名`。
        for (let j = i + 1; j < lines.length; j++) {
          if (!lines[j].trim()) continue;
          if (indentOf(lines[j]) <= keyIndent) break;
          const item = lines[j].match(/^[ \t]*-[ \t]*(.+?)[ \t]*$/);
          if (!item) break;
          value += (value ? "," : "") + item[1];
          i = j;
        }
      }

      value = String(value).replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, a, b) => a ?? b ?? "").trim();
      if (key === "name" && value) name = value;
      if (key === "description" && value) desc = value;
      if (key === "allowedtools" && value) {
        tools = value.split(/[,\n]/).map((v) => v.replace(/^[-\s]+/, "").trim()).filter(Boolean).slice(0, 32);
      }
      if (key === "disablemodelinvocation") userInvoked = /^(true|yes|on|1)$/i.test(value);
      if (key === "argumenthint" && value) argumentHint = value.replace(/\s+/g, " ").trim().slice(0, 160);
    }
  }
  if (!desc) {
    const heading = prompt.match(/^#\s+(.+?)\s*$/m);
    desc = heading ? heading[1].trim() : "标准 SKILL.md";
  }
  return {
    id: `file:${normalizedPath}`,
    name: name.slice(0, 80),
    /*
     * 折叠标量拼出来的描述里还留着原文的换行/连续空格，清单那边是按字符数掐的，
     * 先压平再截断，才不会把预算浪费在空白上。
     *
     * 上限从 240 提到 1200：**description 就是触发判据**。Anthropic 官方那批技能
     * （pptx / xlsx / dataviz）的描述普遍 400–900 字符，而「什么时候该用我 / 什么时候
     * 不要用我」恰恰写在后半截——240 一刀切下去，切掉的正是触发条件本身，模型于是
     * 该用的时候不用、不该用的时候乱用。
     *
     * 这里不再承担"省预算"的职责：目录（_skillCatalogBlock）自己有 6000 字符总预算和
     * 400→240→140→90→60 的逐级压缩，装不下时它会按当前技能数量决定压到哪一档。解析期
     * 提前砍死，等于把那套动态预算的上限永久钉在 240。
     */
    desc: desc.replace(/\s+/g, " ").trim().slice(0, 1200),
    /*
     * 正文剥掉 YAML frontmatter。
     *
     * 以前 prompt 存的是整份文件，于是 name / description / allowed-tools 会原样进模型：
     * 常驻注入时进一次，read_skill 再读一次，而 description 早就在技能清单里了——同一段
     * 元数据在上下文里出现三遍，占的还是最贵的那块预算（常驻 10k、read_skill 24k）。
     * `allowed-tools: Read, Grep` 这行以纯文本混在指令里更别扭：它读起来像一句给模型的
     * 命令，而真正的约束在 _skillAllowedTools 那道闸上，两边说法不一致时模型信哪个？
     * Claude Code 给模型的就是剥掉 frontmatter 之后的正文。
     *
     * 剥完是空的（整份文件只有 frontmatter）就退回原文：那种技能本来也没有正文可给，
     * 剥成空串只会让它从清单里凭空消失——那是比多几行元数据更糟的结果。
     */
    prompt: (frontmatter ? prompt.slice(frontmatter[0].length).trim() : prompt) || prompt,
    sourcePath: normalizedPath,
    baseDir: normalizedPath.slice(0, normalizedPath.lastIndexOf("/")) || ".",
    ...(tools.length ? { tools } : {}),
    ...(userInvoked ? { userInvoked: true } : {}),
    ...(argumentHint ? { argumentHint } : {}),
    _readonly: true,
  };
}
