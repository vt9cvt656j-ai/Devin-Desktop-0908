import { coerceSupportedLocale, isSupportedLocale, systemPreferredLocale } from "./locales.js";
// 切块用的是编辑器那边同一套判据（按 UTF-8 字节，不把多字节字符切两半）。它是个纯函数、
// 不碰 DOM 也不碰网络，所以直接引过来 —— 在这里另抄一份，两份迟早漂开，而漂开的后果是
// 一边切得对、另一边把超长的条目原样送出去被网关静默丢掉。
import { chunkText } from "./agent/hover-doc.js";

const EN = {
  "titlebar.open": "Open",
  "titlebar.save": "Save",
  "titlebar.title": "Mr. Day One",

  "sidebar.explorer": "Explorer",
  "sidebar.source": "Source",

  "explorer.noFolder": "No folder",
  "explorer.openHint": "Open a folder to get started.",
  "explorer.openBtn": "Open folder…",
  "explorer.newFile": "New File",
  "explorer.newFolder": "New Folder",
  "explorer.folderCount": "{count} 个文件夹 · {name}",
  "explorer.refresh": "Refresh",

  "search.placeholder": "Search in folder…",
  "search.matchCase": "Match Case",
  "search.searching": "Searching…",
  "search.noResults": "No results",
  "search.openFolder": "Open a folder to search.",
  "search.resultsMeta": "{total} result{s1} in {files} file{s2}",

  "git.commit": "Commit",
  "git.commitPlaceholder": "Message (commit staged changes)",
  "git.pull": "Pull",
  "git.push": "Push",
  "git.branchHint": "Current branch — click to switch",
  "git.stagedChanges": "Staged Changes",
  "git.changes": "Changes",
  "git.unstageAll": "Unstage all",
  "git.stageAll": "Stage all",
  "git.unstage": "Unstage",
  "git.stage": "Stage",
  "git.noChanges": "No changes — working tree clean.",
  "git.notRepo": "This folder is not a Git repository.",
  "git.openFolder": "Open a folder to see source control.",
  "git.pushing": "Pushing…",
  "git.pulling": "Pulling…",
  "git.pushed": "Pushed.",
  "git.pulled": "Pulled.",
  "git.switchingTo": "Switching to {name}…",
  "git.switchedTo": "Switched to branch '{name}'",
  "git.createdBranch": "Created and switched to '{name}'",
  "git.committed": "Committed {hash}",
  "git.emptyMsg": "Enter a commit message first.",
  "git.onBranch": "On branch {name}",
  "git.newBranch": "Create new branch…",
  "git.newBranchPrompt": "New branch name:",
  "git.staged": "Staged {name}",
  "git.unstaged": "Unstaged {name}",
  "git.stagedAll": "Staged all changes",
  "git.unstagedAll": "Unstaged all changes",
  "git.history": "History",
  "git.timeline": "Timeline",
  "git.toggleTimeline": "Toggle Timeline",
  "sidebar.debug": "Debug",
  "git.toggleHistory": "Toggle history",
  "git.stash": "Stash",
  "git.stashes": "Stashes",
  "git.toggleStashes": "Toggle stashes",
  "git.stashed": "Stashed changes.",
  "git.stashApply": "Apply",
  "git.stashPop": "Pop",
  "git.stashDrop": "Drop",
  "git.stashApplied": "Stash applied.",
  "git.stashPopped": "Stash popped.",
  "git.stashDropped": "Stash dropped.",
  "git.stashPopLatest": "Pop Latest Stash",
  "git.blameToggle": "Toggle Git Blame",
  "git.blameLabel": "Blame: On",
  "git.blameOn": "Git Blame enabled.",
  "git.blameOff": "Git Blame disabled.",
  "git.blameToday": "today",
  "git.blameYesterday": "yesterday",
  "git.blameDaysAgo": "{n} days ago",
  "git.blameMonthsAgo": "{n} mo ago",

  "diff.title": "Diff",
  "diff.sub": "HEAD ↔ Working Tree",
  "diff.close": "Close diff",

  "welcome.title": "Mr. Day One",
  "welcome.desc": "A macOS-style editor with a built-in AI assistant. Open a folder, pick a file, and ask the assistant on the right for help.",
  "welcome.tipSave": "Save",
  "welcome.tipAsk": "Ask assistant",
  "welcome.recent": "Recent projects",

  "outline.filter": "Filter symbols…",
  "outline.empty": "Open a file to see its outline.",
  "outline.timeline": "Timeline",

  "debug.runGroup": "Run and Debug",
  "debug.title": "Debug / Debugger (breakpoints, step, variables)",
  "debug.aria": "Debug",
  "debug.variables": "Variables",
  "debug.callStack": "Call Stack",
  "debug.breakpoints": "Breakpoints",
  "notifications.title": "Notifications",
  "updates.check": "Check for Updates…",
  "updates.title": "Mr. Day One Update",
  "updates.available": "Version v{version} is ready",
  "updates.currentVersion": "Current version",
  "updates.newVersion": "New version",
  "updates.releaseNotes": "What's new",
  "updates.noNotes": "This release includes improvements and bug fixes.",
  "updates.downloadRestart": "Download and Restart",
  "updates.downloading": "Downloading update…",
  "updates.installing": "Installing update…",
  "updates.saving": "Saving your work…",
  "updates.upToDate": "Mr. Day One is up to date",
  "updates.failed": "Update check failed: {error}",
  "updates.installFailed": "Update installation failed: {error}",
  "updates.saveFailed": "Some edited files could not be saved. The update was cancelled.",
  "updates.close": "Close update dialog",
  "updates.restartNotice": "The signed update will be installed, then Mr. Day One will restart.",
  "updates.desktopOnly": "Update checks are available in the Mr. Day One desktop app.",
  "voice.input": "Voice input",

  "problems.title": "Problems",
  "problems.empty": "No problems have been detected.",
  "problems.close": "Close panel",
  "problems.errors": "errors",
  "problems.warnings": "warnings",
  "problems.none": "no problems",

  "terminal.title": "Terminal",
  "terminal.close": "Close panel",
  "terminal.toggle": "Toggle terminal",
  "terminal.split": "Split Terminal",
  "output.title": "Output",
  "output.channel.lsp": "Language Service",
  "output.channel.tasks": "Tasks",
  "output.channel.extensions": "Extensions",
  "test.empty": "No tests detected. Open a project with test files.",
  "test.runAll": "Run All Tests",

  "assistant.name": "Qiming",
  "assistant.placeholder": "Ask about the open file…",
  "assistant.selectModel": "Select model",
  "assistant.switchModel": "Switch model",
  "assistant.send": "Send",
  "assistant.thinking": "Thinking",
  "assistant.you": "You",
  "assistant.chatHintTitle": "Ask about your code",
  "assistant.chatHintDesc": "The open file — and any text you select — is sent as context automatically.",
  "assistant.currentFile": "current file",
  "assistant.chip.explain": "Explain this file",
  "assistant.chip.bugs": "Find potential bugs",
  "assistant.chip.comments": "Add doc comments",
  "assistant.chip.test": "Write a unit test",
  "assistant.chip.fixErrors": "Fix errors ({count})",
  "assistant.chip.explainSelection": "Explain selected code",
  "assistant.chip.reviewChange": "Review my changes",
  "assistant.chip.commitMessage": "Write commit message",
  "assistant.chip.reviewAllChanges": "Review all changes ({count})",
  "assistant.chip.explainFile": "Explain “{name}”",
  "assistant.chip.howToRun": "How to run it",
  "assistant.chip.polishDoc": "Polish this document",
  "assistant.chip.addTestCases": "Add test cases",
  "assistant.chip.refactor": "Optimize/refactor",
  "assistant.chip.errorHandling": "Add error handling",
  "assistant.chip.callGraph": "Map call relationships",
  "tool.action.skill": "Skill",
  "assistant.chip.startProject": "Start something here",
  "assistant.prompt.startProject": "This folder is empty. Ask me what I want to build, suggest a couple of concrete directions with a one-line tradeoff each, and once I pick one, scaffold it and get it running.",
  "assistant.chip.scaffoldHere": "Scaffold a project",
  "assistant.prompt.scaffoldHere": "Scaffold a runnable starter project in this empty folder: pick a sensible stack, create the files, install what it needs, and run it so I can see it working.",
  "assistant.chip.projectResearch": "Explore this project",
  "assistant.chip.whatIsProject": "What does it do?",
  "assistant.chip.addFeature": "Help me add a feature",
  "assistant.chip.findIssues": "Find project issues",
  "assistant.chip.addTests": "Add tests",
  "assistant.chip.openFolder": "Open a folder",
  "assistant.chip.whatCanIdeDo": "What can this IDE do?",
  "assistant.chip.writeCode": "Write code",
  "assistant.chip.explainSnippet": "Explain code",
  "assistant.chip.writeRegex": "Write a regex",
  "assistant.chip.writeScript": "Write a small script",
  "assistant.onboardHeader": "📁 Opened {name} · getting started:",
  "tool.action.write": "Write",
  "tool.action.edit": "Edit",
  "tool.action.multiedit": "Multi-edit",
  "tool.action.read": "Read",
  "tool.action.list": "List",
  "tool.action.cmd": "Run",
  "tool.action.search": "Search",
  "tool.action.find": "Find",
  "tool.action.web": "Fetch",
  "tool.action.websearch": "Web search",
  "tool.action.search_tools": "Find tools",
  "tool.action.memory": "Memory",
  "tool.action.think": "Think",
  "tool.action.delete": "Delete",
  "tool.action.move": "Move",
  "tool.action.diag": "Diagnostics",
  "tool.action.git": "Git",
  "tool.action.gh": "GitHub",
  "tool.action.lsp": "LSP",
  "tool.action.findsymbol": "Find symbol",
  "tool.action.semsearch": "Semantic search",
  "tool.action.knowledge": "Knowledge search",
  "tool.action.mkdir": "New folder",
  "tool.action.copy": "Copy",
  "tool.action.format": "Format",
  "tool.action.termtask": "Terminal task",
  "tool.action.termread": "Read terminal",
  "tool.action.termlist": "Terminals",
  "tool.action.termstop": "Stop terminal",
  "tool.action.http": "HTTP",
  "tool.action.tor": "Tor",
  "tool.action.download": "Download",
  "tool.action.mcp": "MCP",
  "tool.action.demostart": "Recording",
  "tool.action.demostop": "Recorded",
  "tool.action.screenshot": "Screenshot",
  "tool.action.browser": "Browser",
  "tool.action.computer": "Computer",
  "tool.action.system": "System",
  "tool.action.automation": "Automation",
  "tool.action.readscreen": "Read screen",
  "tool.action.uiclick": "Click element",
  "tool.action.remote": "Remote",
  "tool.action.askuser": "Needs your input",
  "tool.action.current_time": "Current time",
  "tool.action.localdiscovery": "Nearby devices",
  "tool.action.liveenvironment": "Environment data",
  "tool.action.livemarkets": "Market data",
  "tool.action.liveflights": "Flight status",
  "tool.action.roadenvironment": "Road conditions",
  "tool.action.trackshipment": "Track shipment",
  "tool.action.shopcatalog": "Prices",
  "tool.action.db": "Database",
  "tool.action.qr": "Scan QR",
  "tool.action.genimage": "Generate image",
  "tool.action.vizcompare": "Visual compare",
  "tool.action.designboard": "Design board",
  "tool.action.preview": "Preview options",
  "tool.action.explain": "Visual explainer",
  "tool.action.capture_start": "Start capture",
  "tool.action.capture_flows": "Read capture",
  "tool.action.capture_stop": "Stop capture",
  "tool.action.capture_replay": "Replay request",
  "tool.action.background_monitor": "Background monitor",
  "tool.action.worktree": "Worktree",
  "tool.action.awaitsubagent": "Await subagents",
  "tool.action.game_scaffold": "Game scaffold",
  "tool.action.web_scaffold": "Site scaffold",
  "tool.action.learn_design": "Learn design system",
  "tool.action.generate_3d": "3D model",
  "tool.action.generate_sound": "Sound",
  "tool.action.generate_music": "Music",
  "tool.action.generate_voice": "Voice",
  "tool.action.auto_rig": "Auto-rig",
  "tool.action.generate_motion": "Animation",
  "tool.action.generate_texture": "Texture",
  "tool.action.search_game_assets": "Asset search",
  "tool.action.download_asset": "Download asset",
  "tool.action.unknown": "Unknown tool",
  "subagent.label": "Subagent",
  "subagent.researchProject": "Explore the codebase",
  "subagent.researchFocus": "Explore · {focus}",
  "tool.readLines": "{count} lines",
  "tool.undo": "Undo",
  "subagent.researchSteps": "{count} steps researched",
  "subagent.researchStepsOne": "1 step researched",
  "subagent.workerStepsOne": "1 step (worker)",
  "subagent.workerStepsNoWriteOne": "1 step (worker \u00b7 nothing written)",
  "subagent.workerSteps": "{count} steps (worker)",
  "subagent.workerStepsNoWrite": "{count} steps (worker · nothing written)",
  "subagent.jobsSettled": "{count} jobs settled",
  "chat.nextSteps": "Next \u203a",
  "subagent.worker": "Worker",
  "subagent.noSteps": "0 steps · did not run",
  "subagent.queued": "Queued",
  "subagent.concurrent": "{count} in parallel",
  "tool.stopped": "Stopped",
  "tool.failed": "Failed",
  "plan.title": "Task plan",
  "plan.badgeDone": "{done}/{total} done",
  "plan.badgeCancelled": " · {count} cancelled",
  "plan.cancelHint": "click to cancel \u2715",
  "plan.restoreHint": "click to restore \u21a9",
  "assistant.prompt.warningSuffix": ", plus {count} warning(s)",
  "assistant.prompt.fixErrors": "The current file {path} has {errors} error(s){warnings}. Locate each root cause and fix them one by one. After editing, use get_diagnostics to confirm they are gone and no new issues were introduced.",
  "assistant.prompt.explainSelection": "Explain the selected code in {path}: what it does, how it works, any edge cases, and whether there is a clearer way to write it.",
  "assistant.prompt.reviewChange": "Review my uncommitted changes in {path} with git diff. Point out potential bugs, missing error handling, style drift, and concrete improvements.",
  "assistant.prompt.commitMessage": "Look at my uncommitted changes (git diff --staged first; if nothing is staged, git diff) and write a conventional commit message: one concise subject plus a body if needed.",
  "assistant.prompt.reviewAllChanges": "Review all current uncommitted changes with git diff. Go file by file and point out potential bugs, missing error handling, style issues, and worthwhile improvements.",
  "assistant.prompt.explainFile": "Explain {path}: its overall responsibility, key functions/types, data flow, and its role in the project.",
  "assistant.prompt.howToRunFile": "Look at {path} and the related config. Tell me how to install dependencies, start, and build this project with commands I can copy directly.",
  "assistant.prompt.polishDoc": "Read and polish {path}: improve structure, wording, typos, and clarity while preserving the original meaning.",
  "assistant.prompt.addTestCases": "Read {path}, find branches and edge cases that are not covered yet, and add test cases using the file's existing test framework and style.",
  "assistant.prompt.findBugs": "Carefully review {path}. Find potential bugs, races, edge cases, and missing error handling. List them by severity with fixes.",
  "assistant.prompt.refactor": "Review {path} for opportunities to simplify, extract, deduplicate, or improve readability/performance. Suggest safe small-step refactors that preserve behavior.",
  "assistant.prompt.writeTests": "Write unit tests for {path}: cover the main functions, important branches, and edge cases, following the project's existing test framework and style.",
  "assistant.prompt.docComments": "Add clear documentation comments to the public functions/types in {path}: purpose, parameters, return values, and side effects, following this language's conventions.",
  "assistant.prompt.errorHandling": "Review the error handling in {path}: find calls that may throw or return errors without handling, then add robust and clear handling.",
  "assistant.prompt.callGraph": "Map how {path} relates to the rest of the project: who calls it, what it depends on, and the impact of changing it.",
  "assistant.prompt.projectResearch": "Use research_project to deeply explore this project and give me an onboarding map: tech stack, directory structure, core module responsibilities, data/control flow, code conventions, and common change entry points.",
  "assistant.prompt.whatIsProject": "What does this project do? Briefly explain the core features, target users, and overall architecture.",
  "assistant.prompt.howToRunProject": "How do I install dependencies and start this project? Read README/package.json and related config, then give directly executable steps.",
  "assistant.prompt.addFeature": "I want to add a new feature to this project. First research the related code, find the right change entry points, then give me a plan.",
  "assistant.prompt.findProjectIssues": "Scan this project for obvious bugs, risks, code smells, or outdated dependencies. List them by priority.",
  "assistant.prompt.addProjectTests": "Review the existing test coverage, identify weak spots in key modules, and help me add valuable tests.",
  "assistant.prompt.openFolder": "How do I open a project folder in this IDE and start working?",
  "assistant.prompt.whatCanIdeDo": "Briefly introduce this IDE's core abilities: AI agent, running commands, Git, debugging, and how I should get started.",
  "assistant.prompt.writeCode": "Help me write code:",
  "assistant.prompt.explainSnippet": "I will paste a code snippet; explain what it does and how it works:",
  "assistant.prompt.writeRegex": "Help me write a regular expression that matches:",
  "assistant.prompt.writeScript": "Help me write a small script. I will describe the purpose and language:",
  "assistant.configFirst": "Please sign in to your Michael account first",
  "assistant.capabilities": "Capabilities",
  "assistant.capabilities.open": "Open User Habits and User Rules menu",
  "assistant.capability.habits": "User Habits",
  "assistant.capability.rules": "User Rules",
  "assistant.capability.browser": "Browser",
  "assistant.capability.caps": "My Capabilities",
  "assistant.mode.agent": "Agent",
  "assistant.mode.plan": "Plan",
  "assistant.mode.chat": "Chat",
  "assistant.mode.auto": "Auto",
  "assistant.mode.switch": "Switch AI mode",
  "assistant.jumpToLatest": "Jump to latest",
  "assistant.tokenMeter": "Context cache: {percent}%",

  "model.desc.opus": "Anthropic Claude Opus — flagship-grade model for complex reasoning, coding, and long tasks.",
  "model.desc.sonnet": "Anthropic Claude Sonnet — balanced capability and speed, strong for everyday coding.",
  "model.desc.haiku": "Anthropic Claude Haiku — lightweight and fast for high-frequency, lower-cost tasks.",
  "model.desc.deepseek": "DeepSeek — strong coding and reasoning, long context, high cost performance.",
  "model.desc.minimax": "MiniMax — extra-long context with strong Chinese capability.",
  "model.desc.gemini": "Google Gemini — native multimodal capability and extra-long context.",
  "model.desc.qwen": "Alibaba Qwen — multilingual model with strong Chinese and coding capability.",
  "model.desc.glm": "Zhipu GLM — Chinese-friendly general model.",
  "model.desc.grok": "xAI Grok — real-time knowledge and strong reasoning.",
  "model.desc.kimi": "Moonshot Kimi — extra-long context and strong Chinese long-form processing.",
  "model.desc.openai": "OpenAI GPT — flagship general multimodal model with strong overall capability.",
  "model.price.title": "Model price",
  "model.price.input": "Input",
  "model.price.output": "Output",
  "model.price.flat": "Per request",
  "model.price.perMillionTokens": "/ 1M tokens",
  "model.price.perCallUnsplit": "/ call (backend did not split input/output)",
  "model.price.source": "Source: {source}",
  "model.price.rate": "Rate / multiplier: {rate}",
  "model.price.source.modelOverride": "backend per-model setting",
  "model.price.source.backend": "backend connection settings",
  "model.price.source.catalog": "built-in model price catalog",
  "model.price.source.unset": "not configured",
  "model.price.imageBilling": "Image model · billed per image",
  "model.price.missing": "Backend did not return input/output prices",
  "model.thinkingDepth": "Reasoning depth",
  "model.thinkingToggle": "Thinking (on/off only)",
  "model.thinking.on": "Reasoning on · {level}",
  "model.thinking.off": "Reasoning off",
  "model.thinking.defaultHint": "Send reasoning parameters according to this model's real public capability.",
  "model.thinking.unsupported": "This model does not support adjustable reasoning parameters.",
  "model.thinking.level.off": "Off",
  "model.thinking.level.minimal": "Minimal",
  "model.thinking.level.low": "Low",
  "model.thinking.level.medium": "Medium",
  "model.thinking.level.high": "High",
  "model.thinking.level.xhigh": "XHigh",
  "model.thinking.level.max": "Max",
  "model.thinking.level.alwaysOn": "Always on",
  "model.thinking.level.enabled": "On",
  "model.thinking.tip.off": "Off / do not send adjustable reasoning parameters. If the model has forced built-in reasoning, it still follows its default behavior.",
  "model.thinking.tip.minimal": "Minimal reasoning for very simple tasks (only supported by some models).",
  "model.thinking.tip.low": "Low reasoning: balances speed and quality.",
  "model.thinking.tip.medium": "Medium reasoning (recommended default).",
  "model.thinking.tip.high": "High reasoning for hard problems.",
  "model.thinking.tip.xhigh": "Extra-high reasoning (only for models that explicitly support this tier).",
  "model.thinking.tip.max": "Max budget tier (only for models that explicitly accept a thinking budget). Slower and more expensive.",
  "model.thinking.reason.noPublic": "This model has no public adjustable reasoning parameter; IDE will not send fake reasoning_effort.",
  "model.thinking.reason.notSelected": "No model selected",
  "model.thinking.reason.image": "Image generation models do not support chat reasoning depth.",
  "model.thinking.reason.kimiForced": "Kimi K2.7 Code has official always-on reasoning; it cannot be turned off or manually tiered.",
  "model.thinking.reason.kimiForcedHint": "Kimi K2.7 Code has official always-on reasoning; IDE will use the model default.",
  "model.thinking.reason.kimiToggleHint": "This Kimi family only supports thinking.type on/off, not low/medium/high/max tiers.",
  "model.thinking.reason.glmToggleHint": "GLM 4.5+/5.x only exposes a thinking.type on/off switch; low/medium/high depth tiers have no effect on it.",
  "model.thinking.reason.kimiNormal": "Regular Kimi models do not expose public adjustable reasoning tiers; IDE will not send fake parameters.",
  "model.thinking.reason.grok45": "Grok 4.5 supports low / medium / high; there is no official off tier, default is high. The tier does take effect, but no thinking card will appear \u2014 xAI returns no reasoning content on the Chat Completions API (only the Responses API does).",
  "model.thinking.reason.grok43": "Grok 4.3 supports none / low / medium / high. The tier does take effect, but no thinking card will appear \u2014 xAI returns no reasoning content on the Chat Completions API.",
  "model.thinking.reason.grokReasoning": "This Grok reasoning model uses reasoning_effort tiers; non-reasoning Grok models do not show this control. The tier does take effect (it changes how long the model thinks and what you are billed), but **no thinking card will appear**: xAI documents \u201cno reasoning content returned\u201d for the Chat Completions API \u2014 visible reasoning summaries exist only on its Responses API.",
  "model.thinking.reason.grokNone": "This Grok model has no public adjustable reasoning_effort; IDE will not send fake parameters.",
  "model.thinking.reason.gpt56": "GPT-5.6 follows the gateway's none/low/medium/high/xhigh/max reasoning_effort tiers — measured 2026-08-13, the tiers are real (low/medium produce about half the output of high; an invalid tier is rejected). But this family returns its reasoning as a SUMMARY OUTLINE — a few bold section titles, roughly 50–900 characters — not a reasoning trace. If you want to read real reasoning, the Claude family returns about 1,200 characters of actual analysis on the same question.",
  "model.thinking.reason.openai": "OpenAI reasoning models use reasoning_effort: low / medium / high; when off, IDE does not send the field.",
  "model.thinking.reason.claudeHaiku": "Claude Haiku usually does not expose manual extended-thinking budget; IDE will not send fake parameters.",
  "model.thinking.reason.claude": "Claude uses extended/adaptive thinking budget; low/medium/high/max send different budget_tokens.",
  "model.thinking.reason.gemini3": "Gemini 3 uses thinkingLevel; Flash supports minimal/low/medium/high, Pro uses low/medium/high.",
  "model.thinking.reason.gemini25": "Gemini 2.5 uses thinkingBudget; Flash can set 0 to turn off, Pro keeps thinking on.",
  "model.thinking.reason.geminiUnknown": "This Gemini model has no IDE-confirmed adjustable thinkingLevel/thinkingBudget; IDE will not send fake parameters.",
  "model.thinking.reason.nativeReasoning": "This is a native reasoning/thinking-output model, but it has no unified public adjustable-depth parameter; it runs with the model default.",
  "model.thinking.reason.minimax": "MiniMax currently has no reliable public reasoning_effort/thinking budget tiers; IDE will not send fake parameters.",
  "model.thinking.reason.unknown": "Unknown models have no public adjustable reasoning parameter; IDE will not send fake reasoning_effort.",
  "model.account": "Account & credits",
  "model.custom": "Custom models",

  "feature.title": "Advanced Settings",
  "feature.tabsLabel": "Advanced Settings tabs",
  "feature.close": "Close",
  "feature.tab.settings": "Settings",
  "feature.tab.appearance": "Appearance",
  "feature.tab.growth": "Growth",
  "feature.tab.adaptive": "Adaptive",
  "feature.tab.shortcuts": "Shortcuts",
  "feature.tab.tasks": "Task Runner",
  "feature.tab.debugger": "Debugger",
  "feature.tab.conflicts": "Merge Conflicts",
  "feature.tab.lsp": "Language Servers",
  "feature.tab.workspace": "Workspaces",
  "feature.tab.remote": "Remote",
  "feature.settings.title": "Settings",
  "feature.settings.desc": "Editor preferences are saved automatically and persist across sessions.",
  "feature.settings.group.language": "Language",
  "feature.settings.locale.label": "App language",
  "feature.settings.locale.hint": "Default is Simplified Chinese. The selection is used as the global UI, AI response, and data-tool language preference.",
  "feature.settings.country.label": "Country / region",
  "feature.settings.country.hint": "Shown as a flag in your profile and used as the regional preference for AI and data tools.",
  "feature.settings.group.appearance": "Appearance",
  "feature.settings.theme.label": "Color theme",
  "feature.appearance.title": "Appearance",
  "feature.appearance.desc": "Choose the IDE's light or dark look from visual previews. Changes apply to the whole app immediately.",
  "feature.appearance.light.title": "Light",
  "feature.appearance.light.desc": "Google-style clean light UI for daytime work.",
  "feature.appearance.dark.title": "Dark",
  "feature.appearance.dark.desc": "Cursor-style dark UI for focused coding.",
  "feature.appearance.editorVisuals": "Editor visuals",
  "feature.appearance.themeApplied": "Theme switched to {theme}",
  "feature.appearance.font.currentCustom": "Current custom font",
  "feature.appearance.appIcon.section": "App icon",
  "feature.appearance.appIcon.label": "Application icon",
  "feature.appearance.appIcon.hint": "Upload an image to replace the in-app logo, assistant logo, login logo, and browser tab icon. Desktop package icons still require a rebuild.",
  "feature.appearance.appIcon.upload": "Upload icon",
  "feature.appearance.appIcon.processing": "Processing…",
  "feature.appearance.appIcon.reset": "Use default",
  "feature.appearance.appIcon.applied": "Application icon updated",
  "feature.appearance.appIcon.resetDone": "Default icon restored",
  "feature.appearance.appIcon.invalid": "Please choose a valid image file",
  "feature.appearance.appIcon.tooLarge": "Image is too large. Please choose an image under 8 MB.",
  "feature.appearance.appIcon.readFailed": "Failed to read image",
  "feature.settings.fontSize.label": "Font size",
  "feature.settings.fontSize.hint": "px",
  "feature.settings.fontFamily.label": "Font family",
  "feature.settings.lineHeight.label": "Line height",
  "feature.settings.lineHeight.hint": "0 = automatic",
  "feature.settings.group.editor": "Editor",
  "feature.settings.wordWrap.label": "Word wrap",
  "feature.settings.tabSize.label": "Tab size",
  "feature.settings.renderWhitespace.label": "Render whitespace",
  "feature.settings.cursorBlinking.label": "Cursor animation",
  "feature.settings.minimap.label": "Minimap",
  "feature.settings.stickyScroll.label": "Sticky scroll",
  "feature.settings.bracketColorization.label": "Bracket pair colorization",
  "feature.settings.autoFixTypos.label": "Auto-correct identifier typos",
  "feature.settings.autoFixTypos.hint": "Rewrites a word that is one edit away from a keyword while you type. Off by default: it cannot tell a misspelled keyword from a short name you meant (a variable named elf becomes elif).",
  "feature.settings.group.file": "File",
  "feature.settings.autoSave.label": "Auto save",
  "feature.settings.option.off": "Off",
  "feature.settings.option.on": "On",
  "feature.settings.option.wordWrapColumn": "At column",
  "feature.settings.option.bounded": "Bounded",
  "feature.settings.option.none": "None",
  "feature.settings.option.boundary": "Boundary only",
  "feature.settings.option.selection": "Selection only",
  "feature.settings.option.trailing": "Trailing only",
  "feature.settings.option.all": "All",
  "feature.settings.option.blink": "Blink",
  "feature.settings.option.smooth": "Smooth",
  "feature.settings.option.phase": "Fade",
  "feature.settings.option.expand": "Expand",
  "feature.settings.option.solid": "Solid",
  "feature.settings.ai.title": "AI execution",
  "feature.settings.approval.label": "Approve before changes",
  "feature.settings.approval.hint": "When enabled, the agent asks before side-effect actions like writing files, deleting files, running commands, or controlling the computer.",
  "feature.settings.liveFollow.label": "Live follow",
  "feature.settings.liveFollow.hint": "When enabled, the agent automatically opens relevant files, terminals, or panels so you can see each step.",
  "feature.settings.reset": "Restore defaults",
  "feature.settings.localeSwitched": "App language switched to {language}",
  "feature.settings.localeEditorRestart": "The editor's own menus follow after a restart",
  "feature.settings.countrySwitched": "Country set to {country}",
  "feature.settings.approvalOn": "Enabled: approve before changes",
  "feature.settings.approvalOff": "Approval off — nothing will be asked, destructive actions included",
  "feature.settings.liveFollowOn": "Enabled: live-follow agent work panels",
  "feature.settings.liveFollowOff": "Live follow disabled; you control the view manually",
  "account.notSignedIn": "Not signed in",
  "account.signInHint": "Click to sign in",
  "account.signedIn": "Signed in",
  "account.signedInNoPlan": "Signed in · no active plan",
  "account.memberSuffix": "member",
  "account.profile": "Profile",
  "account.billing": "Billing",
  "account.generalSettings": "General settings",
  "account.shortcuts": "Shortcuts",
  "account.logout": "Log out",
  "account.logoutConfirmTitle": "Log out",
  "account.logoutConfirmBody": "You will need to sign in again to use AI. The current account session will be cleared from this device.",
  "account.logoutSuccess": "Logged out",
  "billing.loading": "Loading...",

  "login.title": "Welcome to Mr. Day One",
  "login.subtitle": "Enter your email to sign in. New users are created automatically.",
  "login.emailPlaceholder": "Email",
  "login.passwordPlaceholder": "Password",
  "login.next": "Continue",
  "login.agreePrefix": "I have read and agree to the",
  "login.terms": "Terms of Service",
  "login.and": "and",
  "login.privacy": "Privacy Policy",
  "login.codeHint": "Enter the 6-digit code sent to your email",
  "login.resend": "Resend code",
  "login.submit": "Sign in",
  "login.useCode": "Use verification code",
  "login.back": "Back",
  "login.sending": "Sending…",
  "login.resendSuccess": "Code resent",
  "login.sendFailed": "Send failed: {message}",
  "login.failed": "Operation failed",
  "login.invalidEmail": "Enter a valid email address",
  "login.checking": "Checking…",
  "login.checkEmailFailed": "Email check failed: {message}",
  "login.signupPasswordPlaceholder": "Set password (at least 6 characters)",
  "login.welcomeBack": "{email} · Welcome back. Enter your password to sign in.",
  "login.newAccountHint": "{email} · New account. Set a password, then verify your email.",
  "login.signupNext": "Next",
  "login.loggingIn": "Signing in…",
  "login.verifying": "Verifying…",
  "login.passwordMin": "Password must be at least 6 characters",
  "login.sendingCode": "Sending code…",
  "login.completeSignup": "Complete sign-up",
  "login.signingUp": "Signing up…",
  "login.verify": "Verify",

  "statusbar.commands": "Commands",

  "settings.title": "AI Models",
  "settings.sub": "Model requests go through the Michael gateway for unified credits, billing, model catalog, and route failover. Users do not need to configure third-party providers.",
  "settings.gatewayTitle": "Michael Gateway",
  "settings.gatewayEnabled": "Enabled: all AI model requests are routed through your gateway.",
  "settings.baseUrl": "Gateway URL",
  "settings.apiKey": "Account credential",
  "settings.model": "Model",
  "settings.cancel": "Cancel",
  "settings.gotIt": "Got it",
  "settings.save": "Save",
  "settings.saved": "AI settings saved",
  "settings.configure": "Michael 网关…",
  "devin.title": "Connect Devin",
  "devin.subPrefix": "Enter your Devin API Key (starts with",
  "devin.subSuffix": "). The assistant will connect directly to real Devin sessions. The key is stored locally only.",

  "dialog.cancel": "Cancel",
  "dialog.ok": "OK",
  "dialog.create": "Create",
  "dialog.rename": "Rename",

  "ctx.newFile": "New File…",
  "ctx.newFolder": "New Folder…",
  "ctx.rename": "Rename…",
  "ctx.delete": "Delete",
  "ctx.openProjectPath": "打开项目路径",
  "ctx.copyPath": "Copy Path",
  "ctx.removeWorkspaceFolder": "从工作区移除",
  "ctx.collapseFolder": "折叠文件夹",
  "ctx.expandFolder": "展开文件夹",
  "workspace.remove.title": "从工作区移除文件夹",
  "workspace.remove.confirm": "要把「{name}」从工作区移除吗？\n\n磁盘上的项目不会被删除。完整路径：\n{path}",
  "workspace.remove.ok": "移除",
  "workspace.removed": "已从工作区移除 {name}",

  "tabctx.close": "Close",
  "tabctx.closeOthers": "Close Others",
  "tabctx.closeRight": "Close to the Right",
  "tabctx.closeAll": "Close All",
  "tabctx.pin": "Pin Tab",
  "tabctx.unpin": "Unpin Tab",
  "tabctx.reveal": "Reveal in Explorer",
  "tabctx.copyPath": "Copy Path",
  "tabctx.copyRelPath": "Copy Relative Path",

  "file.saved": "Saved {name}",
  "file.copiedPath": "Copied path",

  "delete.title": "Delete {type}",
  "delete.file": "File",
  "delete.folder": "Folder",
  "delete.confirm": "Are you sure you want to delete \u201C{name}\u201D? This cannot be undone.",
  "delete.confirmPath": "Are you sure you want to delete “{name}”? This cannot be undone.\n\nFull path:\n{path}",

  "menu.file": "File",
  "menu.edit": "Edit",
  "menu.view": "View",
  "menu.tools": "Tools",
  "premiumDb.title": "Michael Premium — Database Tool",
  "feature.tab.mcp": "MCP",
  "feature.tab.skills": "Skills",
  "premiumDb.menu": "Michael Premium",
  "menu.help": "Help",
  "menu.openFolder": "Open Folder…",
  "menu.addWorkspaceFolder": "Add Folder to Workspace…",
  "menu.newProject": "New Project…",
  "menu.newWindow": "New Window",
  "menu.connectRemote": "Connect Remote Machine…",
  "menu.save": "Save",
  "menu.closeFile": "Close File",
  "menu.autoSave": "Auto Save",
  "menu.undo": "Undo",
  "menu.redo": "Redo",
  "menu.find": "Find…",
  "menu.replace": "Replace…",
  "menu.explorer": "Explorer",
  "menu.search": "Search",
  "menu.sourceControl": "Source Control",
  "menu.output": "Output",
  "menu.toggleExplorer": "Toggle Explorer",
  "menu.toggleAssistant": "Toggle Assistant",
  "menu.toggleTerminal": "Toggle Terminal",
  "menu.openExplorer": "Open Explorer",
  "menu.closeExplorer": "Close Explorer",
  "menu.openAssistant": "Open AI Assistant",
  "menu.closeAssistant": "Close AI Assistant",
  "menu.openTerminal": "Open Terminal",
  "menu.closeTerminal": "Close Terminal",
  "menu.problems": "Problems",
  "menu.commandPalette": "Command Palette…",
  "menu.uiGallery": "UI Components…",
  "menu.runCurrentFile": "Run Current File",
  "menu.remoteDesktop": "Remote Computer",
  "menu.featureSettings": "Advanced Settings",
  "menu.documentation": "Documentation",
  "menu.aiSettings": "AI Settings…",
  "menu.about": "About",
  "menu.aboutMsg": "Mr. Day One — a macOS-style editor with a built-in AI assistant",
  "about.subtitle": "AI-native code editor and local development workspace",
  "about.version": "Version v{version}",
  "about.developer": "Developer",
  "about.account": "Account",
  "about.membership": "Membership",
  "about.region": "Country / region",
  "about.notSignedIn": "Not signed in",
  "about.memberNone": "No active membership",
  "about.gateway": "Model requests go through the Michael gateway for unified accounts, billing, model catalog, and route failover.",
  "about.copyright": "© {year} Michael. All rights reserved.",
  "about.close": "Close About dialog",

  "ext.title": "Extensions",
  "ext.sub": "Extensions run in a sandbox and only get the capabilities they declare.",
  "ext.installFile": "Install from file…",
  "ext.done": "Done",
  "ext.installed": "Installed",
  "ext.available": "Available",
  "ext.noInstalled": "No extensions installed yet.",
  "ext.allInstalled": "All bundled extensions are installed.",
  "ext.disable": "Disable",
  "ext.enable": "Enable",
  "ext.uninstall": "Uninstall",
  "ext.install": "Install",
  "ext.installedMsg": "Installed {name}",

  "palette.placeholder": "Type a command…",
  "palette.noResults": "No commands match your query",

  "quickOpen.placeholder": "Type a file name to open…",
  "quickOpen.noResults": "No matching files",

  "search.replace": "Replace",
  "search.replaceAll": "Replace All",
  "search.replacePlaceholder": "Replace with…",
  "search.replaced": "Replaced {count} occurrence{s} in {files} file{s2}",
  "search.replacedInFile": "Replaced {count} occurrence{s}",

  "terminal.new": "New Terminal",
  "terminal.closeTab": "Close",

  "autosave.enabled": "Auto-save enabled",
  "autosave.disabled": "Auto-save disabled",

  "theme.title": "Theme",
  "theme.light": "Light",
  "theme.dark": "Dark",

  "openai": "OpenAI",
  "anthropic": "Anthropic",
  "local": "Local",
};

