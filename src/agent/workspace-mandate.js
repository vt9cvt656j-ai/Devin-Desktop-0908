// 开工首轮那条 [AGENT_MODE_TOOL_REQUIRED] 的正文。
//
// 它有过一个真实的优先级 bug：`_ORCH_NOTE + f() ? A : B` 会被解析成
// `(_ORCH_NOTE + f()) ? A : B`，而 _ORCH_NOTE 非空 —— 于是每个开着工作区的回合都被告知
// 「本轮只读」，让它改东西它不改，读一圈、讲一通该怎么改、然后停下。括号补上之后，
// 分流本身又剩了一个结构性缺口，就是下面这个。
//
// **缺口：只读那条分支结构上够不到。**
// _agentAnswerOnlyInspection 要求 intentSource === "ai"（夺能力方向的门一律精确比较，
// gate-tristate 钉着）。而完整裁决那份 43 字段大 JSON 只有会话第一轮等得起
// （_intentWaitPaid 一个会话只付一次），第二轮起落地时机在循环边界之后。真正到场的是
// 快通道画像：它**写 workspaceAction**（于是能把这条强制令打开），却带着
// intentSource="fast"（于是永远选不到收敛那条）。合起来的后果是——
// 一句 workspaceAction=inspect 的问话，拿到的是最偏动作的那条文案「再完成修改、运行或
// 回答」。用户实拍：问「当前项目工作路径是什么」，模型先通读项目、再跑一个终端。
//
// 生产遥测（10 天，221 个 agent 轮）量到的就是这个形状：141 轮只读却用了工具，步数中位
// 4、p90 14、最长 84，其中 21% 跑了 shell 命令。
//
// 修法是**按 workspaceAction 分流，而不是按裁决到没到**。inspect 这个声明本身就说明
// 交付物是答案，「再完成修改、运行」那半句放在这里是可改分支的词漏过来了。
//
// 中间这条**一样能力都不夺**：不写「不得运行命令」之类的禁令。拿快通道判断去把一轮
// 标成只读是夺能力方向（explicitReadOnly 就是因此在快通道里被剥掉的），这里只收窄措辞、
// 不收窄工具。真正解决用户那一幕的是最后一句：**已经注入的运行时状态就是已取得的证据**。
// 模型不知道环境块算证据，于是照着「先取得真实证据」的字面去重新取一遍它手上已有的东西。
// 这是补一条关于「你手上有什么」的事实，不是劝它少做事。

const HEAD = "[AGENT_MODE_TOOL_REQUIRED]\n";

/** 已注入的运行时状态就是证据——三条分支里只有"要去取证"的两条需要它。 */
const ALREADY_IN_HAND =
  "本轮上下文里已经放好的运行时状态——工作区根目录与相对路径基准、当前打开的文件、"
  + "终端与诊断——是**已经取得的证据**，和你自己调工具读回来的完全等价。"
  + "答案已经在里面时直接用它回答，不要再跑一遍工具去重新得到同一个事实。";

/**
 * @param engineering  run.engineering（可能来自完整裁决，也可能来自快通道，甚至是空的）
 * @param answerOnly   _agentAnswerOnlyInspection(engineering) 的结果，由调用方算好传进来
 */
export function workspaceToolMandate(engineering, answerOnly) {
  if (answerOnly) {
    return HEAD
      + "本轮是项目评价/解释型只读任务。只用 read_file、list_dir、search、find_files、代码导航、"
      + "诊断或 Git 只读工具取得最小充分事实；不得运行命令、启动服务、安装依赖、修改文件、"
      + "操作浏览器或做知识库/公网预取。读到目录、清单/入口和少量关键源码后直接回答并结束。"
      + ALREADY_IN_HAND;
  }
  if ((engineering || {}).workspaceAction === "inspect") {
    return HEAD
      + "本轮声明为只读检查（workspaceAction=inspect）：交付物是答案，不是改动。"
      + "用与结构化目标一致的最直接工具取得**最小充分**事实后就回答，"
      + "不得把取证扩展成用户没有要求的工作。"
      + ALREADY_IN_HAND;
  }
  return HEAD
    + "本轮明确指向当前项目。先用与结构化目标一致的最直接工具取得真实证据，"
    + "再完成修改、运行或回答；不得把可能有用的动作扩展成用户没有要求的工作。"
    + ALREADY_IN_HAND;
}
