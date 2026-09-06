//! 提示词模块目录（prompts/prompt_graph.json v3）：「必须」与「按需」两层的数据模型和判据。
//!
//! # 为什么是数据不是代码
//!
//! v2 的图把每一块的挂载条件写死在 assemble_into 里（一条旗标一个 `if`），要加一块就要改 Rust、
//! 改测试、重新发版；而线上量出来的问题恰恰是「某一块挂在了不该挂的任务上」——调整条件应该
//! 是改一行 JSON 的事。v3 把每个模块写成一条记录：`files`（正文）、`head`（什么旗标 / 模式下
//! 进系统提示）、`tail`（第一次用到哪族工具时贴到那条工具结果后面）、`pull`（模型用 load_guide
//! 按 id 自取时给它看的一行说明）。装配器只跑一个通用循环。
//!
//! # 头与尾的分工（缓存纪律）
//!
//! - `head` 进系统提示，位置 0，一旦变化整条对话的前缀缓存作废；所以它只认**运行开始就知道**
//!   的旗标（客户端会话内只增不减地粘住它们），并按目录顺序排，旗标顺序不影响字节。
//! - `tail` 由对话本身决定：扫描 assistant 的 tool_calls，命中条件的**第一次**调用之后（它那一串
//!   工具结果的末尾）插一条 harness 消息。同一份历史每次都算出同一个位置、同一段正文，所以
//!   上游前缀缓存不断；折叠/摘要改写历史时它跟着历史一起变，不需要任何服务端状态。
//! - 一个模块整条对话只投递一次：头里有了尾就不再贴，尾贴过一次就不再贴。
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

pub(crate) const GRAPH_VERSION: u32 = 3;
/// 模型自取指南的工具名（tools.json 里的 schema，客户端只回一句「已附上」）。
pub(crate) const LOAD_GUIDE_TOOL: &str = "load_guide";

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct PromptGraph {
    pub version: u32,
    /// agent 模式必带的那几块，按顺序。
    #[serde(default)]
    pub core: Vec<String>,
    pub modes: HashMap<String, Vec<String>>,
    #[serde(default)]
    pub modules: Vec<ModuleSpec>,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct ModuleSpec {
    pub id: String,
    #[serde(default)]
    pub title: String,
    /// 正文文件名（prompts/<name>.txt），按顺序拼接。
    #[serde(default)]
    pub files: Vec<String>,
    /// 正文不是文件而是代码派生的（目前只有 defect_classes_writing）。
    #[serde(default)]
    pub derived: Option<String>,
    #[serde(default)]
    pub head: Option<HeadCond>,
    #[serde(default)]
    pub tail: Option<TailCond>,
    /// load_guide 索引里给模型看的一句话；None 表示不开放自取。
    #[serde(default)]
    pub pull: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Default)]
pub(crate) struct HeadCond {
    /// 允许的模式，空 = 只有 agent。
    #[serde(default)]
    pub modes: Vec<String>,
    /// 任一旗标命中即挂。
    #[serde(default)]
    pub flags: Vec<String>,
    /// 任一旗标出现即不挂（defects_write 与 defects 互斥）。
    #[serde(default)]
    pub not_flags: Vec<String>,
    /// 这些模块必须已经在头里（设计子层要求 design 先在）。
    #[serde(default)]
    pub requires: Vec<String>,
    /// 裁决还没落定（unjudged）时按默认挂上——只有 engineering 用它。
    #[serde(default)]
    pub unjudged_default: bool,
}

#[derive(Clone, Debug, Deserialize, Default)]
pub(crate) struct TailCond {
    /// 允许的模式，空 = 只有 agent。
    #[serde(default)]
    pub modes: Vec<String>,
    /// 工具名，支持 `git_*` 这种前缀通配。
    #[serde(default)]
    pub tools: Vec<String>,
    /// 路径参数（path / paths / dest / file / files / target）命中的后缀通配，如 `*.tsx`。
    /// 只在 `tools` 也命中时才看；`tools` 为空时对任何工具看路径。
    #[serde(default)]
    pub files: Vec<String>,
    /// run_cmd / run_in_terminal 的 command 里出现的子串（小写比较）。
    #[serde(default)]
    pub commands: Vec<String>,
    /// 这些模块必须已经投递（头或更早的尾）。
    #[serde(default)]
    pub requires: Vec<String>,
}

