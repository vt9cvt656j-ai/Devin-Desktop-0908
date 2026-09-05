# Growth — 成长性系统设计与实现

> 让小白零门槛上手、让认真的人越用越强，并主动对抗 AI 工具的「越用越废」。
> **成长属于「你这个开发者」，不属于某个项目**——技能跨所有项目积累、换项目带着走，越战越勇。
> 实现：`src/growth.js`（自包含模块）+ `src/main.js` 若干 hook 点。

---

## 0. 它要解决的矛盾

两个需求对普通软件是对立的：

- **「小白轻松上手」** 通常要简化、收窄 → 压低天花板；
- **「越勇越厉害」** 通常要堆功能、加挑战 → 吓退新手。

对一个 **AI IDE** 还有第三个、更要命的陷阱：AI 把活全干了，用户其实**越用越废**——
2026 年 Anthropic 的研究显示 AI 编程辅助让开发者技能掌握度下降约 **17%**，多项研究称之为「元认知惰性 (metacognitive laziness)」：把思考外包给了 AI。

**结论：对 AI IDE，唯一值得做的成长系统是让「用户的真实能力」增长的系统。** 这条决定了下面的一切。

---

## 1. 解法：一个长在 IDE 里的智能导学系统 (ITS)

矛盾通过**单一机制**化解：**自适应脚手架 + 渐隐 (adaptive scaffolding with fading)**，由一个持久的**学习者模型**驱动。这正是 ITS 50 年来的标准四件套：

| ITS 组件 | 在 Michael IDE 里 | 代码 |
|---|---|---|
| **领域模型** Domain | 一张技能图（见 §3） | `SKILLS` |
| **学习者模型** Learner —「越来越懂你」 | 对你每项技能的掌握度估计 + 偏好 + 行为统计 | `state.skills` (BKT) |
| **教学模型** Pedagogical —「把能力交还给你」 | 把模型翻译成自适应教学：注入系统提示 | `promptBlock()` |
| **界面** UI | Open Learner Model 面板（可看、可改） | `renderPanel()` |

> 这是用户选定的 **(C) 方案**：让「越来越懂你」(B) 当引擎，去精准驱动「把能力交还给你」(A)。
> 适配因此是**逐技能、个性化**的，而不是一根全局滑块。

---

## 2. 文献依据（每条都落到了实现）

| 框架 | 来源 | 在本系统中的体现 |
|---|---|---|
| Low floor / High ceiling / Wide walls | Papert → Resnick (Scratch) | 新手默认「充分讲解」（低地板）；掌握后无上限地渐隐（高天花板） |
| 渐进式披露 | Nielsen 1995/2006 | 讲解密度按档位分级；`tooling` 技能按需推荐高级功能 |
| ZPD + 脚手架 + **渐隐** | Vygotsky；Wood/Bruner | 弱项给 `coach` 指令，强项撤掉——**脚手架会褪去**，避免依赖 |
| **专长反转效应** | Kalyuga / Sweller | 同一句解释，新手要、老手烦 → 逐技能控制详略 |
| 心流通道 / 动态难度 | Csikszentmihalyi | 总体档位驱动讲解密度，保持「够得着」 |
| **合意 difficulty**（表现≠学习） | Bjork | 「挑战模式」：难处先让用户自己想，再揭晓 |
| 自我决定论 / 过度合理化 | Deci & Ryan | **不用积分/徽章/排行榜**；成长挂在真实能力上；OLM 给自主权 |
| **AI 去技能化 / 元认知惰性** | Anthropic 2026；多项研究 | 信号奖励「认知投入」而非「委托量」；§5 主动探测去技能化 |
| 贝叶斯知识追踪 (BKT) | Corbett & Anderson | `bktUpdate()` —— 从行为估计掌握度 |
| Open Learner Model | Bull & Kay | 面板可看、可逐项 ± 纠正、可重置 |

---

## 3. 技能图（领域模型）

只保留**有真实信号喂养**的技能——不做没数据的死进度条。