const ZH_CN = {
  "titlebar.open": "打开",
  "titlebar.save": "保存",
  "titlebar.title": "Mr. Day One",
  "sidebar.explorer": "文件",
  "sidebar.source": "Git",
  "explorer.noFolder": "未打开文件夹",
  "explorer.openHint": "打开一个文件夹以开始。",
  "explorer.openBtn": "打开文件夹…",
  "explorer.newFile": "新建文件",
  "explorer.newFolder": "新建文件夹",
  "explorer.folderCount": "{count} 个文件夹 · {name}",
  "explorer.refresh": "刷新",
  "search.placeholder": "在文件夹中搜索…",
  "search.matchCase": "区分大小写",
  "search.searching": "搜索中…",
  "search.noResults": "无结果",
  "search.openFolder": "打开文件夹以搜索。",
  "search.resultsMeta": "{files} 个文件中 {total} 个结果",
  "git.commit": "提交",
  "git.commitPlaceholder": "提交信息（提交已暂存的更改）",
  "git.pull": "拉取",
  "git.push": "推送",
  "git.branchHint": "当前分支 — 点击切换",
  "git.stagedChanges": "已暂存的更改",
  "git.changes": "更改",
  "git.unstageAll": "全部取消暂存",
  "git.stageAll": "全部暂存",
  "git.unstage": "取消暂存",
  "git.stage": "暂存",
  "git.noChanges": "无更改 — 工作区干净。",
  "git.notRepo": "此文件夹不是 Git 仓库。",
  "git.openFolder": "打开文件夹以查看源代码管理。",
  "git.pushing": "推送中…",
  "git.pulling": "拉取中…",
  "git.pushed": "已推送。",
  "git.pulled": "已拉取。",
  "git.switchingTo": "正在切换到 {name}…",
  "git.switchedTo": "已切换到分支 '{name}'",
  "git.createdBranch": "已创建并切换到 '{name}'",
  "git.committed": "已提交 {hash}",
  "git.emptyMsg": "请先输入提交信息。",
  "git.onBranch": "当前分支 {name}",
  "git.newBranch": "创建新分支…",
  "git.newBranchPrompt": "新分支名称：",
  "git.staged": "已暂存 {name}",
  "git.unstaged": "已取消暂存 {name}",
  "git.stagedAll": "已暂存全部更改",
  "git.unstagedAll": "已取消暂存全部更改",
  "git.history": "历史",
  "git.timeline": "时间线",
  "git.toggleTimeline": "折叠时间线",
  "sidebar.debug": "调试",
  "git.toggleHistory": "切换历史",
  "git.stash": "储藏",
  "git.stashes": "储藏列表",
  "git.toggleStashes": "切换储藏",
  "git.stashed": "已储藏更改。",
  "git.stashApply": "应用",
  "git.stashPop": "弹出",
  "git.stashDrop": "删除",
  "git.stashApplied": "储藏已应用。",
  "git.stashPopped": "储藏已弹出。",
  "git.stashDropped": "储藏已删除。",
  "git.stashPopLatest": "弹出最新储藏",
  "git.blameToggle": "切换 Git Blame",
  "git.blameLabel": "Blame: 开启",
  "git.blameOn": "Git Blame 已启用。",
  "git.blameOff": "Git Blame 已禁用。",
  "git.blameToday": "今天",
  "git.blameYesterday": "昨天",
  "git.blameDaysAgo": "{n} 天前",
  "git.blameMonthsAgo": "{n} 月前",
  "diff.title": "差异对比",
  "diff.sub": "HEAD ↔ 工作区",
  "diff.close": "关闭差异视图",
  "welcome.title": "Mr. Day One",
  "welcome.desc": "一款 macOS 风格编辑器，内置 AI 助手。打开文件夹、选择文件，在右侧向 AI 助手提问。",
  "welcome.tipSave": "保存",
  "welcome.tipAsk": "询问助手",
  "welcome.recent": "最近项目",
  "outline.filter": "筛选符号…",
  "outline.empty": "打开文件后显示大纲。",
  "outline.timeline": "时间线",
  "debug.runGroup": "运行与调试",
  "debug.title": "调试 / Debugger（断点、单步、变量）",
  "debug.aria": "调试",
  "debug.variables": "变量",
  "debug.callStack": "调用栈",
  "debug.breakpoints": "断点",
  "notifications.title": "通知",
  "updates.check": "检查更新…",
  "updates.title": "Mr. Day One 更新",
  "updates.available": "v{version} 新版本已准备好",
  "updates.currentVersion": "当前版本",
  "updates.newVersion": "新版本",
  "updates.releaseNotes": "更新内容",
  "updates.noNotes": "此版本包含体验改进和错误修复。",
  "updates.downloadRestart": "下载并重启",
  "updates.downloading": "正在下载更新…",
  "updates.installing": "正在安装更新…",
  "updates.saving": "正在保存你的工作…",
  "updates.upToDate": "Mr. Day One 已是最新版本",
  "updates.failed": "检查更新失败：{error}",
  "updates.installFailed": "安装更新失败：{error}",
  "updates.saveFailed": "部分编辑文件无法保存，已取消更新。",
  "updates.close": "关闭更新窗口",
  "updates.restartNotice": "签名更新包安装完成后，Mr. Day One 会自动重启。",
  "updates.desktopOnly": "更新检查仅适用于 Mr. Day One 桌面版。",
  "voice.input": "语音输入",
  "problems.title": "问题",
  "problems.empty": "未检测到任何问题。",
  "problems.close": "关闭面板",
  "problems.errors": "错误",
  "problems.warnings": "警告",
  "problems.none": "无问题",
  "terminal.title": "终端",
  "terminal.close": "关闭面板",
  "terminal.toggle": "切换终端",
  "terminal.split": "拆分终端",
  "output.title": "输出",
  "output.channel.lsp": "语言服务",
  "output.channel.tasks": "任务",
  "output.channel.extensions": "扩展",
  "test.empty": "未检测到测试。打开包含测试文件的项目。",
  "test.runAll": "运行全部测试",
  "assistant.name": "启明",
  "assistant.placeholder": "询问关于当前文件的问题…",
  "assistant.selectModel": "选择模型",
  "assistant.switchModel": "切换模型",
  "assistant.send": "发送",
  "assistant.thinking": "思考中",
  "assistant.you": "你",
  "assistant.chatHintTitle": "询问关于你的代码",
  "assistant.chatHintDesc": "打开的文件和你选择的文本会作为上下文自动发送。",
  "assistant.currentFile": "当前文件",
  "assistant.chip.explain": "解释这个文件",
  "assistant.chip.bugs": "查找潜在 Bug",
  "assistant.chip.comments": "添加文档注释",
  "assistant.chip.test": "编写单元测试",
  "assistant.chip.fixErrors": "🔧 修复报错 ({count})",
  "assistant.chip.explainSelection": "解释选中的代码",
  "assistant.chip.reviewChange": "审查我的改动",
  "assistant.chip.commitMessage": "✍️ 写提交信息",
  "assistant.chip.reviewAllChanges": "审查全部改动 ({count})",
  "assistant.chip.explainFile": "解释「{name}」",
  "assistant.chip.howToRun": "怎么跑起来",
  "assistant.chip.polishDoc": "润色这篇文档",
  "assistant.chip.addTestCases": "补充测试用例",
  "assistant.chip.refactor": "优化重构",
  "assistant.chip.errorHandling": "加错误处理",
  "assistant.chip.callGraph": "梳理调用关系",
  "tool.action.skill": "读取技能",
  "assistant.chip.startProject": "在这里开始做点什么",
  "assistant.prompt.startProject": "这个文件夹是空的。先问我想做什么，给两三个具体方向、每个一句话说清取舍；我选定之后直接搭起来并跑通。",
  "assistant.chip.scaffoldHere": "搭一个项目骨架",
  "assistant.prompt.scaffoldHere": "在这个空文件夹里搭一个能跑的起步项目：选一套合适的技术栈、把文件建好、装上依赖、然后运行给我看。",
  "assistant.chip.projectResearch": "🔎 深挖这个项目",
  "assistant.chip.whatIsProject": "它是做什么的",
  "assistant.chip.addFeature": "帮我加个功能",
  "assistant.chip.findIssues": "找找有什么问题",
  "assistant.chip.addTests": "补点测试",
  "assistant.chip.openFolder": "打开一个文件夹",
  "assistant.chip.whatCanIdeDo": "这个 IDE 能做什么",
  "assistant.chip.writeCode": "写段代码",
  "assistant.chip.explainSnippet": "解释一段代码",
  "assistant.chip.writeRegex": "写个正则",
  "assistant.chip.writeScript": "写个小脚本",
  "assistant.onboardHeader": "📁 已打开 {name} · 上手引导：",
  "tool.action.write": "写入",
  "tool.action.edit": "编辑",
  "tool.action.multiedit": "批量编辑",
  "tool.action.read": "读取",
  "tool.action.list": "列目录",
  "tool.action.cmd": "运行",
  "tool.action.search": "搜索",
  "tool.action.find": "查找",
  "tool.action.web": "抓取",
  "tool.action.websearch": "联网搜索",
  "tool.action.search_tools": "查找工具",
  "tool.action.memory": "记忆",
  "tool.action.think": "思考",
  "tool.action.delete": "删除",
  "tool.action.move": "移动",
  "tool.action.diag": "诊断",
  "tool.action.git": "Git",
  "tool.action.gh": "GitHub",
  "tool.action.lsp": "LSP",
  "tool.action.findsymbol": "查找符号",
  "tool.action.semsearch": "语义搜索",
  "tool.action.knowledge": "知识检索",
  "tool.action.mkdir": "建目录",
  "tool.action.copy": "复制",
  "tool.action.format": "格式化",
  "tool.action.termtask": "终端任务",
  "tool.action.termread": "读终端",
  "tool.action.termlist": "终端列表",
  "tool.action.termstop": "停止终端",
  "tool.action.http": "HTTP",
  "tool.action.tor": "Tor",
  "tool.action.download": "下载",
  "tool.action.mcp": "MCP",
  "tool.action.demostart": "录制中",
  "tool.action.demostop": "录制完成",
  "tool.action.screenshot": "截图",
  "tool.action.browser": "浏览器",
  "tool.action.computer": "电脑",
  "tool.action.system": "系统",
  "tool.action.automation": "自动化",
  "tool.action.readscreen": "读取屏幕",
  "tool.action.uiclick": "操作元素",
  "tool.action.remote": "远程",
  "tool.action.askuser": "需要你确认",
  "tool.action.current_time": "当前时间",
  "tool.action.localdiscovery": "附近发现",
  "tool.action.liveenvironment": "环境数据",
  "tool.action.livemarkets": "市场数据",
  "tool.action.liveflights": "飞机状态",
  "tool.action.roadenvironment": "道路环境",
  "tool.action.trackshipment": "快递核验",
  "tool.action.shopcatalog": "商品价格",
  "tool.action.db": "数据库",
  "tool.action.qr": "识别二维码",
  "tool.action.genimage": "生成图片",
  "tool.action.vizcompare": "视觉对比",
  "tool.action.designboard": "设计看板",
  "tool.action.preview": "方案预览",
  "tool.action.explain": "视觉解释",
  "tool.action.capture_start": "开始抓包",
  "tool.action.capture_flows": "读取抓包",
  "tool.action.capture_stop": "停止抓包",
  "tool.action.capture_replay": "重放请求",
  "tool.action.background_monitor": "后台监控",
  "tool.action.worktree": "工作树",
  "tool.action.awaitsubagent": "等待子智能体",
  "tool.action.game_scaffold": "游戏脚手架",
  "tool.action.web_scaffold": "网站脚手架",
  "tool.action.learn_design": "学习设计体系",
  "tool.action.generate_3d": "3D 模型",
  "tool.action.generate_sound": "音效",
  "tool.action.generate_music": "音乐",
  "tool.action.generate_voice": "语音",
  "tool.action.auto_rig": "骨骼绑定",
  "tool.action.generate_motion": "动画",
  "tool.action.generate_texture": "纹理",
  "tool.action.search_game_assets": "资源搜索",
  "tool.action.download_asset": "下载资源",
  "tool.action.unknown": "未知工具",
  "subagent.label": "子智能体",
  "subagent.researchProject": "深挖代码库",
  "subagent.researchFocus": "深挖·{focus}",
  "tool.readLines": "{count} 行",
  "tool.undo": "撤销",
  "subagent.researchSteps": "{count} 步调研",
  "subagent.researchStepsOne": "{count} 步调研",
  "subagent.workerStepsOne": "{count} 步（worker）",
  "subagent.workerStepsNoWriteOne": "{count} 步（worker·未写盘）",
  "subagent.workerSteps": "{count} 步（worker）",
  "subagent.workerStepsNoWrite": "{count} 步（worker·未写盘）",
  "subagent.jobsSettled": "{count} 个作业落定",
  "chat.nextSteps": "接下来 \u203a",
  "subagent.worker": "worker",
  "subagent.noSteps": "0 步 · 未执行",
  "subagent.queued": "排队中",
  "subagent.concurrent": "并发×{count}",
  "tool.stopped": "已停止",
  "tool.failed": "失败",
  "plan.title": "任务计划",
  "plan.badgeDone": "{done}/{total} 完成",
  "plan.badgeCancelled": " · {count} 已取消",
  "plan.cancelHint": "点击取消 \u2715",
  "plan.restoreHint": "点击恢复 \u21a9",
  "assistant.prompt.warningSuffix": "、{count} 个警告",
  "assistant.prompt.fixErrors": "当前文件 {path} 有 {errors} 个错误{warnings}。请逐个定位根因并修复，改完用 get_diagnostics 确认全部消除、且没有引入新问题。",
  "assistant.prompt.explainSelection": "解释我在 {path} 里选中的这段代码：它做什么、怎么工作、有没有边界问题或更清晰的写法。",
  "assistant.prompt.reviewChange": "审查我对 {path} 未提交的改动（git diff），逐处指出潜在 bug、遗漏的错误处理、风格不一致和可改进点。",
  "assistant.prompt.commitMessage": "看我未提交的改动（先 git diff --staged，没有暂存就 git diff），帮我写一条规范的中文提交信息：一句话主题 + 必要的正文。",
  "assistant.prompt.reviewAllChanges": "审查我当前所有未提交的改动（git diff），按文件逐处指出潜在 bug、错误处理缺失、风格问题和可改进点。",
  "assistant.prompt.explainFile": "解释 {path}：整体职责、关键函数/类型、数据流，以及它在项目里扮演的角色。",
  "assistant.prompt.howToRunFile": "看 {path} 和相关配置，告诉我这个项目怎么装依赖、怎么启动/构建，给我可直接复制执行的命令。",
  "assistant.prompt.polishDoc": "通读并润色 {path}：结构是否清晰、有无错别字或表述问题，在保持原意的前提下改得更专业易读。",
  "assistant.prompt.addTestCases": "看 {path}，找出还没覆盖到的分支和边界情况，补充测试用例（沿用本文件的测试框架与风格）。",
  "assistant.prompt.findBugs": "仔细审查 {path}，找出潜在的 bug、竞态、边界情况和缺失的错误处理，按严重程度列出并给修复建议。",
  "assistant.prompt.refactor": "审视 {path} 有没有能简化、提炼、去重或提升可读性/性能的地方，给出重构建议（保持行为不变、小步安全）。",
  "assistant.prompt.writeTests": "为 {path} 编写单元测试：覆盖主要函数、关键分支和边界情况，沿用项目已有的测试框架和风格。",
  "assistant.prompt.docComments": "给 {path} 里的公共函数/类型补充清晰的文档注释（用途、参数、返回值、副作用），沿用本语言的惯例。",
  "assistant.prompt.errorHandling": "检查 {path} 的错误处理：哪些调用可能抛异常/返回错误却没被处理，补上健壮、清晰的处理。",
  "assistant.prompt.callGraph": "梳理 {path} 与项目其他部分的关系：谁调用它、它依赖了什么、改动它的影响面有多大。",
  "assistant.prompt.projectResearch": "用 research_project 深挖整个项目，给我一份上手地图：技术栈、目录结构、核心模块职责、数据/控制流、代码约定、常见改动入口。",
  "assistant.prompt.whatIsProject": "这个项目是做什么的？核心功能、目标用户、整体架构，简明讲一下。",
  "assistant.prompt.howToRunProject": "这个项目怎么安装依赖、怎么启动？看 README/package.json 等，给我可直接执行的步骤。",
  "assistant.prompt.addFeature": "我想给这个项目加个新功能。先帮我研究相关代码、找到合适的改动入口，再给方案。",
  "assistant.prompt.findProjectIssues": "通览这个项目，找出明显的 bug、隐患、坏味道或过时依赖，按优先级列给我。",
  "assistant.prompt.addProjectTests": "看项目现有测试情况，指出覆盖薄弱的关键模块，帮我补一批有价值的测试。",
  "assistant.prompt.openFolder": "怎么在这个 IDE 里打开一个项目文件夹开始工作？",
  "assistant.prompt.whatCanIdeDo": "简单介绍下这个 IDE 的核心能力：AI 智能体、运行命令、Git、调试等，我该怎么上手。",
  "assistant.prompt.writeCode": "帮我写一段代码：",
  "assistant.prompt.explainSnippet": "我贴一段代码，你帮我解释它做什么、怎么工作：",
  "assistant.prompt.writeRegex": "帮我写一个正则表达式，匹配：",
  "assistant.prompt.writeScript": "帮我写一个小脚本（说明用途和语言）：",
  "assistant.configFirst": "请先登录 Michael 账号",
  "assistant.capabilities": "能力菜单",
  "assistant.capabilities.open": "打开用户习惯和用户规则菜单",
  "assistant.capability.habits": "用户习惯",
  "assistant.capability.rules": "用户规则",
  "assistant.capability.browser": "浏览器",
  "assistant.capability.caps": "我的能力",
  "assistant.mode.agent": "Agent",
  "assistant.mode.plan": "Plan",
  "assistant.mode.chat": "Chat",
  "assistant.mode.auto": "Auto",
  "assistant.mode.switch": "切换 AI 模式",
  "assistant.jumpToLatest": "回到最新",
  "assistant.tokenMeter": "上下文缓存：{percent}%",
  "model.desc.opus": "Anthropic Claude Opus —— 旗舰级，适合复杂推理、编程与长任务。",
  "model.desc.sonnet": "Anthropic Claude Sonnet —— 能力与速度均衡的主力款，适合日常编码。",
  "model.desc.haiku": "Anthropic Claude Haiku —— 轻量极速，适合高频、低成本任务。",
  "model.desc.deepseek": "DeepSeek —— 强编程与推理，长上下文，高性价比。",
  "model.desc.minimax": "MiniMax —— 超长上下文与优秀中文能力。",
  "model.desc.gemini": "Google Gemini —— 原生多模态、超长上下文。",
  "model.desc.qwen": "阿里通义千问 Qwen —— 多语言、强中文与代码能力。",
  "model.desc.glm": "智谱 GLM —— 中文友好的通用大模型。",
  "model.desc.grok": "xAI Grok —— 实时知识与强推理。",
  "model.desc.kimi": "月之暗面 Kimi —— 超长上下文，强中文长文处理。",
  "model.desc.openai": "OpenAI GPT —— 通用旗舰多模态模型，综合能力强。",
  "model.price.title": "模型价格",
  "model.price.input": "输入",
  "model.price.output": "输出",
  "model.price.flat": "单次",
  "model.price.perMillionTokens": "/ 100万 tokens",
  "model.price.perCallUnsplit": "/ 次（后台未拆输入/输出）",
  "model.price.source": "来源：{source}",
  "model.price.rate": "倍率 / rate：{rate}",
  "model.price.source.modelOverride": "后台单模型设置",
  "model.price.source.backend": "后台连接设置",
  "model.price.source.catalog": "内置模型价格目录",
  "model.price.source.unset": "未配置",
  "model.price.imageBilling": "图像模型 · 按图计费",
  "model.price.missing": "后台未返回输入/输出价",
  "model.thinkingDepth": "思考深度",
  "model.thinkingToggle": "思考（仅开/关）",
  "model.thinking.on": "思考开启 · {level}",
  "model.thinking.off": "思考已关闭",
  "model.thinking.defaultHint": "按该模型真实公开能力发送思考参数。",
  "model.thinking.unsupported": "该模型不支持可调思考参数",
  "model.thinking.level.off": "关闭",
  "model.thinking.level.minimal": "极轻",
  "model.thinking.level.low": "低",
  "model.thinking.level.medium": "中",
  "model.thinking.level.high": "高",
  "model.thinking.level.xhigh": "超高",
  "model.thinking.level.max": "极限",
  "model.thinking.level.alwaysOn": "常开",
  "model.thinking.level.enabled": "开启",
  "model.thinking.tip.off": "关闭/不发送可调思考参数；若模型本身强制内置推理，则仍按模型默认策略运行。",
  "model.thinking.tip.minimal": "Minimal：极轻推理，只适合非常简单的问题（仅支持部分模型）。",
  "model.thinking.tip.low": "Low：浅思考，权衡速度和质量。",
  "model.thinking.tip.medium": "Medium（推荐默认）：中等深度推理。",
  "model.thinking.tip.high": "High：深度推理，多数难题解得开。",
  "model.thinking.tip.xhigh": "XHigh：超高推理（仅支持明确有该档位的模型）。",
  "model.thinking.tip.max": "Max（极限）：最大预算档（仅支持明确接受 thinking budget 的模型）。慢且贵。",
  "model.thinking.reason.noPublic": "该模型没有公开可调思考参数；IDE 不会乱发假 reasoning_effort。",
  "model.thinking.reason.notSelected": "未选择模型",
  "model.thinking.reason.image": "图像生成模型不支持聊天思考深度。",
  "model.thinking.reason.kimiForced": "Kimi K2.7 Code 官方思考常开，不能关闭或调档。",
  "model.thinking.reason.kimiForcedHint": "Kimi K2.7 Code 官方思考常开，不能关闭或调档；IDE 会按模型默认运行。",
  "model.thinking.reason.kimiToggleHint": "Kimi 这个系列只支持 thinking.type 开/关，不支持低/中/高/极限档。",
  "model.thinking.reason.glmToggleHint": "GLM 4.5+/5.x 只支持 thinking.type 开/关；低/中/高深度档位对它不生效。",
  "model.thinking.reason.kimiNormal": "Kimi 普通模型没有公开可调思考档位；IDE 不发送假参数。",
  "model.thinking.reason.grok45": "Grok 4.5 支持 low / medium / high；官方没有关闭档，默认 high。档位是真生效的，但**不会出思考卡**——xAI 在 Chat Completions 这条接口上不返回思考正文（只有 Responses API 才给）。",
  "model.thinking.reason.grok43": "Grok 4.3 支持 none / low / medium / high。档位是真生效的，但不会出思考卡——xAI 在 Chat Completions 这条接口上不返回思考正文。",
  "model.thinking.reason.grokReasoning": "该 Grok 推理模型按 reasoning_effort 调档；非推理 Grok 不会显示这个控制。档位是真生效的（它决定模型想多久、也决定你付多少钱），但**不会出思考卡**：xAI 官方对 Chat Completions 接口明写「不返回思考内容」，可读的思考摘要只在它的 Responses API 上给。",
  "model.thinking.reason.grokNone": "这个 Grok 模型没有公开可调 reasoning_effort；IDE 不发送假参数。",
  "model.thinking.reason.gpt56": "GPT-5.6 系列按 none/low/medium/high/xhigh/max 调整 reasoning_effort。2026-08-13 实测：档位是真的（low/medium 的输出量约为 high 的一半，乱填的档位会被拒）。但这一族回来的「思考」是**摘要提纲**——几行加粗小标题，约 50~900 字，不是推理过程。想看真实推理请用 Claude 族：同一道题它给约 1200 字的实际分析。",
  "model.thinking.reason.openai": "OpenAI 推理模型使用 reasoning_effort：low / medium / high；关闭时不发送该字段。",
  "model.thinking.reason.claudeHaiku": "Claude Haiku 系列通常不开放手动 extended thinking 预算；IDE 不发送假参数。",
  "model.thinking.reason.claude": "Claude 使用 extended/adaptive thinking 预算；低/中/高/极限会发送不同 budget_tokens。",
  "model.thinking.reason.gemini3": "Gemini 3 使用 thinkingLevel；Flash 支持 minimal/low/medium/high，Pro 用 low/medium/high。",
  "model.thinking.reason.gemini25": "Gemini 2.5 使用 thinkingBudget；Flash 可设 0 关闭，Pro 不显示关闭档。",
  "model.thinking.reason.geminiUnknown": "这个 Gemini 型号没有在 IDE 规则中确认可调 thinkingLevel/thinkingBudget；不发送假参数。",
  "model.thinking.reason.nativeReasoning": "该模型属于原生推理/思考输出模型，但没有统一公开可调深度参数；按模型默认运行。",
  "model.thinking.reason.minimax": "MiniMax 当前没有可靠公开的 reasoning_effort/thinking budget 档位；IDE 不发送假参数。",
  "model.thinking.reason.unknown": "未知模型没有公开可调思考参数；IDE 不发送假 reasoning_effort。",
  "model.account": "账号与额度",
  "model.custom": "自定义模型",
  "feature.title": "高级设置",
  "feature.tabsLabel": "高级设置标签页",
  "feature.close": "关闭",
  "feature.tab.settings": "设置",
  "feature.tab.appearance": "外观",
  "feature.tab.growth": "成长",
  "feature.tab.adaptive": "自适应",
  "feature.tab.shortcuts": "快捷键",
  "feature.tab.tasks": "任务运行器",
  "feature.tab.debugger": "调试器",
  "feature.tab.conflicts": "合并冲突",
  "feature.tab.lsp": "语言服务",
  "feature.tab.workspace": "工作区",
  "feature.tab.remote": "远程开发",
  "feature.settings.title": "设置",
  "feature.settings.desc": "编辑器偏好自动保存，跨会话持久保留。",
  "feature.settings.group.language": "语言",
  "feature.settings.locale.label": "软件语言",
  "feature.settings.locale.hint": "默认简体中文；选择后会作为界面、AI 回复和数据工具的全局语言偏好。",
  "feature.settings.country.label": "国家/地区",
  "feature.settings.country.hint": "会在个人资料里显示国旗，并作为 AI 与数据工具的区域偏好。",
  "feature.settings.group.appearance": "外观",
  "feature.settings.theme.label": "配色主题",
  "feature.appearance.title": "外观",
  "feature.appearance.desc": "用缩略图选择软件的浅色或深色外观，点击后会立即应用到整个 IDE。",
  "feature.appearance.light.title": "浅色",
  "feature.appearance.light.desc": "Google 风格的干净浅色界面，适合白天和长时间阅读。",
  "feature.appearance.dark.title": "深色",
  "feature.appearance.dark.desc": "接近 Cursor 的黑色专注风格，适合写代码和夜间使用。",
  "feature.appearance.editorVisuals": "编辑器视觉",
  "feature.appearance.themeApplied": "已切换到{theme}主题",
  "feature.appearance.font.currentCustom": "当前自定义字体",
  "feature.appearance.appIcon.section": "应用图标",
  "feature.appearance.appIcon.label": "软件图标",
  "feature.appearance.appIcon.hint": "上传图片后会替换 IDE 内部 logo、助手 logo、登录页 logo 和浏览器标签图标；桌面安装包/Dock 图标需要重新打包才会变。",
  "feature.appearance.appIcon.upload": "上传图标",
  "feature.appearance.appIcon.processing": "处理中…",
  "feature.appearance.appIcon.reset": "恢复默认",
  "feature.appearance.appIcon.applied": "应用图标已更新",
  "feature.appearance.appIcon.resetDone": "已恢复默认图标",
  "feature.appearance.appIcon.invalid": "请选择有效的图片文件",
  "feature.appearance.appIcon.tooLarge": "图片太大，请选择 8 MB 以内的图片。",
  "feature.appearance.appIcon.readFailed": "读取图片失败",
  "feature.settings.fontSize.label": "字号",
  "feature.settings.fontSize.hint": "px",
  "feature.settings.fontFamily.label": "字体",
  "feature.settings.lineHeight.label": "行高",
  "feature.settings.lineHeight.hint": "0 = 自动",
  "feature.settings.group.editor": "编辑器",
  "feature.settings.wordWrap.label": "自动换行",
  "feature.settings.tabSize.label": "Tab 宽度",
  "feature.settings.renderWhitespace.label": "显示空白字符",
  "feature.settings.cursorBlinking.label": "光标动画",
  "feature.settings.minimap.label": "代码缩略图",
  "feature.settings.stickyScroll.label": "粘性滚动",
  "feature.settings.bracketColorization.label": "括号配对着色",
  "feature.settings.autoFixTypos.label": "自动改写标识符拼写",
  "feature.settings.autoFixTypos.hint": "打字停顿后，把和关键字只差一个字母的词改掉。默认关闭：它分不出「拼错的关键字」和「我就是要叫这个名字的短变量」——叫 elf 的变量会被改成 elif。",
  "feature.settings.group.file": "文件",
  "feature.settings.autoSave.label": "自动保存",
  "feature.settings.option.off": "关闭",
  "feature.settings.option.on": "开启",
  "feature.settings.option.wordWrapColumn": "按列换行",
  "feature.settings.option.bounded": "有界换行",
  "feature.settings.option.none": "不显示",
  "feature.settings.option.boundary": "仅边界",
  "feature.settings.option.selection": "仅选区",
  "feature.settings.option.trailing": "仅行尾",
  "feature.settings.option.all": "全部",
  "feature.settings.option.blink": "闪烁",
  "feature.settings.option.smooth": "平滑",
  "feature.settings.option.phase": "渐隐",
  "feature.settings.option.expand": "展开",
  "feature.settings.option.solid": "常亮",
  "feature.settings.ai.title": "AI 执行",
  "feature.settings.approval.label": "改动前审批",
  "feature.settings.approval.hint": "开启后，写文件、删除、运行命令、操控电脑等有副作用操作前会先问你。**关闭时一个都不问**，包括高危命令和删除——删目录没有回收站也没有撤销入口。",
  "feature.settings.liveFollow.label": "实时跟随",
  "feature.settings.liveFollow.hint": "开启后，智能体干活时会自动打开相关文件、终端或面板，让你看到每一步。",
  "feature.settings.reset": "恢复默认设置",
  "feature.settings.localeSwitched": "软件语言已切换为 {language}",
  "feature.settings.localeEditorRestart": "编辑器自带的那套菜单重启后跟上",
  "feature.settings.countrySwitched": "国家/地区已切换为 {country}",
  "feature.settings.approvalOn": "已开启：改动前先审批",
  "feature.settings.approvalOff": "已关闭审批——任何操作都不再问你，包括删除和高危命令",
  "feature.settings.liveFollowOn": "已开启：实时跟随智能体的工作面板",
  "feature.settings.liveFollowOff": "已关闭实时跟随，视图由你手动控制",
  "account.notSignedIn": "未登录",
  "account.signInHint": "点击登录",
  "account.signedIn": "已登录",
  "account.signedInNoPlan": "已登录 · 未开通会员",
  "account.memberSuffix": "会员",
  "account.profile": "个人资料",
  "account.billing": "账单",
  "account.generalSettings": "通用设置",
  "account.shortcuts": "快捷键",
  "account.logout": "退出登录",
  "account.logoutConfirmTitle": "退出登录",
  "account.logoutConfirmBody": "退出后需要重新登录才能使用 AI。当前账号会话将从这台设备清除。",
  "account.logoutSuccess": "已退出登录",
  "billing.loading": "加载中...",
  "login.title": "欢迎使用 Mr. Day One",
  "login.subtitle": "输入邮箱即可登录，新用户自动创建账号",
  "login.emailPlaceholder": "邮箱",
  "login.passwordPlaceholder": "输入密码",
  "login.next": "继续",
  "login.agreePrefix": "我已阅读并同意",
  "login.terms": "服务条款",
  "login.and": "和",
  "login.privacy": "隐私政策",
  "login.codeHint": "输入发送到邮箱的 6 位验证码",
  "login.resend": "重新发送验证码",
  "login.submit": "登录",
  "login.useCode": "使用验证码登录",
  "login.back": "返回",
  "login.sending": "发送中…",
  "login.resendSuccess": "验证码已重新发送",
  "login.sendFailed": "发送失败：{message}",
  "login.failed": "操作失败",
  "login.invalidEmail": "请输入有效的邮箱地址",
  "login.checking": "检测中…",
  "login.checkEmailFailed": "检测邮箱失败：{message}",
  "login.signupPasswordPlaceholder": "设置密码（至少 6 位）",
  "login.welcomeBack": "{email} · 欢迎回来，输入密码登录",
  "login.newAccountHint": "{email} · 新账号，设置密码后验证邮箱",
  "login.signupNext": "下一步",
  "login.loggingIn": "登录中…",
  "login.verifying": "验证中…",
  "login.passwordMin": "密码至少 6 位",
  "login.sendingCode": "发送验证码…",
  "login.completeSignup": "完成注册",
  "login.signingUp": "注册中…",
  "login.verify": "验证",
  "statusbar.commands": "命令",
  "settings.title": "AI 模型",
  "settings.sub": "模型请求固定走 Michael 网关，统一账号额度、计费、模型目录和线路容灾；用户无需配置任何第三方供应商。",
  "settings.gatewayTitle": "Michael 网关",
  "settings.gatewayEnabled": "已启用：所有 AI 模型请求都会通过你的网关转发。",
  "settings.baseUrl": "网关地址",
  "settings.apiKey": "账号凭证",
  "settings.model": "模型",
  "settings.cancel": "取消",
  "settings.gotIt": "知道了",
  "settings.save": "保存",
  "settings.saved": "AI 设置已保存",
  "settings.configure": "Michael 网关…",
  "devin.title": "连接 Devin",
  "devin.subPrefix": "输入你的 Devin API Key（以",
  "devin.subSuffix": "开头），助手将直接对接真实的 Devin 会话。密钥只保存在本地。",
  "dialog.cancel": "取消",
  "dialog.ok": "确定",
  "dialog.create": "创建",
  "dialog.rename": "重命名",
  "ctx.newFile": "新建文件…",
  "ctx.newFolder": "新建文件夹…",
  "ctx.rename": "重命名…",
  "ctx.delete": "删除",
  "ctx.openProjectPath": "打开项目路径",
  "ctx.copyPath": "复制路径",
  "ctx.removeWorkspaceFolder": "从工作区移除",
  "ctx.collapseFolder": "折叠文件夹",
  "ctx.expandFolder": "展开文件夹",
  "workspace.remove.title": "从工作区移除文件夹",
  "workspace.remove.confirm": "要把「{name}」从工作区移除吗？\n\n磁盘上的项目不会被删除。完整路径：\n{path}",
  "workspace.remove.ok": "移除",
  "workspace.removed": "已从工作区移除 {name}",
  "tabctx.close": "关闭",
  "tabctx.closeOthers": "关闭其他",
  "tabctx.closeRight": "关闭右侧",
  "tabctx.closeAll": "全部关闭",
  "tabctx.pin": "固定标签",
  "tabctx.unpin": "取消固定",
  "tabctx.reveal": "在文件管理器中显示",
  "tabctx.copyPath": "复制路径",
  "tabctx.copyRelPath": "复制相对路径",
  "file.saved": "已保存 {name}",
  "file.copiedPath": "已复制路径",
  "delete.title": "删除{type}",
  "delete.file": "文件",
  "delete.folder": "文件夹",
  "delete.confirm": "确定要删除「{name}」吗？此操作无法撤销。",
  "delete.confirmPath": "确定要删除「{name}」吗？此操作无法撤销。\n\n完整路径：\n{path}",
  "menu.file": "文件",
  "menu.edit": "编辑",
  "menu.view": "视图",
  "menu.tools": "工具",
  "premiumDb.title": "Michael Premium — 数据库工具",
  "feature.tab.mcp": "MCP",
  "feature.tab.skills": "Skills",
  "premiumDb.menu": "Michael Premium",
  "menu.help": "帮助",
  "menu.openFolder": "打开文件夹…",
  "menu.addWorkspaceFolder": "添加文件夹到工作区…",
  "menu.newProject": "新建项目…",
  "menu.newWindow": "新建窗口",
  "menu.connectRemote": "连接远程机器…",
  "menu.save": "保存",
  "menu.closeFile": "关闭文件",
  "menu.autoSave": "Auto Save",
  "menu.undo": "撤销",
  "menu.redo": "重做",
  "menu.find": "查找…",
  "menu.replace": "替换…",
  "menu.explorer": "文件管理器",
  "menu.search": "搜索",
  "menu.sourceControl": "源代码管理",
  "menu.output": "输出",
  "menu.toggleExplorer": "切换文件管理器",
  "menu.toggleAssistant": "切换 AI 助手",
  "menu.toggleTerminal": "切换终端",
  "menu.openExplorer": "打开文件管理器",
  "menu.closeExplorer": "关闭文件管理器",
  "menu.openAssistant": "打开 AI 助手",
  "menu.closeAssistant": "关闭 AI 助手",
  "menu.openTerminal": "打开终端",
  "menu.closeTerminal": "关闭终端",
  "menu.problems": "问题",
  "menu.commandPalette": "命令面板…",
  "menu.uiGallery": "UI 组件长廊…",
  "menu.runCurrentFile": "运行当前文件",
  "menu.remoteDesktop": "远程电脑",
  "menu.featureSettings": "高级设置",
  "menu.documentation": "文档",
  "menu.aiSettings": "AI 设置…",
  "menu.about": "关于",
  "menu.aboutMsg": "Mr. Day One — 一款内置 AI 助手的 macOS 风格代码编辑器",
  "about.subtitle": "AI 原生代码编辑器与本地开发工作台",
  "about.version": "版本 v{version}",
  "about.developer": "开发者",
  "about.account": "账号",
  "about.membership": "会员",
  "about.region": "国家 / 地区",
  "about.notSignedIn": "未登录",
  "about.memberNone": "未开通会员",
  "about.gateway": "模型请求固定走 Michael 网关，统一账号额度、计费、模型目录和线路容灾。",
  "about.copyright": "© {year} Michael。保留所有权利。",
  "about.close": "关闭关于弹窗",
  "ext.title": "扩展",
  "ext.sub": "扩展在沙箱中运行，只拥有声明的权限。",
  "ext.installFile": "从文件安装…",
  "ext.done": "完成",
  "ext.installed": "已安装",
  "ext.available": "可用",
  "ext.noInstalled": "尚未安装任何扩展。",
  "ext.allInstalled": "所有内置扩展均已安装。",
  "ext.disable": "禁用",
  "ext.enable": "启用",
  "ext.uninstall": "卸载",
  "ext.install": "安装",
  "ext.installedMsg": "已安装 {name}",
  "palette.placeholder": "输入命令…",
  "palette.noResults": "没有匹配的命令",
  "quickOpen.placeholder": "输入文件名以打开…",
  "quickOpen.noResults": "没有匹配的文件",
  "search.replace": "替换",
  "search.replaceAll": "全部替换",
  "search.replacePlaceholder": "替换为…",
  "search.replaced": "在 {files} 个文件中替换了 {count} 处",
  "search.replacedInFile": "替换了 {count} 处",
  "terminal.new": "新建终端",
  "terminal.closeTab": "关闭",
  "autosave.enabled": "自动保存已启用",
  "autosave.disabled": "自动保存已禁用",
  "theme.title": "主题",
  "theme.light": "浅色",
  "theme.dark": "深色",
  "openai": "OpenAI",
  "anthropic": "Anthropic",
  "local": "本地",
};