/// 一次尾部投递：在 `anchor`（消息数组下标，插在它之前）放 `modules` 这几块；
/// `unknown` 是 load_guide 点了但目录里没有的 id，回一句可用清单。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TailPlan {
    pub anchor: usize,
    pub modules: Vec<String>,
    pub unknown: Vec<String>,
}

/// 一次工具调用里能拿来做判据的部分。
struct CallView {
    name: String,
    args: serde_json::Value,
}

impl PromptGraph {
    pub(crate) fn module(&self, id: &str) -> Option<&ModuleSpec> {
        self.modules.iter().find(|m| m.id == id)
    }

    /// 图的结构性校验：加载期就拒绝，不让一个写错的字段在线上静默变成「不挂」。
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.version != GRAPH_VERSION {
            return Err(format!("prompt graph version {} (want {GRAPH_VERSION})", self.version));
        }
        if self.core.is_empty() {
            return Err("prompt graph core is empty".into());
        }
        for mode in ["chat", "plan", "explorer", "reviewer"] {
            if self.modes.get(mode).is_none_or(|m| m.is_empty()) {
                return Err(format!("prompt graph mode {mode} is missing or empty"));
            }
        }
        let mut seen = HashSet::new();
        for m in &self.modules {
            if m.id.is_empty() || !m.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') {
                return Err(format!("prompt module id is not [a-z0-9_]: {:?}", m.id));
            }
            if !seen.insert(m.id.clone()) {
                return Err(format!("prompt module id repeated: {}", m.id));
            }
            if m.files.is_empty() && m.derived.is_none() {
                return Err(format!("prompt module {} has neither files nor derived", m.id));
            }
            if m.head.is_none() && m.tail.is_none() && m.pull.is_none() {
                return Err(format!("prompt module {} can never be delivered (no head, tail or pull)", m.id));
            }
            for req in m
                .head
                .iter()
                .flat_map(|h| h.requires.iter())
                .chain(m.tail.iter().flat_map(|t| t.requires.iter()))
            {
                if self.modules.iter().all(|other| &other.id != req) {
                    return Err(format!("prompt module {} requires unknown module {req}", m.id));
                }
            }
        }
        Ok(())
    }
}

fn mode_allowed(modes: &[String], mode: &str) -> bool {
    if modes.is_empty() {
        mode == "agent"
    } else {
        modes.iter().any(|m| m == mode)
    }
}

/// 这一轮进系统提示的模块，按目录顺序。`flags` 是客户端的语义画像（已粘住的并集）。
pub(crate) fn head_modules<'a>(
    graph: &'a PromptGraph,
    mode: &str,
    flags: &HashSet<String>,
) -> Vec<&'a ModuleSpec> {
    let mut out: Vec<&ModuleSpec> = Vec::new();
    let mut loaded: HashSet<&str> = HashSet::new();
    for m in &graph.modules {
        let Some(head) = &m.head else { continue };
        if !mode_allowed(&head.modes, mode) {
            continue;
        }
        if head.not_flags.iter().any(|f| flags.contains(f)) {
            continue;
        }
        let by_flag = head.flags.iter().any(|f| flags.contains(f));
        let by_default = head.unjudged_default && flags.contains("unjudged");
        if !(by_flag || by_default) {
            continue;
        }
        if !head.requires.iter().all(|r| loaded.contains(r.as_str())) {
            continue;
        }
        loaded.insert(m.id.as_str());
        out.push(m);
    }
    out
}

fn tool_matches(pattern: &str, name: &str) -> bool {
    match pattern.strip_suffix('*') {
        Some(prefix) => name.starts_with(prefix),
        None => pattern == name,
    }
}

fn path_matches(globs: &[String], path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    globs.iter().any(|g| match g.strip_prefix('*') {
        Some(suffix) => lower.ends_with(&suffix.to_ascii_lowercase()),
        None => lower == g.to_ascii_lowercase(),
    })
}

const PATH_ARGS: &[&str] = &["path", "paths", "file", "files", "dest", "target", "filename"];

fn call_paths(args: &serde_json::Value) -> Vec<String> {
    let mut out = Vec::new();
    for key in PATH_ARGS {
        match args.get(key) {
            Some(serde_json::Value::String(s)) => out.push(s.clone()),
            Some(serde_json::Value::Array(items)) => {
                out.extend(items.iter().filter_map(|v| v.as_str().map(str::to_string)));
            }
            _ => {}
        }
    }
    out
}

