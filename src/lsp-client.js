// Mr. Day One — real Language Server Protocol client.
//
// The Rust backend (`lsp.rs`) only handles process spawning and Content-Length
// framing: it forwards each decoded LSP message to the frontend as a clean JSON
// string and writes whatever JSON we hand back. This module is the actual LSP
// *client*: it performs the initialize handshake, mirrors document lifecycle
// (didOpen/didChange/didSave/didClose), turns `publishDiagnostics` into Monaco
// markers, and registers Monaco language-feature providers (completion, hover,
// definition, references, rename, document symbols, signature help, formatting,
// code actions) that proxy to the running servers.
//
// Monaco already ships an excellent built-in language service for
// TS/JS/JSON/CSS/HTML, so this client targets the "gap" languages that have no
// in-browser intelligence (Rust, Python, Go, C/C++) and any custom server the
// user starts manually.
import * as monaco from "monaco-editor";

// Languages we auto-start + wire Monaco providers for. Monaco's bundled service
// covers ts/js/json/css/html, so we deliberately leave those to Monaco to avoid
// duplicate completions and diagnostics.
const MANAGED_LANGS = [
  "rust", "python", "go", "c", "cpp", "objective-c",
  "java", "ruby", "php", "lua", "shell", "yaml", "csharp", "kotlin", "swift",
  "dart", "elixir", "clojure", "scala", "hcl", "graphql", "dockerfile", "vue",
];

// Monaco language id -> the `lang` key the backend's KNOWN_SERVERS table uses.
const SERVER_LANG = {
  rust: "rust",
  python: "python",
  go: "go",
  c: "c",
  cpp: "cpp",
  typescript: "typescript",
  javascript: "javascript",
  html: "html",
  css: "css",
  json: "json",
};

// Monaco language id -> the `languageId` reported in textDocument items. Most
// match 1:1; this exists for the few that differ.
const DOC_LANGUAGE_ID = {
  rust: "rust",
  python: "python",
  go: "go",
  c: "c",
  cpp: "cpp",
  typescript: "typescript",
  javascript: "javascript",
  // bash-language-server identifies documents as "shellscript", not "shell".
  shell: "shellscript",
};

// LSP SymbolKind (1..26) -> short display name, for the agent's outline tool.
const LSP_SYMBOL_KIND_NAMES = {
  1: "file", 2: "module", 3: "namespace", 4: "package", 5: "class", 6: "method",
  7: "property", 8: "field", 9: "constructor", 10: "enum", 11: "interface",
  12: "function", 13: "variable", 14: "constant", 15: "string", 16: "number",
  17: "boolean", 18: "array", 19: "object", 20: "key", 21: "null",
  22: "enum-member", 23: "struct", 24: "event", 25: "operator", 26: "type-param",
};

const Sev = monaco.MarkerSeverity;
const LSP_TO_SEVERITY = { 1: Sev.Error, 2: Sev.Warning, 3: Sev.Info, 4: Sev.Hint };

const CK = monaco.languages.CompletionItemKind;
const LSP_TO_COMPLETION_KIND = {
  1: CK.Text, 2: CK.Method, 3: CK.Function, 4: CK.Constructor, 5: CK.Field,
  6: CK.Variable, 7: CK.Class, 8: CK.Interface, 9: CK.Module, 10: CK.Property,
  11: CK.Unit, 12: CK.Value, 13: CK.Enum, 14: CK.Keyword, 15: CK.Snippet,
  16: CK.Color, 17: CK.File, 18: CK.Reference, 19: CK.Folder, 20: CK.EnumMember,
  21: CK.Constant, 22: CK.Struct, 23: CK.Event, 24: CK.Operator, 25: CK.TypeParameter,
};

const REQUEST_TIMEOUT_MS = 20000;

const PYTHON_SETTINGS = {
  pythonPath: "python3",
  analysis: {
    autoSearchPaths: true,
    diagnosticMode: "openFilesOnly",
    typeCheckingMode: "standard",
    useLibraryCodeForTypes: true,
    autoImportCompletions: true,
    extraPaths: [],
  },
};


// ---- coordinate conversions (LSP is 0-based, Monaco is 1-based) ----
function toMonacoPosition(p) {
  return { lineNumber: (p.line ?? 0) + 1, column: (p.character ?? 0) + 1 };
}
function toMonacoRange(r) {
  if (!r) return undefined;
  return {
    startLineNumber: (r.start.line ?? 0) + 1,
    startColumn: (r.start.character ?? 0) + 1,
    endLineNumber: (r.end.line ?? 0) + 1,
    endColumn: (r.end.character ?? 0) + 1,
  };
}
function fromMonacoPosition(pos) {
  return { line: pos.lineNumber - 1, character: pos.column - 1 };
}
function pathToUri(path) {
  return monaco.Uri.file(path).toString();
}
function baseName(p) {
  return p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || p;
}

function lspMarkupToString(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (typeof content.value === "string") {
    // MarkedString { language, value } -> fenced code block.
    if (content.language) return "```" + content.language + "\n" + content.value + "\n```";
    return content.value;
  }
  return "";
}

function hoverContentsToMarkdown(contents) {
  const list = Array.isArray(contents) ? contents : [contents];
  return list
    .map(lspMarkupToString)
    .filter(Boolean)
    .map((value) => ({ value, isTrusted: false }));
}

function completionDocsToMonaco(doc) {
  if (doc == null) return undefined;
  if (typeof doc === "string") return doc;
  if (typeof doc.value === "string") return { value: doc.value };
  return undefined;
}

// ---- a single language server connection ----
class LspClient {
  constructor(lang, manager) {
    this.lang = lang;
    this.manager = manager;
    this.serverLang = SERVER_LANG[lang] || lang;
    this.nextId = 1;
    this.pending = new Map();
    this.capabilities = {};
    this.initialized = false;
    this.initPromise = null;
    this.openDocs = new Map(); // uri -> version
    this.disposed = false;
    this.logLines = [];
  }

  log(line) {
    this.logLines.push(line);
    if (this.logLines.length > 400) this.logLines.shift();
    this.manager.onLog?.(this.lang, line);
  }

  async start(custom) {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._startInner(custom);
    return this.initPromise;
  }

  async _startInner(custom) {
    const config = {
      lang: this.serverLang,
      command: custom?.command || "",
      args: custom?.args || [],
      rootUri: this.manager.primaryRootUri() || "",
      // 只有已信任的工作区才允许用它自带的语言服务器二进制（node_modules/.bin、
      // .venv/bin）。用项目自己的 TypeScript 版本是真实功能，但它同时意味着"打开一个
      // 仓库的 .ts 文件 = 执行那个仓库带的可执行文件"。未信任时降级到系统安装的服务器。
      trustWorkspaceBinaries: this.manager.isWorkspaceTrusted() === true,
    };
    try {
      await this.manager.backend.lspStart(config, (ev) => this._onEvent(ev));
    } catch (e) {
      this.initPromise = null;
      throw e;
    }
    await this._initialize();
    return this;
  }

  _onEvent(ev) {
    if (this.disposed) return;
    switch (ev?.kind) {
      case "message":
        this._onMessage(ev.data);
        break;
      case "started":
        this.log(`[started] ${ev.lang}`);
        break;
      case "error":
        this.log(`[error] ${ev.message}`);
        break;
      case "stopped": {
        // 后端会把进程死前的最后几行 stderr 一起带上来。没有它，用户看到的就是一句
        // 光秃秃的「已停止」，而真正的原因（找不到 JDK、node 版本太老、缺依赖）被丢掉。
        const tail = Array.isArray(ev.tail) ? ev.tail.filter(Boolean) : [];
        this.log(`[stopped] ${ev.lang}`);
        for (const line of tail) this.log(`[stopped:stderr] ${line}`);
        this.manager._handleStopped(this.lang, this, tail);
        break;
      }
      default:
        break;
    }
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // Response to one of our requests.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        // 服务器回 error 走 reject 那条：不这么分，"服务器明确拒绝"就和"服务器说没有"
        // 挤成同一个 null，调用方再也分不开（reject 只到 requestDetailed 为止，
        // request() 照旧 resolve(null)，对外契约没变）。
        if (msg.error) { if (pending.reject) pending.reject(msg.error); else pending.resolve(null); }
        else pending.resolve(msg.result);
      }
      return;
    }
    // Server -> client request (needs a reply).
    if (msg.method && msg.id !== undefined) {
      this._handleServerRequest(msg);
      return;
    }
    // Notification.
    if (msg.method) this._handleNotification(msg);
  }

  _handleServerRequest(msg) {
    const reply = (result) => this._respond(msg.id, result);
    switch (msg.method) {
      case "workspace/configuration": {
        const items = msg.params?.items || [];
        reply(items.map((item) => this._getConfigForSection(item.section)));
        break;
      }
      case "workspace/applyEdit": {
        // applyWorkspaceEdit 现在是 async（它可能要先从磁盘把缺的 model 建出来）。
        // 不 await 的话 reply 收到的是一个 Promise 对象——恒真，于是无论成败都告诉服务器
        // "已应用"，服务器据此认为重构完成了。
        this.manager
          .applyWorkspaceEdit(msg.params?.edit)
          .then((ok) => reply({ applied: !!ok }))
          .catch((e) => reply({ applied: false, failureReason: String(e?.message || e) }));
        break;
      }
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/workDoneProgress/create":
      case "workspace/semanticTokens/refresh":
      case "workspace/codeLens/refresh":
      case "workspace/inlayHint/refresh":
      case "workspace/diagnostic/refresh":
        reply(null);
        break;
      default:
        // Be lenient: reply null so servers never hang waiting on us.
        reply(null);
        break;
    }
  }

  _handleNotification(msg) {
    switch (msg.method) {
      case "textDocument/publishDiagnostics":
        this.manager.applyDiagnostics(this.lang, msg.params);
        break;
      case "window/logMessage":
      case "window/showMessage":
        if (msg.params?.message) this.log(`[srv] ${msg.params.message}`);
        break;
      default:
        break;
    }
  }

  _send(method, params) {
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
    return this.manager.backend.lspSend(this.serverLang, payload).catch(() => {});
  }

  _respond(id, result) {
    const payload = JSON.stringify({ jsonrpc: "2.0", id, result });
    return this.manager.backend.lspSend(this.serverLang, payload).catch(() => {});
  }

  /*
   * 一次请求的**完整**结果：{ ok, result, reason, detail }。
   *
   * request() 只回 result，于是 null 有四种来源——超时、发送失败、服务器回 error、
   * 以及服务器真的答了 null（"这里没有定义"是一个合法结论）。调用方分不出"没有"和
   * "没查成"，就会把后者说成前者。已经出过事的那条：agent 问"谁调用了这个函数"，
   * 语言服务超时 → 回 [] → 模型读成"没人调用"→ 删掉。
   *
   * 所以判别放在这一层，只有一份实现；request() 就是它丢掉 reason 的那个薄封装
   * （**不改 request 的行为**：全仓 36 处 await 依赖它 resolve(null)，改成 reject
   * 会复现"initialize 超时 → capabilities={} 却 initialized=true"那个老 bug）。
   */
  requestDetailed(method, params, opts) {
    const id = this.nextId++;
    const timeoutMs = (opts && opts.timeoutMs) || REQUEST_TIMEOUT_MS;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve) => {
      const settle = (v) => { this.pending.delete(id); resolve(v); };
      const timer = setTimeout(() => {
        settle({ ok: false, result: null, reason: "timeout", detail: `${method} 等了 ${Math.round(timeoutMs / 1000)}s 没有回应` });
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (result) => { clearTimeout(timer); settle({ ok: true, result, reason: "", detail: "" }); },
        reject: (err) => {
          clearTimeout(timer);
          const text = err && (err.message || err.code !== undefined)
            ? `${err.message || "server error"}${err.code !== undefined ? ` (code ${err.code})` : ""}`
            : "server error";
          settle({ ok: false, result: null, reason: "error", detail: `${method} 被服务器拒绝：${text}` });
        },
        timer,
      });
      this.manager.backend.lspSend(this.serverLang, payload).catch((e) => {
        if (!this.pending.has(id)) return;
        clearTimeout(timer);
        settle({ ok: false, result: null, reason: "transport", detail: `${method} 没能送到语言服务器：${String(e && e.message ? e.message : e).slice(0, 120)}` });
      });
    });
  }

  request(method, params, opts) {
    return this.requestDetailed(method, params, opts).then((r) => (r.ok ? r.result : null));
  }

  async _initialize() {
    const roots = this.manager.workspaceRoots();
    const primary = roots[0] || null;
    const params = {
      processId: null,
      clientInfo: { name: "Mr. Day One", version: "0.1.0" },
      locale: "en",
      rootUri: primary ? pathToUri(primary) : null,
      rootPath: primary || null,
      workspaceFolders: roots.length
        ? roots.map((r) => ({ uri: pathToUri(r), name: baseName(r) }))
        : null,
      capabilities: clientCapabilities(),
      initializationOptions: this._getInitOptions(),
    };
    // gopls/pyright can take much longer than the default 20s to answer `initialize` on a cold or
    // large workspace (module download, indexing). If we let it time out and resolve null, we would
    // set capabilities={} yet initialized=true → supports("completion") is poisoned false forever for
    // that server (the "only ONE lsp loads / no autocomplete" bug). So: give initialize a generous
    // timeout, and if it still fails, throw WITHOUT marking initialized — ensureServer's catch drops
    // the client so the next open retries against a now-warmer server.
    const result = await this.request("initialize", params, { timeoutMs: 120000 });
    if (!result || !result.capabilities) {
      this.initialized = false;
      throw new Error(`LSP initialize failed/timed out: ${this.lang}`);
    }
    this.capabilities = result.capabilities;
    this._send("initialized", {});
    this._send("workspace/didChangeConfiguration", {
      settings: this._getLangSettings(),
    });
    this.initialized = true;
    this.manager.onStatus?.();
    this.log("[initialized]");
    return this;
  }

  _getInitOptions() {
    if (this.serverLang === "python") {
      return this.manager._pythonSettings || {};
    }
    // Volar 2.x 自己不带 TypeScript：拿不到 tsdk 它就只能做模板那一半，
    // <script setup> 里的补全/悬停/跳转/类型诊断全部没有——而它不会报错，
    // 表现是「模板里还行、脚本里什么都没有」，用户会描述成时好时坏。
    if (this.serverLang === "vue") {
      const tsdk = this.manager._vueTsdk;
      return tsdk ? { typescript: { tsdk } } : {};
    }
    return {};
  }

  _getLangSettings() {
    if (this.serverLang === "python") {
      return { python: this.manager._pythonSettings || {} };
    }
    return {};
  }

  _getConfigForSection(section) {
    if (this.serverLang === "python") {
      const pythonSettings = this.manager._pythonSettings || {};
      if (!section || section === "python") return pythonSettings;
      if (section === "python.analysis") return pythonSettings.analysis || {};
      const parts = section.split(".");
      let obj = pythonSettings;
      for (const part of parts.slice(parts[0] === "python" ? 1 : 0)) {
        obj = obj?.[part];
        if (obj === undefined) return {};
      }
      return obj ?? {};
    }
    return {};
  }

  supports(name) {
    const c = this.capabilities || {};
    switch (name) {
      case "completion": return !!c.completionProvider;
      case "hover": return !!c.hoverProvider;
      case "definition": return !!c.definitionProvider;
      case "references": return !!c.referencesProvider;
      case "rename": return !!c.renameProvider;
      case "documentSymbol": return !!c.documentSymbolProvider;
      case "signatureHelp": return !!c.signatureHelpProvider;
      case "formatting": return !!c.documentFormattingProvider;
      case "codeAction": return !!c.codeActionProvider;
      case "resolveCompletion": return !!(c.completionProvider && c.completionProvider.resolveProvider);
      case "inlayHint": return !!c.inlayHintProvider;
      case "semanticTokens": return !!(c.semanticTokensProvider);
      case "implementation": return !!c.implementationProvider;
      case "typeDefinition": return !!c.typeDefinitionProvider;
      case "declaration": return !!c.declarationProvider;
      case "callHierarchy": return !!c.callHierarchyProvider;
      case "codeLens": return !!c.codeLensProvider;
      case "documentHighlight": return !!c.documentHighlightProvider;
      case "colorProvider": return !!c.colorProvider;
      case "linkedEditingRange": return !!c.linkedEditingRangeProvider;
      case "foldingRange": return !!c.foldingRangeProvider;
      case "onTypeFormatting": return !!c.documentOnTypeFormattingProvider;
      case "rangeFormatting": return !!c.documentRangeFormattingProvider;
      case "selectionRange": return !!c.selectionRangeProvider;
      case "documentLink": return !!c.documentLinkProvider;
      case "workspaceSymbol": return !!c.workspaceSymbolProvider;
      default: return false;
    }
  }

  completionTriggerCharacters() {
    return this.capabilities?.completionProvider?.triggerCharacters || [];
  }
  signatureTriggerCharacters() {
    return this.capabilities?.signatureHelpProvider?.triggerCharacters || [];
  }

  didOpen(uri, languageId, version, text) {
    if (this.openDocs.has(uri)) return;
    this.openDocs.set(uri, version);
    this._send("textDocument/didOpen", {
      textDocument: { uri, languageId, version, text },
    });
  }

  didChange(uri, version, text) {
    if (!this.openDocs.has(uri)) return;
    this.openDocs.set(uri, version);
    this._send("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  didSave(uri, text) {
    if (!this.openDocs.has(uri)) return;
    this._send("textDocument/didSave", {
      textDocument: { uri },
      text,
    });
  }

  didClose(uri) {
    if (!this.openDocs.has(uri)) return;
    this.openDocs.delete(uri);
    this._send("textDocument/didClose", { textDocument: { uri } });
  }

  shutdown() {
    this.disposed = true;
    // 服务器没了，这些请求就是**没答上来**，不是"答了没有"。走 reject 那条路，
    // 调用方才不会把一次进程退出说成"这个符号没有引用"。
    for (const { timer, resolve, reject } of this.pending.values()) {
      clearTimeout(timer);
      if (reject) reject({ message: "语言服务器已停止", code: -32003 });
      else resolve(null);
    }
    this.pending.clear();
  }
}

