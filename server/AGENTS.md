# server 项目 Git 工作流规则（每次提交前必读）

本文件是对本仓库 server 目录生效的**强制工作流规则**。在本仓库做任何提交、推送、
合并相关操作之前，先完整读一遍本文件，然后严格按它执行。

## 一、默认仓库与默认分支

- 本仓库默认工作分支是 **gao-dev**，日常所有开发提交都落在它上面。
- 本地工作分支应保持为 `gao-dev`（`git branch --show-current` 应为 gao-dev）。
- main 不是开发分支：不直接在 main 上提交、不直接往 main 推。

## 二、每次提交必须走的流程（固定步骤，不许跳过）

1. 确认在 gao-dev 上：
   ```bash
   git switch gao-dev   # 本地没有则：git switch -c gao-dev --track origin/gao-dev
   ```
2. 在 gao-dev 上提交改动：
   ```bash
   git add <改动文件> && git commit -m "<提交说明>"
   ```
3. 推送到 gao-dev：
   ```bash
   git push origin gao-dev
   ```
4. 提交完成后，向 main 发起合并请求（PR：gao-dev → main），
   标题和描述写清楚改了什么、为什么，然后把 PR 链接交给用户。

## 三、禁止自动合并 main（红线，违反即无效）

- 不得执行任何会把改动并进 main 的动作：
  - `git push origin main`、`git push origin HEAD:main` —— 禁止；
  - 在 GitHub 上代替用户点击合并 / 批准合并 PR —— 禁止；
  - 任何 CI、脚本、定时任务形式的自动合并 —— 禁止。
- main 的合并**只能由用户本人执行**。agent 的职责到「PR 已创建并交给用户」为止。

## 四、操作范围

- 只操作 `server/` 目录下的内容（本文件、`server/.githooks/` 属于本规则的一部分，可以改）。
- 不碰 server/ 之外的文件（ide/、src/、src-tauri/、docs/、根目录脚本等一律不改）。

## 五、本地强制机制

- 仓库已配置 `core.hooksPath = server/.githooks`，本地 git 钩子会拦住两条红线：
  - `pre-commit`：在 main 分支上直接提交 → 拒绝，并提示切到 gao-dev；
  - `pre-push`：向 main 推送 → 拒绝，并提示走「推 gao-dev → 发 PR」。
- 钩子只是兜底，不是规则本身：就算钩子没触发，本文件的流程和红线依然有效。

## 六、为什么

- main 只接受经 PR 审查后的合并，保证主干始终可发布；
- gao-dev 是开发主干，提交集中在这里，PR 到 main 的路径才清晰、可审查。
