// 浏览器工具的「读」「找」「滚到」三段页内脚本，加上全仓唯一的节点编号器。
//
// 这里的每个 export 都是**字符串**（或返回字符串的函数），交给 browser_eval 在被测页面里跑——
// 所以下面出现的 document / querySelectorAll 是模板内容，不是 IDE 自己碰 DOM。
//
// 为什么要有 read / find（2026-09-06 所有者原话：「不够智能……也不懂的用很多东西」）：
// 每一步回给模型的页面文字只有 1500 字、节点最多 60 个且只有视口内的——模型**读不了**一个页面，
// 只能一屏一屏截图往下滚，或者写 eval 抠 DOM。read 把页面当一篇文档分页读（正文里的链接/按钮
// 带着节点号），find 按文字/正则/角色找到位置、给出旁边的节点号并把它滚进视口。
//
// 节点编号器（NODE_TAG_SNIPPET）是四处共用的**同一份**实现：Rust 的 enumerate_elements（每次
// 快照：截图红数字 + elements 清单）、nodes / observe（结构化清单）、read（正文里的 [n]）、
// find（命中处旁边的节点号）。同一份选择器、同一份遍历次序、同一份可见性判据、同一个上限，
// 于是同一页面状态下四处编号相同：红数字 = node 号 = 正文里的 [n]，模型只需要认一套编号。
// Rust 那份拷贝必须和这里逐字一致，test/browser-read-scripts.test.mjs 拿两边比。

/** 一次最多给多少个节点编号。四处共用，改这里要连 Rust 那份一起改。 */
export const NODE_TAG_CAP = 200;

/**
 * 定义 __mtag(cap)：清掉旧编号，按序给可交互元素打 data-mnode / data-mref（同一个数），
 * 返回 { nodes, roots, total, 若干助手 }。nodes[i] = { i, r(角色), n(名称), s(状态)?, off?, el, rect }。
 * 只用 var 和 function，页面可能是很老的运行环境；不用反引号和 ${，两边的宿主字符串都吃不了。
 */