function clientCapabilities() {
  return {
    textDocument: {
      synchronization: { dynamicRegistration: false, willSave: false, didSave: true },
      completion: {
        dynamicRegistration: false,
        contextSupport: true,
        completionItem: {
          snippetSupport: true,
          commitCharactersSupport: false,
          documentationFormat: ["markdown", "plaintext"],
          deprecatedSupport: true,
          preselectSupport: true,
          insertReplaceSupport: true,
          resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
        },
        completionItemKind: { valueSet: Array.from({ length: 25 }, (_, i) => i + 1) },
      },
      hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
      signatureHelp: {
        dynamicRegistration: false,
        signatureInformation: {
          documentationFormat: ["markdown", "plaintext"],
          parameterInformation: { labelOffsetSupport: true },
          activeParameterSupport: true,
        },
      },
      definition: { dynamicRegistration: false, linkSupport: true },
      declaration: { dynamicRegistration: false, linkSupport: true },
      implementation: { dynamicRegistration: false, linkSupport: true },
      typeDefinition: { dynamicRegistration: false, linkSupport: true },
      references: { dynamicRegistration: false },
      callHierarchy: { dynamicRegistration: false },
      codeLens: { dynamicRegistration: false },
      documentHighlight: { dynamicRegistration: false },
      colorProvider: { dynamicRegistration: false },
      linkedEditingRange: { dynamicRegistration: false },
      foldingRange: { dynamicRegistration: false, foldingRangeKind: { valueSet: ["comment", "imports", "region"] }, lineFoldingOnly: true },
      onTypeFormatting: { dynamicRegistration: false },
      rangeFormatting: { dynamicRegistration: false },
      selectionRange: { dynamicRegistration: false },
      documentLink: { dynamicRegistration: false, tooltipSupport: true },
      documentSymbol: {
        dynamicRegistration: false,
        hierarchicalDocumentSymbolSupport: true,
        symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) },
      },
      formatting: { dynamicRegistration: false },
      rename: { dynamicRegistration: false, prepareSupport: false },
      publishDiagnostics: { relatedInformation: true, versionSupport: true },
      codeAction: {
        dynamicRegistration: false,
        codeActionLiteralSupport: {
          codeActionKind: {
            valueSet: ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports"],
          },
        },
        isPreferredSupport: true,
        resolveSupport: { properties: ["edit"] },
      },
      inlayHint: {
        dynamicRegistration: false,
        resolveSupport: { properties: ["tooltip", "textEdits", "label.tooltip", "label.location", "label.command"] },
      },
      semanticTokens: {
        dynamicRegistration: false,
        tokenTypes: [
          "namespace","type","class","enum","interface","struct","typeParameter",
          "parameter","variable","property","enumMember","event","function",
          "method","macro","keyword","modifier","comment","string","number",
          "regexp","operator","decorator",
        ],
        tokenModifiers: [
          "declaration","definition","readonly","static","deprecated",
          "abstract","async","modification","documentation","defaultLibrary",
        ],
        formats: ["relative"],
        requests: { full: { delta: false }, range: false },
        multilineTokenSupport: false,
        overlappingTokenSupport: false,
      },
    },
    workspace: {
      applyEdit: true,
      configuration: true,
      workspaceFolders: true,
      didChangeConfiguration: { dynamicRegistration: true },
      didChangeWatchedFiles: { dynamicRegistration: false },
      symbol: { dynamicRegistration: false },
      executeCommand: { dynamicRegistration: false },
    },
    window: { workDoneProgress: true, showMessage: {}, showDocument: { support: false } },
  };
}

// The "缺少 X 语言服务器" install prompt is bounded per language (see _LSP_MAX_PROMPTS) — never
// nag on every file-open. Counted across sessions.
//
// **这句以前写着「用户仍然可以从『语言服务』面板安装任何服务器」——那个面板 2026-08-13
// 已经整组下掉了**（renderLspTool 现在零调用点，状态栏的 LSP 指示器也不可点）。
// 留着这句比没有注释更糟：它让人以为「装不上还有别的入口」，于是没人去管这条提示
// 用光之后会发生什么。事实是这条通知**就是唯一的入口**，所以它必须允许重试。
/*
 * 安装提示的记账。**从「一辈子一次」改成「最多三次」（2026-08-25）。**
 *
 * 原来是一次：`_lspMarkPrompted` 在 `showNotification` **之前**调，也就是在用户看没看见、
 * 安装成没成之前就记账了。于是三种情况都会把这门语言的一键入口永久烧掉：
 * 用户没看见（提示只挂 20 秒）、点了安装但命令是死的（mac 表里实测有两条）、
 * 或者 brew/pip/winget 因别的原因失败。而注释里承诺的兜底「语言服务面板」已经是死代码。
 *
 * 为什么不做成「成功才记账」：这条通知是发完就不管的，没有成功/忽略的回调，
 * 要接就得把结果从 main.js 的安装进度卡一路传回来。有界重试用一个计数器就能修掉
 * 「错过一次就永远没有」，又不会每次打开文件都烦人——先把病治了，回调那条以后再说。
 *
 * 键名换成 v2：旧键存的是「提示过」的语言名数组，语义变成计数之后必须让它整体失效，
 * 否则老用户的旧记录会被读成计数 0 → 又回到一辈子一次。
 */