fn call_command(call: &CallView) -> Option<String> {
    if !matches!(call.name.as_str(), "run_cmd" | "run_in_terminal") {
        return None;
    }
    call.args
        .get("command")
        .and_then(|v| v.as_str())
        .map(|s| s.to_ascii_lowercase())
}

fn tail_matches(tail: &TailCond, call: &CallView) -> bool {
    let tool_hit = tail.tools.iter().any(|p| tool_matches(p, &call.name));
    if !tail.files.is_empty() {
        // 路径条件：工具名列表非空时先要工具命中，再看路径；为空则任何工具都看路径。
        if !tail.tools.is_empty() && !tool_hit {
            return false;
        }
        return call_paths(&call.args).iter().any(|p| path_matches(&tail.files, p));
    }
    if tool_hit {
        return true;
    }
    if !tail.commands.is_empty() {
        if let Some(cmd) = call_command(call) {
            return tail.commands.iter().any(|c| cmd.contains(&c.to_ascii_lowercase()));
        }
    }
    false
}

fn calls_of(message: &serde_json::Value) -> Vec<CallView> {
    let mut out = Vec::new();
    if let Some(calls) = message.get("tool_calls").and_then(|v| v.as_array()) {
        for c in calls {
            let name = c.pointer("/function/name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if name.is_empty() {
                continue;
            }
            let args = match c.pointer("/function/arguments") {
                Some(serde_json::Value::String(s)) => serde_json::from_str(s).unwrap_or(serde_json::Value::Null),
                Some(v) => v.clone(),
                None => serde_json::Value::Null,
            };
            out.push(CallView { name, args });
        }
    }
    // Anthropic 形状的历史（content 里的 tool_use 块）——客户端不这样发，但第三方按这个形状
    // 走网关时判据一样成立。
    if let Some(parts) = message.get("content").and_then(|v| v.as_array()) {
        for p in parts {
            if p.get("type").and_then(|v| v.as_str()) != Some("tool_use") {
                continue;
            }
            let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if name.is_empty() {
                continue;
            }
            out.push(CallView { name, args: p.get("input").cloned().unwrap_or(serde_json::Value::Null) });
        }
    }
    out
}

fn is_tool_result_message(message: &serde_json::Value) -> bool {
    match message.get("role").and_then(|v| v.as_str()) {
        Some("tool") => true,
        Some("user") => message
            .get("content")
            .and_then(|v| v.as_array())
            .is_some_and(|parts| {
                !parts.is_empty()
                    && parts.iter().all(|p| p.get("type").and_then(|v| v.as_str()) == Some("tool_result"))
            }),
        _ => false,
    }
}

/// 按对话内容算出这一轮要贴在尾部的模块：每个模块只在**第一次**命中的那串工具结果后面出现一次。
/// `loaded` 是头里已经有的模块 id。结果按 anchor 升序，同一 anchor 的模块按目录顺序。
pub(crate) fn plan_tail(
    graph: &PromptGraph,
    mode: &str,
    messages: &[serde_json::Value],
    loaded: &HashSet<String>,
) -> Vec<TailPlan> {
    let mut delivered: HashSet<String> = loaded.clone();
    let mut plans: Vec<TailPlan> = Vec::new();
    let mut i = 0;
    while i < messages.len() {
        let m = &messages[i];
        let is_assistant = m.get("role").and_then(|v| v.as_str()) == Some("assistant");
        let calls = if is_assistant { calls_of(m) } else { Vec::new() };
        if calls.is_empty() {
            i += 1;
            continue;
        }
        let mut anchor = i + 1;
        while anchor < messages.len() && is_tool_result_message(&messages[anchor]) {
            anchor += 1;
        }
        let mut here: Vec<String> = Vec::new();
        let mut unknown: Vec<String> = Vec::new();
        for call in &calls {
            if call.name == LOAD_GUIDE_TOOL {
                let id = ["id", "name", "guide"]
                    .iter()
                    .find_map(|k| call.args.get(k).and_then(|v| v.as_str()))
                    .unwrap_or("")
                    .trim()
                    .to_ascii_lowercase()
                    .replace('-', "_");
                match graph.module(&id) {
                    Some(spec) if spec.pull.is_some() || spec.head.is_some() || spec.tail.is_some() => {
                        if delivered.insert(spec.id.clone()) {
                            here.push(spec.id.clone());
                        }
                    }
                    _ => {
                        if !unknown.contains(&id) {
                            unknown.push(id);
                        }
                    }
                }
                continue;
            }
            for spec in &graph.modules {
                let Some(tail) = &spec.tail else { continue };
                if delivered.contains(&spec.id) || !mode_allowed(&tail.modes, mode) {
                    continue;
                }
                if !tail.requires.iter().all(|r| delivered.contains(r)) {
                    continue;
                }
                if tail_matches(tail, call) {
                    delivered.insert(spec.id.clone());
                    here.push(spec.id.clone());
                }
            }
        }
        if !here.is_empty() || !unknown.is_empty() {
            plans.push(TailPlan { anchor, modules: here, unknown });
        }
        i = anchor.max(i + 1);
    }
    plans
}