export const NODE_TAG_SNIPPET = String.raw`var __mtag=(function(){
var clean=function(s){s=String(s||'');var out='',sp=false;for(var k=0;k<s.length;k++){var ch=s[k];if(ch===' '||ch==='\n'||ch==='\t'||ch==='\r'){if(!sp){out+=' ';sp=true;}}else{out+=ch;sp=false;}}return out.trim();};
var rootList=function(){var out=[],seen=[],iframeCount=0,shadowCount=0,blocked=[];var push=function(root,depth){if(!root||seen.indexOf(root)>=0||depth>5)return;seen.push(root);out.push(root);var all=[];try{all=Array.prototype.slice.call(root.querySelectorAll('*'),0,2200);}catch(e){}for(var i=0;i<all.length;i++){var el=all[i];try{if(el.shadowRoot){shadowCount++;push(el.shadowRoot,depth+1);}}catch(e1){}try{if(el.tagName==='IFRAME'){if(el.contentDocument){iframeCount++;push(el.contentDocument,depth+1);}else{var _r=el.getBoundingClientRect();blocked.push({src:String(el.src||'').slice(0,120),w:Math.round(_r.width),h:Math.round(_r.height)});}}}catch(e2){try{var _r2=el.getBoundingClientRect();blocked.push({src:String(el.src||'').slice(0,120),w:Math.round(_r2.width),h:Math.round(_r2.height)});}catch(e3){}}}};push(document,0);out.iframeCount=iframeCount;out.shadowCount=shadowCount;out.blockedFrames=blocked;return out;};
var qsa=function(sel,roots){var out=[],rs=roots||rootList();for(var d=0;d<rs.length;d++){try{out=out.concat(Array.prototype.slice.call(rs[d].querySelectorAll(sel)));}catch(e){}}return out.filter(function(el,i){return el&&out.indexOf(el)===i;});};
var rootOf=function(el){try{return el&&el.getRootNode?el.getRootNode():document;}catch(e){return document;}};
var parentDeep=function(el){try{return el&&(el.parentElement||(rootOf(el).host||null));}catch(e){return null;}};
var closestDeep=function(el,sel){var cur=el,guard=0;while(cur&&cur.nodeType===1&&guard++<80){try{if(cur.matches&&cur.matches(sel))return cur;}catch(e){}cur=parentDeep(cur);}return null;};
var SEL='a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=menu],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=listbox],[role=option],[role=checkbox],[role=switch],[role=radio],[role=combobox],[role=slider],[role=spinbutton],[role=textbox],[role=searchbox],[role=treeitem],[onclick],[draggable=true],[data-radix-collection-item],[data-state],[data-value],[cmdk-item],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"]),summary,label';
var nameOf=function(el){var t=el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.getAttribute('title')||el.getAttribute('alt')||(el.tagName==='INPUT'||el.tagName==='SELECT'||el.tagName==='TEXTAREA'?'':(el.innerText||el.textContent||''))||el.getAttribute('name')||'';try{var lab=closestDeep(el,'label');if(lab&&!t)t=lab.innerText||lab.textContent||'';}catch(e){}try{if(!t&&el.id){var lb=(el.ownerDocument||document).querySelector('label[for="'+el.id+'"]');if(lb)t=lb.innerText||lb.textContent||'';}}catch(e4){}try{var host=rootOf(el).host;if(host&&!t)t=host.getAttribute('aria-label')||host.getAttribute('title')||host.getAttribute('data-testid')||host.getAttribute('id')||'';}catch(e2){}return clean(t).slice(0,52);};
var isH=function(tag){return tag.length===2&&tag.charAt(0)==='h'&&tag.charAt(1)>='1'&&tag.charAt(1)<='6';};
var roleOf=function(el){var r=el.getAttribute('role');if(r)return r;var tag=el.tagName.toLowerCase();if(tag==='a')return'link';if(tag==='button')return'button';if(tag==='input'){var ty=(el.getAttribute('type')||'text').toLowerCase();if(ty==='checkbox')return'checkbox';if(ty==='radio')return'radio';if(ty==='submit'||ty==='button'||ty==='reset'||ty==='image')return'button';if(ty==='range')return'slider';if(ty==='file')return'file';return'textbox';}if(tag==='select')return'combobox';if(tag==='textarea')return'textbox';if(isH(tag))return'heading';if(tag==='summary')return'summary';if(tag==='label')return'label';return tag;};
var stateOf=function(el){var s={};if(el.disabled||el.getAttribute('aria-disabled')==='true')s.disabled=true;if(el.checked||el.getAttribute('aria-checked')==='true')s.checked=true;var exp=el.getAttribute('aria-expanded');if(exp!=null)s.expanded=(exp==='true');if(el.getAttribute('aria-selected')==='true')s.selected=true;if((el.tagName==='INPUT'||el.tagName==='TEXTAREA'||el.tagName==='SELECT')&&el.value)s.value=(el.getAttribute('type')||'').toLowerCase()==='password'?'••••':String(el.value).slice(0,32);if(el.tagName==='A'&&el.getAttribute('href'))s.href=el.getAttribute('href').slice(0,70);return s;};
var visible=function(el){try{var r=el.getBoundingClientRect();var w=(el.ownerDocument&&el.ownerDocument.defaultView)||window;var cs=w.getComputedStyle(el);return !(r.width<1||r.height<1||cs.visibility==='hidden'||cs.display==='none'||cs.opacity==='0');}catch(e){return false;}};
return function(cap){cap=cap||120;var roots=rootList();qsa('[data-mnode],[data-mref]',roots).forEach(function(e){e.removeAttribute('data-mnode');e.removeAttribute('data-mref');});var nodes=[],id=0;var els=qsa(SEL,roots).slice(0,1500);for(var i=0;i<els.length;i++){if(id>=cap)break;var el=els[i],r;try{r=el.getBoundingClientRect();}catch(e){continue;}if(!visible(el))continue;el.setAttribute('data-mnode',String(id));el.setAttribute('data-mref',String(id));var inView=!(r.bottom<=0||r.right<=0||r.top>=innerHeight||r.left>=innerWidth);var node={i:id,r:roleOf(el),n:nameOf(el)};var st=stateOf(el);for(var kk in st){node.s=st;break;}if(!inView)node.off=1;node.el=el;node.rect=r;nodes.push(node);id++;}return {nodes:nodes,roots:roots,total:id,clean:clean,qsa:qsa,nameOf:nameOf,roleOf:roleOf,stateOf:stateOf,closestDeep:closestDeep,visible:visible,SEL:SEL};};
})();`;

