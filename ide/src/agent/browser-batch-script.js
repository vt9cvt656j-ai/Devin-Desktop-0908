/**
 * 浏览器批处理的**页内脚本**。从 main.js 抽出来的第五块，793 行一个函数。
 *
 * 它构造的是一段字符串，交给 browser_eval 在**被测页面**里跑——所以这里出现的
 * document / querySelectorAll 不是 IDE 自己碰 DOM，是模板内容。判据因此照旧成立：
 * 零外部依赖（AST 实测自由变量为空）、纯函数、无模块级可变状态。
 *
 * 独占一个文件是因为它一个人就顶 MODULE_MAX_LINES(1200) 的 66%，和别人合住会撞线。
 */

export function _browserBatchFastJS(steps) {
  const safeSteps = (Array.isArray(steps) ? steps : []).slice(0, 25).map((step) => ({
    op: String(step?.op || step?.action || "").toLowerCase().trim(),
    kind: String(step?.kind || "").toLowerCase().slice(0, 8),
    selector: String(step?.selector || ""),
    node: Number.isFinite(+step?.node) ? Math.floor(+step.node) : null,
    index: Number.isFinite(+step?.index) ? Math.floor(+step.index) : null,
    toSelector: String(step?.toSelector || step?.to_selector || ""),
    toNode: Number.isFinite(+step?.toNode) ? Math.floor(+step.toNode) : (Number.isFinite(+step?.to_node) ? Math.floor(+step.to_node) : null),
    toIndex: Number.isFinite(+step?.toIndex) ? Math.floor(+step.toIndex) : (Number.isFinite(+step?.to_index) ? Math.floor(+step.to_index) : null),
    toTarget: String(step?.toTarget || step?.to_target || step?.dropTarget || step?.drop_target || ""),
    toRole: String(step?.toRole || step?.to_role || ""),
    text: String(step?.text ?? step?.value ?? ""),
    value: String(step?.value ?? step?.option ?? ""),
    target: String(step?.target || step?.label || step?.name || step?.field || step?.placeholder || ""),
    option: String(step?.option || ""),
    role: String(step?.role || ""),
    key: String(step?.key || ""),
    button: String(step?.button || step?.mouseButton || step?.mouse_button || "").toLowerCase().slice(0, 16),
    clickCount: Number.isFinite(+step?.clickCount) ? Math.max(1, Math.min(3, Math.floor(+step.clickCount))) : (Number.isFinite(+step?.click_count) ? Math.max(1, Math.min(3, Math.floor(+step.click_count))) : null),
    modifiers: Array.isArray(step?.modifiers) ? step.modifiers.map((m) => String(m || "").slice(0, 24)).slice(0, 6) : String(step?.modifiers || ""),
    clear: !!step?.clear,
    append: !!step?.append,
    absent: !!step?.absent,
    expect: String(step?.expect || ""),
    expectText: String(step?.expectText || step?.expect_text || step?.assertText || step?.assert_text || ""),
    expectSelector: String(step?.expectSelector || step?.expect_selector || step?.assertSelector || step?.assert_selector || ""),
    expectUrl: String(step?.expectUrl || step?.expect_url || ""),
    expectValue: String(step?.expectValue || step?.expect_value || ""),
    expectAbsent: !!(step?.expectAbsent || step?.expect_absent),
    amount: Number.isFinite(+step?.amount) ? Math.round(+step.amount) : null,
    x: Number.isFinite(+step?.x) ? +step.x : null,
    y: Number.isFinite(+step?.y) ? +step.y : null,
    toX: Number.isFinite(+step?.toX) ? +step.toX : (Number.isFinite(+step?.to_x) ? +step.to_x : null),
    toY: Number.isFinite(+step?.toY) ? +step.toY : (Number.isFinite(+step?.to_y) ? +step.to_y : null),
    dx: Number.isFinite(+step?.dx) ? +step.dx : null,
    dy: Number.isFinite(+step?.dy) ? +step.dy : null,
    percent: Number.isFinite(+step?.percent) ? Math.max(0, Math.min(100, +step.percent)) : null,
    duration: Number.isFinite(+step?.duration) ? Math.max(0, Math.min(2500, Math.round(+step.duration))) : null,
    checked: typeof step?.checked === "boolean" ? step.checked : null,
    ms: Number.isFinite(+step?.ms) ? Math.max(0, Math.min(8000, Math.round(+step.ms))) : null,
  }));
  return `(() => {
    var STEPS = ${JSON.stringify(safeSteps)};
    var delay = function(ms){ return new Promise(function(resolve){ setTimeout(resolve, ms); }); };
    var frame = function(){ return new Promise(function(resolve){ try { requestAnimationFrame(function(){ requestAnimationFrame(resolve); }); } catch(e){ setTimeout(resolve, 16); } }); };
    var clean = function(s){ s=String(s||''); var out='', sp=false; for (var k=0;k<s.length;k++){ var ch=s[k]; if (ch===' '||ch==='\\n'||ch==='\\t'||ch==='\\r'){ if(!sp){ out+=' '; sp=true; } } else { out+=ch; sp=false; } } return out.trim(); };
    var lower = function(s){ return clean(s).toLowerCase(); };
    var rootList = function(){
      // blocked：**够不着**的 iframe（跨域）。此前它们被静默跳过，contexts.iframes 只数同源的，
      // 模型看到 iframes:0 就以为页面没有嵌套内容，然后对着一个根本不在本文档里的元素
      // 无穷换选择器。Stripe 支付、第三方登录、嵌入式播放器全是这个形态。
      var out = [], seen = [], iframeCount = 0, shadowCount = 0, blocked = [];
      var push = function(root, depth){
        if (!root || seen.indexOf(root) >= 0 || depth > 5) return;
        seen.push(root); out.push(root);
        var all = [];
        try { all = Array.prototype.slice.call(root.querySelectorAll('*'), 0, 2200); } catch(e){}
        for (var i=0;i<all.length;i++){
          var el = all[i];
          try { if (el.shadowRoot) { shadowCount++; push(el.shadowRoot, depth + 1); } } catch(e1){}
          try { if (el.tagName === 'IFRAME') { if (el.contentDocument) { iframeCount++; push(el.contentDocument, depth + 1); } else { var _r = el.getBoundingClientRect(); blocked.push({ src: String(el.src || '').slice(0, 120), w: Math.round(_r.width), h: Math.round(_r.height) }); } } } catch(e2){ try { var _r2 = el.getBoundingClientRect(); blocked.push({ src: String(el.src || '').slice(0, 120), w: Math.round(_r2.width), h: Math.round(_r2.height) }); } catch(e3){} }
        }
      };
      push(document, 0);
      out.iframeCount = iframeCount; out.shadowCount = shadowCount; out.blockedFrames = blocked;
      return out;
    };
    var docs = function(){ return rootList().filter(function(r){ return r && r.nodeType === 9; }); };
    var qsa = function(sel){
      var out = [], rs = rootList();
      for (var d=0; d<rs.length; d++){ try { out = out.concat(Array.prototype.slice.call(rs[d].querySelectorAll(sel))); } catch(e){} }
      return out.filter(function(el, i){ return el && out.indexOf(el) === i; });
    };
    var qs = function(sel){ var rs = rootList(); for (var d=0; d<rs.length; d++){ try { var el = rs[d].querySelector(sel); if (el) return el; } catch(e){} } return null; };
    var rootOf = function(el){ try { return el && el.getRootNode ? el.getRootNode() : document; } catch(e){ return document; } };
    var parentDeep = function(el){ try { return el && (el.parentElement || (rootOf(el).host || null)); } catch(e){ return null; } };
    var closestDeep = function(el, sel){
      var cur = el, guard = 0;
      while (cur && cur.nodeType === 1 && guard++ < 80) {
        try { if (cur.matches && cur.matches(sel)) return cur; } catch(e){}
        cur = parentDeep(cur);
      }
      return null;
    };
    var containsDeep = function(parent, child){
      if (!parent || !child) return false;
      try { if (parent === child || (parent.contains && parent.contains(child))) return true; } catch(e){}
      for (var cur = child, guard = 0; cur && guard++ < 80; cur = parentDeep(cur)) { if (cur === parent) return true; }
      return false;
    };
    var deepElementFromPoint = function(doc, x, y){
      var top = null;
      try { top = (doc || document).elementFromPoint(x, y); } catch(e){}
      for (var guard=0; top && guard<8; guard++) {
        var next = null;
        try { if (top.shadowRoot && top.shadowRoot.elementFromPoint) next = top.shadowRoot.elementFromPoint(x, y); } catch(e1){}
        try {
          if (!next && top.tagName === 'IFRAME' && top.contentDocument) {
            var fr = top.getBoundingClientRect();
            next = top.contentDocument.elementFromPoint(x - fr.left, y - fr.top);
          }
        } catch(e2){}
        if (!next || next === top) break;
        top = next;
      }
      return top;
    };
    var findInside = function(el, sel){
      if (!el) return null;
      try { if (el.querySelector) { var hit = el.querySelector(sel); if (hit) return hit; } } catch(e){}
      try { if (el.shadowRoot) { var sh = el.shadowRoot.querySelector(sel); if (sh) return sh; } } catch(e2){}
      return null;
    };
    var styleOf = function(el){ try { return (el.ownerDocument.defaultView || window).getComputedStyle(el); } catch(e){ return null; } };
    var visible = function(el){ try { var r=el.getBoundingClientRect(); var cs=styleOf(el); return r.width>1 && r.height>1 && cs && cs.visibility!=='hidden' && cs.display!=='none' && Number(cs.opacity||1)>0.01; } catch(e){ return false; } };
    var disabled = function(el){ try { return !!(el.disabled || el.getAttribute('aria-disabled') === 'true' || closestDeep(el, '[disabled],[aria-disabled="true"]')); } catch(e){ return false; } };
    var modifiersOf = function(step){
      var raw = step && step.modifiers, parts = [];
      if (Array.isArray(raw)) parts = raw;
      else parts = String(raw || '').split(/[+,\s]+/);
      var out = { ctrlKey:false, metaKey:false, shiftKey:false, altKey:false };
      for (var i=0;i<parts.length;i++){
        var m = lower(parts[i]);
        if (!m) continue;
        if (m === 'ctrl' || m === 'control' || m === 'cmdorctrl') out.ctrlKey = true;
        else if (m === 'meta' || m === 'cmd' || m === 'command' || m === 'super') out.metaKey = true;
        else if (m === 'shift') out.shiftKey = true;
        else if (m === 'alt' || m === 'option') out.altKey = true;
      }
      return out;
    };
    var buttonOf = function(step){
      var b = lower(step && step.button);
      if (b === 'right' || b === 'secondary' || b === 'context') return 2;
      if (b === 'middle' || b === 'aux') return 1;
      return 0;
    };
    var brief = function(el){
      if (!el) return '';
      try {
        var s = el.tagName.toLowerCase();
        if (el.id) s += '#' + el.id.slice(0,32);
        var cls = String(el.className && el.className.baseVal ? el.className.baseVal : (el.className || '')).trim().split(/\\s+/).filter(Boolean).slice(0,3).join('.');
        if (cls) s += '.' + cls;
        var txt = clean(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.innerText || el.textContent || el.value || '').slice(0,56);
        return txt ? s + ' "' + txt + '"' : s;
      } catch(e){ return String(el && el.tagName || 'element'); }
    };
    var labelText = function(el){
      var bits = [];
      try { bits.push(el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title'), el.getAttribute('alt'), el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('data-testid'), el.getAttribute('autocomplete'), el.getAttribute('type')); } catch(e){}
      try { if (el.id) { var rt = rootOf(el); var lf = rt && rt.querySelector ? rt.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null; if (!lf && el.ownerDocument) lf = el.ownerDocument.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (lf) bits.push(lf.innerText || lf.textContent); } } catch(e){}
      try { var lab = closestDeep(el, 'label'); if (lab) bits.push(lab.innerText || lab.textContent); } catch(e){}
      try { var host = rootOf(el).host; if (host) bits.push(host.getAttribute('aria-label'), host.getAttribute('title'), host.getAttribute('data-testid'), host.getAttribute('id'), host.getAttribute('class')); } catch(e){}
      try { var anc = closestDeep(el, '[aria-label],[title],[data-testid]'); if (anc && anc !== el) bits.push(anc.getAttribute('aria-label'), anc.getAttribute('title'), anc.getAttribute('data-testid')); } catch(e){}
      try { if (!/^(INPUT|TEXTAREA|SELECT)$/i.test(el.tagName)) bits.push(el.innerText || el.textContent); } catch(e){}
      return lower(bits.filter(Boolean).join(' '));
    };
    var textTarget = function(sel){
      var m = String(sel||'').match(/^([\\s\\S]*?):(?:has-text|text|contains)\\(\\s*(['"]?)([\\s\\S]*?)\\2\\s*\\)\\s*$/i)
        || String(sel||'').match(/^([\\s\\S]*?)\\s*\\btext\\s*=\\s*(['"]?)([\\s\\S]+?)\\2\\s*$/i);
      if (!m) return null;
      var prefix = clean(m[1] || '') || '*', txt = String(m[3] || '');
      var pool = []; try { pool = qsa(prefix); } catch(e){ try { pool = qsa('*'); } catch(e2){} }
      var hits = pool.filter(function(el){ return visible(el) && (el.textContent||'').indexOf(txt) >= 0; });
      hits.sort(function(a,b){ return (a.textContent||'').length - (b.textContent||'').length; });
      var pick = hits[0] || null;
      if (pick) {
        var clicky = closestDeep(pick, 'a,button,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[onclick],label,summary,input[type=button],input[type=submit],input[type=checkbox],input[type=radio]');
        if (clicky && (clicky.textContent||'').indexOf(txt) >= 0) pick = clicky;
      }
      return pick;
    };
    var selectorFor = function(step){
      if (step.node !== null && step.node !== undefined) return '[data-mnode="' + step.node + '"]';
      if (step.index !== null && step.index !== undefined) return '[data-mref="' + step.index + '"]';
      return step.selector || '';
    };
    var destinationStep = function(step){
      if (!step) return null;
      if (step.toNode !== null && step.toNode !== undefined) return { node:step.toNode, target:step.toTarget || '', role:step.toRole || '' };
      if (step.toIndex !== null && step.toIndex !== undefined) return { index:step.toIndex, target:step.toTarget || '', role:step.toRole || '' };
      if (step.toSelector) return { selector:step.toSelector, target:step.toTarget || '', role:step.toRole || '' };
      if (step.toTarget || step.toRole) return { target:step.toTarget || '', role:step.toRole || '' };
      return null;
    };
    var semanticTarget = function(step, mode){
      var want = lower(step.target || ((mode === 'click' || mode === 'wait') ? step.text : ''));
      var role = lower(step.role || '');
      if (!want && !role) return null;
      var sel = mode === 'type'
        ? 'input:not([type=hidden]),textarea,select,[contenteditable=""],[contenteditable=true]'
        : 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=checkbox],[role=switch],[role=radio],[role=option],[role=combobox],[role=slider],[onclick],[draggable=true],[data-radix-collection-item],[data-state],[contenteditable=""],[contenteditable=true],summary,label';
      var pool = qsa(sel).filter(visible), scored = [];
      for (var i=0;i<pool.length;i++){
        var el = pool[i], lt = labelText(el), sc = 0;
        if (want && lt === want) sc += 120;
        if (want && lt.indexOf(want) >= 0) sc += 70;
        if (want && want.indexOf(lt) >= 0 && lt.length >= 2) sc += 20;
        if (role && lower(el.getAttribute('role') || el.tagName).indexOf(role) >= 0) sc += 30;
        if (role === 'slider' && (el.getAttribute('role') === 'slider' || lower(el.getAttribute('type')) === 'range')) sc += 80;
        if ((role === 'switch' || role === 'checkbox') && (el.getAttribute('role') === role || lower(el.getAttribute('type')) === role)) sc += 80;
        if (disabled(el)) sc -= 200;
        if (sc > 0) scored.push({ el:el, score:sc, len:lt.length });
      }
      scored.sort(function(a,b){ return (b.score - a.score) || (a.len - b.len); });
      return scored[0] ? scored[0].el : null;
    };
    var findTarget = function(step, mode){
      var sel = selectorFor(step);
      var el = null;
      if (sel) {
        try { el = qs(sel); } catch(e) {}
        if (!el && /:(?:has-text|text|contains)\\(|(?:^|[\\s,])text\\s*=/i.test(sel)) el = textTarget(sel);
      }
      if (!el) el = semanticTarget(step, mode || 'click');
      return el;
    };
    var candidateHints = function(step, mode){
      var want = lower((step && (step.target || step.text || step.selector)) || ''), role = lower(step && step.role || '');
      var sel = mode === 'type'
        ? 'input:not([type=hidden]),textarea,select,[contenteditable=""],[contenteditable=true]'
        : 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=checkbox],[role=switch],[role=radio],[role=option],[role=combobox],[role=slider],[onclick],[draggable=true],[data-radix-collection-item],[data-state],[contenteditable=""],[contenteditable=true],summary,label';
      var pool = [];
      try { pool = qsa(sel).filter(visible); } catch(e){}
      var scored = [];
      for (var i=0;i<pool.length;i++){
        var el = pool[i], lt = labelText(el), sc = 0;
        if (want && lt.indexOf(want) >= 0) sc += 60;
        if (role && lower(el.getAttribute('role') || el.tagName).indexOf(role) >= 0) sc += 35;
        if (!want && !role) sc += 1;
        if (disabled(el)) sc -= 60;
        if (sc > 0) scored.push({ el:el, score:sc, text:lt });
      }
      scored.sort(function(a,b){ return b.score - a.score; });
      return scored.slice(0, 6).map(function(x){ return brief(x.el); }).filter(Boolean);
    };
    var clickableOf = function(el){
      if (!el) return null;
      try {
        var sel = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=checkbox],[role=switch],[role=radio],[role=option],[role=combobox],[role=slider],[onclick],[draggable=true],[data-radix-collection-item],[data-state],[contenteditable=""],[contenteditable=true],summary,label';
        if (el.matches && el.matches(sel)) return el;
        var c = closestDeep(el, sel);
        return c || el;
      } catch(e){ return el; }
    };
    var inputOf = function(el){
      if (!el) return null;
      try {
        if (el.tagName === 'LABEL' && el.control) return el.control;
        if (el.matches && el.matches('input:not([type=hidden]),textarea,select,[contenteditable=""],[contenteditable=true]')) return el;
        var nested = findInside(el, 'input:not([type=hidden]),textarea,select,[contenteditable=""],[contenteditable=true]');
        return nested || el;
      } catch(e){ return el; }
    };
    var actionVariants = function(raw, mode){
      var out = [], seen = [];
      var push = function(el){
        if (!el || seen.indexOf(el) >= 0) return;
        seen.push(el); out.push(el);
      };
      push(mode === 'type' ? inputOf(raw) : clickableOf(raw));
      push(raw);
      try { if (mode === 'type') push(findInside(raw, 'input:not([type=hidden]),textarea,select,[contenteditable=""],[contenteditable=true]')); } catch(e){}
      try { if (mode !== 'type') push(findInside(raw, 'button,a[href],[role=button],[role=menuitem],[role=option],input:not([type=hidden]),[onclick],[data-radix-collection-item],[data-state]')); } catch(e2){}
      try { var host = rootOf(raw).host; if (host) push(mode === 'type' ? inputOf(host) : clickableOf(host)); } catch(e3){}
      return out.filter(Boolean);
    };
    var actionPoint = function(el){
      var doc = el.ownerDocument || document, win = doc.defaultView || window, r = el.getBoundingClientRect();
      var pts = [[0.5,0.5],[0.25,0.5],[0.75,0.5],[0.5,0.25],[0.5,0.75]];
      var last = null;
      for (var i=0;i<pts.length;i++){
        var x = Math.max(1, Math.min((win.innerWidth || 1) - 2, r.left + r.width * pts[i][0]));
        var y = Math.max(1, Math.min((win.innerHeight || 1) - 2, r.top + r.height * pts[i][1]));
        var top = null; try { top = deepElementFromPoint(doc, x, y); } catch(e){}
        last = top;
        if (top && (top === el || containsDeep(el, top) || containsDeep(top, el))) return { ok:true, x:x, y:y, top:top };
      }
      return { ok:false, x:Math.round(r.left + r.width/2), y:Math.round(r.top + r.height/2), top:last };
    };
    var pointFromStep = function(step, el, fallback){
      var doc = (el && el.ownerDocument) || document, win = doc.defaultView || window, r = null;
      try { r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null; } catch(e){}
      var base = fallback || (r ? { x:r.left + r.width/2, y:r.top + r.height/2 } : { x:(win.innerWidth||1)/2, y:(win.innerHeight||1)/2 });
      var x = step.x !== null && step.x !== undefined ? Number(step.x) : base.x;
      var y = step.y !== null && step.y !== undefined ? Number(step.y) : base.y;
      if (r && Math.abs(x) <= 1 && Math.abs(y) <= 1) { x = r.left + r.width * x; y = r.top + r.height * y; }
      return { x:Math.max(1, Math.min((win.innerWidth||1)-2, x)), y:Math.max(1, Math.min((win.innerHeight||1)-2, y)) };
    };
    var endPointFromStep = function(step, el, start){
      var doc = (el && el.ownerDocument) || document, win = doc.defaultView || window, r = null;
      try { r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null; } catch(e){}
      var x = step.toX !== null && step.toX !== undefined ? Number(step.toX) : null;
      var y = step.toY !== null && step.toY !== undefined ? Number(step.toY) : null;
      var dstStep = destinationStep(step);
      if ((x === null || y === null) && dstStep) {
        var dst = findTarget(dstStep, 'click');
        if (dst) {
          try { dst.scrollIntoView({ block:'center', inline:'center', behavior:'instant' }); } catch(e){ try { dst.scrollIntoView({ block:'center', inline:'center' }); } catch(e2){} }
          var dp = actionPoint(clickableOf(dst) || dst);
          if (dp && dp.x != null && dp.y != null) { x = dp.x; y = dp.y; }
        }
      }
      if (r && x !== null && y !== null && Math.abs(x) <= 1 && Math.abs(y) <= 1) { x = r.left + r.width * x; y = r.top + r.height * y; }
      if (x === null) x = start.x + (step.dx !== null && step.dx !== undefined ? Number(step.dx) : 0);
      if (y === null) y = start.y + (step.dy !== null && step.dy !== undefined ? Number(step.dy) : 0);
      if (r && step.percent !== null && step.percent !== undefined) {
        var pct = Math.max(0, Math.min(100, Number(step.percent))) / 100;
        x = r.left + Math.max(2, r.width - 4) * pct + 2;
        y = r.top + r.height / 2;
      }
      return { x:Math.max(1, Math.min((win.innerWidth||1)-2, x)), y:Math.max(1, Math.min((win.innerHeight||1)-2, y)) };
    };
    var actionable = async function(el){
      if (!el) return { ok:false, reason:'missing' };
      if (disabled(el)) return { ok:false, reason:'disabled', el:el };
      try { el.scrollIntoView({ block:'center', inline:'center', behavior:'instant' }); } catch(e){ try { el.scrollIntoView({ block:'center', inline:'center' }); } catch(e2){} }
      await frame(); await delay(25);
      if (!visible(el)) return { ok:false, reason:'not_visible', el:el };
      var cs = styleOf(el);
      if (cs && cs.pointerEvents === 'none') return { ok:false, reason:'pointer_events_none', el:el };
      var p = actionPoint(el);
      if (!p.ok) return { ok:false, reason:'covered', el:el, blocker:p.top, point:p };
      return { ok:true, el:el, point:p };
    };
    var pointer = function(el, name, p, down, opts){
      var doc = el && el.nodeType === 9 ? el : ((el && el.ownerDocument) || document);
      var target = el || doc;
      opts = opts || {};
      var button = opts.button == null ? 0 : opts.button;
      var common = Object.assign({ bubbles:true, cancelable:true, composed:true, view:(doc.defaultView || window), clientX:p.x, clientY:p.y, screenX:p.x, screenY:p.y, button:button, buttons:down ? (button === 2 ? 2 : button === 1 ? 4 : 1) : 0, detail:opts.detail || 1 }, opts.modifiers || {});
      try {
        if (/^pointer/.test(name) && typeof PointerEvent !== 'undefined') {
          var pi = Object.assign({}, common, { pointerId:1, pointerType:'mouse', isPrimary:true, width:1, height:1, pressure:down ? 0.5 : 0 });
          target.dispatchEvent(new PointerEvent(name, pi)); return;
        }
      } catch(e){}
      var mouse = name.replace(/^pointer/, 'mouse');
      try { target.dispatchEvent(new MouseEvent(mouse, common)); } catch(e){}
    };
    var mouseEvent = function(el, name, p, opts){
      try {
        opts = opts || {};
        var doc = (el && el.ownerDocument) || document;
        var init = Object.assign({ bubbles:true, cancelable:true, composed:true, view:(doc.defaultView||window), clientX:p.x, clientY:p.y, screenX:p.x, screenY:p.y, button:opts.button || 0, buttons:0, detail:opts.detail || 1 }, opts.modifiers || {});
        el.dispatchEvent(new MouseEvent(name, init));
      } catch(e){}
    };
    var dragEvent = function(el, name, p, data){
      try {
        if (typeof DragEvent === 'undefined') return;
        var doc = (el && el.ownerDocument) || document, ev = new DragEvent(name, { bubbles:true, cancelable:true, composed:true, view:(doc.defaultView||window), clientX:p.x, clientY:p.y, dataTransfer:data || undefined });
        el.dispatchEvent(ev);
      } catch(e){}
    };
    var elementAt = function(el, p){
      try { return ((el && el.ownerDocument) || document).elementFromPoint(p.x, p.y) || el; } catch(e){ return el; }
    };
    var scrollBoxOf = function(el){
      try {
        var cur = el && el.nodeType === 1 ? el : document.scrollingElement;
        while (cur && cur !== document.body && cur !== document.documentElement) {
          var cs = styleOf(cur);
          var oy = cs ? String(cs.overflowY || '') : '', ox = cs ? String(cs.overflowX || '') : '';
          if ((/(auto|scroll|overlay)/i.test(oy) && cur.scrollHeight > cur.clientHeight + 2) || (/(auto|scroll|overlay)/i.test(ox) && cur.scrollWidth > cur.clientWidth + 2)) return cur;
          cur = cur.parentElement;
        }
      } catch(e){}
      return document.scrollingElement || document.documentElement || document.body;
    };
    var smartHover = async function(raw, step){
      var variants = actionVariants(raw, 'click'), last = { ok:false, reason:'missing' };
      for (var vi=0; vi<variants.length; vi++) {
        var el = variants[vi], ready = await actionable(el);
        if (!ready.ok) { last = ready; continue; }
        var p = pointFromStep(step || {}, el, ready.point);
        try { pointer(el, 'pointerover', p, false); pointer(el, 'pointerenter', p, false); pointer(el, 'pointermove', p, false); pointer(el, 'mouseover', p, false); pointer(el, 'mouseenter', p, false); pointer(el, 'mousemove', p, false); } catch(e){}
        return { ok:true, el:el, point:p, recovered:vi>0 };
      }
      return last;
    };
    var smartClick = async function(raw, step){
      var variants = actionVariants(raw, 'click'), last = { ok:false, reason:'missing' };
      for (var vi=0; vi<variants.length; vi++) {
        var el = variants[vi], ready = await actionable(el);
        if (!ready.ok) { last = ready; continue; }
        var p = pointFromStep(step || {}, el, ready.point), button = buttonOf(step || {}), count = Math.max(1, Math.min(3, Number(step && step.clickCount) || ((step && /^(doubleclick|dblclick)$/.test(step.op)) ? 2 : 1))), mods = modifiersOf(step || {});
        var opts = { button:button, modifiers:mods };
        try { pointer(el, 'pointerover', p, false, opts); pointer(el, 'pointermove', p, false, opts); pointer(el, 'mouseover', p, false, opts); pointer(el, 'mousemove', p, false, opts); } catch(e){}
        try { pointer(el, 'pointerdown', p, true, opts); pointer(el, 'mousedown', p, true, opts); } catch(e){}
        if (step && /^(longpress|hold)$/.test(step.op)) await delay(Math.max(350, Math.min(2500, Number(step.duration) || 700)));
        try { if (typeof el.focus === 'function') el.focus({ preventScroll:true }); } catch(e){ try { el.focus(); } catch(e2){} }
        try { pointer(el, 'pointerup', p, false, opts); pointer(el, 'mouseup', p, false, opts); } catch(e){}
        if (button === 2 || (step && /^(rightclick|contextmenu|longpress|hold)$/.test(step.op))) {
          mouseEvent(el, 'contextmenu', p, Object.assign({}, opts, { detail:1 }));
          return { ok:true, el:el, point:p, recovered:vi>0 };
        }
        try {
          if (count === 1 && !mods.ctrlKey && !mods.metaKey && !mods.shiftKey && !mods.altKey) el.click();
          else {
            for (var ci=1; ci<=count; ci++) mouseEvent(el, 'click', p, Object.assign({}, opts, { detail:ci }));
            if (count >= 2) mouseEvent(el, 'dblclick', p, Object.assign({}, opts, { detail:2 }));
          }
        } catch(e){ try { mouseEvent(el, 'click', p, opts); } catch(e2){ last = { ok:false, reason:String(e2 && e2.message || e2), el:el }; continue; } }
        return { ok:true, el:el, point:p, recovered:vi>0 };
      }
      return last;
    };
    var smartDrag = async function(raw, step){
      var el = clickableOf(raw), ready = await actionable(el);
      if (!ready.ok) return ready;
      var start = pointFromStep(step || {}, el, ready.point), end = endPointFromStep(step || {}, el, start);
      var duration = Math.max(80, Math.min(2500, Number(step && step.duration) || 420));
      var doc = el.ownerDocument || document, dataTransfer = null;
      try { dataTransfer = typeof DataTransfer !== 'undefined' ? new DataTransfer() : null; } catch(e){}
      try { pointer(el, 'pointerover', start, false); pointer(el, 'pointermove', start, false); pointer(el, 'mousemove', start, false); } catch(e){}
      try { pointer(el, 'pointerdown', start, true); pointer(el, 'mousedown', start, true); } catch(e){}
      dragEvent(el, 'dragstart', start, dataTransfer);
      var steps = Math.max(4, Math.min(24, Math.round(duration / 35)));
      for (var i=1;i<=steps;i++){
        var t = i / steps, p = { x:start.x + (end.x - start.x) * t, y:start.y + (end.y - start.y) * t };
        var target = elementAt(el, p) || el;
        pointer(target, 'pointermove', p, true); pointer(target, 'mousemove', p, true);
        pointer(doc, 'pointermove', p, true); pointer(doc, 'mousemove', p, true);
        dragEvent(el, 'drag', p, dataTransfer); if (target && target !== el) { dragEvent(target, 'dragenter', p, dataTransfer); dragEvent(target, 'dragover', p, dataTransfer); }
        if (i < steps) await delay(Math.max(8, Math.round(duration / steps)));
      }
      var upTarget = elementAt(el, end) || el;
      try { pointer(upTarget, 'pointerup', end, false); pointer(upTarget, 'mouseup', end, false); } catch(e){}
      dragEvent(upTarget, 'drop', end, dataTransfer); dragEvent(el, 'dragend', end, dataTransfer);
      return { ok:true, el:el, start:start, end:end };
    };
    var sliderTrackBox = function(el){
      var er = null; try { er = el.getBoundingClientRect(); } catch(e){}
      var candidates = [];
      try { candidates.push(el.closest('[data-radix-slider-root],[data-orientation],[role=slider]')); } catch(e){}
      try { candidates.push(el.parentElement, el.parentElement && el.parentElement.parentElement, el); } catch(e){}
      for (var i=0;i<candidates.length;i++){
        var c = candidates[i]; if (!c || !visible(c)) continue;
        try {
          var r = c.getBoundingClientRect();
          if (!er || r.width >= er.width * 2 || r.height >= er.height * 2 || c === el) return { el:c, rect:r };
        } catch(e){}
      }
      return er ? { el:el, rect:er } : null;
    };
    var setSlider = async function(raw, step){
      var el = raw, ready = await actionable(el);
      if (!ready.ok) return ready;
      var pct = step.percent !== null && step.percent !== undefined ? Math.max(0, Math.min(100, Number(step.percent))) : null;
      var value = step.value || step.text || '';
      if (el.tagName === 'INPUT' && lower(el.getAttribute('type')) === 'range') {
        var min = Number(el.min || 0), max = Number(el.max || 100), val = value !== '' ? Number(value) : (pct == null ? Number(el.value || min) : min + (max - min) * pct / 100);
        if (!Number.isFinite(val)) val = min;
        nativeSet(el, String(Math.max(min, Math.min(max, val))));
        return { ok:true, el:el, value:String(el.value || val) };
      }
      var arMin = Number(el.getAttribute('aria-valuemin') || 0), arMax = Number(el.getAttribute('aria-valuemax') || 100);
      var arVal = value !== '' ? Number(value) : (pct == null ? Number(el.getAttribute('aria-valuenow') || arMin) : arMin + (arMax - arMin) * pct / 100);
      if (Number.isFinite(arVal)) {
        try { el.setAttribute('aria-valuenow', String(Math.max(arMin, Math.min(arMax, arVal)))); } catch(e){}
      }
      if (pct !== null) {
        var box = sliderTrackBox(el);
        if (box && box.rect) {
          var vertical = /vertical/i.test(el.getAttribute('aria-orientation') || el.getAttribute('data-orientation') || (box.el && box.el.getAttribute && box.el.getAttribute('data-orientation')) || '');
          var end = vertical
            ? { toX: box.rect.left + box.rect.width / 2, toY: box.rect.bottom - Math.max(2, box.rect.height - 4) * pct / 100 - 2 }
            : { toX: box.rect.left + Math.max(2, box.rect.width - 4) * pct / 100 + 2, toY: box.rect.top + box.rect.height / 2 };
          return smartDrag(el, Object.assign({}, step, end, { percent:null }));
        }
      }
      return smartDrag(el, Object.assign({}, step, pct == null ? {} : { percent:pct }));
    };
    var toggleControl = async function(raw, step){
      var el = clickableOf(raw);
      var want = step.checked;
      var readChecked = function(node){
        var cur = null;
        try {
          if ('checked' in node) cur = !!node.checked;
          else if (node.getAttribute('aria-checked') != null) cur = node.getAttribute('aria-checked') === 'true';
          else if (node.getAttribute('data-state')) cur = /checked|on|open/i.test(node.getAttribute('data-state'));
        } catch(e){}
        return cur;
      };
      var current = readChecked(el);
      if (want === null || want === undefined || current === null || current !== want) {
        var clicked = await smartClick(el, step);
        if (!clicked.ok) return clicked;
        if (want !== null && want !== undefined) {
          await delay(60);
          var after = readChecked(clicked.el || el);
          if (after !== null && after !== want) return { ok:false, reason:'checked_not_applied', el:clicked.el || el, actual:after };
        }
        return clicked;
      }
      return { ok:true, el:el, unchanged:true };
    };
    var verifyExpectations = function(step, el){
      var checks = [], fail = null, text = step.expectText || step.expect || '', sel = step.expectSelector || '', url = step.expectUrl || '', val = step.expectValue || '';
      var pageText = function(){
        var bits = [], rs = rootList();
        for (var i=0;i<rs.length;i++) {
          try {
            if (rs[i].body) bits.push(rs[i].body.innerText || rs[i].body.textContent || '');
            else if (rs[i].host) bits.push(rs[i].host.innerText || rs[i].host.textContent || '');
          } catch(e){}
        }
        return clean(bits.join(' '));
      };
      if (text) {
        var okText = lower(pageText()).indexOf(lower(text)) >= 0;
        checks.push('text:' + (okText ? 'ok' : 'missing'));
        if (!okText) fail = fail || { reason:'expect_text_missing', expected:text };
      }
      if (sel) {
        var found = false;
        try { found = !!qs(sel); } catch(e){}
        var okSel = step.expectAbsent ? !found : found;
        checks.push('selector:' + (okSel ? 'ok' : (step.expectAbsent ? 'still_present' : 'missing')));
        if (!okSel) fail = fail || { reason: step.expectAbsent ? 'expect_selector_still_present' : 'expect_selector_missing', expected:sel };
      }
      if (url) {
        var okUrl = String(location.href || '').indexOf(url) >= 0;
        checks.push('url:' + (okUrl ? 'ok' : 'mismatch'));
        if (!okUrl) fail = fail || { reason:'expect_url_mismatch', expected:url, actual:String(location.href || '') };
      }
      if (val) {
        var input = inputOf(el || document.activeElement), actual = '';
        try { actual = input && input.isContentEditable ? clean(input.textContent || '') : String(input && input.value || ''); } catch(e){}
        var okVal = actual.indexOf(String(val)) >= 0;
        checks.push('value:' + (okVal ? 'ok' : 'mismatch'));
        if (!okVal) fail = fail || { reason:'expect_value_mismatch', expected:val, actual:actual };
      }
      return fail ? Object.assign({ ok:false, checks:checks }, fail) : { ok:true, checks:checks };
    };
    var fire = function(el, name, extra){ try {
      if (name === 'input' && typeof InputEvent !== 'undefined') el.dispatchEvent(new InputEvent('input', Object.assign({ bubbles:true, cancelable:true, inputType:'insertText' }, extra || {})));
      else el.dispatchEvent(new Event(name, { bubbles:true, cancelable:true }));
    } catch(e){ try { el.dispatchEvent(new Event(name, { bubbles:true })); } catch(e2){} } };
    var nativeSet = function(el, value){
      if (el.isContentEditable) {
        try { el.focus(); } catch(e){}
        try { document.execCommand && document.execCommand('selectAll', false, null); } catch(e){}
        try { document.execCommand && document.execCommand('insertText', false, value); } catch(e){ el.textContent = value; }
        if (clean(el.textContent || '') !== clean(value)) el.textContent = value;
        fire(el, 'input', { data:value }); fire(el, 'change');
        return true;
      }
      if (el.tagName === 'SELECT') {
        var opts = Array.prototype.slice.call(el.options || []), want = String(value);
        var hit = opts.find(function(o){ return String(o.value) === want; }) || opts.find(function(o){ return clean(o.textContent) === clean(want); }) || opts.find(function(o){ return lower(o.textContent).indexOf(lower(want)) >= 0; });
        if (hit) want = hit.value;
        try { var sd = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value'); if (sd && sd.set) sd.set.call(el, want); else el.value = want; } catch(e){ el.value = want; }
        fire(el, 'input', { data:want }); fire(el, 'change');
        return true;
      }
      if ('value' in el) {
        try {
          var proto = Object.getPrototypeOf(el), desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
          var base = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          var desc2 = Object.getOwnPropertyDescriptor(base, 'value');
          (desc && desc.set ? desc : desc2).set.call(el, value);
        } catch(e){ try { el.value = value; } catch(e2){ return false; } }
        fire(el, 'beforeinput', { data:value }); fire(el, 'input', { data:value }); fire(el, 'change');
        return true;
      }
      return false;
    };
    var typeInto = function(el, value, step){
      el = inputOf(el);
      if (!el) return { ok:false, reason:'missing_input' };
      if (disabled(el)) return { ok:false, reason:'disabled', el:el };
      try { el.scrollIntoView({ block:'center', inline:'center' }); } catch(e){}
      try { el.focus(); } catch(e){}
      try { el.click(); } catch(e){}
      if (step && step.append && !el.isContentEditable && el.tagName !== 'SELECT') value = String(el.value || '') + String(value);
      if (step && step.append && el.isContentEditable) value = String(el.textContent || '') + String(value);
      if (step && step.clear) value = '';
      if (!nativeSet(el, String(value))) return { ok:false, reason:'not_editable', el:el };
      var actual = el.isContentEditable ? clean(el.textContent || '') : String(el.value || '');
      if (el.tagName === 'SELECT') {
        try { actual = clean((el.selectedOptions && el.selectedOptions[0] && (el.selectedOptions[0].textContent || el.selectedOptions[0].value)) || el.value || ''); } catch(e){}
        return { ok:true, el:el, actual:actual };
      }
      var ok = actual === String(value) || actual.indexOf(String(value)) >= 0 || String(value).indexOf(actual) >= 0;
      return ok ? { ok:true, el:el, actual:actual } : { ok:false, reason:'value_not_applied', el:el, actual:actual };
    };
    var findOption = function(value){
      var want = lower(value || '');
      var pool = qsa('[role=option],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[data-radix-collection-item],[cmdk-item],[data-value],option,li,button').filter(visible);
      var scored = [];
      for (var i=0;i<pool.length;i++){
        var el = pool[i], lt = labelText(el) || lower(el.textContent || el.value || ''), sc = 0;
        if (!want) sc += 1;
        if (want && lt === want) sc += 120;
        if (want && lt.indexOf(want) >= 0) sc += 70;
        try { if (want && lower(el.getAttribute('data-value') || el.getAttribute('value') || '') === want) sc += 100; } catch(e){}
        if (disabled(el)) sc -= 200;
        if (sc > 0) scored.push({ el:el, score:sc, len:lt.length });
      }
      scored.sort(function(a,b){ return (b.score - a.score) || (a.len - b.len); });
      return scored[0] ? scored[0].el : null;
    };
    var selectOption = async function(raw, step){
      var wanted = step.option || step.value || step.text || '';
      var input = inputOf(raw);
      if (input && input.tagName === 'SELECT') return typeInto(input, wanted, step);
      var before = signature(), opened = await smartClick(raw, step);
      if (!opened.ok) return opened;
      await settleAfter(before, 70, 420); await delay(80);
      var opt = findOption(wanted);
      if (!opt) return { ok:false, reason:'option_not_found', el:raw, actual:wanted };
      var chosen = await smartClick(opt);
      if (!chosen.ok) return chosen;
      return { ok:true, el:opt, actual:clean(opt.innerText || opt.textContent || opt.value || wanted) };
    };
    var pressKey = function(key, step){
      var el = document.activeElement || document.body;
      var mods = modifiersOf(step || {});
      var parts = String(key || 'Enter').split('+').map(function(p){ return clean(p); }).filter(Boolean);
      var finalKey = parts.length > 1 ? parts[parts.length - 1] : String(key || 'Enter');
      if (parts.length > 1) mods = modifiersOf({ modifiers:parts.slice(0, -1) });
      var init = Object.assign({ key:finalKey, code:finalKey, bubbles:true, cancelable:true }, mods);
      try { el.dispatchEvent(new KeyboardEvent('keydown', init)); } catch(e){}
      try { el.dispatchEvent(new KeyboardEvent('keypress', init)); } catch(e){}
      if (/^Enter$/i.test(finalKey) && el && el.form && typeof el.form.requestSubmit === 'function') { try { el.form.requestSubmit(); } catch(e){} }
      try { el.dispatchEvent(new KeyboardEvent('keyup', init)); } catch(e){}
    };
    var mutationVersion = 0, observer = null;
    try {
      // 只监听 task-container 的变化（自动化交互区域），避免全树高频触发
      var targetEl = document.querySelector('.task-container, .chat-session-container');
      if (targetEl) {
        observer = new MutationObserver(function(){ mutationVersion++; });
        observer.observe(targetEl, { subtree:true, childList:true }); // 只监听 DOM 增减，不监听属性/文本变化
      }
    } catch(e){}
    var signature = function(){
      try { return [location.href, mutationVersion, document.readyState, document.body ? document.body.innerText.length : 0, document.querySelectorAll('*').length].join('|'); }
      catch(e){ return String(Date.now()); }
    };
    var settleAfter = async function(before, minMs, maxMs){
      await frame(); await delay(minMs || 60);
      var end = Date.now() + (maxMs || 420), after = signature();
      while (Date.now() < end) {
        if (after !== before) return 'changed';
        await delay(55); after = signature();
      }
      return after !== before ? 'changed' : 'stable';
    };
    var nodeList = function(){
      try { qsa('[data-mnode]').forEach(function(e){ e.removeAttribute('data-mnode'); }); } catch(e){}
      var SEL = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=menu],[role=menuitem],[role=menuitemcheckbox],[role=listbox],[role=option],[role=checkbox],[role=switch],[role=radio],[role=combobox],[role=slider],[onclick],[draggable=true],[data-radix-collection-item],[data-state],[data-value],[cmdk-item],[contenteditable=""],[contenteditable=true],summary,label';
      var roleOf = function(el){ var r=el.getAttribute('role'); if (r) return r; var tag=el.tagName.toLowerCase(); if(tag==='a')return'link'; if(tag==='button')return'button'; if(tag==='input'){ var ty=(el.getAttribute('type')||'text').toLowerCase(); if(ty==='checkbox')return'checkbox'; if(ty==='radio')return'radio'; if(ty==='submit'||ty==='button'||ty==='reset'||ty==='image')return'button'; if(ty==='range')return'slider'; if(ty==='file')return'file'; return'textbox'; } if(tag==='select')return'combobox'; if(tag==='textarea')return'textbox'; if(tag==='summary')return'summary'; if(tag==='label')return'label'; return tag; };
      var nameOf = function(el){ return clean(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || (el.tagName==='INPUT'||el.tagName==='SELECT'||el.tagName==='TEXTAREA' ? '' : (el.innerText||el.textContent||'')) || el.getAttribute('name') || '').slice(0,52); };
      var stateOf = function(el){ var s={}; if(el.disabled||el.getAttribute('aria-disabled')==='true')s.disabled=true; if(el.checked||el.getAttribute('aria-checked')==='true')s.checked=true; var exp=el.getAttribute('aria-expanded'); if(exp!=null)s.expanded=(exp==='true'); if(el.getAttribute('aria-selected')==='true')s.selected=true; if((el.tagName==='INPUT'||el.tagName==='TEXTAREA'||el.tagName==='SELECT')&&el.value)s.value=String(el.value).slice(0,32); return s; };
      var roots = rootList();
      var nodes=[], id=0, els=[]; try { els = qsa(SEL).slice(0, 1500); } catch(e){}
      for (var i=0;i<els.length && id<110;i++){ var el=els[i], r; try{ r=el.getBoundingClientRect(); }catch(e){ continue; } if(!visible(el)) continue; el.setAttribute('data-mnode', String(id)); var inView=!(r.bottom<=0||r.right<=0||r.top>=innerHeight||r.left>=innerWidth); var node={ i:id, r:roleOf(el), n:nameOf(el) }; var st=stateOf(el); for(var kk in st){ node.s=st; break; } if(!inView)node.off=1; nodes.push(node); id++; }
      var heads=[]; try { heads = qsa('h1,h2,h3').slice(0, 20).map(function(h){ return { r:'h'+(h.tagName.charAt(1)), n:clean(h.innerText||'').slice(0,56) }; }).filter(function(h){ return h.n; }).slice(0,12); } catch(e){}
      return { url:location.href, title:clean(document.title).slice(0,80), ready:document.readyState, active:brief(document.activeElement), contexts:{ roots:roots.length, iframes:roots.iframeCount||0, shadowRoots:roots.shadowCount||0, crossOriginFrames:(roots.blockedFrames||[]).slice(0,6) }, total:id, structure:heads, nodes:nodes, legend:'fast_batch/observe 后的节点快照；i=节点号，用 browser click/type node=i 继续；off=1 先 scroll；contexts.iframes/shadowRoots=已纳入的同源上下文；contexts.crossOriginFrames=够不着的跨域 iframe，其内元素不在本快照里' };
    };
    return (async function(){
      var log = [], broken = false, failed = null;
      var expectSuffix = function(v){ return v && v.checks && v.checks.length ? ' verify=' + v.checks.join(',') : ''; };
      for (var i=0; i<STEPS.length && !broken; i++) {
        var s = STEPS[i] || {}, op = s.op || '', label = selectorFor(s) || s.target || ((op === 'click' || op === 'wait' || op === 'hover') ? s.text : '') || op;
        try {
          if (op === 'locate') {
            // 只定位不动手：用 click 同一套目标解析（selector/node/text/role + 可点性判断），把选中的元素
            // 打上 data-mfind，让 Rust 侧的 browser_click / browser_type 按 '[data-mfind]' 走人类化 CDP
            // （trusted 事件 + 真实轨迹）。以前单步 click 全程在这段页内脚本里用合成事件点，
            // isTrusted=false，遇到只认 trusted 事件的站点就"点了没反应"。
            try { document.querySelectorAll('[data-mfind]').forEach(function(e){ e.removeAttribute('data-mfind'); }); } catch(e){}
            var lel = findTarget(s, s.kind === 'type' ? 'type' : 'click');
            if (!lel) { var lch = candidateHints(s, 'click'); log.push((i+1)+'. locate ✗ 找不到 ' + label + (lch.length ? ' candidates=' + lch.join(' | ') : '')); failed = { step:i+1, op:op, reason:'not_found', target:label, candidates:lch }; broken = true; break; }
            var lr = await actionable(lel);
            if (!lr.ok) { var lblocker = lr.blocker ? brief(lr.blocker) : ''; log.push((i+1)+'. locate ✗ ' + lr.reason + (lblocker ? ' blockedBy=' + lblocker : '') + ' target=' + brief(lr.el || lel)); failed = { step:i+1, op:op, reason:lr.reason, target:brief(lr.el || lel), blocker:lblocker }; broken = true; break; }
            try { lel.setAttribute('data-mfind', '1'); } catch(e){}
            log.push((i+1)+'. locate ' + label + ' ✓ ' + brief(lel) + ' @' + Math.round(lr.point.x) + ',' + Math.round(lr.point.y));
          } else if (op === 'click' || op === 'tap' || op === 'dblclick' || op === 'doubleclick' || op === 'rightclick' || op === 'contextmenu' || op === 'longpress' || op === 'hold') {
            var el = findTarget(s, 'click');
            if (!el) { var ch = candidateHints(s, 'click'); log.push((i+1)+'. ' + op + ' ✗ 找不到 ' + label + (ch.length ? ' candidates=' + ch.join(' | ') : '')); failed = { step:i+1, op:op, reason:'not_found', target:label, candidates:ch }; broken = true; break; }
            var before = signature(), cr = await smartClick(el, s);
            if (!cr.ok) { var blocker = cr.blocker ? brief(cr.blocker) : ''; log.push((i+1)+'. click ✗ ' + cr.reason + (blocker ? ' blockedBy=' + blocker : '') + ' target=' + brief(cr.el || el)); failed = { step:i+1, op:op, reason:cr.reason, target:brief(cr.el || el), blocker:blocker }; broken = true; break; }
            var settled = await settleAfter(before, 70, 520);
            var cv = verifyExpectations(s, cr.el || el);
            if (!cv.ok) { log.push((i+1)+'. ' + op + ' ✗ ' + cv.reason + ' expected=' + clean(cv.expected || '') + expectSuffix(cv)); failed = { step:i+1, op:op, reason:cv.reason, expected:cv.expected || '', actual:cv.actual || '', checks:cv.checks || [] }; broken = true; break; }
            log.push((i+1)+'. ' + op + ' ' + label + ' ✓ ' + settled + (cr.recovered ? ' recovered' : '') + ' @' + Math.round(cr.point.x) + ',' + Math.round(cr.point.y) + expectSuffix(cv));
          } else if (op === 'hover' || op === 'move') {
            var hv = findTarget(s, 'click');
            if (!hv) { var hh = candidateHints(s, 'click'); log.push((i+1)+'. hover ✗ 找不到 ' + label + (hh.length ? ' candidates=' + hh.join(' | ') : '')); failed = { step:i+1, op:op, reason:'not_found', target:label, candidates:hh }; broken = true; break; }
            var hr = await smartHover(hv, s);
            if (!hr.ok) { var hblocker = hr.blocker ? brief(hr.blocker) : ''; log.push((i+1)+'. hover ✗ ' + hr.reason + (hblocker ? ' blockedBy=' + hblocker : '') + ' target=' + brief(hr.el || hv)); failed = { step:i+1, op:op, reason:hr.reason, target:brief(hr.el || hv), blocker:hblocker }; broken = true; break; }
            var hvx = verifyExpectations(s, hr.el || hv);
            if (!hvx.ok) { log.push((i+1)+'. hover ✗ ' + hvx.reason + ' expected=' + clean(hvx.expected || '') + expectSuffix(hvx)); failed = { step:i+1, op:op, reason:hvx.reason, expected:hvx.expected || '', actual:hvx.actual || '', checks:hvx.checks || [] }; broken = true; break; }
            log.push((i+1)+'. hover ' + label + ' ✓' + (hr.recovered ? ' recovered' : '') + ' @' + Math.round(hr.point.x) + ',' + Math.round(hr.point.y) + expectSuffix(hvx));
          } else if (op === 'drag' || op === 'slide' || op === 'swipe') {
            var dg = findTarget(s, op === 'slide' ? 'slider' : 'click');
            if (!dg && op === 'swipe' && (s.x !== null || s.y !== null || s.dx !== null || s.dy !== null || s.toX !== null || s.toY !== null)) dg = document.body;
            if (!dg) { var dh = candidateHints(s, op === 'slide' ? 'slider' : 'click'); log.push((i+1)+'. ' + op + ' ✗ 找不到 ' + label + (dh.length ? ' candidates=' + dh.join(' | ') : '')); failed = { step:i+1, op:op, reason:'not_found', target:label, candidates:dh }; broken = true; break; }
            var db = signature();
            var dr = op === 'slide' ? await setSlider(dg, s) : await smartDrag(dg, s);
            if (!dr.ok) { var dblocker = dr.blocker ? brief(dr.blocker) : ''; log.push((i+1)+'. ' + op + ' ✗ ' + dr.reason + (dblocker ? ' blockedBy=' + dblocker : '') + ' target=' + brief(dr.el || dg)); failed = { step:i+1, op:op, reason:dr.reason, target:brief(dr.el || dg), blocker:dblocker }; broken = true; break; }
            var ds = await settleAfter(db, 60, 520);
            var dv = verifyExpectations(s, dr.el || dg);
            if (!dv.ok) { log.push((i+1)+'. ' + op + ' ✗ ' + dv.reason + ' expected=' + clean(dv.expected || '') + expectSuffix(dv)); failed = { step:i+1, op:op, reason:dv.reason, expected:dv.expected || '', actual:dv.actual || '', checks:dv.checks || [] }; broken = true; break; }
            log.push((i+1)+'. ' + op + ' ' + label + ' ✓ ' + ds + (dr.end ? ' ' + Math.round(dr.start.x) + ',' + Math.round(dr.start.y) + '→' + Math.round(dr.end.x) + ',' + Math.round(dr.end.y) : (dr.value ? ' value=' + dr.value : '')) + expectSuffix(dv));
          } else if (op === 'toggle' || op === 'check' || op === 'uncheck') {
            var tg = findTarget(s, 'click');
            if (!tg) { var th = candidateHints(s, 'click'); log.push((i+1)+'. ' + op + ' ✗ 找不到 ' + label + (th.length ? ' candidates=' + th.join(' | ') : '')); failed = { step:i+1, op:op, reason:'not_found', target:label, candidates:th }; broken = true; break; }
            var wantChecked = op === 'check' ? true : (op === 'uncheck' ? false : s.checked);
            var tb = signature(), trr = await toggleControl(tg, Object.assign({}, s, { checked: wantChecked }));
            if (!trr.ok) { var tblocker = trr.blocker ? brief(trr.blocker) : ''; log.push((i+1)+'. ' + op + ' ✗ ' + trr.reason + (tblocker ? ' blockedBy=' + tblocker : '') + ' target=' + brief(trr.el || tg)); failed = { step:i+1, op:op, reason:trr.reason, target:brief(trr.el || tg), blocker:tblocker }; broken = true; break; }
            var ts = await settleAfter(tb, 40, 420);
            var tv = verifyExpectations(s, trr.el || tg);
            if (!tv.ok) { log.push((i+1)+'. ' + op + ' ✗ ' + tv.reason + ' expected=' + clean(tv.expected || '') + expectSuffix(tv)); failed = { step:i+1, op:op, reason:tv.reason, expected:tv.expected || '', actual:tv.actual || '', checks:tv.checks || [] }; broken = true; break; }
            log.push((i+1)+'. ' + op + ' ' + label + ' ✓ ' + (trr.unchanged ? 'unchanged' : ts) + expectSuffix(tv));
          } else if (op === 'select' || op === 'choose') {
            var sl = findTarget(s, 'click');
            if (!sl) { var sh = candidateHints(s, 'click'); log.push((i+1)+'. select ✗ 找不到 ' + label + (sh.length ? ' candidates=' + sh.join(' | ') : '')); failed = { step:i+1, op:op, reason:'not_found', target:label, candidates:sh }; broken = true; break; }
            var sv = s.option || s.value || s.text || '';
            var sr = await selectOption(sl, Object.assign({}, s, { option:sv }));
            if (!sr.ok) { log.push((i+1)+'. select ✗ ' + sr.reason + ' target=' + brief(sr.el || sl)); failed = { step:i+1, op:op, reason:sr.reason, target:brief(sr.el || sl) }; broken = true; break; }
            await settleAfter(signature(), 35, 180);
            var svx = verifyExpectations(s, sr.el || sl);
            if (!svx.ok) { log.push((i+1)+'. select ✗ ' + svx.reason + ' expected=' + clean(svx.expected || '') + expectSuffix(svx)); failed = { step:i+1, op:op, reason:svx.reason, expected:svx.expected || '', actual:svx.actual || '', checks:svx.checks || [] }; broken = true; break; }
            log.push((i+1)+'. select ' + label + ' ✓ value=' + clean(sr.actual).slice(0,48) + expectSuffix(svx));
          } else if (op === 'type' || op === 'fill' || op === 'input' || op === 'clear' || op === 'append') {
            var input = findTarget(s, 'type');
            if (!input) { var ih = candidateHints(s, 'type'); log.push((i+1)+'. ' + op + ' ✗ 找不到 ' + label + (ih.length ? ' candidates=' + ih.join(' | ') : '')); failed = { step:i+1, op:op, reason:'not_found', target:label, candidates:ih }; broken = true; break; }
            var tr = typeInto(input, s.text || '', Object.assign({}, s, { clear: s.clear || op === 'clear', append: s.append || op === 'append' }));
            if (!tr.ok) { log.push((i+1)+'. type ✗ ' + tr.reason + ' target=' + brief(tr.el || input) + (tr.actual != null ? ' actual=' + clean(tr.actual).slice(0,40) : '')); failed = { step:i+1, op:op, reason:tr.reason, target:brief(tr.el || input), actual:tr.actual || '' }; broken = true; break; }
            await settleAfter(signature(), 35, 120);
            var txv = verifyExpectations(Object.assign({}, s, { expectValue: s.expectValue || (op === 'type' || op === 'fill' || op === 'input' || op === 'append' ? '' : s.expectValue) }), tr.el || input);
            if (!txv.ok) { log.push((i+1)+'. type ✗ ' + txv.reason + ' expected=' + clean(txv.expected || '') + expectSuffix(txv)); failed = { step:i+1, op:op, reason:txv.reason, expected:txv.expected || '', actual:txv.actual || '', checks:txv.checks || [] }; broken = true; break; }
            log.push((i+1)+'. ' + op + ' ' + label + ' ✓ value=' + clean(tr.actual).slice(0,48) + expectSuffix(txv));
          } else if (op === 'focus' || op === 'blur') {
            var fe = findTarget(s, op === 'focus' ? 'type' : 'click');
            if (!fe) { var fh = candidateHints(s, 'click'); log.push((i+1)+'. ' + op + ' ✗ 找不到 ' + label + (fh.length ? ' candidates=' + fh.join(' | ') : '')); failed = { step:i+1, op:op, reason:'not_found', target:label, candidates:fh }; broken = true; break; }
            try { if (op === 'focus') fe.focus({ preventScroll:true }); else fe.blur(); } catch(e){ try { if (op === 'focus') fe.focus(); else fe.blur(); } catch(e2){} }
            var fv = verifyExpectations(s, fe);
            if (!fv.ok) { log.push((i+1)+'. ' + op + ' ✗ ' + fv.reason + ' expected=' + clean(fv.expected || '') + expectSuffix(fv)); failed = { step:i+1, op:op, reason:fv.reason, expected:fv.expected || '', actual:fv.actual || '', checks:fv.checks || [] }; broken = true; break; }
            log.push((i+1)+'. ' + op + ' ' + label + ' ✓' + expectSuffix(fv));
          } else if (op === 'press' || op === 'key') {
            var kb = signature();
            pressKey(s.key || s.text || 'Enter', s);
            var ks = await settleAfter(kb, 60, 420);
            var pv = verifyExpectations(s, document.activeElement || document.body);
            if (!pv.ok) { log.push((i+1)+'. press ✗ ' + pv.reason + ' expected=' + clean(pv.expected || '') + expectSuffix(pv)); failed = { step:i+1, op:op, reason:pv.reason, expected:pv.expected || '', actual:pv.actual || '', checks:pv.checks || [] }; broken = true; break; }
            log.push((i+1)+'. press ' + (s.key || s.text || 'Enter') + ' ✓ ' + ks + expectSuffix(pv));
          } else if (op === 'scroll') {
            var sx = Number.isFinite(s.dx) ? s.dx : 0, sy = Number.isFinite(s.amount) ? s.amount : (Number.isFinite(s.dy) ? s.dy : 600);
            var se = findTarget(s, 'click');
            var sb = scrollBoxOf(se || document.body);
            if (sb && sb.scrollBy) sb.scrollBy(sx, sy); else window.scrollBy(sx, sy);
            log.push((i+1)+'. scroll ✓ ' + sx + ',' + sy);
            await delay(90);
          } else if (op === 'wheel') {
            var wh = findTarget(s, 'click') || document.body;
            var wp = pointFromStep(s, wh, null);
            var wx = Number.isFinite(s.dx)?s.dx:0, wy = Number.isFinite(s.dy)?s.dy:(Number.isFinite(s.amount)?s.amount:600);
            try { wh.dispatchEvent(new WheelEvent('wheel', { bubbles:true, cancelable:true, view:(wh.ownerDocument.defaultView||window), clientX:wp.x, clientY:wp.y, deltaX:wx, deltaY:wy, deltaMode:0 })); } catch(e) {}
            var wb = scrollBoxOf(wh);
            try { if (wb && wb.scrollBy) wb.scrollBy(wx, wy); else window.scrollBy(wx, wy); } catch(e) { try { window.scrollBy(wx, wy); } catch(e2){} }
            log.push((i+1)+'. wheel ✓');
            await delay(90);
          } else if (op === 'wait') {
            var budget = Number.isFinite(s.ms) ? s.ms : 500;
            var waited = 0, ok = true;
            if (selectorFor(s) || s.target || s.text || s.role) {
              ok = false;
              while (waited <= budget) { var foundWait = !!findTarget(s, 'wait'); if ((s.absent && !foundWait) || (!s.absent && foundWait)) { ok = true; break; } await delay(100); waited += 100; }
            } else {
              await delay(budget);
            }
            log.push((i+1)+'. wait ' + (ok ? '✓' : '✗ timeout'));
            if (!ok) { failed = { step:i+1, op:op, reason:'timeout', target:label }; broken = true; break; }
            var wv = verifyExpectations(s, document.activeElement || document.body);
            if (!wv.ok) { log.push((i+1)+'. wait ✗ ' + wv.reason + ' expected=' + clean(wv.expected || '') + expectSuffix(wv)); failed = { step:i+1, op:op, reason:wv.reason, expected:wv.expected || '', actual:wv.actual || '', checks:wv.checks || [] }; broken = true; break; }
          } else if (op === 'observe') {
            var roots = rootList();
            log.push((i+1)+'. observe ✓ roots=' + roots.length + ' iframes=' + (roots.iframeCount||0) + ' shadowRoots=' + (roots.shadowCount||0));
          } else {
            log.push((i+1)+'. skip unknown op ' + op);
          }
        } catch(e) {
          log.push((i+1)+'. ' + op + ' ✗ ' + String(e && e.message || e).slice(0,80));
          failed = { step:i+1, op:op, reason:String(e && e.message || e).slice(0,160), target:label };
          broken = true;
        }
      }
      try { if (observer) observer.disconnect(); } catch(e){}
      var snap = nodeList();
      snap.mode = 'fast_batch';
      snap.ok = !broken;
      snap.log = log;
      if (failed) snap.failed = failed;
      return JSON.stringify(snap);
    })();
  })()`;
}