/// load_guide 的可用清单（给「没有这个指南」的回话和工具描述对账用）。
pub(crate) fn pullable_ids(graph: &PromptGraph) -> Vec<&str> {
    graph
        .modules
        .iter()
        .filter(|m| m.pull.is_some())
        .map(|m| m.id.as_str())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn graph() -> PromptGraph {
        serde_json::from_value(json!({
            "version": 3,
            "core": ["system_invariants"],
            "modes": {"chat": ["chat"], "plan": ["plan"], "explorer": ["explorer"], "reviewer": ["reviewer"]},
            "modules": [
                {"id": "engineering", "files": ["engineering_core"], "head": {"flags": ["engineering"], "unjudged_default": true}},
                {"id": "git", "files": ["git_guide"], "head": {"flags": ["git"]}, "tail": {"tools": ["git_commit", "gh_*"], "commands": ["git commit"]}, "pull": "git"},
                {"id": "design", "files": ["design_core"], "head": {"modes": ["agent", "plan"], "flags": ["design"]}, "tail": {"tools": ["write_file"], "files": ["*.tsx"]}, "pull": "ui"},
                {"id": "design_review", "files": ["design_verification"], "head": {"flags": ["design_review"], "requires": ["design"]}, "tail": {"tools": ["browser"], "requires": ["design"]}, "pull": "verify"},
                {"id": "defects_write", "derived": "defect_classes_writing", "head": {"flags": ["defects_write"], "not_flags": ["defects"]}},
                {"id": "reasoning", "files": ["reasoning"], "pull": "full"}
            ]
        }))
        .unwrap()
    }

    fn flags(list: &[&str]) -> HashSet<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn call(name: &str, args: serde_json::Value) -> serde_json::Value {
        json!({"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "type": "function", "function": {"name": name, "arguments": args.to_string()}}]})
    }

    #[test]
    fn head_follows_flags_modes_requires_and_exclusions() {
        let g = graph();
        assert!(g.validate().is_ok());
        let ids = |v: Vec<&ModuleSpec>| v.iter().map(|m| m.id.clone()).collect::<Vec<_>>();
        assert_eq!(ids(head_modules(&g, "agent", &flags(&["engineering", "git"]))), vec!["engineering", "git"]);
        // unjudged 时工程块按默认挂上，裁决落定后只看旗标。
        assert_eq!(ids(head_modules(&g, "agent", &flags(&["unjudged"]))), vec!["engineering"]);
        assert_eq!(ids(head_modules(&g, "agent", &flags(&[]))), Vec::<String>::new());
        // design_review 要求 design 先在；plan 模式能拿 design，拿不到只允许 agent 的 git。
        assert_eq!(ids(head_modules(&g, "agent", &flags(&["design_review"]))), Vec::<String>::new());
        assert_eq!(ids(head_modules(&g, "agent", &flags(&["design", "design_review"]))), vec!["design", "design_review"]);
        assert_eq!(ids(head_modules(&g, "plan", &flags(&["design", "git"]))), vec!["design"]);
        // 互斥：defects 在场时写码切片不挂。
        assert_eq!(ids(head_modules(&g, "agent", &flags(&["defects_write"]))), vec!["defects_write"]);
        assert_eq!(ids(head_modules(&g, "agent", &flags(&["defects_write", "defects"]))), Vec::<String>::new());
    }

    #[test]
    fn tail_fires_once_at_the_end_of_the_first_matching_tool_run() {
        let g = graph();
        let msgs = vec![
            json!({"role": "user", "content": "提交一下"}),
            json!({"role": "assistant", "content": "", "tool_calls": [
                {"id": "a", "type": "function", "function": {"name": "read_file", "arguments": "{\"path\":\"a.rs\"}"}},
                {"id": "b", "type": "function", "function": {"name": "git_commit", "arguments": "{\"message\":\"x\"}"}}
            ]}),
            json!({"role": "tool", "tool_call_id": "a", "content": "..."}),
            json!({"role": "tool", "tool_call_id": "b", "content": "ok"}),
            json!({"role": "user", "content": "〔系统编排提示——这不是用户发言〕facts"}),
            call("git_commit", json!({"message": "again"})),
            json!({"role": "tool", "tool_call_id": "c1", "content": "ok"}),
        ];
        let plans = plan_tail(&g, "agent", &msgs, &HashSet::new());
        assert_eq!(plans, vec![TailPlan { anchor: 4, modules: vec!["git".into()], unknown: vec![] }]);
        // 头里已经有了就不再贴。
        assert!(plan_tail(&g, "agent", &msgs, &flags(&["git"])).is_empty());
        // 同一份历史再长一截，早先的锚点一个字节都不动。
        let mut longer = msgs.clone();
        longer.push(json!({"role": "assistant", "content": "done"}));
        assert_eq!(plan_tail(&g, "agent", &longer, &HashSet::new()), plans);
    }

    #[test]
    fn tail_matches_prefix_globs_commands_paths_and_requires() {
        let g = graph();
        let one = |m: serde_json::Value| vec![json!({"role": "user", "content": "x"}), m, json!({"role": "tool", "tool_call_id": "c1", "content": "ok"})];
        let ids = |plans: Vec<TailPlan>| plans.into_iter().flat_map(|p| p.modules).collect::<Vec<_>>();
        assert_eq!(ids(plan_tail(&g, "agent", &one(call("gh_pr_create", json!({}))), &HashSet::new())), vec!["git"]);
        assert_eq!(ids(plan_tail(&g, "agent", &one(call("run_cmd", json!({"command": "cd x && GIT COMMIT -m hi"}))), &HashSet::new())), vec!["git"]);
        assert!(ids(plan_tail(&g, "agent", &one(call("run_cmd", json!({"command": "git status"}))), &HashSet::new())).is_empty());
        // 路径条件：写 .tsx 才算界面，写 .rs 不算。
        assert_eq!(ids(plan_tail(&g, "agent", &one(call("write_file", json!({"path": "src/App.TSX", "content": ""}))), &HashSet::new())), vec!["design"]);
        assert!(ids(plan_tail(&g, "agent", &one(call("write_file", json!({"path": "src/main.rs", "content": ""}))), &HashSet::new())).is_empty());
        // requires：没先拿到 design，browser 不触发验收层；头里有 design 就触发。
        assert!(ids(plan_tail(&g, "agent", &one(call("browser", json!({"action": "navigate"}))), &HashSet::new())).is_empty());
        assert_eq!(ids(plan_tail(&g, "agent", &one(call("browser", json!({"action": "navigate"}))), &flags(&["design"]))), vec!["design_review"]);
        // chat 模式没有尾部投递（tail.modes 为空 = 只有 agent）。
        assert!(plan_tail(&g, "chat", &one(call("git_commit", json!({}))), &HashSet::new()).is_empty());
    }

    #[test]
    fn load_guide_pulls_by_id_and_reports_unknown_ids() {
        let g = graph();
        let msgs = vec![
            json!({"role": "user", "content": "x"}),
            call("load_guide", json!({"id": "Reasoning"})),
            json!({"role": "tool", "tool_call_id": "c1", "content": "〔已附上〕"}),
            call("load_guide", json!({"id": "nope"})),
            json!({"role": "tool", "tool_call_id": "c1", "content": "〔已附上〕"}),
        ];
        let plans = plan_tail(&g, "agent", &msgs, &HashSet::new());
        assert_eq!(plans, vec![
            TailPlan { anchor: 3, modules: vec!["reasoning".into()], unknown: vec![] },
            TailPlan { anchor: 5, modules: vec![], unknown: vec!["nope".into()] },
        ]);
        assert_eq!(pullable_ids(&g), vec!["git", "design", "design_review", "reasoning"]);
    }

    #[test]
    fn validation_rejects_broken_graphs() {
        let mut g = graph();
        g.version = 2;
        assert!(g.validate().is_err());
        let mut g = graph();
        g.modules.push(ModuleSpec { id: "orphan".into(), title: String::new(), files: vec!["x".into()], derived: None, head: None, tail: None, pull: None });
        assert!(g.validate().unwrap_err().contains("orphan"));
        let mut g = graph();
        g.modules[3].head.as_mut().unwrap().requires = vec!["ghost".into()];
        assert!(g.validate().unwrap_err().contains("ghost"));
    }
}