function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}

/** read 的分页上限：默认一页 6000 字（中文一字约一 token），最多 16000，最少 500。 */
export const READ_DEFAULTS = { maxChars: 6000, maxCharsCap: 16000, minChars: 500 };
/** find 一次最多回多少条命中。 */
export const FIND_DEFAULTS = { limit: 12, limitCap: 40 };

/** 把 body（或 main/article/指定选择器）走一遍，变成带结构的纯文本：标题、列表、表格、链接[n]、控件[n …]。 */
const READ_BODY = String.raw`var T = __mtag(__CAP), clean = T.clean;
var SKIP = {SCRIPT:1,STYLE:1,NOSCRIPT:1,TEMPLATE:1,SVG:1,CANVAS:1,IFRAME:1,HEAD:1,META:1,LINK:1,TITLE:1,OBJECT:1,EMBED:1,VIDEO:1,AUDIO:1,MAP:1};
var BLOCK = {P:1,DIV:1,SECTION:1,ARTICLE:1,HEADER:1,FOOTER:1,NAV:1,ASIDE:1,MAIN:1,UL:1,OL:1,LI:1,TABLE:1,THEAD:1,TBODY:1,TFOOT:1,TR:1,TD:1,TH:1,H1:1,H2:1,H3:1,H4:1,H5:1,H6:1,BLOCKQUOTE:1,PRE:1,BR:1,HR:1,FORM:1,FIELDSET:1,DL:1,DT:1,DD:1,FIGURE:1,FIGCAPTION:1,DETAILS:1,SUMMARY:1,ADDRESS:1,DIALOG:1};
var CJK = /[　-鿿豈-﫿＀-￯]/;
var FENCE = String.fromCharCode(96, 96, 96);
var hidden = function(el){ try { if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true; var rs = el.getClientRects(); return !rs || rs.length === 0; } catch (e) { return false; } };
var pickRoot = function(){
  if (OPT.selector) { var s = null; try { s = T.qsa(OPT.selector)[0] || null; } catch (e) {} return s ? { el: s, name: OPT.selector } : { el: null, name: 'not_found' }; }
  var bodyLen = 0; try { bodyLen = document.body && document.body.innerText ? document.body.innerText.length : 0; } catch (e) {}
  var cands = Array.prototype.slice.call(document.querySelectorAll('main,[role="main"],article'));
  var best = null, bestLen = 0;
  for (var i = 0; i < cands.length; i++) { var len = 0; try { len = (cands[i].innerText || '').length; } catch (e) {} if (len > bestLen) { best = cands[i]; bestLen = len; } }
  if (best && bodyLen && bestLen >= bodyLen * 0.4) return { el: best, name: best.tagName.toLowerCase() + (best.id ? '#' + best.id : '') };
  return { el: document.body, name: 'body' };
};
var lines = [], cur = '';
var flush = function(){ var t = clean(cur); if (t) lines.push(t); cur = ''; };
var add = function(t){ t = String(t || ''); if (!t) return; var glue = cur && !/\s$/.test(cur) && !(CJK.test(cur.charAt(cur.length - 1)) && CJK.test(t.charAt(0))) ? ' ' : ''; cur += glue + t; };
var mnode = function(el){ var v = el.getAttribute ? el.getAttribute('data-mnode') : null; return v == null || v === '' ? null : v; };
var renderInline = function(el){ var savedLines = lines, savedCur = cur; lines = []; cur = ''; var kids = el.childNodes; for (var i = 0; i < kids.length; i++) walk(kids[i], 1); flush(); var out = lines.join(' '); lines = savedLines; cur = savedCur; return clean(out).slice(0, 200); };
var tagOf = function(el, role, label, value){ var n = mnode(el); return '[' + (n != null ? n + ' ' : '') + role + (label ? ' "' + label + '"' : '') + (value != null && value !== '' ? ' = ' + value : '') + ']'; };
var walk = function(node, depth){
  if (depth > 60) return;
  if (node.nodeType === 3) { add(clean(node.nodeValue)); return; }
  if (node.nodeType !== 1) return;
  var el = node, tag = el.tagName;
  if (SKIP[tag] || hidden(el)) return;
  if (tag === 'BR') { flush(); return; }
  if (tag === 'HR') { flush(); lines.push('---'); return; }
  if (tag === 'IMG') { var alt = clean(el.getAttribute('alt') || ''); if (alt) add('[图 ' + alt.slice(0, 60) + ']'); return; }
  if (tag === 'A' && el.getAttribute('href')) {
    var at = clean(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '');
    if (!at) { try { var lab = el.querySelector('[aria-label],[title],img[alt]'); if (lab) at = clean(lab.getAttribute('aria-label') || lab.getAttribute('title') || lab.getAttribute('alt') || ''); } catch (e) {} }
    if (!at) { try { var u = new URL(el.href, location.href); at = u.origin !== location.origin ? u.hostname : (u.pathname.split('/').filter(Boolean).pop() || u.hostname); } catch (e) { at = 'link'; } }
    var an = mnode(el); add(at.slice(0, 120) + (an != null ? ' [' + an + ']' : '')); return;
  }
  if (tag === 'BUTTON' || (tag === 'INPUT' && /^(submit|button|reset|image)$/i.test(el.type || ''))) { add(tagOf(el, 'button', clean(el.innerText || el.value || el.getAttribute('aria-label') || '').slice(0, 40))); return; }
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    var role = T.roleOf(el), val = '';
    if (tag === 'SELECT') val = el.selectedOptions && el.selectedOptions[0] ? clean(el.selectedOptions[0].textContent) : '';
    else if ((el.type || '').toLowerCase() === 'password') val = el.value ? '••••' : '';
    else val = clean(el.value || '');
    if (role === 'checkbox' || role === 'radio') val = el.checked ? '已选' : '未选';
    add(tagOf(el, role, T.nameOf(el).slice(0, 40), val.slice(0, 40))); return;
  }
  var isBlock = !!BLOCK[tag];
  if (isBlock) flush();
  if (tag === 'PRE') { var pt = String(el.innerText || el.textContent || ''); if (pt.trim()) lines.push(FENCE + '\n' + pt.replace(/\s+$/, '').slice(0, 4000) + '\n' + FENCE); return; }
  if (tag === 'TR') {
    // 只有「数据行」才画成 | a | b |：至少两格、格子里没有块级结构。整页套在 table 里的老站
    // （布局表格）当普通块走，单元格各自成行——否则整页会被压成一行、每格再截 120 字。
    var cells = Array.prototype.slice.call(el.children).filter(function(c){ return c.tagName === 'TD' || c.tagName === 'TH'; });
    var dataRow = cells.length >= 2 && cells.every(function(c){ try { return !c.querySelector('table,div,p,ul,ol,h1,h2,h3,h4,h5,h6,form,section,article,pre,blockquote'); } catch (e) { return false; } });
    if (dataRow) { var row = cells.map(function(c){ return renderInline(c); }); if (row.join('').trim()) lines.push('| ' + row.join(' | ') + ' |'); return; }
  }
  var prefix = '';
  if (/^H[1-6]$/.test(tag)) prefix = '######'.slice(0, +tag.charAt(1)) + ' ';
  else if (tag === 'LI') prefix = '- ';
  else if (tag === 'DT') prefix = '· ';
  else if (tag === 'BLOCKQUOTE') prefix = '> ';
  if (prefix) cur = prefix;
  var kids = el.childNodes;
  for (var i = 0; i < kids.length; i++) walk(kids[i], depth + 1);
  if (isBlock) flush();
};
var root = pickRoot();
if (!root.el) return JSON.stringify({ error: 'selector_not_found', selector: OPT.selector });
walk(root.el, 0); flush();
var full = lines.join('\n').replace(/\n{3,}/g, '\n\n');
var total = full.length;
var offset = Math.min(OPT.offset, total);
var text = full.slice(offset, offset + OPT.maxChars);
var next = offset + OPT.maxChars < total ? offset + OPT.maxChars : null;
var outline = [];
if (offset === 0) { try { outline = T.qsa('h1,h2,h3').slice(0, 30).map(function(h){ return { l: +h.tagName.charAt(1), t: clean(h.innerText || '').slice(0, 60) }; }).filter(function(h){ return h.t; }).slice(0, 12); } catch (e) {} }
return JSON.stringify({ url: location.href, title: clean(document.title).slice(0, 100), root: root.name, total: total, offset: offset, next: next, chars: text.length, outline: outline, nodes: T.total, crossOriginFrames: (T.roots.blockedFrames || []).length, text: text });`;