| id | 标签 | 正向信号 | 负向信号 |
|---|---|---|---|
| `reviewing` | 审查 AI 产出 | 展开 diff 查看 / 撤销错误编辑 / **改了文件、验证过、没被返工的一轮** | 闭眼接受（应用了、没看、**而且这一轮没验证过**）/ **返工**（上一轮 ✓ 后半小时内又提同一件事） |
| `authoring` | 独立投入 | 当轮有审查/撤销/用 chat·plan 思考 | 纯 agent 自动驾驶、不看就过 |
| `prompting` | 表达需求 | **一次问清（run 里 ask_user 0 次）且做成** | **问了 ≥2 次** / 返工。（2026-09-05 起不再按字数判：≥60 字算好、否则算差，会把老手的一句话指令全记成失败） |
| `planning` | 任务规划 | 用 plan 模式 / 敢接复杂任务 | — |
| `tooling` | 掌握 IDE 能力 | 首次用到某模式或 @文件 | — |
| `verifying` | 验证习惯 | agent 运行改完跑了测试/构建/诊断 | 改了却没验证就收尾 |

---

## 4. 学习者模型与更新（BKT）

经典 4 参数 BKT：每个技能一个隐状态「是否已掌握」的概率 `p`，每次行为按贝叶斯更新。
可解释、轻量——深度/LSTM 知识追踪对单个本地用户是过度工程。

```
参数:  pInit=0.25  pLearn=0.12  pSlip=0.10  pGuess=0.20  forgetPerDay=0.015
正确:  p ← p(1-slip) / [p(1-slip) + (1-p)guess]
错误:  p ← p·slip   / [p·slip   + (1-p)(1-guess)]
随后:  p ← p + (1-p)·pLearn          // 习得转移
遗忘:  长期不练的技能向先验缓慢回落    // 间隔/合意difficulty 直觉
```

**回合对账 (`reconcileTurn`)**：新一轮提问会结算上一轮——AI 应用了但用户**从没展开看过**的编辑算作「闭眼接受」，给 `reviewing` 弱负证据（每轮封顶 3 次，防一轮暴跌）。**这就是过度依赖会实打实掉掌握度的机制。**

> 2026-09-05 修正：**这一轮的 run 验证过（测试/构建/诊断真跑过且过了）的话，没点开 diff 不算闭眼。**
> 量了产品所有者自己的档案：862 轮里 AI 改 1041 处、点开 27 次、"未看就接受率" 70%，四项能力钉在地板 ——
> 他不是没审，是不在这个面板里审。点开面板是界面事件，验证是执行事实；判据改认后者。
> 同一次修正还加了 `getExperienceTier()`：用量 ≥60 轮且跨 ≥2 个项目 = seasoned，放宽工具窗口那条判据
> 除了 BKT 也看它 —— 用了几十轮、跨多个项目的人不是新手。

---

## 5. 教学模型：四根杠杆（B 驱动 A）

1. **自适应讲解密度（已实现）** — `promptBlock()` 把画像翻译成教学指令注入系统提示：
   - 强项 → 「别赘述，直接给结论」；弱项 → 给对应 `coach` 脚手架；
   - 始终追加「点出一个可迁移原理、避免只复制结果」的反依赖指令；
   - 对**任何** OpenAI 兼容模型都生效（纯提示层，零后端改动）。
2. **靶向合意 difficulty / 「你先猜」（已实现，真 UI 闸门）** — 开「挑战模式」后，AI 应用一处较大改动时，diff 会先被**毛玻璃遮住**，提示「先自己想一遍这段怎么改」，点「揭晓答案」才显示，随后 👍/👎 自评思路是否接近。命中/落空 = `predict` 信号，是**最强的学习证据**（检索练习 + 合意difficulty），强力拉动 `authoring`。每轮最多触发一次、只对 ≥4 行的改动触发，教学而不打扰。纯增量覆盖层，不改任何现有 diff 渲染逻辑。
3. **去技能化探测（已实现）** — 面板横幅：若**用量在涨但掌握度没涨**（且 AI 改动≥4），提示「当心元认知惰性」。
4. **个性化披露（已实现，基础版）** — `tooling` 技能驱动「顺带推荐没用过的功能」。

> 已验证（`scratchpad/growth-test.mjs`）：
> 新手 → `新手/充分讲解`；认真用 16 轮 → `熟练/精简`（脚手架渐隐）；
> 闭眼委托 16 轮 → 停在 `新手`，`reviewing` 掉到 **0.137**、闭眼接受率 **100%**。

---