const JA = {
  "titlebar.open": "開く",
  "titlebar.save": "保存",
  "titlebar.title": "Mr. Day One",
  "sidebar.explorer": "エクスプローラー",
  "sidebar.source": "Git",
  "explorer.noFolder": "フォルダーなし",
  "explorer.openHint": "フォルダーを開いて開始します。",
  "explorer.openBtn": "フォルダーを開く…",
  "explorer.newFile": "新規ファイル",
  "explorer.newFolder": "新規フォルダー",
  "explorer.folderCount": "{count} 個のフォルダー · {name}",
  "explorer.refresh": "更新",
  "search.placeholder": "フォルダー内を検索…",
  "search.matchCase": "大文字と小文字を区別",
  "search.searching": "検索中…",
  "search.noResults": "結果なし",
  "search.openFolder": "検索するにはフォルダーを開いてください。",
  "search.resultsMeta": "{files} 個のファイルで {total} 件",
  "git.commit": "コミット",
  "git.commitPlaceholder": "メッセージ（ステージ済み変更をコミット）",
  "git.pull": "プル",
  "git.push": "プッシュ",
  "git.branchHint": "現在のブランチ — クリックして切り替え",
  "git.stagedChanges": "ステージ済みの変更",
  "git.changes": "変更",
  "git.unstageAll": "すべてステージ解除",
  "git.stageAll": "すべてステージ",
  "git.unstage": "ステージ解除",
  "git.stage": "ステージ",
  "git.noChanges": "変更なし — 作業ツリーはクリーンです。",
  "git.notRepo": "このフォルダーは Git リポジトリではありません。",
  "git.openFolder": "ソース管理を表示するにはフォルダーを開いてください。",
  "git.pushing": "プッシュ中…",
  "git.pulling": "プル中…",
  "git.pushed": "プッシュしました。",
  "git.pulled": "プルしました。",
  "git.history": "履歴",
  "git.timeline": "タイムライン",
  "git.toggleTimeline": "タイムラインを切替",
  "sidebar.debug": "デバッグ",
  "git.stash": "スタッシュ",
  "diff.title": "差分",
  "diff.sub": "HEAD ↔ 作業ツリー",
  "diff.close": "差分を閉じる",
  "welcome.title": "Mr. Day One",
  "welcome.desc": "AI アシスタントを内蔵した macOS 風エディターです。フォルダーを開き、ファイルを選んで、右側のアシスタントに質問できます。",
  "welcome.tipSave": "保存",
  "welcome.tipAsk": "アシスタントに質問",
  "welcome.recent": "最近のプロジェクト",
  "outline.filter": "シンボルを絞り込み…",
  "outline.empty": "ファイルを開くとアウトラインが表示されます。",
  "outline.timeline": "タイムライン",
  "problems.title": "問題",
  "problems.empty": "検出された問題はありません。",
  "problems.close": "パネルを閉じる",
  "problems.errors": "エラー",
  "problems.warnings": "警告",
  "problems.none": "問題なし",
  "terminal.title": "ターミナル",
  "terminal.close": "パネルを閉じる",
  "terminal.toggle": "ターミナルを切り替え",
  "terminal.split": "ターミナルを分割",
  "debug.runGroup": "実行とデバッグ",
  "debug.title": "デバッグ / Debugger（ブレークポイント、ステップ、変数）",
  "debug.aria": "デバッグ",
  "debug.variables": "変数",
  "debug.callStack": "コールスタック",
  "debug.breakpoints": "ブレークポイント",
  "notifications.title": "通知",
  "voice.input": "音声入力",
  "output.title": "出力",
  "output.channel.lsp": "言語サービス",
  "output.channel.tasks": "タスク",
  "output.channel.extensions": "拡張機能",
  "test.empty": "テストは検出されていません。テストファイルを含むプロジェクトを開いてください。",
  "test.runAll": "すべてのテストを実行",
  "assistant.name": "啓明",
  "assistant.placeholder": "現在のファイルについて質問…",
  "assistant.selectModel": "モデルを選択",
  "assistant.switchModel": "モデルを切り替え",
  "assistant.send": "送信",
  "assistant.thinking": "考え中",
  "assistant.you": "あなた",
  "assistant.chatHintTitle": "コードについて質問",
  "assistant.chatHintDesc": "開いているファイルと選択中のテキストは自動的にコンテキストとして送信されます。",
  "assistant.currentFile": "現在のファイル",
  "assistant.chip.explain": "このファイルを説明",
  "assistant.chip.bugs": "潜在的なバグを探す",
  "assistant.chip.comments": "ドキュメントコメントを追加",
  "assistant.chip.test": "単体テストを書く",
  "assistant.chip.fixErrors": "🔧 エラーを修正 ({count})",
  "assistant.chip.explainSelection": "選択したコードを説明",
  "assistant.chip.reviewChange": "自分の変更をレビュー",
  "assistant.chip.commitMessage": "✍️ コミットメッセージを書く",
  "assistant.chip.reviewAllChanges": "すべての変更をレビュー ({count})",
  "assistant.chip.explainFile": "「{name}」を説明",
  "assistant.chip.howToRun": "実行方法",
  "assistant.chip.polishDoc": "このドキュメントを改善",
  "assistant.chip.addTestCases": "テストケースを追加",
  "assistant.chip.refactor": "最適化 / リファクタ",
  "assistant.chip.errorHandling": "エラー処理を追加",
  "assistant.chip.callGraph": "呼び出し関係を整理",
  "tool.action.skill": "スキル",
  "assistant.chip.startProject": "ここで何か始める",
  "assistant.prompt.startProject": "このフォルダは空です。まず何を作りたいか聞いて、具体的な方向を2〜3個、それぞれ一言でトレードオフを添えて提案してください。決めたらそのまま構築して動かしてください。",
  "assistant.chip.scaffoldHere": "プロジェクトの雛形を作る",
  "assistant.prompt.scaffoldHere": "この空のフォルダに動く雛形プロジェクトを作ってください：適切な技術スタックを選び、ファイルを作成し、依存関係を入れて、実行して見せてください。",
  "assistant.chip.projectResearch": "🔎 このプロジェクトを深掘り",
  "assistant.chip.whatIsProject": "これは何をするもの？",
  "assistant.chip.addFeature": "機能追加を手伝って",
  "assistant.chip.findIssues": "問題点を探す",
  "assistant.chip.addTests": "テストを追加",
  "assistant.chip.openFolder": "フォルダーを開く",
  "assistant.chip.whatCanIdeDo": "この IDE で何ができる？",
  "assistant.chip.writeCode": "コードを書く",
  "assistant.chip.explainSnippet": "コードを説明",
  "assistant.chip.writeRegex": "正規表現を書く",
  "assistant.chip.writeScript": "小さなスクリプトを書く",
  "assistant.onboardHeader": "📁 {name} を開きました · はじめに：",
  "assistant.prompt.warningSuffix": "、警告 {count} 件",
  "assistant.configFirst": "先に Michael アカウントへログインしてください",
  "assistant.capabilities": "機能メニュー",
  "assistant.capabilities.open": "ユーザーの習慣とユーザールールのメニューを開く",
  "assistant.capability.habits": "ユーザーの習慣",
  "assistant.capability.rules": "ユーザールール",
  "assistant.capability.browser": "ブラウザ",
  "assistant.capability.caps": "自分の機能",
  "assistant.mode.agent": "Agent",
  "assistant.mode.plan": "Plan",
  "assistant.mode.chat": "Chat",
  "assistant.mode.auto": "Auto",
  "assistant.mode.switch": "AI モードを切り替え",
  "assistant.tokenMeter": "コンテキストキャッシュ：{percent}%",
  "model.desc.minimax": "MiniMax — 超長コンテキストと優れた中国語能力。",
  "model.price.title": "モデル料金",
  "model.price.input": "入力",
  "model.price.output": "出力",
  "model.price.flat": "1 回あたり",
  "model.price.perMillionTokens": "/ 100万 tokens",
  "model.price.perCallUnsplit": "/ 回（バックエンドは入力/出力を分割していません）",
  "model.price.source": "ソース：{source}",
  "model.price.rate": "倍率 / rate：{rate}",
  "model.price.source.modelOverride": "バックエンドのモデル別設定",
  "model.price.source.backend": "バックエンド接続設定",
  "model.price.source.catalog": "内蔵モデル料金カタログ",
  "model.price.source.unset": "未設定",
  "model.price.imageBilling": "画像モデル · 画像単位課金",
  "model.price.missing": "バックエンドが入力/出力料金を返していません",
  "model.thinkingDepth": "思考深度",
  "model.thinking.on": "思考オン · {level}",
  "model.thinking.off": "思考オフ",
  "model.thinking.defaultHint": "このモデルの実際に公開されている能力に応じて思考パラメータを送信します。",
  "model.thinking.unsupported": "このモデルは調整可能な思考パラメータをサポートしていません。",
  "model.thinking.level.off": "オフ",
  "model.thinking.level.minimal": "最小",
  "model.thinking.level.low": "低",
  "model.thinking.level.medium": "中",
  "model.thinking.level.high": "高",
  "model.thinking.level.xhigh": "超高",
  "model.thinking.level.max": "最大",
  "model.thinking.level.alwaysOn": "常時オン",
  "model.thinking.level.enabled": "オン",
  "model.thinking.reason.noPublic": "このモデルには公開された調整可能な思考パラメータがないため、IDE は偽の reasoning_effort を送信しません。",
  "model.thinking.reason.notSelected": "モデルが選択されていません",
  "model.thinking.reason.image": "画像生成モデルはチャットの思考深度に対応していません。",
  "model.thinking.reason.minimax": "MiniMax は現在、信頼できる公開 reasoning_effort / thinking budget 段階を提供していないため、IDE は偽のパラメータを送信しません。",
  "model.thinking.reason.unknown": "不明なモデルには公開された調整可能な思考パラメータがないため、IDE は偽の reasoning_effort を送信しません。",
  "model.account": "アカウントとクレジット",
  "model.custom": "カスタムモデル",
  "feature.title": "詳細設定",
  "feature.tabsLabel": "詳細設定のタブ",
  "feature.close": "閉じる",
  "feature.tab.settings": "設定",
  "feature.tab.appearance": "外観",
  "feature.tab.growth": "成長",
  "feature.tab.adaptive": "適応",
  "feature.tab.shortcuts": "ショートカット",
  "feature.tab.tasks": "タスクランナー",
  "feature.tab.debugger": "デバッガー",
  "feature.tab.conflicts": "マージ競合",
  "feature.tab.lsp": "言語サーバー",
  "feature.tab.workspace": "ワークスペース",
  "feature.tab.remote": "リモート",
  "feature.settings.title": "設定",
  "feature.settings.desc": "エディター設定は自動保存され、セッションをまたいで保持されます。",
  "feature.settings.group.language": "言語",
  "feature.settings.locale.label": "アプリの言語",
  "feature.settings.locale.hint": "選択した言語は UI、AI 返信、データツールのグローバル言語設定として使われます。",
  "feature.settings.country.label": "国 / 地域",
  "feature.settings.country.hint": "プロフィールに国旗として表示され、AI とデータツールの地域設定として使われます。",
  "feature.settings.group.appearance": "外観",
  "feature.settings.theme.label": "カラーテーマ",
  "feature.appearance.title": "外観",
  "feature.appearance.desc": "プレビューから IDE のライト / ダーク外観を選択します。変更はアプリ全体にすぐ反映されます。",
  "feature.appearance.light.title": "ライト",
  "feature.appearance.light.desc": "日中作業向けの Google 風クリーンなライト UI。",
  "feature.appearance.dark.title": "ダーク",
  "feature.appearance.dark.desc": "集中してコードを書くための Cursor 風ダーク UI。",
  "feature.appearance.editorVisuals": "エディター表示",
  "feature.appearance.themeApplied": "{theme}テーマに切り替えました",
  "feature.appearance.font.currentCustom": "現在のカスタムフォント",
  "feature.appearance.appIcon.section": "アプリアイコン",
  "feature.appearance.appIcon.label": "アプリアイコン",
  "feature.appearance.appIcon.hint": "画像をアップロードすると、IDE 内のロゴ、アシスタントロゴ、ログインロゴ、ブラウザータブのアイコンが置き換わります。デスクトップパッケージのアイコン変更には再ビルドが必要です。",
  "feature.appearance.appIcon.upload": "アイコンをアップロード",
  "feature.appearance.appIcon.processing": "処理中…",
  "feature.appearance.appIcon.reset": "デフォルトに戻す",
  "feature.appearance.appIcon.applied": "アプリアイコンを更新しました",
  "feature.appearance.appIcon.resetDone": "デフォルトアイコンに戻しました",
  "feature.appearance.appIcon.invalid": "有効な画像ファイルを選択してください",
  "feature.appearance.appIcon.tooLarge": "画像が大きすぎます。8 MB 未満の画像を選択してください。",
  "feature.appearance.appIcon.readFailed": "画像の読み込みに失敗しました",
  "feature.settings.fontSize.label": "フォントサイズ",
  "feature.settings.fontSize.hint": "px",
  "feature.settings.fontFamily.label": "フォント",
  "feature.settings.lineHeight.label": "行の高さ",
  "feature.settings.lineHeight.hint": "0 = 自動",
  "feature.settings.group.editor": "エディター",
  "feature.settings.wordWrap.label": "折り返し",
  "feature.settings.tabSize.label": "Tab 幅",
  "feature.settings.renderWhitespace.label": "空白文字を表示",
  "feature.settings.cursorBlinking.label": "カーソルアニメーション",
  "feature.settings.minimap.label": "ミニマップ",
  "feature.settings.stickyScroll.label": "固定スクロール",
  "feature.settings.bracketColorization.label": "括弧ペアの色分け",
  "feature.settings.autoFixTypos.label": "識別子のスペル自動修正",
  "feature.settings.autoFixTypos.hint": "キーワードと 1 文字違いの語を入力中に書き換えます。既定はオフ：綴り間違いと意図した短い名前を区別できません（elf という変数が elif になります）。",
  "feature.settings.group.file": "ファイル",
  "feature.settings.autoSave.label": "自動保存",
  "feature.settings.option.off": "オフ",
  "feature.settings.option.on": "オン",
  "feature.settings.option.wordWrapColumn": "列で折り返し",
  "feature.settings.option.bounded": "範囲内",
  "feature.settings.option.none": "表示しない",
  "feature.settings.option.boundary": "境界のみ",
  "feature.settings.option.selection": "選択範囲のみ",
  "feature.settings.option.trailing": "行末のみ",
  "feature.settings.option.all": "すべて",
  "feature.settings.option.blink": "点滅",
  "feature.settings.option.smooth": "スムーズ",
  "feature.settings.option.phase": "フェード",
  "feature.settings.option.expand": "拡大",
  "feature.settings.option.solid": "常時表示",
  "feature.settings.ai.title": "AI 実行",
  "feature.settings.approval.label": "変更前に承認",
  "feature.settings.approval.hint": "オンにすると、ファイル書き込み、削除、コマンド実行、PC 操作など副作用のある操作前に確認します。",
  "feature.settings.liveFollow.label": "リアルタイム追従",
  "feature.settings.liveFollow.hint": "オンにすると、エージェント作業中に関連ファイル、ターミナル、パネルを自動で開きます。",
  "feature.settings.reset": "既定に戻す",
  "feature.settings.localeSwitched": "アプリの言語を {language} に切り替えました",
  "feature.settings.localeEditorRestart": "エディター自身のメニューは再起動後に切り替わります",
  "feature.settings.countrySwitched": "国 / 地域を {country} に切り替えました",
  "statusbar.commands": "コマンド",
  "settings.cancel": "キャンセル",
  "settings.save": "保存",
  "dialog.cancel": "キャンセル",
  "dialog.ok": "OK",
  "dialog.create": "作成",
  "dialog.rename": "名前を変更",
  "ctx.newFile": "新規ファイル…",
  "ctx.newFolder": "新規フォルダー…",
  "ctx.rename": "名前を変更…",
  "ctx.delete": "削除",
  "ctx.openProjectPath": "プロジェクトパスを開く",
  "ctx.copyPath": "パスをコピー",
  "ctx.removeWorkspaceFolder": "ワークスペースから削除",
  "ctx.collapseFolder": "フォルダーを折りたたむ",
  "ctx.expandFolder": "フォルダーを展開",
  "menu.file": "ファイル",
  "menu.edit": "編集",
  "menu.view": "表示",
  "menu.tools": "ツール",
  "premiumDb.title": "Michael Premium — データベースツール",
  "feature.tab.mcp": "MCP",
  "feature.tab.skills": "Skills",
  "premiumDb.menu": "Michael Premium",
  "menu.help": "ヘルプ",
  "menu.openFolder": "フォルダーを開く…",
  "menu.addWorkspaceFolder": "フォルダーをワークスペースに追加…",
  "menu.newProject": "新規プロジェクト…",
  "menu.newWindow": "新規ウィンドウ",
  "menu.connectRemote": "リモートマシンに接続…",
  "menu.save": "保存",
  "menu.closeFile": "ファイルを閉じる",
  "menu.autoSave": "自動保存",
  "menu.undo": "元に戻す",
  "menu.redo": "やり直す",
  "menu.find": "検索…",
  "menu.replace": "置換…",
  "menu.explorer": "エクスプローラー",
  "menu.search": "検索",
  "menu.sourceControl": "ソース管理",
  "menu.output": "出力",
  "menu.toggleExplorer": "エクスプローラーを切り替え",
  "menu.toggleAssistant": "AI アシスタントを切り替え",
  "menu.toggleTerminal": "ターミナルを切り替え",
  "menu.openExplorer": "エクスプローラーを開く",
  "menu.closeExplorer": "エクスプローラーを閉じる",
  "menu.openAssistant": "AI アシスタントを開く",
  "menu.closeAssistant": "AI アシスタントを閉じる",
  "menu.openTerminal": "ターミナルを開く",
  "menu.closeTerminal": "ターミナルを閉じる",
  "menu.problems": "問題",
  "menu.commandPalette": "コマンドパレット…",
  "menu.uiGallery": "UI コンポーネント…",
  "menu.runCurrentFile": "現在のファイルを実行",
  "menu.remoteDesktop": "リモートPC",
  "menu.featureSettings": "詳細設定",
  "menu.documentation": "ドキュメント",
  "menu.aiSettings": "AI 設定…",
  "menu.about": "情報",
  "menu.aboutMsg": "Mr. Day One — AI アシスタント内蔵の macOS 風コードエディター",
  "about.subtitle": "AI ネイティブなコードエディターとローカル開発ワークスペース",
  "about.version": "バージョン v{version}",
  "about.developer": "開発者",
  "about.account": "アカウント",
  "about.membership": "メンバーシップ",
  "about.region": "国 / 地域",
  "about.notSignedIn": "未ログイン",
  "about.memberNone": "有効なメンバーシップなし",
  "about.gateway": "モデルリクエストは Michael ゲートウェイを経由し、アカウント、課金、モデルカタログ、経路フェイルオーバーを統一します。",
  "about.copyright": "© {year} Michael. All rights reserved.",
  "about.close": "情報ダイアログを閉じる",
  "theme.title": "テーマ",
  "theme.light": "ライト",
  "theme.dark": "ダーク",
  "account.notSignedIn": "未ログイン",
  "account.signInHint": "クリックしてログイン",
  "account.signedIn": "ログイン済み",
  "account.signedInNoPlan": "ログイン済み · 有効なプランなし",
  "account.memberSuffix": "メンバー",
  "account.profile": "プロフィール",
  "account.billing": "請求",
  "account.generalSettings": "一般設定",
  "account.shortcuts": "ショートカット",
  "account.logout": "ログアウト",
  "account.logoutConfirmTitle": "ログアウト",
  "account.logoutConfirmBody": "AI を使うには再ログインが必要です。このデバイスから現在のアカウントセッションを削除します。",
  "account.logoutSuccess": "ログアウトしました",
  "billing.loading": "読み込み中...",
  "login.title": "Mr. Day One へようこそ",
  "login.subtitle": "メールアドレスを入力してログインします。新規ユーザーは自動作成されます。",
  "login.emailPlaceholder": "メールアドレス",
  "login.passwordPlaceholder": "パスワードを入力",
  "login.next": "続行",
  "login.agreePrefix": "以下を読んで同意します：",
  "login.terms": "利用規約",
  "login.and": "と",
  "login.privacy": "プライバシーポリシー",
  "login.codeHint": "メールに送信された 6 桁のコードを入力",
  "login.resend": "確認コードを再送信",
  "login.submit": "ログイン",
  "login.useCode": "確認コードでログイン",
  "login.back": "戻る",
  "login.sending": "送信中…",
  "login.resendSuccess": "確認コードを再送信しました",
  "login.sendFailed": "送信に失敗しました：{message}",
  "login.failed": "操作に失敗しました",
  "login.invalidEmail": "有効なメールアドレスを入力してください",
  "login.checking": "確認中…",
  "login.checkEmailFailed": "メール確認に失敗しました：{message}",
  "login.signupPasswordPlaceholder": "パスワードを設定（6 文字以上）",
  "login.welcomeBack": "{email} · おかえりなさい。パスワードを入力してログインしてください。",
  "login.newAccountHint": "{email} · 新規アカウントです。パスワード設定後、メールを確認してください。",
  "login.signupNext": "次へ",
  "login.loggingIn": "ログイン中…",
  "login.verifying": "確認中…",
  "login.passwordMin": "パスワードは 6 文字以上必要です",
  "login.sendingCode": "確認コードを送信中…",
  "login.completeSignup": "登録を完了",
  "login.signingUp": "登録中…",
  "login.verify": "確認",
  "settings.title": "AI モデル",
  "settings.sub": "モデルリクエストは Michael ゲートウェイ経由で処理され、クレジット、課金、モデルカタログ、経路フェイルオーバーを統一します。ユーザーが第三者プロバイダーを設定する必要はありません。",
  "settings.gatewayTitle": "Michael ゲートウェイ",
  "settings.gatewayEnabled": "有効：すべての AI モデルリクエストはあなたのゲートウェイ経由で転送されます。",
  "settings.gotIt": "了解",
  "devin.title": "Devin に接続",
  "devin.subPrefix": "Devin API Key（",
  "devin.subSuffix": "で始まる）を入力してください。アシスタントは実際の Devin セッションへ直接接続します。キーはローカルにのみ保存されます。",
};