/**
 * read：把页面当一篇文档读，分页。
 * @param {{offset?: number, maxChars?: number, selector?: string}} opts
 *   offset 从第几个字开始（上一页回执里的 next）；maxChars 一页多少字；selector 只读某个容器。
 */
export function _readPageJS(opts = {}) {
  const o = {
    offset: clampInt(opts.offset, 0, 5_000_000, 0),
    maxChars: clampInt(opts.maxChars, READ_DEFAULTS.minChars, READ_DEFAULTS.maxCharsCap, READ_DEFAULTS.maxChars),
    selector: String(opts.selector || "").slice(0, 300),
  };
  return "(() => { try {\nvar OPT = " + JSON.stringify(o) + ";\nvar __CAP = " + NODE_TAG_CAP + ";\n" + NODE_TAG_SNIPPET + "\n" + READ_BODY + "\n} catch (e) { return JSON.stringify({ error: String((e && e.message) || e) }); } })()";
}

/** 按文字 / 正则 / 角色在页面里找：节点名命中 + 正文命中（带上下文和旁边的节点号），第一处滚进视口。 */
const FIND_BODY = String.raw`var T = __mtag(__CAP), clean = T.clean;
var q = String(OPT.text || ''), re = null;
try {
  if (OPT.pattern) re = new RegExp(OPT.pattern, 'i');
  else if (q) re = new RegExp(q.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'), 'i');
} catch (e) { return JSON.stringify({ error: 'bad_pattern', detail: String((e && e.message) || e) }); }
if (!re && !OPT.role) return JSON.stringify({ error: 'empty_query' });
var lowerQ = q.toLowerCase();
var nodeMatches = [];
for (var i = 0; i < T.nodes.length && nodeMatches.length < OPT.limit; i++) {
  var nd = T.nodes[i];
  if (OPT.role && nd.r !== OPT.role) continue;
  var name = String(nd.n || '');
  var hit = re ? re.test(name) : true;
  if (!hit) continue;
  var o = { i: nd.i, r: nd.r, n: nd.n }; if (nd.s) o.s = nd.s; if (nd.off) o.off = 1;
  nodeMatches.push(o);
}
var textMatches = [], first = null;
if (re) {
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: function(t){ var p = t.parentElement; if (!p) return NodeFilter.FILTER_REJECT; var tg = p.tagName; if (tg === 'SCRIPT' || tg === 'STYLE' || tg === 'NOSCRIPT' || tg === 'TEMPLATE') return NodeFilter.FILTER_REJECT; if (!/\S/.test(t.nodeValue || '')) return NodeFilter.FILTER_REJECT; return NodeFilter.FILTER_ACCEPT; } });
  while (textMatches.length < OPT.limit) {
    var t = walker.nextNode(); if (!t) break;
    var v = clean(t.nodeValue); var m = re.exec(v); if (!m) continue;
    var p = t.parentElement; var rs = null; try { rs = p.getClientRects(); } catch (e) {}
    if (!rs || rs.length === 0) continue;
    var at = m.index;
    var ctx = v.slice(Math.max(0, at - 80), at + m[0].length + 80);
    var host = T.closestDeep(p, '[data-mnode]');
    var node = host ? +host.getAttribute('data-mnode') : null;
    if (node === null) { try { var blk = p.closest('li,tr,p,section,article,form,label,td,th,div') || p; var inner = blk.querySelector('[data-mnode]'); if (inner) node = +inner.getAttribute('data-mnode'); } catch (e) {} }
    var r = p.getBoundingClientRect();
    var inView = !(r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth);
    textMatches.push({ ctx: ctx, node: node, inView: inView });
    if (!first) first = p;
  }
}
var scrolled = false;
if (OPT.scroll) {
  var target = first || (nodeMatches.length ? (T.nodes[nodeMatches[0].i] || {}).el : null);
  if (target) { try { target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); scrolled = true; } catch (e) { try { target.scrollIntoView(); scrolled = true; } catch (e2) {} } }
}
return JSON.stringify({ query: q || OPT.pattern || ('role=' + OPT.role), nodeMatches: nodeMatches, textMatches: textMatches, count: nodeMatches.length + textMatches.length, scrolled: scrolled, url: location.href });`;