const _LSP_DISMISS_KEY = "lsp_install_prompted_v2";
const _LSP_MAX_PROMPTS = 3;
function _lspPromptCounts() {
  try {
    const raw = JSON.parse(localStorage.getItem(_LSP_DISMISS_KEY) || "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}
function _lspAlreadyPrompted(langId) {
  return (Number(_lspPromptCounts()[langId]) || 0) >= _LSP_MAX_PROMPTS;
}
function _lspMarkPrompted(langId) {
  try {
    const counts = _lspPromptCounts();
    counts[langId] = (Number(counts[langId]) || 0) + 1;
    localStorage.setItem(_LSP_DISMISS_KEY, JSON.stringify(counts));
  } catch {}
}

/// 当前是不是 Windows。安装命令、以及"装好了没"的探测方式都得按这个分。
function isWindows() {
  try {
    const nav = typeof navigator !== "undefined" ? navigator : null;
    return /Win/i.test(nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || "");
  } catch { return false; }
}

export function createLspManager(options) {
  const {
    /// 把一批英文文档翻成用户选的语言（i18n 的 translateNow）。**必须注入**：
    /// lsp-client 是 node --test 直接加载的模块，静态 import i18n 会把整套 DOM/网络
    /// 依赖一起拖进来，测试当场加载不了。没注入就不翻，悬浮说明照旧出英文。
    translateDoc,
    backend,
    enabled = true,
    getWorkspaceRoots = () => [],
    showToast = () => {},
    showNotification = null,
    onLog = null,
    onStatus = null,
    // 当前工作区是否已信任。决定语言服务器能否使用**仓库自带**的二进制
    // （node_modules/.bin、.venv/bin）。缺省不信任 —— fail closed。
    isWorkspaceTrusted = () => false,
  } = options;

  const clients = new Map(); // monaco lang id -> LspClient
  const changeTimers = new Map(); // uri -> { timer, langId, modelUri }
  // URIs of models we created purely for cross-file diagnostics (the file is not open
  // in the editor). Insertion-ordered, so the oldest is the first key.
  const lazyModels = new Set();
  /// 这些 model 最多留几个。
  ///
  /// 之前只有「size > 150 就不再创建」这一道闸——它挡住的是新增，**已有的 150 个从不
  /// dispose**。每个 model 都带全文、行结构和 tokenization 缓存，JS/TS 还会因
  /// setEagerModelSync 整份进 TypeScript worker 参与全量语义分析。
  const LAZY_MODEL_CAP = 150;

  /// 丢弃最旧的、当前没有被任何编辑器使用的惰性 model。
  ///
  /// `isAttachedToEditor()` 是关键：用户后来手动打开了这个文件时，Monaco 复用的就是
  /// 同一个 model，这时候 dispose 会直接把他正在看的编辑器搞坏。
  function evictLazyModels() {
    for (const uri of [...lazyModels]) {
      if (lazyModels.size <= LAZY_MODEL_CAP) break;
      lazyModels.delete(uri);
      try {
        const m = monaco.editor.getModel(monaco.Uri.parse(uri));
        if (m && !m.isAttachedToEditor?.()) {
          // 先告诉服务器这个文档关了。不关的话它侧的句柄永远不释放（跨文件诊断会给
          // 一堆没打开的文件建惰性 model，几十个之后是实打实的内存），而且下次同名
          // didOpen 会因为 openDocs 里已经有它而被当成 no-op。
          try { clients.get(lspLangOf(m))?.didClose(uri); } catch { /* 服务器没了就算了 */ }
          m.dispose();
        }
      } catch { /* 已经没了就算了 */ }
    }
  }
  let executeCommandRegistered = false;

  const manager = {
    backend,
    onLog,
    onStatus,
    // LspClient._startInner 里用 this.manager.isWorkspaceTrusted() 决定
    // trustWorkspaceBinaries——必须挂在这个内部 manager 上，不能只挂公开返回面。
    isWorkspaceTrusted,
    workspaceRoots,
    primaryRootUri,
    applyDiagnostics,
    applyWorkspaceEdit,
    _handleStopped,
    _pythonSettings: null,
  };

  function workspaceRoots() {
    const roots = getWorkspaceRoots() || [];
    return Array.isArray(roots) ? roots.filter(Boolean) : [];
  }
  function primaryRootUri() {
    const r = workspaceRoots()[0];
    return r ? pathToUri(r) : "";
  }

  // langId -> 上一次非预期停止的原因（stderr 最后一行看着像错误的那句）。
  const lastStopReason = new Map();

  function isManaged(langId) {
    return MANAGED_LANGS.includes(langId);
  }

  /*
   * 这个 model 该交给哪个语言服务器。
   *
   * 多数时候就是 Monaco 的 languageId，但 `.vue` 是个例外：客户端把它映射成 html
   * （extLang 里写死的），于是 Monaco 里**根本不存在 "vue" 这个 languageId**——后端
   * KNOWN_SERVERS 里那条 vue-language-server 登记项从来没有机会被启动过，整条链不可达。
   *
   * 不改那个映射是有意的：改了，.vue 就失去 HTML 的高亮和 html worker，而没装
   * vue-language-server 的用户会**倒退**。所以只在 LSP 这一层按扩展名认它——高亮照旧，
   * 装了 vue 服务器的人多拿到补全/跳转/诊断，没装的人和以前一模一样。
   */
  // 一份真相：扩展名 → { 交给哪个语言服务器, 它在 Monaco 里的 languageId }。
  // 下面两处都从这里推（路由、provider 选择器），不要再各维护一张表——这个仓库已经
  // 因为「手工维护的两份清单」栽过好几次。
  const _EXT_LSP_LANG = {
    vue: { lsp: "vue", monaco: "html" },
  };
  function lspLangOf(model, path = "") {
    const p = String(path || (model && model.uri ? model.uri.toString() : ""));
    const ext = (p.split(/[?#]/)[0].split(".").pop() || "").toLowerCase();
    const mapped = _EXT_LSP_LANG[ext];
    if (mapped) return mapped.lsp;
    return model && model.getLanguageId ? model.getLanguageId() : "";
  }

  function clientForModel(model) {
    if (!model) return null;
    return clients.get(lspLangOf(model)) || null;
  }

  /**
   * 语言服务器停了。`tail` 是它死前最后几行 stderr —— 停止**原因**。
   *
   * 只在**非预期**停止时告诉用户：手动 stop / 重启换服务器不该弹提示。判据是这个
   * 客户端还挂在 clients 上（stop() 会先摘掉它再关）。
   */
  function _handleStopped(langId, stoppedClient, tail = []) {
    const client = clients.get(langId);
    // The event belongs to the channel that emitted it. A final stopped event
    // from a manually replaced server must not remove the new client.
    if (!client || (stoppedClient && client !== stoppedClient)) return;
    /*
     * **没有 else 的话，一整类死法是零提示的。**
     *
     * 这里原来只在 tail 非空、且截得出非空 why 时才说一句。而实测常见的语言服务器里
     * 多数在死掉时 stderr 是**空的**——被 OOM kill、收到信号、干净退出、或者只往
     * stdout 写东西，四种死法一个字都不留。于是：markers 被清空、状态栏少一门语言、
     * clients 里的记录被删掉，界面上没有任何解释。
     *
     * 用户看到的是「写着写着红线和补全突然全没了」，然后下次打开同语言文件又会重启
     * 服务器（因为 clients 已删）——所以他的描述是「时好时坏」，而不是「坏了」。
     * lsp.rs 里为「说清死因」专门建的那条 stderr 转发通道，终点是一个没人渲染的 Map。
     *
     * 所以：有 stderr 就说 stderr，没有也要说「它死了、而且没留下任何原因」——
     * 后者本身就是有用的信息（它把「服务没起来」和「服务起来了又悄悄死了」分开了）。
     */
    let why = "";
    if (tail.length) {
      // 挑最能说明问题的一行：优先看着像错误的那句，没有就用最后一行。
      const bad = tail.filter((l) => /error|exception|fatal|panic|not found|cannot find|traceback/i.test(l));
      why = String(bad.length ? bad[bad.length - 1] : tail[tail.length - 1]).trim().slice(0, 180);
    }
    if (!why) {
      // 兜底文案要说清两件事：它确实死过（不是没起来），以及为什么这里给不出原因。
      why = "进程退出，没有留下任何错误输出（可能是被系统回收内存杀掉、或收到了退出信号）";
    }
    // 留给智能体：语言服务器死了之后，lsp_* 工具只会说「这个语言没有可用的服务」，
    // 不说为什么。存下来，工具回执里带上——模型才知道该去装什么、修什么。
    lastStopReason.set(langId, why);
    showToast(`${langId} 语言服务已停止：${why}`);
    client.shutdown();
    clients.delete(langId);
    // Drop any debounced didChange still queued for this language: firing it after
    // the server died would push a document version to a dead client (and, once a
    // fresh server starts, arrive out of order before its didOpen). refreshWorkspace
    // re-syncs full document state on reconnect, so nothing is lost by cancelling.
    for (const [uri, entry] of changeTimers) {
      if (entry.langId === langId) {
        clearTimeout(entry.timer);
        changeTimers.delete(uri);
      }
    }
    // Clear any markers owned by this server.
    for (const m of monaco.editor.getModels()) {
      monaco.editor.setModelMarkers(m, "lsp:" + langId, []);
    }
    onStatus?.();
  }

  async function ensureServer(langId, custom) {
    if (!enabled) return null;
    let client = clients.get(langId);
    if (client) {
      if (client.initPromise) {
        try { await client.initPromise; } catch { /* fall through */ }
      }
      return clients.get(langId) || null;
    }
    if (langId === "vue" && manager._vueTsdk === undefined) {
      /*
       * 用**项目自己的** typescript，不是全局那份。
       *
       * 理由和 lsp.rs 里「用项目自己的 TypeScript / pyright 版本是真实且必要的功能」
       * 那段一致：Vue 项目的类型来自它自己锁定的那个 TS 版本，全局那份多半对不上。
       * 探测方式取最便宜的一种——读一下 package.json 读得到就算有，不新增后端命令。
       * 探不到就留空串：Volar 会退回只做模板那一半（比崩掉好），而 _getInitOptions
       * 此时不发 typescript 字段，不去编一个不存在的路径。
       */
      manager._vueTsdk = "";
      const root = String(manager.workspaceRoots?.()[0] || "").replace(/\/+$/, "");
      if (root) {
        try {
          await backend.readTextFile(`${root}/node_modules/typescript/package.json`);
          manager._vueTsdk = `${root}/node_modules/typescript/lib`;
        } catch { /* 项目没装 typescript：留空，Volar 只做模板那一半 */ }
      }
    }
    if (langId === "python" && !manager._pythonSettings) {
      try {
        // Pass the workspace root so the backend prefers the project's .venv interpreter — pyright then
        // resolves the packages installed in the venv instead of flagging them "unresolved" on reopen.
        const info = await backend.lspDetectPython(manager.workspaceRoots?.()[0] || null);
        // 未信任的工作区会退回系统解释器（后端不去执行仓库自带的 .venv/bin/python）。
        // 说一句，否则用户对着满屏「import X could not be resolved」不知道为什么——
        // 而那恰恰是一个他一键就能解决的问题。
        if (info && info.untrustedFallback) {
          showToast("这个工作区还没信任，Python 用的是系统解释器——venv 里装的包解析不到。信任这个工作区就能用它自己的 venv。");
        }
        if (info && info.pythonPath) {
          manager._pythonSettings = {
            pythonPath: info.pythonPath,
            analysis: {
              ...PYTHON_SETTINGS.analysis,
              extraPaths: info.sitePackages || [],
            },
          };
        } else {
          manager._pythonSettings = PYTHON_SETTINGS;
        }
      } catch {
        manager._pythonSettings = PYTHON_SETTINGS;
      }
    }
    client = new LspClient(langId, manager);
    clients.set(langId, client);
    try {
      await client.start(custom);
      lastStopReason.delete(langId); // 起来了，别再拿上一次的死因解释这一次
      // No success toast. A language server starting is routine background plumbing the user
      // did not ask for and cannot act on, and it fires again for every language a project
      // touches. The status bar already shows which servers are live ("LSP: python, shell"),
      // which is the same information without interrupting. Failures below still toast —
      // those the user can act on.
      onStatus?.();
      return client;
    } catch (e) {
      if (clients.get(langId) === client) clients.delete(langId);
      const msg = String(e && e.message ? e.message : e);
      const alreadyRunning = /already running/i.test(msg);
      if (alreadyRunning) {
        /*
         * 「已经在跑了」几乎总是**后端那条记录成了孤儿**：读线程遇到一个非法帧退出、
         * 却没把自己从 map 里摘掉（lsp.rs 那边现在会摘了，这里是对老进程/竞态的兜底）。
         * 原来这条分支只写一行日志就静默 return —— 于是这门语言整个会话再也起不来，
         * 界面上一个字都没有。
         *
         * 先真的把它停掉，再重试一次。还是不行才认输，而且**说出来**。
         */
        onLog?.(`[lsp] ${langId}: ${msg}`);
        try { await backend.lspStop(SERVER_LANG[langId] || langId); } catch { /* 已经没了也算成功 */ }
        try {
          const retry = new LspClient(langId, manager);
          clients.set(langId, retry);
          await retry.start(custom);
          onStatus?.();
          return retry;
        } catch (e2) {
          // 这里不能用下面那张 names 表：它是同一个函数作用域里 const 声明的，声明点在
          // 这一行**之后**，读它是 TDZ 抛错（而且只在这条 catch 路径上炸，语法检查看不见）。
          clients.delete(langId);
          showToast(`${langId} 语言服务卡住了，已尝试重启但没起来：${String(e2 && e2.message ? e2.message : e2).slice(0, 120)}`);
          return null;
        }
      }
      /*
       * 安装命令按平台分。以前整张表是照 macOS 写的，Windows 上是三重失败：
       *
       *   1. 22 个语言里 11 个写的是 `brew install` —— Windows 上根本没有 brew，
       *      终端里蹦出一句「'brew' 不是内部或外部命令」。
       *   2. Pyright 那条的 `2>/dev/null` 在 cmd 里不是"丢弃错误输出"，是往
       *      `.\dev\null` 这个不存在的目录里写文件，于是重定向本身就失败。
       *   3. 命令是打进**交互终端**执行的，而 Windows 上那个终端是 cmd / PowerShell
       *      （terminal.rs 读 COMSPEC），不是 Git Bash——POSIX 写法一句都不成立。
       *
       * 所以：能跨平台的（pip / npm / go / gem / rustup / dotnet）两边共用一条；只在
       * 某个平台有包的，另一个平台**宁可不给命令**也不给一条注定失败的——给了就是让用户
       * 点一下、看它报错、再等 90 秒进度条转完告诉他"安装超时"。没有命令时通知里不带
       * 「安装」按钮，改成告诉他去哪儿装。
       */
      const CROSS = {
        // pip 装的 pyright 自带 node 运行时。不再用 `--user … || …` 那套：`--user` 在
        // 激活的 venv 里会被 pip 拒绝，原来的写法靠 POSIX 重定向吞掉报错再退回普通装，
        // 换个 shell 就不成立。直接普通装——有 venv 就落进 venv，没有就落进用户目录，
        // 两种情况 augmented PATH 都找得到。
        python: "pip install pyright",
        rust: "rustup component add rust-analyzer",
        go: "go install golang.org/x/tools/gopls@latest",
        ruby: "gem install solargraph",
        php: "npm i -g intelephense",
        shell: "npm i -g bash-language-server",
        yaml: "npm i -g yaml-language-server",
        graphql: "npm i -g graphql-language-service-cli",
        dockerfile: "npm i -g dockerfile-language-server-nodejs",
        /*
         * **钉在 2.x，不是 latest。** 这不是保守，是 3.x 在这个产品里结构上不可用：
         *
         * @vue/language-server 3.x 是 hybrid 模式——它自己不做 TypeScript 那一半，而是
         * 对每个 file: 请求先发一条 `tsserver/request` 通知，然后 await 一个只有客户端回
         * `tsserver/response` 才会兑现的 Promise（无超时、无降级）。VS Code 那边是把
         * @vue/typescript-plugin 塞进 tsserver 来应答的；本产品不跑 tsserver，也没有这条
         * 中继，于是补全/悬停/跳转/诊断/大纲**全部**永远挂着——而 initialize 是成功的、
         * capabilities 是齐的，状态栏一路绿灯。
         *
         * 更早一步还有一道坎：不钉 typescript 版本时 npm 会按 peer `"*"` 装进 TS 7，
         * 而 3.x 读 `ts.server` —— TS 7 的入口不导出它，第一个 didOpen 就抛异常退出。
         * 也就是说照原来这条命令装出来的组合是**必崩**的。
         *
         * 2.x 把 @vue/language-service 作为**依赖**带着，自己做 TS 那一半，是标准 LSP，
         * 只要给它 typescript.tsdk 就完整可用（见 _getInitOptions）。代价是钉死一个旧大版本。
         */
        vue: "npm i -g @vue/language-server@2",
      };
      const MAC_ONLY = {
        c: "brew install llvm",
        cpp: "brew install llvm",
        "objective-c": "brew install llvm",
        java: "brew install jdtls",
        lua: "brew install lua-language-server",
        // csharp 这条删了：`brew install omnisharp` 是**死命令**——formula 和 cask 都不存在
        // （实测 `brew info omnisharp` → No available formula）。给一条注定失败的命令，
        // 用户点一下、看它报错、再等 180 秒进度条转完才被告知"安装超时"，而 _lspMarkPrompted
        // 在弹窗那一刻就记过账了——这门语言的一键入口就此耗尽。宁可不给。
        // 要重新给命令，必须**同时**改 lsp.rs 里的二进制名和参数：下面 Windows 那段注释
        // 早就写明 NuGet 上的 csharp-ls 和本产品启动的 `omnisharp -lsp` 对不上。只改一处更糟。
        kotlin: "brew install kotlin-language-server",
        elixir: "brew install elixir-ls",
        clojure: "brew install clojure-lsp",
        // 原来是 `brew install coursier && cs install metals`——第二步的可执行文件不存在：
        // homebrew-core 的 coursier formula 产出的命令名叫 `coursier`，没有 `cs`（实测
        // `command -v cs` → not found）。而 homebrew-core **直接就有 metals**（实测 1.6.7），
        // 装完落进 /opt/homebrew/bin/metals，正是 lsp.rs 要找的那个名字。一步就中。
        scala: "brew install metals",
        hcl: "brew install hashicorp/tap/terraform-ls",
        // dart 原来一条都没有，于是落进"这个平台上它没有一键安装的包"那句——**在 mac 上是假话**
        // （实测 `brew info dart-sdk` → 3.13.1，bin 里符号链接出 `dart`，正是要启动的那个名字）。
        dart: "brew install dart-sdk",
      };
      // Windows 上只写有把握的：winget 里确实有 LLVM 这个包（clangd 在里面）。
      // 其余几个在 Windows 上只有 GitHub release 或多步安装，与其给一条会失败的命令，
      // 不如不给。
      const WIN_ONLY = {
        c: "winget install -e --id LLVM.LLVM",
        cpp: "winget install -e --id LLVM.LLVM",
        "objective-c": "winget install -e --id LLVM.LLVM",
        // 这两个的 winget 包 ID 是核实过的，而且装出来的可执行文件名正好是上面
        // SERVERS 表里要启动的那个（lua-language-server / terraform-ls）——包对不上
        // 二进制名的一律不加：装完照样报"缺少"，比不给命令更糟。
        lua: "winget install -e --id LuaLS.lua-language-server",
        hcl: "winget install -e --id Hashicorp.TerraformLanguageServer",
        // 这条符合上面那句"包对不上二进制名的一律不加"：Google.DartSDK 的
        // PortableCommandAlias 就是 `dart`，正是 lsp.rs 要启动的名字。
        dart: "winget install -e --id Google.DartSDK",
      };
      // 仍然没有 Windows 一键安装的：java(jdtls) / csharp / kotlin / elixir / clojure /
      // scala / swift。（这份名单以前漏了 swift 和 dart；dart 现在两个平台都有命令了，
      // swift 的 sourcekit-lsp 跟着 Xcode 走、也确实没有独立包。）
      // 原因各不相同，但都不是"懒得加"：
      //   · jdtls / kotlin / elixir  —— 只有 GitHub release 压缩包，装完还要自己配 PATH；
      //   · clojure-lsp             —— 要先 `scoop bucket add` 再装，两步且依赖 scoop；
      //   · scala(metals)           —— 要先装 coursier 再 `cs install metals`，同样两步；
      //   · csharp                  —— NuGet 上的 csharp-ls 装得上，但 IDE 启动的是
      //                                `omnisharp -lsp`，二进制名和参数都对不上，
      //                                给了它等于让用户装一个用不上的东西。
      // 这几个宁可不给命令：给一条注定失败的，用户点一下、看它报错、再等 90 秒
      // 进度条转完告诉他"安装超时"。
      const installHints = isWindows()
        ? { ...CROSS, ...WIN_ONLY }
        : { ...CROSS, ...MAC_ONLY };
      const names = {
        python: "Pyright", rust: "rust-analyzer", go: "gopls", c: "clangd", cpp: "clangd",
        "objective-c": "clangd", java: "jdtls", ruby: "Solargraph", php: "Intelephense",
        lua: "lua-language-server", shell: "bash-language-server", yaml: "yaml-language-server",
        csharp: "OmniSharp", kotlin: "kotlin-language-server", dart: "Dart LSP", swift: "SourceKit-LSP",
        elixir: "elixir-ls", clojure: "clojure-lsp", scala: "Metals", hcl: "terraform-ls",
        graphql: "GraphQL LSP", dockerfile: "Docker LS", vue: "Vue LS",
      };
      const hint = installHints[langId];
      let toolExists = false;
      try { toolExists = await backend.lspCheckAvailable(langId); } catch { /* ignore */ }
      if (!toolExists && showNotification && !_lspAlreadyPrompted(langId) && names[langId]) {
        _lspMarkPrompted(langId); // show at most ONCE ever — never nag again on later file-opens
        showNotification({
          title: `缺少 ${names[langId] || langId} 语言服务器`,
          message: hint
            ? `装了能获得智能补全 / 跳转定义（不装也能正常写代码、运行程序，不影响用）`
            : `这个平台上它没有一键安装的包，需要手动装 ${names[langId] || langId}（不装也能正常写代码、运行程序）`,
          actionLabel: hint ? "安装" : undefined,
          duration: 20000,
          installCmd: hint,
          // 装完之后靠它判断成没成——后端那个探测是跨平台的（Windows 上会扫
          // .exe/.cmd/.bat），比在前端拼一句 POSIX 命令可靠得多。
          langId,
        });
      } else if (toolExists) {
        showToast(`${names[langId] || langId} 启动失败: ${msg}`);
      } else {
        showToast(`LSP ${langId}: ${msg}`);
      }
      onLog?.(`[lsp] ${langId}: ${msg}`);
      return null;
    }
  }

  // ---- document lifecycle ----
  function didOpen(path, model) {
    if (!enabled || !model || typeof model.getLanguageId !== "function" || typeof model.getValue !== "function" || !model.uri) return;
    const langId = lspLangOf(model, path);
    if (!isManaged(langId)) return;
    const uri = model.uri.toString();
    const docLang = DOC_LANGUAGE_ID[langId] || langId;
    /*
     * 取样必须放在 await 之后，不能在这一行。
     *
     * ensureServer 里那次 initialize 对 gopls / pyright 是**几十秒**级别的（超时特意
     * 放宽到 120s）。原来 version/text 在这里同步取一次，然后等 initialize 完成才发出去
     * ——发的是「打开那一刻」的内容。而这几十秒里用户敲的每一个字，didChange 都在
     * `!client.initialized` 上早退（既不排队也不缓存）。于是 initialize 完成时，服务器
     * 拿到的是几十秒前的旧文本：红线整体偏移十几行，报的是已经不存在的问题，而且只有
     * 再敲一个字符才会自愈——用户停下来看错误列表的那一刻，看到的全是错的。
     */
    ensureServer(langId).then((client) => {
      if (!client) return;
      const live = monaco.editor.getModel(model.uri) || model;
      client.didOpen(uri, docLang, live.getVersionId(), live.getValue());
    });
  }

  function didChange(path, model) {
    if (!enabled || !model || typeof model.getLanguageId !== "function" || typeof model.getValue !== "function" || !model.uri) return;
    const langId = lspLangOf(model, path);
    if (!isManaged(langId)) return;
    const client = clients.get(langId);
    // 没有 client 才早退。**还没 initialized 不算没有**——原来这里一并早退，冷启动那
    // 几十秒里的编辑就此消失（既不排队也不缓存）。现在照常排进防抖队列：真要发的时候
    // 现取 live model 的最新全文，服务器那时也已经 initialize 完了。
    if (!client) return;
    const uri = model.uri.toString();
    const existing = changeTimers.get(uri);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(async () => {
      changeTimers.delete(uri);
      // 还在握手就等它落定再发；等不到（超时/失败）就不发，didOpen 那边会带上最新全文。
      if (!client.initialized && client.initPromise) {
        try { await client.initPromise; } catch { return; }
      }
      if (!client.initialized) return;
      const live = monaco.editor.getModel(model.uri);
      if (!live) return;
      // 服务器还没 didOpen 过这个文档时，didChange 在协议上就是空操作（LspClient 里也
      // 照着挡了）。重启窗口正是这种情况：client 在、文档句柄没了。这时要发的是
      // didOpen，否则这段编辑仍然落不到服务器手里，只是换了个地方丢。
      if (client.openDocs.has(uri)) client.didChange(uri, live.getVersionId(), live.getValue());
      else client.didOpen(uri, DOC_LANGUAGE_ID[langId] || langId, live.getVersionId(), live.getValue());
    }, 180);
    changeTimers.set(uri, { timer, langId, modelUri: model.uri });
  }

  function didSave(path, model) {
    if (!enabled || !model || typeof model.getLanguageId !== "function" || typeof model.getValue !== "function" || !model.uri) return;
    const langId = lspLangOf(model, path);
    if (!isManaged(langId)) return;
    const client = clients.get(langId);
    if (!client) return;
    client.didSave(model.uri.toString(), model.getValue());
  }

  function didClose(path) {
    if (!enabled || !path) return;
    const uri = pathToUri(path);
    for (const client of clients.values()) client.didClose(uri);
  }

  function flushPendingChange(uri) {
    const entry = changeTimers.get(uri);
    if (!entry) return;
    clearTimeout(entry.timer);
    changeTimers.delete(uri);
    const live = monaco.editor.getModel(entry.modelUri);
    if (!live) return;
    const client = clients.get(entry.langId);
    if (client && client.initialized) {
      client.didChange(uri, live.getVersionId(), live.getValue());
    }
  }

  function modelPath(model) {
    return String(model?.uri?.fsPath || model?.uri?.path || "");
  }

  function pathAtOrUnder(path, root) {
    const p = String(path || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const r = String(root || "").replace(/\\/g, "/").replace(/\/+$/, "");
    return !r || p === r || p.startsWith(r + "/");
  }

  function refreshWorkspace(root = "") {
    for (const [uri] of changeTimers) flushPendingChange(uri);
    for (const [langId, client] of clients.entries()) {
      for (const model of monaco.editor.getModels()) {
        if (!model || model.getLanguageId?.() !== langId || !pathAtOrUnder(modelPath(model), root)) continue;
        try { monaco.editor.setModelMarkers(model, "lsp:" + langId, []); } catch {}
        const uri = model.uri.toString();
        const docLang = DOC_LANGUAGE_ID[langId] || langId;
        if (client.initialized) {
          client.didOpen(uri, docLang, model.getVersionId(), model.getValue());
          client.didChange(uri, model.getVersionId(), model.getValue());
          client.didSave(uri, model.getValue());
        }
      }
      try {
        client._send("workspace/didChangeConfiguration", { settings: client._getLangSettings() });
        // 这里原来还发一条 `didChangeWatchedFiles { changes: [] }` —— 全仓唯一一处发送，
        // 而且 changes 恒为空，纯 no-op。真正的变更现在走 notifyWatchedFiles。
      } catch {}
    }
    onStatus?.();
  }

  /**
   * 把一批文件系统变更告诉所有活着的语言服务器。
   *
   * **这条通知不是可选的。** 语言服务器只从 didOpen 认得到「编辑器打开过的文件」；
   * 项目里被外部创建/删除的文件（智能体用 shell 生成、脚手架命令产出、依赖装完）
   * 它一无所知。pyright 尤其明显：它把 didOpen 的新模块加进 program，但**导入解析的
   * 目录缓存只认这条通知**——实测新建 b.py 之后，a.py 里那句
   * `Import "b" could not be resolved` 靠 didOpen / didChange / didSave 都消不掉，
   * 只发一条 didChangeWatchedFiles 就在 200ms 内清零。
   *
   * 那条假错误会进 markers、进每轮喂给模型的实时诊断块——模型据此反复重改同一行。
   *
   * 类型必须分对：多数服务器只在 Created/Deleted 时作废目录缓存，Changed 只标脏。
   * 而文件监视器分不出这三者（debouncer 只给 Any），所以后端顺手做了一次 exists 判断，
   * 把不存在的那些放在 missing 里传过来（见 watcher.rs）。存在的一律按 Created(1) 发：
   * 我们区分不了「新建」和「修改」，而 Created 才是触发缓存作废的那个类型——对一个
   * 只是被修改的文件发 Created，服务器重读一遍而已；反过来就是这条通知白发。
   */
  function notifyWatchedFiles(paths, missing = []) {
    const list = (paths || []).filter(Boolean);
    if (!list.length) return;
    const gone = new Set(missing || []);
    const changes = list.map((p) => ({ uri: pathToUri(p), type: gone.has(p) ? 3 : 1 }));
    for (const client of clients.values()) {
      if (!client?.initialized) continue;
      try { client._send("workspace/didChangeWatchedFiles", { changes }); } catch { /* 单个失败不影响其余 */ }
    }
  }

  // ---- diagnostics ----
  async function applyDiagnostics(langId, params) {
    if (!params?.uri) return;
    const uri = params.uri;
    let model = findModelByUri(uri);
    if (!model) {
      // Create a lightweight model so cross-file diagnostics still surface in
      // the Problems panel. Capped to avoid model explosion on huge outputs.
      const diags = params.diagnostics || [];
      if (!diags.length) return;
      model = await lazilyCreateModel(uri);
      if (!model) return;
    }
    if (changeTimers.has(uri)) {
      flushPendingChange(uri);
      return;
    }
    const incomingVersion = Number(params.version);
    const currentVersion = Number(model?.getVersionId?.());
    if (Number.isFinite(incomingVersion) && Number.isFinite(currentVersion) && incomingVersion < currentVersion) return;
    const owner = "lsp:" + langId;
    const markers = (params.diagnostics || []).map((d) => diagnosticToMarker(d));
    monaco.editor.setModelMarkers(model, owner, markers);
  }

  function diagnosticToMarker(d) {
    const r = toMonacoRange(d.range) || { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
    const related = (d.relatedInformation || []).map((ri) => ({
      resource: monaco.Uri.parse(ri.location.uri),
      message: ri.message,
      startLineNumber: (ri.location.range.start.line ?? 0) + 1,
      startColumn: (ri.location.range.start.character ?? 0) + 1,
      endLineNumber: (ri.location.range.end.line ?? 0) + 1,
      endColumn: (ri.location.range.end.character ?? 0) + 1,
    }));
    return {
      severity: LSP_TO_SEVERITY[d.severity] ?? Sev.Error,
      message: d.message || "",
      code: typeof d.code === "object" ? d.code?.value : d.code,
      source: d.source,
      startLineNumber: r.startLineNumber,
      startColumn: r.startColumn,
      endLineNumber: r.endLineNumber,
      endColumn: r.endColumn,
      relatedInformation: related.length ? related : undefined,
      tags: (d.tags || []).map((tg) => (tg === 1 ? monaco.MarkerTag.Unnecessary : monaco.MarkerTag.Deprecated)),
    };
  }

  function findModelByUri(uri) {
    const parsed = monaco.Uri.parse(uri);
    return monaco.editor.getModel(parsed) || monaco.editor.getModels().find((m) => m.uri.toString() === uri) || null;
  }

  async function lazilyCreateModel(uri) {
    try {
      const parsed = monaco.Uri.parse(uri);
      const path = parsed.fsPath;
      const content = await backend.readTextFile(path);
      let model = monaco.editor.getModel(parsed);
      if (!model) {
        model = monaco.editor.createModel(content ?? "", undefined, parsed);
        lazyModels.add(uri);
        evictLazyModels();
      } else if (lazyModels.has(uri) && !model.isAttachedToEditor?.() && model.getValue() !== content) {
        // 刚从磁盘读到的内容不能丢。
        //
        // 这份 model 是之前某次跨文件诊断建的惰性副本，之后智能体把文件改了——改动
        // 没经过编辑器，所以没人更新过它。原来这里直接 `return model`，于是
        // lsp_definition / lsp_hover / lsp_references 全部按**改前**的内容算行号。
        try { model.setValue(String(content ?? "")); } catch { /* 建不动就用旧的 */ }
      }
      return model;
    } catch {
      return null;
    }
  }

  // ---- agent navigation: ensure the right server is up and the doc is synced
  // before issuing an ad-hoc request for an arbitrary project file (which may not
  // be open in the editor). Returns null when no managed LSP applies (e.g. JS/TS,
  // which use Monaco's built-in worker, or a language with no installed server).
  async function _agentEnsureDoc(path) {
    if (!enabled || !path) return null;
    const model = await lazilyCreateModel(pathToUri(path));
    if (!model) return null;
    const langId = lspLangOf(model, path);
    if (!isManaged(langId)) return null;
    const client = await ensureServer(langId);
    if (!client || !client.initialized) return null;
    const uri = model.uri.toString();
    const docLang = DOC_LANGUAGE_ID[langId] || langId;
    // didOpen is idempotent (the client tracks openDocs) and ordered before our
    // request on the same stream, so the server has the doc when it answers.
    client.didOpen(uri, docLang, model.getVersionId(), model.getValue());
    return { uri, model, langId, client };
  }

  // ---- workspace edits (rename, code actions, server applyEdit) ----
  /**
   * 应用一份工作区编辑（服务器主动发来的 workspace/applyEdit、跨文件快速修复）。
   *
   * 以前遇到没有 model 的文件是 `continue` ——**静默跳过**。于是一次"自动补 import"或
   * "move to new file" 会只改一半：改到的文件变了，没打开的那个原样不动，而调用方拿到的
   * 返回值仍是 true。半应用的重构比完全失败更糟，因为没人知道它失败过。
   *
   * 现在先给每个目标文件把 model 建出来（lazilyCreateModel 会从磁盘读内容），建不出来的
   * 单独收集并如实报出去。落盘由 main.js 的后台持久化负责——那边监听 model 的内容变化。
   */
  async function applyWorkspaceEdit(edit) {
    if (!edit) return false;
    const byUri = new Map();
    if (edit.changes) {
      for (const [uri, edits] of Object.entries(edit.changes)) byUri.set(uri, edits);
    }
    if (Array.isArray(edit.documentChanges)) {
      for (const dc of edit.documentChanges) {
        if (dc.textDocument && dc.edits) byUri.set(dc.textDocument.uri, dc.edits);
      }
    }
    // 先解析出全部 model，再动手改。有一个建不出来就整笔不做——半应用的重构是最坏结果。
    const resolved = [];
    const missing = [];
    for (const [uri, edits] of byUri.entries()) {
      let model = findModelByUri(uri);
      if (!model) model = await lazilyCreateModel(uri);
      if (!model) { missing.push(uri); continue; }
      resolved.push([model, edits]);
    }
    if (missing.length) {
      console.warn("[lsp] workspace edit 放弃：这些文件建不出 model", missing);
      return false;
    }
    let applied = false;
    for (const [model, edits] of resolved) {
      const ops = edits.map((e) => ({
        range: toMonacoRange(e.range),
        text: e.newText,
        forceMoveMarkers: true,
      }));
      model.pushStackElement();
      model.pushEditOperations([], ops, () => null);
      model.pushStackElement();
      applied = true;
    }
    return applied;
  }

  function toMonacoWorkspaceEdit(edit) {
    const edits = [];
    const pushEdits = (uri, list) => {
      const resource = monaco.Uri.parse(uri);
      for (const e of list) {
        edits.push({ resource, textEdit: { range: toMonacoRange(e.range), text: e.newText }, versionId: undefined });
      }
    };
    if (edit?.changes) {
      for (const [uri, list] of Object.entries(edit.changes)) pushEdits(uri, list);
    }
    if (Array.isArray(edit?.documentChanges)) {
      for (const dc of edit.documentChanges) {
        if (dc.textDocument && dc.edits) pushEdits(dc.textDocument.uri, dc.edits);
      }
    }
    return { edits };
  }

  // ---- Monaco provider registration ----
  /*
   * 编辑器里的补全/悬停/跳转注册在**Monaco 的 languageId** 上，而 .vue 的 languageId
   * 是 "html"（见 lspLangOf 那段注释：故意不改，改了会让没装 vue 服务器的人倒退）。
   * 所以选择器要额外带上 "html"——真正决定用不用得上语言服务器的是 clientForModel，
   * 它走 lspLangOf：.vue 拿到 vue 客户端，真正的 .html 拿到 undefined 直接返回空，
   * Monaco 自带的 html worker 照常出它自己的补全（多个 provider 是并存的）。
   */
  const PROVIDER_LANGS = [...new Set([
    ...MANAGED_LANGS,
    ...Object.values(_EXT_LSP_LANG).map((m) => m.monaco),
  ])];

  function registerProviders() {
    if (!enabled) return;
    registerExecuteCommand();

    monaco.languages.registerCompletionItemProvider(PROVIDER_LANGS, {
      triggerCharacters: [".", ":", ">", "<", "\"", "'", "/", "@", "(", "#", "$", "*", "&"],
      async provideCompletionItems(model, position, context) {
        let client = clientForModel(model);
        // A server still running its (sometimes slow) `initialize` handshake has no capabilities yet.
        // Instead of silently returning empty for the entire cold-start window, wait briefly for init
        // to settle so the first completion after opening a file actually works. Capped at 6s so a
        // genuinely stuck server never hangs the completion popup — the next keystroke retries.
        if (client && !client.initialized && client.initPromise) {
          try {
            await Promise.race([
              client.initPromise.catch(() => {}),
              new Promise((r) => setTimeout(r, 6000)),
            ]);
          } catch { /* ignore */ }
          client = clientForModel(model);
        }
        if (!client || !client.supports("completion")) return { suggestions: [] };
        flushPendingChange(model.uri.toString());
        const lspTrigger = (context.triggerKind || 0) + 1;
        const lspContext = { triggerKind: lspTrigger };
        if (context.triggerCharacter) lspContext.triggerCharacter = context.triggerCharacter;
        const result = await client.request("textDocument/completion", {
          textDocument: { uri: model.uri.toString() },
          position: fromMonacoPosition(position),
          context: lspContext,
        });
        if (!result) return { suggestions: [] };
        const items = Array.isArray(result) ? result : result.items || [];
        const isIncomplete = !Array.isArray(result) && !!result.isIncomplete;
        if (items.length > 0 && manager.onCompletionSymbols) {
          const labels = items.map((it) => typeof it.label === "string" ? it.label : it.label?.label).filter(Boolean);
          try { manager.onCompletionSymbols(labels); } catch { /* ignore */ }
        }
        const word = model.getWordUntilPosition(position);
        const defaultRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
        return {
          incomplete: isIncomplete,
          suggestions: items.map((it) => completionToMonaco(it, defaultRange, client.lang)),
        };
      },
      async resolveCompletionItem(item) {
        const client = clients.get(item.__lspLang);
        if (!client || !client.supports("resolveCompletion") || !item.__lspItem) return item;
        const resolved = await client.request("completionItem/resolve", item.__lspItem);
        if (!resolved) return item;
        if (resolved.documentation) item.documentation = completionDocsToMonaco(resolved.documentation);
        if (resolved.detail) item.detail = resolved.detail;
        if (Array.isArray(resolved.additionalTextEdits)) {
          item.additionalTextEdits = resolved.additionalTextEdits.map((e) => ({
            range: toMonacoRange(e.range),
            text: e.newText,
          }));
        }
        return item;
      },
    });

    monaco.languages.registerHoverProvider(PROVIDER_LANGS, {
      async provideHover(model, position) {
        const client = clientForModel(model);
        if (!client || !client.supports("hover")) return null;
        flushPendingChange(model.uri.toString());
        const result = await client.request("textDocument/hover", {
          textDocument: { uri: model.uri.toString() },
          position: fromMonacoPosition(position),
        });
        if (!result || !result.contents) return null;
        let contents = hoverContentsToMarkdown(result.contents);
        if (!contents.length) return null;
        /*
         * 文档按用户选的语言翻出来（用户：「把变量、函数、方法根据用户选择的语言进行自动
         * 翻译，对每个开发者都能很友好」）。
         *
         * 只翻**围栏外的散文**：签名在代码围栏里，翻了就成了一句读不了也抄不走的话，
         * 比不翻更糟。切段和「值不值得翻」的判据都在 agent/hover-doc.js，纯函数。
         *
         * 在这里 await 而不是"先出英文、翻好再换"：hover 是一次性把 markdown 交给编辑器
         * 渲染，之后没有第二次机会。translateNow 自带超时，慢的时候就照原样出英文。
         */
        if (typeof translateDoc === "function") {
          try {
            const merged = await translateDoc(contents.map((c) => c.value).join("\n\n"));
            if (merged && merged.trim()) contents = [{ value: merged, isTrusted: false }];
          } catch { /* 翻不成就出原文，绝不让悬浮说明因此变空 */ }
        }
        return { range: toMonacoRange(result.range), contents };
      },
    });

    monaco.languages.registerDefinitionProvider(PROVIDER_LANGS, {
      async provideDefinition(model, position) {
        const client = clientForModel(model);
        if (!client || !client.supports("definition")) return null;
        const result = await client.request("textDocument/definition", {
          textDocument: { uri: model.uri.toString() },
          position: fromMonacoPosition(position),
        });
        return locationsToMonaco(result);
      },
    });

    monaco.languages.registerImplementationProvider(PROVIDER_LANGS, {
      async provideImplementation(model, position) {
        const client = clientForModel(model);
        if (!client || !client.supports("implementation")) return null;
        const result = await client.request("textDocument/implementation", {
          textDocument: { uri: model.uri.toString() },
          position: fromMonacoPosition(position),
        });
        return locationsToMonaco(result);
      },
    });

    monaco.languages.registerTypeDefinitionProvider(PROVIDER_LANGS, {
      async provideTypeDefinition(model, position) {
        const client = clientForModel(model);
        if (!client || !client.supports("typeDefinition")) return null;
        const result = await client.request("textDocument/typeDefinition", {
          textDocument: { uri: model.uri.toString() },
          position: fromMonacoPosition(position),
        });
        return locationsToMonaco(result);
      },
    });

    monaco.languages.registerDeclarationProvider(PROVIDER_LANGS, {
      async provideDeclaration(model, position) {
        const client = clientForModel(model);
        if (!client || !client.supports("declaration")) return null;
        const result = await client.request("textDocument/declaration", {
          textDocument: { uri: model.uri.toString() },
          position: fromMonacoPosition(position),
        });
        return locationsToMonaco(result);
      },
    });

    monaco.languages.registerReferenceProvider(PROVIDER_LANGS, {
      async provideReferences(model, position, context) {
        const client = clientForModel(model);
        if (!client || !client.supports("references")) return null;
        const result = await client.request("textDocument/references", {
          textDocument: { uri: model.uri.toString() },
          position: fromMonacoPosition(position),
          context: { includeDeclaration: context?.includeDeclaration ?? true },
        });
        return locationsToMonaco(result);
      },
    });

    monaco.languages.registerRenameProvider(PROVIDER_LANGS, {
      async provideRenameEdits(model, position, newName) {
        const client = clientForModel(model);
        if (!client || !client.supports("rename")) {
          return { edits: [], rejectReason: "Rename is not supported by this language server." };
        }
        const result = await client.request("textDocument/rename", {
          textDocument: { uri: model.uri.toString() },
          position: fromMonacoPosition(position),
          newName,
        });
        if (!result) return { edits: [], rejectReason: "Rename failed." };
        return toMonacoWorkspaceEdit(result);
      },
    });

    monaco.languages.registerDocumentSymbolProvider(PROVIDER_LANGS, {
      async provideDocumentSymbols(model) {
        const client = clientForModel(model);
        if (!client || !client.supports("documentSymbol")) return [];
        const result = await client.request("textDocument/documentSymbol", {
          textDocument: { uri: model.uri.toString() },
        });
        return symbolsToMonaco(result);
      },
    });

    monaco.languages.registerSignatureHelpProvider(PROVIDER_LANGS, {
      signatureHelpTriggerCharacters: ["(", ","],
      signatureHelpRetriggerCharacters: [")"],
      async provideSignatureHelp(model, position) {
        const client = clientForModel(model);
        if (!client || !client.supports("signatureHelp")) return null;
        flushPendingChange(model.uri.toString());
        const result = await client.request("textDocument/signatureHelp", {
          textDocument: { uri: model.uri.toString() },
          position: fromMonacoPosition(position),
        });
        if (!result || !Array.isArray(result.signatures) || !result.signatures.length) return null;
        return { value: signatureHelpToMonaco(result), dispose() {} };
      },
    });

    monaco.languages.registerDocumentFormattingEditProvider(PROVIDER_LANGS, {
      async provideDocumentFormattingEdits(model, formatOptions) {
        const client = clientForModel(model);
        if (!client || !client.supports("formatting")) return [];
        const result = await client.request("textDocument/formatting", {
          textDocument: { uri: model.uri.toString() },
          options: {
            tabSize: formatOptions?.tabSize ?? 4,
            insertSpaces: formatOptions?.insertSpaces ?? true,
            trimTrailingWhitespace: true,
            insertFinalNewline: true,
          },
        });
        if (!Array.isArray(result)) return [];
        return result.map((e) => ({ range: toMonacoRange(e.range), text: e.newText }));
      },
    });

    monaco.languages.registerCodeActionProvider(PROVIDER_LANGS, {
      async provideCodeActions(model, range, context) {
        const client = clientForModel(model);
        if (!client || !client.supports("codeAction")) return { actions: [], dispose() {} };
        const diagnostics = (context?.markers || []).map(markerToLspDiagnostic);
        const result = await client.request("textDocument/codeAction", {
          textDocument: { uri: model.uri.toString() },
          range: {
            start: fromMonacoPosition({ lineNumber: range.startLineNumber, column: range.startColumn }),
            end: fromMonacoPosition({ lineNumber: range.endLineNumber, column: range.endColumn }),
          },
          context: { diagnostics, only: undefined },
        });
        const actions = (Array.isArray(result) ? result : [])
          .map((a) => codeActionToMonaco(a, client.lang))
          .filter(Boolean);
        return { actions, dispose() {} };
      },
    });

    monaco.languages.registerInlayHintsProvider(PROVIDER_LANGS, {
      async provideInlayHints(model, range) {
        const client = clientForModel(model);
        if (!client || !client.supports("inlayHint")) return { hints: [], dispose() {} };
        const result = await client.request("textDocument/inlayHint", {
          textDocument: { uri: model.uri.toString() },
          range: {
            start: fromMonacoPosition({ lineNumber: range.startLineNumber, column: range.startColumn }),
            end: fromMonacoPosition({ lineNumber: range.endLineNumber, column: range.endColumn }),
          },
        });
        if (!Array.isArray(result)) return { hints: [], dispose() {} };
        const hints = result.map((h) => ({
          position: toMonacoPosition(h.position),
          label: typeof h.label === "string" ? h.label : Array.isArray(h.label) ? h.label.map((p) => p.value).join("") : "",
          kind: h.kind === 1 ? monaco.languages.InlayHintKind.Type : h.kind === 2 ? monaco.languages.InlayHintKind.Parameter : undefined,
          paddingLeft: h.paddingLeft,
          paddingRight: h.paddingRight,
        }));
        return { hints, dispose() {} };
      },
    });

    // ---- CodeLens ----
    monaco.languages.registerCodeLensProvider(PROVIDER_LANGS, {
      async provideCodeLenses(model) {
        const client = clientForModel(model);
        if (!client || !client.supports("codeLens")) return { lenses: [], dispose() {} };
        const result = await client.request("textDocument/codeLens", {
          textDocument: { uri: model.uri.toString() },
        });
        if (!Array.isArray(result)) return { lenses: [], dispose() {} };
        const lenses = result.map((cl) => {
          const lens = { range: toMonacoRange(cl.range) };
          if (cl.command) {
            lens.command = {
              id: "michael.lsp.executeCommand",
              title: cl.command.title || "",
              arguments: [client.lang, cl.command],
            };
          }
          lens.__lspItem = cl;
          lens.__lspLang = client.lang;
          return lens;
        });
        return { lenses, dispose() {} };
      },
      async resolveCodeLens(_model, codeLens) {
        const client = clients.get(codeLens.__lspLang);
        if (!client || !codeLens.__lspItem) return codeLens;
        const cap = client.capabilities?.codeLensProvider;
        if (!cap?.resolveProvider) return codeLens;
        const resolved = await client.request("codeLens/resolve", codeLens.__lspItem);
        if (!resolved) return codeLens;
        if (resolved.command) {
          codeLens.command = {
            id: "michael.lsp.executeCommand",
            title: resolved.command.title || "",
            arguments: [client.lang, resolved.command],
          };
        }
        return codeLens;
      },
    });

    // ---- Document Highlight (highlight all occurrences of selected symbol) ----
    monaco.languages.registerDocumentHighlightProvider(PROVIDER_LANGS, {
      async provideDocumentHighlights(model, position) {
        const client = clientForModel(model);
        if (!client || !client.supports("documentHighlight")) return [];
        const result = await client.request("textDocument/documentHighlight", {
          textDocument: { uri: model.uri.toString() },
          position: fromMonacoPosition(position),
        });
        if (!Array.isArray(result)) return [];
        return result.map((h) => ({
          range: toMonacoRange(h.range),
          kind: h.kind === 2 ? monaco.languages.DocumentHighlightKind.Read
            : h.kind === 3 ? monaco.languages.DocumentHighlightKind.Write
            : monaco.languages.DocumentHighlightKind.Text,
        }));
      },
    });

    // ---- Color Provider (inline color swatches in CSS/code) ----
    monaco.languages.registerColorProvider(PROVIDER_LANGS, {
      async provideDocumentColors(model) {
        const client = clientForModel(model);
        if (!client || !client.supports("colorProvider")) return [];
        const result = await client.request("textDocument/documentColor", {
          textDocument: { uri: model.uri.toString() },
        });
        if (!Array.isArray(result)) return [];
        return result.map((c) => ({
          range: toMonacoRange(c.range),
          color: { red: c.color.red, green: c.color.green, blue: c.color.blue, alpha: c.color.alpha },
        }));
      },
      async provideColorPresentations(model, colorInfo) {
        const client = clientForModel(model);
        if (!client || !client.supports("colorProvider")) return [];
        const result = await client.request("textDocument/colorPresentation", {
          textDocument: { uri: model.uri.toString() },
          color: colorInfo.color,
          range: {
            start: fromMonacoPosition({ lineNumber: colorInfo.range.startLineNumber, column: colorInfo.range.startColumn }),
            end: fromMonacoPosition({ lineNumber: colorInfo.range.endLineNumber, column: colorInfo.range.endColumn }),
          },
        });
        if (!Array.isArray(result)) return [];
        return result.map((p) => {
          const pres = { label: p.label };
          if (p.textEdit) {
            pres.textEdit = { range: toMonacoRange(p.textEdit.range), text: p.textEdit.newText };
          }
          if (Array.isArray(p.additionalTextEdits)) {
            pres.additionalTextEdits = p.additionalTextEdits.map((e) => ({
              range: toMonacoRange(e.range), text: e.newText,
            }));
          }
          return pres;
        });
      },
    });

    // ---- Linked Editing Ranges (rename HTML open/close tags together) ----
    monaco.languages.registerLinkedEditingRangeProvider(PROVIDER_LANGS, {
      async provideLinkedEditingRanges(model, position) {
        const client = clientForModel(model);
        if (!client || !client.supports("linkedEditingRange")) return null;
        const result = await client.request("textDocument/linkedEditingRange", {
          textDocument: { uri: model.uri.toString() },
          position: fromMonacoPosition(position),
        });
        if (!result || !Array.isArray(result.ranges)) return null;
        return {
          ranges: result.ranges.map(toMonacoRange),
          wordPattern: result.wordPattern ? new RegExp(result.wordPattern) : undefined,
        };
      },
    });

    // ---- Folding Range Provider ----
    // 无答案时必须返回 null 而不是 []：注册了 provider 后，[] 是「确定没有可折叠
    // 区域」的正式答复，会顶掉 Monaco 的缩进折叠兜底——LSP 没起来/不支持
    // foldingRange 的语言从此一个折叠箭头都没有；null 才会回退到缩进折叠。
    monaco.languages.registerFoldingRangeProvider(PROVIDER_LANGS, {
      async provideFoldingRanges(model) {
        const client = clientForModel(model);
        if (!client || !client.supports("foldingRange")) return null;
        try {
          const result = await client.request("textDocument/foldingRange", {
            textDocument: { uri: model.uri.toString() },
          });
          if (!Array.isArray(result)) return null;
          return result.map((fr) => ({
            start: fr.startLine + 1,
            end: fr.endLine + 1,
            kind: fr.kind === "comment" ? monaco.languages.FoldingRangeKind.Comment
              : fr.kind === "imports" ? monaco.languages.FoldingRangeKind.Imports
              : monaco.languages.FoldingRangeKind.Region,
          }));
        } catch {
          return null; // LSP 请求失败（崩溃/超时）同样回退缩进折叠，不能让折叠整个消失
        }
      },
    });

    // ---- On-Type Formatting ----
    const onTypeCandidates = [";", "}", "\n", ":", ")"];
    monaco.languages.registerOnTypeFormattingEditProvider(PROVIDER_LANGS, {
      autoFormatTriggerCharacters: onTypeCandidates,
      async provideOnTypeFormattingEdits(model, position, ch, formatOptions) {
        const client = clientForModel(model);
        if (!client || !client.supports("onTypeFormatting")) return [];
        const serverChars = [
          client.capabilities?.documentOnTypeFormattingProvider?.firstTriggerCharacter,
          ...(client.capabilities?.documentOnTypeFormattingProvider?.moreTriggerCharacter || []),
        ].filter(Boolean);
        if (!serverChars.includes(ch)) return [];
        const result = await client.request("textDocument/onTypeFormatting", {
          textDocument: { uri: model.uri.toString() },
          position: fromMonacoPosition(position),
          ch,
          options: { tabSize: formatOptions?.tabSize ?? 4, insertSpaces: formatOptions?.insertSpaces ?? true },
        });
        if (!Array.isArray(result)) return [];
        return result.map((e) => ({ range: toMonacoRange(e.range), text: e.newText }));
      },
    });

    // ---- Range Formatting ----
    monaco.languages.registerDocumentRangeFormattingEditProvider(PROVIDER_LANGS, {
      async provideDocumentRangeFormattingEdits(model, range, formatOptions) {
        const client = clientForModel(model);
        if (!client || !client.supports("rangeFormatting")) return [];
        const result = await client.request("textDocument/rangeFormatting", {
          textDocument: { uri: model.uri.toString() },
          range: {
            start: fromMonacoPosition({ lineNumber: range.startLineNumber, column: range.startColumn }),
            end: fromMonacoPosition({ lineNumber: range.endLineNumber, column: range.endColumn }),
          },
          options: {
            tabSize: formatOptions?.tabSize ?? 4,
            insertSpaces: formatOptions?.insertSpaces ?? true,
            trimTrailingWhitespace: true,
            insertFinalNewline: true,
          },
        });
        if (!Array.isArray(result)) return [];
        return result.map((e) => ({ range: toMonacoRange(e.range), text: e.newText }));
      },
    });

    // ---- Call Hierarchy (only if Monaco exposes the API) ----
    if (typeof monaco.languages.registerCallHierarchyProvider === "function") {
      monaco.languages.registerCallHierarchyProvider(PROVIDER_LANGS, {
        async prepareCallHierarchy(model, position) {
          const client = clientForModel(model);
          if (!client || !client.supports("callHierarchy")) return [];
          const result = await client.request("textDocument/prepareCallHierarchy", {
            textDocument: { uri: model.uri.toString() },
            position: fromMonacoPosition(position),
          });
          if (!Array.isArray(result) || !result.length) return [];
          return result.map((item) => callHierarchyItemToMonaco(item, client.lang));
        },
        async provideIncomingCalls(item) {
          const client = clients.get(item.__lspLang);
          if (!client) return [];
          const result = await client.request("callHierarchy/incomingCalls", { item: item.__lspItem });
          if (!Array.isArray(result)) return [];
          return result.map((call) => ({
            from: callHierarchyItemToMonaco(call.from, client.lang),
            fromRanges: (call.fromRanges || []).map(toMonacoRange),
          }));
        },
        async provideOutgoingCalls(item) {
          const client = clients.get(item.__lspLang);
          if (!client) return [];
          const result = await client.request("callHierarchy/outgoingCalls", { item: item.__lspItem });
          if (!Array.isArray(result)) return [];
          return result.map((call) => ({
            to: callHierarchyItemToMonaco(call.to, client.lang),
            fromRanges: (call.fromRanges || []).map(toMonacoRange),
          }));
        },
      });
    }

    // ---- Selection Range ----
    monaco.languages.registerSelectionRangeProvider(PROVIDER_LANGS, {
      async provideSelectionRanges(model, positions) {
        const client = clientForModel(model);
        if (!client || !client.supports("selectionRange")) return [];
        const result = await client.request("textDocument/selectionRange", {
          textDocument: { uri: model.uri.toString() },
          positions: positions.map(fromMonacoPosition),
        });
        if (!Array.isArray(result)) return [];
        return result.map((sr) => {
          const ranges = [];
          let cur = sr;
          while (cur) {
            ranges.push({ range: toMonacoRange(cur.range) });
            cur = cur.parent;
          }
          return ranges;
        });
      },
    });

    // ---- Document Link ----
    monaco.languages.registerLinkProvider(PROVIDER_LANGS, {
      async provideLinks(model) {
        const client = clientForModel(model);
        if (!client || !client.supports("documentLink")) return { links: [] };
        const result = await client.request("textDocument/documentLink", {
          textDocument: { uri: model.uri.toString() },
        });
        if (!Array.isArray(result)) return { links: [] };
        return {
          links: result.map((l) => ({
            range: toMonacoRange(l.range),
            url: l.target,
            tooltip: l.tooltip,
          })),
        };
      },
    });

    // ---- Workspace Symbol (only if Monaco exposes the API) ----
    if (typeof monaco.languages.registerWorkspaceSymbolProvider === "function") {
      monaco.languages.registerWorkspaceSymbolProvider({
        async provideWorkspaceSymbols(query) {
          const results = [];
          for (const [langId, client] of clients) {
            if (!client.initialized || !client.supports("workspaceSymbol")) continue;
            const symbols = await client.request("workspace/symbol", { query });
            if (!Array.isArray(symbols)) continue;
            for (const s of symbols) {
              results.push({
                name: s.name,
                kind: (s.kind ?? 1) - 1,
                containerName: s.containerName || "",
                location: {
                  uri: monaco.Uri.parse(s.location.uri),
                  range: toMonacoRange(s.location.range),
                },
              });
            }
          }
          return results;
        },
      });
    }
  }

  function registerExecuteCommand() {
    if (executeCommandRegistered) return;
    executeCommandRegistered = true;
    monaco.editor.registerCommand("michael.lsp.executeCommand", (_accessor, langId, command) => {
      const client = clients.get(langId);
      if (!client || !command) return;
      client.request("workspace/executeCommand", {
        command: command.command,
        arguments: command.arguments || [],
      });
    });
  }

  // ---- LSP -> Monaco translation helpers ----
  function completionToMonaco(it, defaultRange, langId) {
    let insertText = it.insertText ?? it.label ?? "";
    let range = defaultRange;
    const edit = it.textEdit;
    if (edit) {
      insertText = edit.newText ?? insertText;
      if (edit.range) {
        range = toMonacoRange(edit.range);
      } else if (edit.insert && edit.replace) {
        range = { insert: toMonacoRange(edit.insert), replace: toMonacoRange(edit.replace) };
      }
    }
    const monacoItem = {
      label: typeof it.label === "string" ? it.label : it.label?.label ?? "",
      kind: LSP_TO_COMPLETION_KIND[it.kind] ?? CK.Text,
      insertText,
      range,
      detail: it.detail,
      documentation: completionDocsToMonaco(it.documentation),
      sortText: it.sortText,
      filterText: it.filterText,
      preselect: it.preselect,
      commitCharacters: it.commitCharacters,
    };
    if (it.insertTextFormat === 2) {
      monacoItem.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
    }
    if (Array.isArray(it.additionalTextEdits)) {
      monacoItem.additionalTextEdits = it.additionalTextEdits.map((e) => ({
        range: toMonacoRange(e.range),
        text: e.newText,
      }));
    }
    if (it.tags?.includes(1) || it.deprecated) {
      monacoItem.tags = [monaco.languages.CompletionItemTag.Deprecated];
    }
    const isCallable = it.kind === 2 || it.kind === 3 || it.kind === 4;
    if (isCallable && it.insertTextFormat !== 2 && !insertText.includes("(")) {
      monacoItem.insertText = insertText + "($1)";
      monacoItem.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
    }
    monacoItem.__lspItem = it;
    monacoItem.__lspLang = langId;
    return monacoItem;
  }

  function locationsToMonaco(result) {
    if (!result) return null;
    const list = Array.isArray(result) ? result : [result];
    const out = [];
    for (const loc of list) {
      if (loc.targetUri) {
        out.push({
          uri: monaco.Uri.parse(loc.targetUri),
          range: toMonacoRange(loc.targetSelectionRange || loc.targetRange),
        });
      } else if (loc.uri) {
        out.push({ uri: monaco.Uri.parse(loc.uri), range: toMonacoRange(loc.range) });
      }
    }
    return out;
  }

  function symbolsToMonaco(result) {
    if (!Array.isArray(result)) return [];
    const convert = (s) => {
      // DocumentSymbol (hierarchical) vs SymbolInformation (flat).
      if (s.location) {
        return {
          name: s.name,
          detail: s.containerName || "",
          kind: (s.kind ?? 1) - 1,
          tags: [],
          range: toMonacoRange(s.location.range),
          selectionRange: toMonacoRange(s.location.range),
        };
      }
      return {
        name: s.name,
        detail: s.detail || "",
        kind: (s.kind ?? 1) - 1,
        tags: (s.tags || []).map(() => monaco.languages.SymbolTag.Deprecated),
        range: toMonacoRange(s.range),
        selectionRange: toMonacoRange(s.selectionRange || s.range),
        children: Array.isArray(s.children) ? s.children.map(convert) : [],
      };
    };
    return result.map(convert);
  }

  function signatureHelpToMonaco(result) {
    return {
      activeSignature: result.activeSignature ?? 0,
      activeParameter: result.activeParameter ?? 0,
      signatures: result.signatures.map((sig) => ({
        label: sig.label,
        documentation: completionDocsToMonaco(sig.documentation),
        parameters: (sig.parameters || []).map((p) => ({
          label: p.label,
          documentation: completionDocsToMonaco(p.documentation),
        })),
        activeParameter: sig.activeParameter,
      })),
    };
  }

  function markerToLspDiagnostic(m) {
    return {
      range: {
        start: { line: m.startLineNumber - 1, character: m.startColumn - 1 },
        end: { line: m.endLineNumber - 1, character: m.endColumn - 1 },
      },
      severity: m.severity === Sev.Error ? 1 : m.severity === Sev.Warning ? 2 : m.severity === Sev.Info ? 3 : 4,
      message: m.message,
      code: m.code,
      source: m.source,
    };
  }

  function codeActionToMonaco(a, langId) {
    if (!a) return null;
    // Plain Command (no CodeAction wrapper).
    if (a.command && !a.title && !a.edit) {
      return {
        title: a.command.title || a.title || "Command",
        command: { id: "michael.lsp.executeCommand", title: a.command.title || "", arguments: [langId, a.command] },
      };
    }
    const action = {
      title: a.title || "Code action",
      kind: a.kind,
      isPreferred: a.isPreferred,
      diagnostics: undefined,
    };
    if (a.edit) action.edit = toMonacoWorkspaceEdit(a.edit);
    if (a.command) {
      const cmd = typeof a.command === "string" ? { command: a.command, title: a.title } : a.command;
      action.command = { id: "michael.lsp.executeCommand", title: cmd.title || a.title || "", arguments: [langId, cmd] };
    }
    return action;
  }

  const LSP_SYMBOL_KIND_MAP = {
    1: 0, 2: 10, 3: 4, 4: 2, 5: 22, 6: 10, 7: 10, 8: 2, 9: 11,
    10: 3, 11: 7, 12: 5, 13: 0, 14: 14, 15: 17, 16: 17, 17: 9,
    18: 8, 19: 6, 20: 1, 21: 12, 22: 13, 23: 18, 24: 23, 25: 24, 26: 25,
  };

  function callHierarchyItemToMonaco(item, langId) {
    return {
      name: item.name,
      kind: LSP_SYMBOL_KIND_MAP[item.kind] ?? 0,
      detail: item.detail || "",
      uri: monaco.Uri.parse(item.uri),
      range: toMonacoRange(item.range),
      selectionRange: toMonacoRange(item.selectionRange),
      tags: (item.tags || []).map(() => 1),
      __lspItem: item,
      __lspLang: langId,
    };
  }

  // ---- public surface ----
  return {
    // 供 LspClient._startInner 判断能否使用仓库自带的语言服务器二进制。
    isWorkspaceTrusted,
    registerProviders,
    didOpen,
    didChange,
    didSave,
    didClose,
    refreshWorkspace,
    notifyWatchedFiles,
    ensureServer,
    /// 这个语言归不归我们管（装了服务器就该有补全/跳转/悬浮）。状态栏据此判断
    /// 「一个服务都没起来」到底是"这个语言本来就没有服务"还是"该有却没起来"——
    /// 前者不该显示任何东西，后者必须说出来。
    isManaged,
    /// 这个语言的语言服务**当前真的起来了吗**。
    ///
    /// get_diagnostics 原来在"没有诊断"时一律回一句「语言服务已在分析；LSP 出结果略有
    /// 延迟，改完稍等再查更准」。可 ensureServer 拿不到服务时返回 null 且**静默**——
    /// 没装 pyright / rust-analyzer、或者启动超时，都会走到同一句话。
    /// 于是模型改完 Python 调 get_diagnostics，拿到"无错误 + 语言服务已在分析"，
    /// 据此向用户报告"已修复"，而真相是**一行都没被检查过**。
    /// 那句"稍等再查更准"更糟：它暗示再等等就准了，而实际上等到天亮也是空的。
    diagnosticsProviderReady(langId) {
      const client = clients.get(String(langId || ""));
      return !!(client && client.initialized === true);
    },
    /**
     * 工作区根**被替换**了（打开另一个项目）——把所有在跑的语言服务器停掉。
     *
     * rootUri / workspaceFolders 是 initialize 时一次性钉进去的，之后没有任何一处会改它
     * （全仓没有一处发 workspace/didChangeWorkspaceFolders）。于是：打开 Rust 项目 A，
     * rust-analyzer 按 A 的 Cargo workspace 起来；不重启应用直接切到项目 B，那个进程
     * 还在按 A 工作。打开 B/src/main.rs → 它不属于 A 认识的任何 crate → 补全、跳转、
     * 诊断全部失效，而状态栏仍然显示 `LSP: rust` 一切正常。唯一的恢复手段是重启应用。
     *
     * 停掉就行，不用在这里重启：下一次 didOpen 会按新根重新 initialize。
     * pyright 的 venv 探测结果也一起清掉——它同样只在第一次 ensureServer 时算一次。
     */
    async resetForNewWorkspace() {
      manager._pythonSettings = null;
      const langs = [...clients.keys()];
      for (const langId of langs) {
        try { await this.stop(langId); } catch { /* 停不掉也要继续停别的 */ }
      }
      // 惰性 model 属于上一个项目，留着只会让新项目里的同名路径拿到旧内容。
      for (const uri of [...lazyModels]) {
        lazyModels.delete(uri);
        try {
          const m = monaco.editor.getModel(monaco.Uri.parse(uri));
          if (m && !m.isAttachedToEditor?.()) m.dispose();
        } catch { /* 已经没了就算了 */ }
      }
      onStatus?.();
      return langs;
    },
    async startManual(langId, custom) {
      return ensureServer(langId, custom);
    },
    async stop(langId) {
      const client = clients.get(langId);
      if (client) {
        client.shutdown();
        clients.delete(langId);
      }
      try { await backend.lspStop(SERVER_LANG[langId] || langId); } catch { /* ignore */ }
      for (const m of monaco.editor.getModels()) {
        monaco.editor.setModelMarkers(m, "lsp:" + langId, []);
      }
      onStatus?.();
    },
    status() {
      return [...clients.entries()].map(([lang, client]) => ({
        lang,
        running: true,
        initialized: client.initialized,
      }));
    },
    isRunning(langId) {
      return clients.has(langId);
    },
    lastStopReason(langId) {
      return lastStopReason.get(langId) || "";
    },
    /**
     * 这个文件刚在磁盘上被改过（智能体的写工具落盘），把新内容同步给语言服务器。
     *
     * 缺这一条的后果是「怎么改都不消失的报错」：pyright 为一个**没开标签页**的
     * models.py 推过诊断（跨文件诊断会给它建一份惰性 model 并 didOpen），智能体随后
     * 把那个类型错误修好了——磁盘写成功，但 _applyDiskContentToOpenFile 因为这个文件
     * 既不在 openFiles 也不在 projectModels（.py 不在预载扩展名里）而直接返回
     * "closed"，didChange 一次都没发。pyright 手里仍是旧文本，继续推同一条旧错误，
     * 那条错误进 markers、进每轮注入给模型的「实时诊断」块——模型看到「没修上」，
     * 再改一遍同一行，循环。同一时刻 lsp_* 查询返回的也全是改前版本的行号。
     *
     * 返回是否真的同步了，调用方据此区分「没这个文档」和「同步过了」。
     */
    syncFromDisk(path, content) {
      if (!enabled || !path) return false;
      let model = null;
      try { model = monaco.editor.getModel(monaco.Uri.file(path)); } catch { return false; }
      if (!model) return false;
      // 用户正开着在编辑的缓冲区不碰——那里可能有还没落盘的输入，覆盖它就是丢用户的字。
      if (model.isAttachedToEditor?.()) return false;
      const next = String(content ?? "");
      if (model.getValue() === next) return false;
      try { model.setValue(next); } catch { return false; }
      const langId = lspLangOf(model, path);
      const client = clients.get(langId);
      if (client && client.initialized) {
        const uri = model.uri.toString();
        try {
          if (client.openDocs.has(uri)) client.didChange(uri, model.getVersionId(), next);
          else client.didOpen(uri, DOC_LANGUAGE_ID[langId] || langId, model.getVersionId(), next);
        } catch { /* 服务器这会儿没了，下次 didOpen 会补上 */ }
      }
      return true;
    },
    logFor(langId) {
      return clients.get(langId)?.logLines.join("\n") || "";
    },
    managedLangs: MANAGED_LANGS.slice(),
    onCompletionSymbols: null,
    async queryDocumentSymbols(uri, langId) {
      const client = clients.get(langId);
      if (!client || !client.initialized || !client.supports("documentSymbol")) return [];
      const result = await client.request("textDocument/documentSymbol", {
        textDocument: { uri },
      });
      if (!Array.isArray(result)) return [];
      const names = [];
      const walk = (items) => {
        for (const item of items) {
          const name = item.name || item.label;
          if (name) names.push(name);
          if (Array.isArray(item.children)) walk(item.children);
        }
      };
      walk(result);
      return names;
    },
    async queryWorkspaceSymbols(langId, query = "") {
      const client = clients.get(langId);
      if (!client || !client.initialized) return [];
      const cap = client.capabilities || {};
      if (!cap.workspaceSymbolProvider) return [];
      const result = await client.request("workspace/symbol", { query });
      if (!Array.isArray(result)) return [];
      return result.map((s) => s.name).filter(Boolean);
    },

    // ---- agent navigation tools (managed languages only; null = use a fallback) ----
    // Document outline: [{ name, kind, line, depth }] (1-based line). Handles both
    // hierarchical DocumentSymbol[] and flat SymbolInformation[].
    // 三种结局要分开，不能合并成一个空数组：
    //   null            —— 这个语言压根没有符号服务（调用方会说「[无 LSP]」）
    //   { unanswered }  —— 服务在，但这次**没答上来**（超时 / 发送失败 / JSON-RPC error）
    //   数组（可能为空）—— 服务真的答了，空就是真的没有符号
    //
    // 原来中间那种被压成 []，于是「刚打开一个 Rust/Go 项目、语言服务还在建索引」被说成
    // 「这个文件里没有符号」—— 一个**肯定判断**。模型据此认为文件是空的，转头凭记忆写代码
    // 或者直接删东西。request() 在超时、发送失败、JSON-RPC error 三条路上一律 resolve(null)，
    // 到这里的 null 有四种来源，只有一种是「服务器真说没有」。
    //
    // 不动 request() 的默认行为：全仓 36 处 await 依赖它 resolve(null)，改成 reject 会复现
    // 「initialize 超时 → capabilities={} 却 initialized=true」那个老 bug。
    async agentDocumentSymbols(path) {
      const ctx = await _agentEnsureDoc(path);
      if (!ctx || !ctx.client.supports("documentSymbol")) return null;
      let r;
      try { r = await ctx.client.requestDetailed("textDocument/documentSymbol", { textDocument: { uri: ctx.uri } }); }
      catch (e) { return { unanswered: true, reason: "transport", detail: String(e && e.message ? e.message : e).slice(0, 160) }; }
      // 服务器**答了 null** 也算没答上来：这是仓库原有的保守选择，现在有了 reason 也照旧保留。
      // 判据是代价不对称——把"答了 null"说成"这文件没有符号"，模型会当成空文件；说成
      // "没答上来"，它最多多读一次文件。
      if (!r.ok || r.result == null) return { unanswered: true, reason: r.ok ? "null" : r.reason, detail: r.detail };
      const result = r.result;
      if (!Array.isArray(result)) return [];
      const out = [];
      const walk = (items, depth) => {
        for (const it of items) {
          const name = it.name || it.label;
          const range = it.range || it.location?.range;
          if (name) out.push({ name, kind: LSP_SYMBOL_KIND_NAMES[it.kind] || "", line: range ? range.start.line + 1 : null, depth });
          if (Array.isArray(it.children)) walk(it.children, depth + 1);
        }
      };
      walk(result, 0);
      return out;
    },

    // Definition / references for the symbol at (line, character) — 1-based line,
    // 0-based character. `kind` is "definition" or "references". Returns
    // [{ path, line }] or null when no managed LSP / capability applies.
    async agentLocate(path, line, character, kind) {
      const ctx = await _agentEnsureDoc(path);
      if (!ctx) return null;
      const cap = kind === "references" ? "references" : "definition";
      if (!ctx.client.supports(cap)) return null;
      const position = { line: Math.max(0, (line | 0) - 1), character: Math.max(0, character | 0) };
      const params = { textDocument: { uri: ctx.uri }, position };
      if (kind === "references") params.context = { includeDeclaration: true };
      /*
       * 「没查成」和「没有引用」必须分开——这一条是四个里最危险的。
       *
       * 超时/服务器报错原来都变成 []，调用方读到的是**「这个符号没人用」**，于是放心
       * 地删掉它、或者改了签名不管调用点。同一个文件里 63337 那段注释已经把这个后果
       * 写出来了（那次修的是"行号偏了"那条路），超时这条路一直没修。
       */
      let r;
      try { r = await ctx.client.requestDetailed("textDocument/" + cap, params); }
      catch (e) { return { unanswered: true, reason: "transport", detail: String(e && e.message ? e.message : e).slice(0, 160) }; }
      // 同上，且这一条代价最大：`[]` 只有在服务器**真的回了一个空数组**时才成立。
      if (!r.ok || r.result == null) return { unanswered: true, reason: r.ok ? "null" : r.reason, detail: r.detail };
      const result = r.result;
      const arr = Array.isArray(result) ? result : (result ? [result] : []);
      const locs = arr.map((loc) => {
        const uri = loc.uri || loc.targetUri;
        const range = loc.range || loc.targetSelectionRange || loc.targetRange;
        if (!uri) return null;
        let p = uri;
        try { p = monaco.Uri.parse(uri).fsPath; } catch { /* keep raw uri */ }
        return { path: p, line: range ? range.start.line + 1 : null };
      }).filter(Boolean);
      return locs;
    },

    /*
     * 悬停信息（签名 + 文档）—— 智能体侧一直没有这个入口。
     *
     * 编辑器早就在用它（textDocument/hover 那条路），而它恰恰是**最省 token 的签名真相
     * 源**：问一次就拿到那个符号在**当前安装版本**下的真实类型，不用读文档、不用猜。
     * 以前只暴露了 symbols / locate / format，写代码最需要的这一件反而没开。
     *
     * 返回纯文本（LSP 的 hover 可能是字符串、MarkedString 或 MarkupContent，三种都要认），
     * 拿不到就返回 null——调用方据此退回别的路子，而不是把"没有"说成"没有这个符号"。
     */
    async agentHover(path, line, character) {
      const ctx = await _agentEnsureDoc(path);
      if (!ctx) return null;
      if (!ctx.client.supports("hover")) return null;
      const position = { line: Math.max(0, (line | 0) - 1), character: Math.max(0, character | 0) };
      let r;
      try { r = await ctx.client.requestDetailed("textDocument/hover", { textDocument: { uri: ctx.uri }, position }); }
      catch (e) { return { unanswered: true, reason: "transport", detail: String(e && e.message ? e.message : e).slice(0, 160) }; }
      // 没答上来 ≠ 这个符号没有类型信息。前者重试有意义，后者重试是浪费。
      if (!r.ok) return { unanswered: true, reason: r.reason, detail: r.detail };
      const contents = r.result?.contents;
      if (!contents) return null;
      const flatten = (node) => {
        if (!node) return "";
        if (typeof node === "string") return node;
        if (Array.isArray(node)) return node.map(flatten).filter(Boolean).join("\n\n");
        if (typeof node.value === "string") return node.value;
        return "";
      };
      const text = flatten(contents).trim();
      return text || null;
    },

    // Whole-document formatting. Returns the formatted text (applied to a
    // throwaway model so the editor's live model is never mutated), the original
    // text when the server reports no edits, or null when no managed formatter
    // applies. The CALLER is responsible for writing it through the reversible
    // edit path.
    async agentFormat(path, options) {
      const ctx = await _agentEnsureDoc(path);
      if (!ctx || !ctx.client.supports("formatting")) return null;
      let r;
      try {
        r = await ctx.client.requestDetailed("textDocument/formatting", {
          textDocument: { uri: ctx.uri },
          options: { tabSize: options?.tabSize || 2, insertSpaces: options?.insertSpaces !== false },
        });
      } catch (e) { return { unanswered: true, reason: "transport", detail: String(e && e.message ? e.message : e).slice(0, 160) }; }
      // 格式化这条的后果不同：没答上来还照旧返回 null 会让调用方以为"这语言没有格式化器"，
      // 于是**再也不试**。分开之后它知道这次只是没答上来。
      if (!r.ok) return { unanswered: true, reason: r.reason, detail: r.detail };
      const edits = r.result;
      if (!Array.isArray(edits)) return null;
      const original = ctx.model.getValue();
      if (!edits.length) return original;
      const tmp = monaco.editor.createModel(original, ctx.model.getLanguageId());
      try {
        tmp.applyEdits(edits.map((e) => ({ range: toMonacoRange(e.range), text: e.newText })));
        return tmp.getValue();
      } catch {
        return null;
      } finally {
        tmp.dispose();
      }
    },
  };
}