let currentLocale = "zh-CN";
let translations = { en: EN, "zh-CN": ZH_CN, ja: JA, "ja-JP": JA };
const FIRST_PARTY_LOCALE_TAGS = new Set(["en", "zh-CN", "ja"]);
const I18N_PACK_CACHE_VERSION = "v3";
let changeListeners = [];
let loadingLocales = new Map();
let textAliasCache = null;
let localeObserver = null;
let localeObserverPending = false;
let applyingLocale = false;
let adhocI18nTimer = null;
let adhocI18nInFlight = false;
const adhocI18nQueues = new Map();
const adhocI18nCaches = new Map();
const adhocTextSources = new WeakMap();
const adhocAttrSources = new WeakMap();
// v6: v5 caches were poisoned — the ad-hoc translator hallucinated on model ids
// ("claude-opus-5" → "claude-sonnet-5"), so bump the version to discard them.
const ADHOC_I18N_CACHE_VERSION = "v6";
const ADHOC_I18N_CACHE_MAX_ENTRIES = 4000;
// Hard fuse: without it a single cache-miss loop turned into ~340k requests/day
// against /api/i18n/pack (2026-07-25 production incident).
const ADHOC_I18N_MAX_REQUESTS_PER_SESSION = 300;
const adhocI18nPending = new Set();
let adhocI18nFailures = 0;
let adhocI18nBackoffUntil = 0;
let adhocI18nRequestCount = 0;
let adhocI18nDisabled = false;