/**
 * find：text（子串，不分大小写）或 pattern（正则）或 role（角色过滤）。
 * @param {{text?: string, pattern?: string, role?: string, limit?: number, scroll?: boolean}} opts
 */
export function _findInPageJS(opts = {}) {
  const o = {
    text: String(opts.text || "").slice(0, 200),
    pattern: String(opts.pattern || "").slice(0, 300),
    role: String(opts.role || "").slice(0, 40),
    limit: clampInt(opts.limit, 1, FIND_DEFAULTS.limitCap, FIND_DEFAULTS.limit),
    scroll: opts.scroll !== false,
  };
  return "(() => { try {\nvar OPT = " + JSON.stringify(o) + ";\nvar __CAP = " + NODE_TAG_CAP + ";\n" + NODE_TAG_SNIPPET + "\n" + FIND_BODY + "\n} catch (e) { return JSON.stringify({ error: String((e && e.message) || e) }); } })()";
}

/** 把某个元素（选择器 / 节点号选择器）或第一处文字滚进视口，回报滚后的位置。 */
const SCROLL_TO_BODY = String.raw`var T = __mtag(__CAP), clean = T.clean;
var el = null, how = '';
if (OPT.selector) { try { el = T.qsa(OPT.selector)[0] || null; } catch (e) {} if (el) how = 'selector'; }
if (!el && OPT.text) {
  var re = null; try { re = new RegExp(String(OPT.text).replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'), 'i'); } catch (e) {}
  if (re) {
    for (var i = 0; i < T.nodes.length && !el; i++) { if (re.test(String(T.nodes[i].n || ''))) { el = T.nodes[i].el; how = 'node'; } }
    if (!el) {
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      var t; while ((t = walker.nextNode())) { var p = t.parentElement; if (!p || p.tagName === 'SCRIPT' || p.tagName === 'STYLE') continue; if (re.test(clean(t.nodeValue))) { var rs = null; try { rs = p.getClientRects(); } catch (e) {} if (rs && rs.length) { el = p; how = 'text'; break; } } }
    }
  }
}
if (!el) return JSON.stringify({ ok: false, reason: 'not_found', selector: OPT.selector, text: OPT.text });
try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); } catch (e) { try { el.scrollIntoView(); } catch (e2) {} }
var d = document.scrollingElement || document.documentElement;
var brief = ''; try { brief = el.tagName.toLowerCase() + (el.getAttribute('data-mnode') != null ? '[' + el.getAttribute('data-mnode') + ']' : '') + ' "' + clean(el.innerText || el.textContent || el.getAttribute('aria-label') || '').slice(0, 60) + '"'; } catch (e) {}
return JSON.stringify({ ok: true, how: how, target: brief, scrollY: Math.round(window.scrollY || 0), height: Math.round(d ? d.scrollHeight : 0), viewport: Math.round(innerHeight || 0) });`;

/**
 * scroll 到某个目标：selector（含 [data-mnode="n"]）优先，其次 text（先匹配节点名，再匹配正文）。
 * @param {{selector?: string, text?: string}} opts
 */
export function _scrollToJS(opts = {}) {
  const o = { selector: String(opts.selector || "").slice(0, 300), text: String(opts.text || "").slice(0, 200) };
  return "(() => { try {\nvar OPT = " + JSON.stringify(o) + ";\nvar __CAP = " + NODE_TAG_CAP + ";\n" + NODE_TAG_SNIPPET + "\n" + SCROLL_TO_BODY + "\n} catch (e) { return JSON.stringify({ ok: false, reason: String((e && e.message) || e) }); } })()";
}