## 5b. 跨项目成长（越战越勇）

成长系统升级为**可迁移的开发者成长档案**，而不是绑死在某个项目上：

- **技能是全局的**：6 项技能存在单一全局 key（`michael-ide.learner-model.v1`），跨所有项目累积——换项目，你的能力带着走。
- **每项目经验台账**：`state.projects[root]` 记录在每个项目里练过哪些技能、练了多少（`touched`）、轮次、起止时间。`message-sent` 信号带上当前项目，之后该回合的每次 `observe()` 都归到这个项目。
- **迁移度 = 广度**：`skillBreadth(skill)` = 「在 ≥2 次练习的不同项目」数。一项技能**既较熟练（p≥0.6）又跨过 ≥2 个项目**，才标记为「**可迁移**」(`isTransferable`)。
  - 依据 Bjork 的 *varying conditions of practice*：**只在一个项目里会的不算真会；在多样情境里证明过的，迁移性才强**。
- **面板呈现**：顶部「成长档案」条显示 *实战项目数 / 可迁移能力数 / 累计轮次* + 一句「越战越勇」引导；每项技能右侧一枚迁移度徽章（`未跨项目` → `N 个项目` → `可迁移·N`）。

> 已验证（`scratchpad/xproject-test.mjs`）：在 alpha/beta/gamma 三个项目各实战 5 轮后，
> `reviewing` 跨 3 个项目、标记可迁移；**5/6 项能力达成跨项目验证**。

---

## 6. 已接入的 hook 点（`src/main.js`）

| 位置 | 信号 |
|---|---|
| `fullPrompt` 拼装处 | 注入 `growth.promptBlock()` |
| 发送消息后 | `message-sent` {mode, len, complex, usedAt, **project, projectName**} |
| 工具步骤展开（write/edit/multiedit） | `review-diff` |
| write_file / multiedit 应用成功 | `edit-applied` + `predictGate(vp)`（挑战模式下的「你先猜」遮罩）|
| 「你先猜」揭晓后自评 👍/👎 | `predict` {hit} → 强力更新 `authoring` |
| 撤销单个编辑 | `undo-edit` |
| 撤销整轮 | `revert-run` |
| agent 运行收尾（有改动） | `run-complete` {verified} → `verifying` |
| 顶栏功能面板新增 `Growth` 标签 | `renderPanel(body, {projectMemory, projectName, onOpenMemory})` |

所有 `signal()` 调用内部 try/catch 包裹——**telemetry 的 bug 绝不会弄坏编辑器热路径**。
持久化用 `localStorage`（原生 app 与 `npm run dev` 浏览器预览都能跑）。

---

## 7. 路线图（下一步）

- **✅ (B) 已并入面板**：Growth 面板的「我对这个项目的理解」直接展示 agent 用 `remember` 攒下的项目知识——「能力 + 项目」统一在一处，(C) 闭环可见。
- **✅ `verifying` 技能已上**：从 agent 运行的 `didVerify` 收尾信号驱动。
- **「你先猜」升级**：从「自评接近度」升级为「让用户真的敲一段再 diff 对比」，捕获更硬的信号。
- **个性化 ZPD 任务推送**：基于薄弱技能，主动建议「刚好够得着」的重构/练习。
- **`architecture` 技能**：把项目记忆的覆盖面/条数接成一条「对本项目的掌握」信号。
- **DKT 升级**：数据足够后再考虑序列模型，当前 BKT 已够。

---

## 文献来源

- Kalyuga, *Expertise Reversal Effect* (Educational Psychology Review, 2007)
- Resnick, *Designing for Wide Walls*；Papert, Logo（low floor / high ceiling）
- Nielsen, *Progressive Disclosure*（1995/2006）
- Vygotsky, ZPD；Wood/Bruner/Ross, *Scaffolding*（1976）
- Bjork & Bjork, *Creating Desirable Difficulties*（2011）
- Csikszentmihalyi, *Flow*；DDA 综述（Zohaib 2018）
- Deci & Ryan, *Self-Determination Theory*；*Overjustification Effect*
- Corbett & Anderson, *Bayesian Knowledge Tracing*（1995）；Bull & Kay, *Open Learner Models*
- Anthropic（2026），AI 编程辅助使技能掌握度下降约 17%；多项「元认知惰性」研究