const AUTO_I18N_SKIP_SELECTOR = [
  "script",
  "style",
  "svg",
  "canvas",
  "textarea",
  "input",
  "code",
  "pre",
  "kbd",
  "[contenteditable]",
  "[data-i18n-skip]",
  "#editor",
  "#terminal",
  "#tree",
  "#tabs",
  "#breadcrumb",
  "#recentList",
  ".monaco-editor",
  ".xterm",
  ".tree",
  ".tabs",
  ".breadcrumb",
  ".welcome__recent-list",
  ".outline-tree",
  ".outline-timeline",
  ".output-panel__body",
  ".terminal-panel__body",
  ".test-output",
  ".problems-panel__body",
  ".diff-view__body",
  ".statusbar__right",
  ".ref-chip",
  // Model picker + hover card: model names are PRODUCT IDENTIFIERS, not UI copy.
  // Sending them to the AI translator produced hallucinated renames (opus→sonnet).
  ".model-picker",
  "#modelMenu",
  ".model-info-card",
  ".chat",
  "#chat",
  ".markdown-body",
  ".message",
  ".msg",
  ".turn",
  ".assistant-message",
  ".user-message",
].join(",");

function apiBase() {
  try {
    const tauri = !!window.__TAURI_INTERNALS__ || /\bTauri\b/i.test(navigator.userAgent || "");
    const saved = localStorage.getItem("michael_api");
    return (saved || (tauri ? "https://code.mrday.one" : window.location.origin)).replace(/\/+$/, "");
  } catch {
    return "";
  }
}

// /api/i18n/pack drives a real model call with the platform's own upstream key, so
// the gateway requires a credential on it. Without a login token the dynamic pack
// simply isn't available — the app still has zh/en/ja built in, so that degrades to
// the bundled dictionaries instead of failing visibly.
function authHeaders() {
  try {
    const tok = localStorage.getItem("michael_token") || "";
    return tok ? { Authorization: "Bearer " + tok } : null;
  } catch {
    return null;
  }
}

function dictionaryFor(locale) {
  const tag = coerceSupportedLocale(locale);
  const base = tag.split("-")[0];
  return translations[tag] || translations[base] || (base === "zh" ? translations["zh-CN"] : translations.en);
}

function localePackIsComplete(locale) {
  const tag = coerceSupportedLocale(locale);
  const base = tag.split("-")[0];
  const dict = translations[tag] || translations[base] || (base === "zh" ? translations["zh-CN"] : null);
  if (!dict) return false;
  return Object.keys(EN).every((key) => Object.prototype.hasOwnProperty.call(dict, key));
}

function isFirstPartyLocale(locale) {
  return FIRST_PARTY_LOCALE_TAGS.has(coerceSupportedLocale(locale));
}

function hasLocaleDictionary(locale) {
  const tag = coerceSupportedLocale(locale);
  const base = tag.split("-")[0];
  return !!(translations[tag] || translations[base] || (base === "zh" ? translations["zh-CN"] : null));
}

function missingLocaleEntries(locale) {
  const tag = coerceSupportedLocale(locale);
  const base = tag.split("-")[0];
  const dict = translations[tag] || translations[base] || (base === "zh" ? translations["zh-CN"] : {}) || {};
  const missing = {};
  for (const [key, value] of Object.entries(EN)) {
    if (!Object.prototype.hasOwnProperty.call(dict, key)) missing[key] = value;
  }
  return missing;
}

export function t(key, params) {
  const dict = dictionaryFor(currentLocale);
  let str = dict[key] ?? EN[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      // Function replacement so a value containing `$` (e.g. a branch name or
      // commit message) is inserted literally, not parsed as `$&`/`$1`/`$$`.
      str = str.replaceAll(`{${k}}`, () => String(v));
    }
  }
  return str;
}

export function registerLocale(locale, dict, options = {}) {
  if (!isSupportedLocale(locale)) return;
  const tag = coerceSupportedLocale(locale);
  const overwrite = options?.overwrite !== false;
  const existing = translations[tag] || {};
  translations[tag] = overwrite
    ? { ...EN, ...existing, ...dict }
    : { ...dict, ...existing };
  textAliasCache = null;
}

function notifyLocaleListeners(locale) {
  applyToDOM();
  for (const fn of changeListeners) {
    try { fn(locale); } catch { /* ignore */ }
  }
}

async function ensureLocalePack(locale) {
  if (!isSupportedLocale(locale)) return false;
  const tag = coerceSupportedLocale(locale);
  const base = tag.split("-")[0];
  if (base === "en") return false;
  const firstParty = isFirstPartyLocale(tag);
  let entries = firstParty ? missingLocaleEntries(tag) : EN;
  if (firstParty && !Object.keys(entries).length) return false;
  if (!firstParty && translations[tag] && localePackIsComplete(tag)) return false;
  if (!firstParty && translations[base] && localePackIsComplete(base)) return false;
  const cacheKey = `michael-ide.i18n-pack.${tag}.${I18N_PACK_CACHE_VERSION}`;
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const dict = JSON.parse(cached);
      if (dict && typeof dict === "object") {
        registerLocale(tag, dict, { overwrite: !firstParty });
        if (firstParty) {
          entries = missingLocaleEntries(tag);
          if (!Object.keys(entries).length) return true;
        } else if (localePackIsComplete(tag)) {
          return true;
        }
      }
    }
  } catch {}
  if (loadingLocales.has(tag)) return loadingLocales.get(tag);
  const p = (async () => {
    const root = apiBase();
    if (!root) return false;
    const auth = authHeaders();
    if (!auth) return false;
    const r = await fetch(root + "/api/i18n/pack", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ locale: tag, source_locale: "auto", entries }),
    });
    if (!r.ok) throw new Error("i18n pack failed: " + r.status);
    const data = await r.json();
    const dict = data && data.translations && typeof data.translations === "object" ? data.translations : null;
    if (!dict) return false;
    registerLocale(tag, dict, { overwrite: !firstParty });
    try { localStorage.setItem(cacheKey, JSON.stringify(dict)); } catch {}
    return true;
  })().catch((e) => {
    console.warn("[i18n] dynamic language pack failed:", tag, e);
    return false;
  }).finally(() => {
    loadingLocales.delete(tag);
  });
  loadingLocales.set(tag, p);
  return p;
}

export function setLocale(locale) {
  const next = coerceSupportedLocale(locale);
  const changed = next !== currentLocale;
  currentLocale = next;
  localStorage.setItem("michael-ide-locale", currentLocale);
  try { document.documentElement.lang = currentLocale; } catch {}
  if (changed && hasLocaleDictionary(currentLocale)) notifyLocaleListeners(currentLocale);
  const ready = ensureLocalePack(currentLocale).then((loaded) => {
    if (loaded && currentLocale === next) notifyLocaleListeners(currentLocale);
    return currentLocale;
  });
  return ready;
}

/// 正在路上的临时翻译请求：同一段话不重复问。key 是 `tag\u0000原文`。
const adhocInFlight = new Map();

/**
 * 立刻把几段话翻成当前语言，**等得到结果**（有上限）。
 *
 * 和上面那套 DOM 观察者驱动的临时翻译共用同一份缓存和同一个接口，区别只在时机：
 * 那边是"先把原文渲染出去，翻好了再换掉"，靠 DOM 还在原地才成立；而这里的调用方
 * （语言服务的悬浮说明）是一次性把 markdown 交给编辑器渲染，之后没有第二次机会。
 *
 * 三处是踩过坑之后定的，别顺手改回去：
 *
 *  ① **切块**。网关那个接口逐项限长 900 **字节**，超了的条目被**静默丢掉**——不报错，
 *     回包里就是没有这一项。一段稍长的文档字符串很容易超（中文一个字三字节），
 *     于是"翻译不生效"看起来像功能没做，其实是那一项从来没进过模型。
 *
 *  ② **等到点就返回，但请求不掐**。这是一次真实的模型调用，冷启动常常超过几秒；
 *     早先到点 abort，结果是**永远等不到**、缓存也永远是空的，每次悬浮都还是英文。
 *     现在超时只决定"这一次先出原文"，请求照跑，落地写进缓存——下一次悬浮就是译文了。
 *
 *  ③ **回包里没有的那一项不进缓存**。返回值和原文相同意味着"本来就是目标语言"，可以记；
 *     而键**缺失**是这一次没成，记下来就等于把它永久钉死在英文上。
 *
 * 一律不抛：它挂在渲染路径上。
 *
 * @returns Map<原文, 译文>；没翻成的条目**不进这张表**，调用方据此保留原文。
 */
export async function translateNow(list, { timeoutMs = 2500, maxBytes = 800 } = {}) {
  const out = new Map();
  const texts = (Array.isArray(list) ? list : [list])
    .map((x) => String(x ?? "").trim()).filter(Boolean);
  if (!texts.length) return out;
  if (!isSupportedLocale(currentLocale)) return out;
  const tag = coerceSupportedLocale(currentLocale);
  const cache = getAdhocCache(tag);

  // 每段先切块（见 ①），块才是缓存和请求的单位。
  const partsOf = new Map(texts.map((t) => [t, chunkText(t, maxBytes)]));
  const miss = [];
  for (const parts of partsOf.values()) {
    for (const part of parts) {
      if (Object.prototype.hasOwnProperty.call(cache, part)) continue;
      if (adhocInFlight.has(adhocPendingKey(tag, part))) continue;
      if (!miss.includes(part)) miss.push(part);
    }
  }

  if (miss.length && !adhocI18nDisabled
      && adhocI18nRequestCount < ADHOC_I18N_MAX_REQUESTS_PER_SESSION
      && apiBase() && authHeaders()) {
    const batch = miss.slice(0, 40);
    const job = adhocTranslateBatch(tag, batch);
    for (const part of batch) adhocInFlight.set(adhocPendingKey(tag, part), job);
    // ② 到点就走，但**不掐**请求：它会自己落地写缓存，下一次悬浮就有了。
    await Promise.race([job, new Promise((r) => setTimeout(r, Math.max(300, timeoutMs)))]);
  }

  for (const [text, parts] of partsOf) {
    const got = parts.map((p) => (Object.prototype.hasOwnProperty.call(cache, p) ? cache[p] : ""));
    if (got.some((v) => !v)) continue;                 // 有一块没翻成，整段保留原文
    const merged = got.join(parts.length > 1 ? "\n" : "");
    if (merged.trim() && merged !== text) out.set(text, merged);
  }
  return out;
}

/// 真正发那一次请求。落地时无论成败都把 in-flight 标记摘掉。
async function adhocTranslateBatch(tag, batch) {
  adhocI18nRequestCount += 1;
  try {
    const entries = {};
    batch.forEach((text, i) => { entries[`doc_${i}`] = text; });
    const r = await fetch(apiBase() + "/api/i18n/pack", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ locale: tag, source_locale: "auto", entries }),
    });
    if (!r.ok) throw new Error("i18n pack failed: " + r.status);
    const data = await r.json();
    const got = data && data.translations && typeof data.translations === "object" ? data.translations : {};
    const cache = getAdhocCache(tag);
    let wrote = false;
    batch.forEach((text, i) => {
      // ③ 键缺失 = 这一次没成（多半是被那条 900 字节的逐项限长静默丢掉了），不记；
      //    记下来等于把这段话永久钉死在英文上。
      const v = String(got[`doc_${i}`] ?? "").trim();
      if (!v) return;
      cache[text] = v;
      wrote = true;
    });
    if (wrote) saveAdhocCache(tag);
  } catch { /* 断网/网关拒绝/解析失败：这一轮保留原文，下次再问 */ }
  finally { for (const text of batch) adhocInFlight.delete(adhocPendingKey(tag, text)); }
}

export function getLocale() {
  return currentLocale;
}

export function onLocaleChange(fn) {
  changeListeners.push(fn);
  return () => {
    changeListeners = changeListeners.filter((f) => f !== fn);
  };
}

function normalizeUiText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function buildTextAliasCache() {
  if (textAliasCache) return textAliasCache;
  const map = new Map();
  const add = (text, key) => {
    if (typeof text !== "string") return;
    if (text.includes("{")) return;
    const normalized = normalizeUiText(text);
    if (!normalized || normalized.length > 180) return;
    if (/^[\d\s.,:;()[\]{}+\-*/%|\\]+$/.test(normalized)) return;
    if (!map.has(normalized)) map.set(normalized, key);
  };
  for (const dict of Object.values(translations)) {
    if (!dict || typeof dict !== "object") continue;
    for (const [key, value] of Object.entries(dict)) add(value, key);
  }
  textAliasCache = map;
  return map;
}

function keyForExistingUiText(text) {
  return buildTextAliasCache().get(normalizeUiText(text));
}

// `closest()` against AUTO_I18N_SKIP_SELECTOR is 40 selectors tested up the whole
// ancestor chain. That is far too expensive to run per text node per frame, so the
// answer is memoised per element. A WeakMap keyed on the element lets the entry die
// with the node, and the result can't go stale in practice: an element's ancestry
// (and therefore whether it sits inside `.chat` / `.monaco-editor` / …) doesn't
// change without the element being re-created.
const skipDecisionCache = new WeakMap();

/// Is this element itself one of the skip containers? Used by the tree walkers to
/// prune an entire subtree in ONE test instead of re-deciding for every descendant.
function isAutoI18nSkipRoot(el) {
  if (!el || el.nodeType !== 1) return false;
  try { return el.matches(AUTO_I18N_SKIP_SELECTOR); } catch { return true; }
}

function shouldSkipAutoI18n(el) {
  if (!el || el.nodeType !== 1) return true;
  const cached = skipDecisionCache.get(el);
  if (cached !== undefined) return cached;
  let skip;
  try { skip = !!el.closest(AUTO_I18N_SKIP_SELECTOR); } catch { skip = true; }
  // Only memoise a connected element. A detached node has no ancestors yet, so
  // `closest()` says "not in a skip region" — caching that would let it stay
  // translatable after it gets appended into `.chat` or the editor.
  if (el.isConnected) skipDecisionCache.set(el, skip);
  return skip;
}

function looksLikeUserPathOrCode(text) {
  const s = normalizeUiText(text);
  if (!s) return true;
  if (/^(?:https?:|file:|data:|blob:|asset:|mailto:)/i.test(s)) return true;
  if (/^[A-Za-z]:[\\/]/.test(s) || /^~?\//.test(s) || /[\\/][^ ]+[\\/]/.test(s)) return true;
  if (/\b[\w.-]+\.(?:js|jsx|ts|tsx|mjs|cjs|css|scss|sass|less|html|vue|svelte|json|jsonc|md|mdx|yaml|yml|toml|rs|go|py|java|kt|swift|c|cc|cpp|h|hpp|cs|php|rb|sh|zsh|fish|ps1|sql|png|jpg|jpeg|gif|webp|svg|pdf|zip|dmg|exe)\b/i.test(s)) return true;
  if (/^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(s)) return true;
  if (/^[#.]?[A-Za-z_$][\w$-]*(?:\.[A-Za-z_$][\w$-]*){1,}$/.test(s)) return true;
  if (/^[A-Z0-9_./:-]{8,}$/.test(s) && /[._/:\\-]/.test(s)) return true;
  // Hyphen/dot slugs like model ids (claude-opus-5, gpt-5.4-mini, grok-4.5) are
  // identifiers, not sentences — translating them invites hallucinated renames.
  if (/^[A-Za-z][\w.]*(?:-[\w.]+)+$/.test(s) && !/\s/.test(s)) return true;
  return false;
}

function looseUiTextEligible(text) {
  const s = normalizeUiText(text);
  if (s.length < 2 || s.length > 260) return false;
  if (/^[\d\s.,:;()[\]{}+\-*/%|\\]+$/.test(s)) return false;
  if (!/[\p{L}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(s)) return false;
  if (looksLikeUserPathOrCode(s)) return false;
  return true;
}

// Text whose script already matches the target locale must never reach the
// server: the "translation" comes back identical (e.g. Chinese UI text under
// zh-CN), identity results used to be uncacheable, and the same strings were
// re-requested on every DOM mutation — the 2026-07-25 request storm.
function textAlreadyInLocale(text, locale) {
  const base = coerceSupportedLocale(locale).split("-")[0];
  const letters = normalizeUiText(text).match(/\p{L}/gu) || [];
  if (!letters.length) return true;
  const ratio = (re) => letters.filter((ch) => re.test(ch)).length / letters.length;
  if (base === "zh") return ratio(/\p{Script=Han}/u) >= 0.5;
  if (base === "ja") return ratio(/[\p{Script=Hiragana}\p{Script=Katakana}]/u) > 0 || ratio(/\p{Script=Han}/u) >= 0.7;
  if (base === "ko") return ratio(/\p{Script=Hangul}/u) >= 0.5;
  if (base === "ru") return ratio(/\p{Script=Cyrillic}/u) >= 0.5;
  // App-authored dynamic strings are zh or en, so under en a latin-only string
  // is already English. Other latin locales (de/es/pt) can't be told apart
  // locally; they rely on identity results being cached after one request.
  if (base === "en") return ratio(/[A-Za-z]/) >= 0.9;
  return false;
}

function adhocCacheKey(locale) {
  return `michael-ide.i18n-adhoc.${coerceSupportedLocale(locale)}.${ADHOC_I18N_CACHE_VERSION}`;
}

function getAdhocCache(locale) {
  if (!isSupportedLocale(locale)) return {};
  const tag = coerceSupportedLocale(locale);
  if (adhocI18nCaches.has(tag)) return adhocI18nCaches.get(tag);
  let cache = {};
  try {
    const raw = localStorage.getItem(adhocCacheKey(tag));
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") cache = parsed;
  } catch {}
  adhocI18nCaches.set(tag, cache);
  return cache;
}

function saveAdhocCache(locale) {
  if (!isSupportedLocale(locale)) return;
  const tag = coerceSupportedLocale(locale);
  const cache = getAdhocCache(tag);
  const keys = Object.keys(cache);
  if (keys.length > ADHOC_I18N_CACHE_MAX_ENTRIES) {
    for (const k of keys.slice(0, keys.length - ADHOC_I18N_CACHE_MAX_ENTRIES)) delete cache[k];
  }
  try { localStorage.setItem(adhocCacheKey(tag), JSON.stringify(cache)); } catch {}
}

function adhocPendingKey(tag, text) {
  // 分隔符写成转义而不是裸字节：文件里一个真 NUL 会让 grep/ripgrep/ugrep 把整份文件
  // 判成二进制并静默跳过，于是搜这个文件永远是「没有」——实测过，找不到任何一条 i18n key。
  // 运行时字符串完全一样。
  return `${tag}\u0000${text}`;
}

function scheduleAdhocFlush(delay) {
  if (adhocI18nTimer) return;
  adhocI18nTimer = setTimeout(() => {
    adhocI18nTimer = null;
    flushAdhocI18nQueue();
  }, delay);
}

function queueAdhocText(locale, source) {
  if (adhocI18nDisabled) return;
  if (!isSupportedLocale(locale)) return;
  const tag = coerceSupportedLocale(locale);
  const text = normalizeUiText(source);
  if (!looseUiTextEligible(text)) return;
  if (textAlreadyInLocale(text, tag)) return;
  const cache = getAdhocCache(tag);
  if (cache[text]) return;
  if (adhocI18nPending.has(adhocPendingKey(tag, text))) return;
  if (!adhocI18nQueues.has(tag)) adhocI18nQueues.set(tag, new Map());
  adhocI18nQueues.get(tag).set(text, text);
  scheduleAdhocFlush(600);
}

async function flushAdhocI18nQueue() {
  if (adhocI18nInFlight) return;
  const wait = adhocI18nBackoffUntil - Date.now();
  if (wait > 0) { scheduleAdhocFlush(wait); return; }
  const root = apiBase();
  if (!root) return;
  if (!isSupportedLocale(currentLocale)) return;
  const tag = coerceSupportedLocale(currentLocale);
  const queue = adhocI18nQueues.get(tag);
  if (!queue || !queue.size) return;
  if (adhocI18nRequestCount >= ADHOC_I18N_MAX_REQUESTS_PER_SESSION) {
    adhocI18nDisabled = true;
    adhocI18nQueues.clear();
    console.warn("[i18n] loose UI translation disabled for this session (request budget exhausted)");
    return;
  }
  const auth = authHeaders();
  if (!auth) {
    adhocI18nDisabled = true;
    adhocI18nQueues.clear();
    return;
  }
  adhocI18nInFlight = true;
  adhocI18nRequestCount += 1;
  const items = [...queue.keys()].slice(0, 80);
  for (const item of items) {
    queue.delete(item);
    adhocI18nPending.add(adhocPendingKey(tag, item));
  }
  try {
    const entries = {};
    items.forEach((text, index) => { entries[`ui_${index}`] = text; });
    const r = await fetch(root + "/api/i18n/pack", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({ locale: tag, source_locale: "auto", entries }),
    });
    if (!r.ok) throw new Error("i18n pack failed: " + r.status);
    const data = await r.json();
    const out = data && data.translations && typeof data.translations === "object" ? data.translations : {};
    const cache = getAdhocCache(tag);
    items.forEach((text, index) => {
      const translated = String(out[`ui_${index}`] || "").trim();
      // Identity and missing results are cached too — otherwise text already in
      // the target language is re-requested on every DOM mutation, forever.
      cache[text] = translated || text;
    });
    saveAdhocCache(tag);
    adhocI18nFailures = 0;
    if (coerceSupportedLocale(currentLocale) === tag) applyToDOM();
  } catch (e) {
    console.warn("[i18n] loose UI translation failed:", tag, e);
    adhocI18nFailures += 1;
    adhocI18nBackoffUntil = Date.now() + Math.min(30000 * 2 ** (adhocI18nFailures - 1), 600000);
    for (const item of items) queue.set(item, item);
  } finally {
    for (const item of items) adhocI18nPending.delete(adhocPendingKey(tag, item));
    adhocI18nInFlight = false;
    if (queue.size) scheduleAdhocFlush(Math.max(1500, adhocI18nBackoffUntil - Date.now()));
  }
}

function knownAdhocTranslation(locale, source) {
  const cache = getAdhocCache(locale);
  return cache[normalizeUiText(source)] || "";
}

function localizeExactTextNode(node) {
  const parent = node?.parentElement;
  if (!parent || shouldSkipAutoI18n(parent)) return;
  const raw = node.nodeValue || "";
  const trimmed = raw.trim();
  if (!trimmed) return;
  const key = keyForExistingUiText(trimmed);
  if (!key) return;
  const next = t(key);
  if (!next || normalizeUiText(next) === normalizeUiText(trimmed)) return;
  const leading = raw.match(/^\s*/)?.[0] || "";
  const trailing = raw.match(/\s*$/)?.[0] || "";
  node.nodeValue = `${leading}${next}${trailing}`;
}

function localizeLooseTextNode(node) {
  const parent = node?.parentElement;
  if (!parent || shouldSkipAutoI18n(parent)) return;
  const raw = node.nodeValue || "";
  const trimmed = raw.trim();
  if (!trimmed || keyForExistingUiText(trimmed)) return;
  const previous = adhocTextSources.get(node);
  const previousSource = typeof previous === "string" ? previous : previous?.source;
  const previousLast = typeof previous === "object" ? previous.last : "";
  const source = previousSource && (
    normalizeUiText(trimmed) === normalizeUiText(previousSource) ||
    normalizeUiText(trimmed) === normalizeUiText(previousLast)
  ) ? previousSource : trimmed;
  if (!looseUiTextEligible(source)) return;
  const translated = knownAdhocTranslation(currentLocale, source);
  if (!translated) {
    adhocTextSources.set(node, { source, last: trimmed });
    queueAdhocText(currentLocale, source);
    return;
  }
  adhocTextSources.set(node, { source, last: translated });
  if (normalizeUiText(translated) === normalizeUiText(trimmed)) return;
  const leading = raw.match(/^\s*/)?.[0] || "";
  const trailing = raw.match(/\s*$/)?.[0] || "";
  node.nodeValue = `${leading}${translated}${trailing}`;
}

function localizeLooseAttribute(el, attr) {
  if (!el.hasAttribute(attr) || shouldSkipAutoI18n(el)) return;
  const raw = el.getAttribute(attr) || "";
  const trimmed = raw.trim();
  if (!trimmed || keyForExistingUiText(trimmed)) return;
  let attrMap = adhocAttrSources.get(el);
  if (!attrMap) {
    attrMap = {};
    adhocAttrSources.set(el, attrMap);
  }
  const previous = attrMap[attr];
  const previousSource = typeof previous === "string" ? previous : previous?.source;
  const previousLast = typeof previous === "object" ? previous.last : "";
  const source = previousSource && (
    normalizeUiText(trimmed) === normalizeUiText(previousSource) ||
    normalizeUiText(trimmed) === normalizeUiText(previousLast)
  ) ? previousSource : trimmed;
  if (!looseUiTextEligible(source)) return;
  const translated = knownAdhocTranslation(currentLocale, source);
  if (!translated) {
    attrMap[attr] = { source, last: trimmed };
    queueAdhocText(currentLocale, source);
    return;
  }
  attrMap[attr] = { source, last: translated };
  if (normalizeUiText(translated) !== normalizeUiText(trimmed)) el.setAttribute(attr, translated);
}

// Collect the translatable text nodes under `container`, pruning skip regions.
//
// Walking with SHOW_TEXT alone cannot prune: text nodes have no children, so
// FILTER_REJECT behaves exactly like FILTER_SKIP and every text node inside the chat
// log still gets visited and tested. Adding SHOW_ELEMENT makes FILTER_REJECT on a
// skip container (`.chat`, `.monaco-editor`, `.xterm`, …) drop that whole subtree in a
// single `matches()` call — which is the difference between "cost grows with the
// conversation" and "cost grows with the chrome around it".
const LOOSE_ATTR_SELECTOR = "[title], [aria-label], [placeholder], [data-placeholder]";
const LOOSE_ATTRS = ["title", "aria-label", "placeholder", "data-placeholder"];

/// Matching elements inside `container`, **plus the container itself** when it matches.
///
/// `querySelectorAll` returns descendants only. That was invisible while the container
/// was always `document`, but the observer now hands us the very element whose
/// attribute changed — whose own `title` would then never be translated.
function elementsWithin(container, selector) {
  const found = container.querySelectorAll?.(selector);
  const descendants = found ? Array.from(found) : [];
  if (container.nodeType === 1 && container.matches?.(selector)) return [container, ...descendants];
  return descendants;
}

function collectAutoI18nTextNodes(container, filter) {
  const walker = document.createTreeWalker(
    container,
    filter.SHOW_TEXT | filter.SHOW_ELEMENT,
    {
      acceptNode(node) {
        if (node.nodeType === 1) {
          return isAutoI18nSkipRoot(node) ? filter.FILTER_REJECT : filter.FILTER_SKIP;
        }
        return (node.nodeValue || "").trim() ? filter.FILTER_ACCEPT : filter.FILTER_REJECT;
      },
    },
  );
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

// One pass over a container: walk the tree ONCE, then run both the exact-key and the
// loose-text localizers over the same node list, and sweep the attributes once.
//
// These used to be two independent functions, each building its own TreeWalker and its
// own node array over the identical tree with an identical filter — double the walking
// and double the 40-selector `matches()` calls, every frame, for results that were the
// same both times.
function localizeTextIn(root) {
  if (typeof document === "undefined") return;
  const container = root && root.nodeType ? root : document;
  if (container.nodeType === 1 && shouldSkipAutoI18n(container)) return;
  const filter = globalThis.NodeFilter || document.defaultView?.NodeFilter;
  if (!filter) return;

  for (const node of collectAutoI18nTextNodes(container, filter)) {
    // Exact key matches win; loose translation only handles what has no key.
    localizeExactTextNode(node);
    localizeLooseTextNode(node);
  }

  for (const el of elementsWithin(container, LOOSE_ATTR_SELECTOR)) {
    if (shouldSkipAutoI18n(el)) continue;
    for (const attr of LOOSE_ATTRS) {
      if (el.hasAttribute(attr)) {
        const raw = el.getAttribute(attr);
        const key = keyForExistingUiText(raw);
        if (key) {
          const next = t(key);
          if (next && normalizeUiText(next) !== normalizeUiText(raw)) el.setAttribute(attr, next);
          continue; // exact key handled it
        }
      }
      localizeLooseAttribute(el, attr);
    }
  }
}

// Subtrees that changed since the last pass, and therefore the only places worth
// re-scanning. Empty set with a scheduled frame means "rescan everything" (used by an
// explicit locale switch).
let pendingAutoI18nRoots = new Set();
let pendingAutoI18nFullPass = false;

function scheduleAutoI18n(root) {
  // Streaming output mutates the chat DOM continuously. Re-scanning the WHOLE document
  // on each of those frames is what made long conversations lock up the machine: two
  // tree walks plus five document-wide querySelectorAll per frame, with cost
  // proportional to the entire transcript. Only the subtree that actually changed
  // needs another look.
  if (root && root.nodeType === 1 && !shouldSkipAutoI18n(root)) {
    // Cap the queue: past a handful of roots a single pass over their common ancestor
    // is cheaper than many overlapping walks.
    if (pendingAutoI18nRoots.size < 32) pendingAutoI18nRoots.add(root);
    else pendingAutoI18nFullPass = true;
  } else if (!root) {
    pendingAutoI18nFullPass = true;
  }
  if (applyingLocale || localeObserverPending || typeof requestAnimationFrame !== "function") return;
  localeObserverPending = true;
  requestAnimationFrame(() => {
    localeObserverPending = false;
    const roots = pendingAutoI18nRoots;
    const full = pendingAutoI18nFullPass;
    pendingAutoI18nRoots = new Set();
    pendingAutoI18nFullPass = false;
    if (full || !roots.size) { applyToDOM(); return; }
    for (const el of roots) {
      // A node can be detached between the mutation and this frame.
      if (el.isConnected) applyToDOM(el);
    }
  });
}

function installLocaleObserver() {
  if (localeObserver || typeof MutationObserver === "undefined" || typeof document === "undefined") return;
  localeObserver = new MutationObserver((mutations) => {
    if (applyingLocale) return;
    for (const m of mutations) {
      // Ignore anything inside a skip region outright — chat messages, the editor and
      // the terminal are never auto-translated, so their mutations must not even cost
      // us a scheduled frame. This is the bulk of the traffic while streaming.
      const target = m.target && m.target.nodeType === 1
        ? m.target
        : m.target && m.target.parentElement;
      if (!target || shouldSkipAutoI18n(target)) continue;
      if (m.type === "attributes") { scheduleAutoI18n(target); continue; }
      if (m.type !== "childList" || !m.addedNodes.length) continue;
      for (const added of m.addedNodes) {
        if (added.nodeType === 1) scheduleAutoI18n(added);
        else if (added.nodeType === 3) scheduleAutoI18n(target);
      }
    }
  });
  localeObserver.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["title", "aria-label", "placeholder", "data-placeholder"],
  });
}

const I18N_MARKER_SELECTOR =
  "[data-i18n],[data-i18n-placeholder],[data-i18n-title],[data-i18n-aria-label]";

/// Apply the explicit `data-i18n*` markers on one element.
function applyI18nMarkers(el) {
  const key = el.getAttribute("data-i18n");
  if (key) {
    const text = t(key);
    if (el.textContent !== text) el.textContent = text;
  }
  const phKey = el.getAttribute("data-i18n-placeholder");
  if (phKey) {
    const text = t(phKey);
    if (el.placeholder !== text) el.placeholder = text;
    if (el.hasAttribute("data-placeholder") && el.getAttribute("data-placeholder") !== text) {
      el.setAttribute("data-placeholder", text);
    }
  }
  const titleKey = el.getAttribute("data-i18n-title");
  if (titleKey) {
    const text = t(titleKey);
    if (el.title !== text) el.title = text;
  }
  const ariaKey = el.getAttribute("data-i18n-aria-label");
  if (ariaKey) {
    const text = t(ariaKey);
    if (el.getAttribute("aria-label") !== text) el.setAttribute("aria-label", text);
  }
}

export function applyToDOM(root) {
  if (typeof document === "undefined") return;
  const container = root && root.nodeType ? root : document;
  applyingLocale = true;
  try {
    // One combined query instead of four separate document-wide sweeps, and the
    // container itself is included: `querySelectorAll` only returns descendants, so a
    // freshly inserted element carrying its own `data-i18n` was previously skipped
    // whenever a subtree (rather than the document) was passed in.
    if (container.nodeType === 1 && container.matches?.(I18N_MARKER_SELECTOR)) {
      applyI18nMarkers(container);
    }
    for (const el of container.querySelectorAll(I18N_MARKER_SELECTOR)) applyI18nMarkers(el);
    localizeTextIn(container);
  } finally {
    applyingLocale = false;
  }
}

export function initLocale() {
  const saved = localStorage.getItem("michael-ide-locale");
  currentLocale = coerceSupportedLocale(saved || systemPreferredLocale());
  if (saved !== currentLocale) {
    try { localStorage.setItem("michael-ide-locale", currentLocale); } catch {}
  }
  try {
    for (const tag of ["zh-CN", "ja", "ko", "de", "es", "pt", "ru"]) {
      localStorage.removeItem(`michael-ide.i18n-pack.${tag}.v1`);
      localStorage.removeItem(`michael-ide.i18n-pack.${tag}.v2`);
      localStorage.removeItem(`michael-ide.i18n-adhoc.${tag}.v3`);
      localStorage.removeItem(`michael-ide.i18n-adhoc.${tag}.v4`);
      localStorage.removeItem(`michael-ide.i18n-adhoc.${tag}.v5`); // poisoned: hallucinated model-id "translations"
    }
  } catch {}
  try { document.documentElement.lang = currentLocale; } catch {}
  applyToDOM();
  installLocaleObserver();
  ensureLocalePack(currentLocale).then((loaded) => {
    if (loaded) notifyLocaleListeners(currentLocale);
  });
}
