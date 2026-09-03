/**
 * 浏览器自动化的**页内脚本**集合（除批处理那一大块之外的全部）。
 *
 * 和 browser-batch-script.js 同源、同判据：这些函数/常量返回的是要在被测页面里
 * 执行的脚本文本，IDE 进程自己不碰 DOM。AST 实测这一组的外部依赖只有族内的
 * _pageHookSrc（_NETWORK_CAPTURE_JS 和 _checkJS 用它），所以整组一起搬。
 *
 * **_resolveBrowserSelector 不在这里**：它夹在这一族中间，但依赖 backend，
 * 留在 main.js。这也是为什么这次抽取必须按 AST 节点名挑，不能按行区间整段切。
 */

// Design-system extractor: run in a page (via browser eval) to grab its real
// design tokens from computed styles — colors by usage, typography, spacing, radii,
// shadows, gradients, CSS custom properties, and motion (durations + easing). Lets
// the agent design GROUNDED in a real reference instead of from memory. No regex
// (so it's safe inside a template literal / no backslash escaping).
export const _DESIGN_EXTRACT_JS = `(() => {
  try {
    const vars = {};
    const keyframes = {};   // name → full @keyframes body (the REAL animation, copyable)
    const effectRules = {}; // selector → its transition/animation/transform (what animates + how)
    const walk = (rules) => {
      for (const rule of (rules || [])) {
        try {
          // @keyframes — the actual animation steps (screenshots can't show these)
          if (rule.type === 7 || (typeof CSSKeyframesRule !== 'undefined' && rule instanceof CSSKeyframesRule)) {
            if (rule.name && !keyframes[rule.name] && Object.keys(keyframes).length < 24) keyframes[rule.name] = String(rule.cssText).slice(0, 600);
            continue;
          }
          if (rule.cssRules) { walk(rule.cssRules); continue; } // @media / @supports → recurse
          if (rule.selectorText) {
            if (rule.selectorText === ':root' || rule.selectorText === 'html' || rule.selectorText.indexOf(':root') === 0) {
              for (const p of rule.style) { if (p.indexOf('--') === 0) vars[p] = rule.style.getPropertyValue(p).trim(); }
            }
            // rules that actually animate / transition / transform → the effect recipe
            const st = rule.style;
            if (st && (((st.animation && st.animation !== 'none') || (st.transition && st.transition !== 'all 0s ease 0s' && st.transition) || (st.transform && st.transform !== 'none')))) {
              if (Object.keys(effectRules).length < 40) {
                const bits = [];
                if (st.transition) bits.push('transition:' + st.transition);
                if (st.animation && st.animation !== 'none') bits.push('animation:' + st.animation);
                if (st.transform && st.transform !== 'none') bits.push('transform:' + st.transform);
                effectRules[String(rule.selectorText).slice(0, 80)] = bits.join('; ').slice(0, 200);
              }
            }
          }
        } catch (e) {}
      }
    };
    for (const sheet of document.styleSheets) { try { walk(sheet.cssRules); } catch (e) {} }
    const all = Array.prototype.slice.call(document.querySelectorAll('body *'), 0, 1800);
    const colors = {}, bgs = {}, fonts = {}, sizes = {}, weights = {}, radii = {}, shadows = {}, transitions = {}, anims = {}, grads = {};
    const bump = (m, k) => { if (!k) return; k = String(k).trim(); if (k === 'none' || k === 'normal' || k === '0px' || k === 'rgba(0, 0, 0, 0)' || k === 'transparent' || k === 'auto') return; m[k] = (m[k] || 0) + 1; };
    for (const el of all) {
      let r; try { r = el.getBoundingClientRect(); } catch (e) { continue; }
      if (r.width < 4 || r.height < 4) continue;
      const cs = getComputedStyle(el);
      bump(colors, cs.color); bump(bgs, cs.backgroundColor);
      if (cs.backgroundImage && cs.backgroundImage.indexOf('gradient') >= 0) bump(grads, cs.backgroundImage.slice(0, 120));
      bump(fonts, cs.fontFamily); bump(sizes, cs.fontSize); bump(weights, cs.fontWeight);
      bump(radii, cs.borderRadius); bump(shadows, cs.boxShadow); bump(transitions, cs.transition);
      if (cs.animationName && cs.animationName !== 'none') bump(anims, cs.animationName + ' (' + cs.animationDuration + ', ' + cs.animationTimingFunction + ')');
    }
    const top = (m, n) => Object.keys(m).sort((a, b) => m[b] - m[a]).slice(0, n);
    return JSON.stringify({ cssVars: vars, textColors: top(colors, 8), backgrounds: top(bgs, 8), gradients: top(grads, 4), fontFamilies: top(fonts, 4), fontSizes: top(sizes, 12), fontWeights: top(weights, 6), borderRadii: top(radii, 6), shadows: top(shadows, 5), transitions: top(transitions, 5), animations: top(anims, 6), keyframes: keyframes, effectRules: effectRules });
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`;

// Network capture (抓包): the page's real traffic, structured — so the agent
// debugs "为什么样式/图没出来" from GROUND TRUTH (a 404 CSS, a failed font, a 500
// API) instead of squinting at a screenshot. Combines the Performance Resource
// Timing API (retroactive: the WHOLE load — css/js/img/font/xhr/fetch with type /
// size / timing / status) with a persistent fetch+XHR hook (installed idempotently,
// survives until next navigation) that records method/status/short-body for calls
// made afterwards. No regex (template-literal safe). Inspired by DevTools Network /
// HAR — structured network data is far more reliable than vision for load bugs.
// Shared page-instrumentation hook (idempotent): wraps fetch/XHR → window.__MNET__
// (network traffic) and console.error/warn + window error events → window.__MERR__
// (JS errors). Installed by network/check so the agent OBSERVES console errors (the
// #1 cause of "按钮点了没反应 / 页面坏了") together with requests — the fused
// observation that browser-agent harnesses (Playwright / browser-use / WebVoyager)
// rely on. No regex / no ${ } (template-literal safe).
export function _pageHookSrc() {
  return `
    var now = function(){ try { return performance.now(); } catch(e){ return 0; } };
    if (!window.__MICHAEL_IDE_DETAIL_NET__) {
      window.__MICHAEL_IDE_DETAIL_NET__ = true;
      window.__MNET__ = window.__MNET__ || [];
      var log = function(rec){ try { window.__MNET__.push(rec); if (window.__MNET__.length > 200) window.__MNET__.shift(); } catch(e){} };
      if (window.fetch && !window.fetch.__mwrap) {
        var of = window.fetch.bind(window);
        var grabHdrs = function(hh){ var o={}; try { if(!hh) return o; if (typeof hh.forEach === 'function' && !Array.isArray(hh)) hh.forEach(function(v,k){ o[k]=String(v).slice(0,400); }); else if (Array.isArray(hh)) hh.forEach(function(p){ if(p&&p.length>=2) o[p[0]]=String(p[1]).slice(0,400); }); else Object.keys(hh).forEach(function(k){ o[k]=String(hh[k]).slice(0,400); }); } catch(e){} return o; };
        var wf = function(input, init){
          var url = (typeof input === 'string') ? input : (input && input.url) || '';
          var method = (init && init.method) || (input && input.method) || 'GET';
          // Capture the REQUEST headers + body too, so a captured call is fully
          // replayable via http_request (re-send / tweak params / debug).
          var rqh = grabHdrs((init && init.headers) || (input && input.headers));
          var rqb = ''; try { if (init && typeof init.body === 'string') rqb = init.body.slice(0,2000); } catch(e){}
          var start = now();
          return of(input, init).then(function(resp){
            var rec = { kind:'fetch', method:String(method).toUpperCase(), url:String(url).slice(0,300), reqHeaders:rqh, reqBody:rqb, status:resp.status, ok:resp.ok, ms:Math.round(now()-start), ctype:(resp.headers.get('content-type')||'').slice(0,40) };
            try { resp.clone().text().then(function(b){ rec.body=(b||'').slice(0,500); }).catch(function(){}); } catch(e){}
            log(rec); return resp;
          }).catch(function(err){ log({ kind:'fetch', method:String(method).toUpperCase(), url:String(url).slice(0,300), reqHeaders:rqh, reqBody:rqb, status:0, ok:false, ms:Math.round(now()-start), error:String(err).slice(0,140) }); throw err; });
        };
        wf.__mwrap = true; window.fetch = wf;
      }
      var XP = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
      if (XP && !XP.__mwrap) {
        var oo = XP.open, os = XP.send, osh = XP.setRequestHeader;
        XP.open = function(m, u){ this.__m = { kind:'xhr', method:String(m||'GET').toUpperCase(), url:String(u||'').slice(0,300), reqHeaders:{} }; return oo.apply(this, arguments); };
        // Record each setRequestHeader so the captured XHR carries its real headers
        // (auth tokens, signatures, content-type) and can be replayed via http_request.
        XP.setRequestHeader = function(k, v){ try { if(!this.__m) this.__m={reqHeaders:{}}; if(!this.__m.reqHeaders) this.__m.reqHeaders={}; this.__m.reqHeaders[k]=String(v).slice(0,400); } catch(e){} return osh.apply(this, arguments); };
        XP.send = function(body){ var self=this, start=now(); if(self.__m){ self.__m.reqBody=(typeof body==='string'? body.slice(0,2000):''); } self.addEventListener('loadend', function(){ try{ var r=self.__m||{kind:'xhr'}; r.status=self.status; r.ok=self.status>=200&&self.status<400; r.ms=Math.round(now()-start); try{ r.body=String(self.responseText||'').slice(0,500); }catch(e){} log(r); }catch(e){} }); return os.apply(self, arguments); };
        XP.__mwrap = true;
      }
    }
    if (!window.__MERR__) {
      window.__MERR__ = [];
      var elog = function(rec){ try { window.__MERR__.push(rec); if (window.__MERR__.length > 120) window.__MERR__.shift(); } catch(e){} };
      var fmt = function(args){ try { return Array.prototype.map.call(args, function(a){ try { return (a && a.message) ? a.message : (typeof a === 'object' ? JSON.stringify(a).slice(0,160) : String(a)); } catch(e){ return '?'; } }).join(' ').slice(0,280); } catch(e){ return '?'; } };
      try { var oce = console.error; console.error = function(){ try { elog({ level:'error', msg:fmt(arguments) }); } catch(e){} return oce.apply(console, arguments); }; } catch(e){}
      try { var ocw = console.warn; console.warn = function(){ try { elog({ level:'warn', msg:fmt(arguments) }); } catch(e){} return ocw.apply(console, arguments); }; } catch(e){}
      try { window.addEventListener('error', function(ev){ try { elog({ level:'error', msg:String((ev && (ev.message || (ev.error && ev.error.message))) || 'script error').slice(0,260), src:(ev && ev.filename ? String(ev.filename).slice(0,100) + ':' + (ev.lineno||'?') : '') }); } catch(e){} }, true); } catch(e){}
      try { window.addEventListener('unhandledrejection', function(ev){ try { var r = ev && ev.reason; elog({ level:'error', msg:'unhandledrejection: ' + String((r && (r.message || r)) || '').slice(0,240) }); } catch(e){} }); } catch(e){}
    }`;
}

export const _NETWORK_CAPTURE_JS = `(() => {
  try {
    ${_pageHookSrc()}
    var res = [], entries = [];
    try { entries = performance.getEntriesByType('resource') || []; } catch(e){}
    var nav = null; try { nav = (performance.getEntriesByType('navigation')||[])[0] || null; } catch(e){}
    for (var i=0;i<entries.length;i++){
      var e = entries[i], sz = e.transferSize||0, enc = e.encodedBodySize||0;
      res.push({ url:String(e.name).slice(0,200), type:e.initiatorType, status:(e.responseStatus||0), ms:Math.round(e.duration||0), transferKB:Math.round(sz/102.4)/10, encKB:Math.round(enc/102.4)/10 });
    }
    var assetTypes = { script:1, link:1, css:1, img:1, image:1, font:1, fetch:1, xmlhttprequest:1, other:1 };
    var fails = res.filter(function(r){ return (r.status>=400) || (r.status===0 && r.transferKB===0 && r.encKB===0 && assetTypes[r.type]); });
    var byType = {}; for (var j=0;j<res.length;j++){ byType[res[j].type]=(byType[res[j].type]||0)+1; }
    var slim = function(r){ var o={ kind:r.kind, method:r.method, url:String(r.url||'').slice(0,300), status:r.status, ok:r.ok, ms:r.ms }; if(r.ctype) o.ctype=r.ctype; if(r.error) o.error=r.error; if(r.reqHeaders && Object.keys(r.reqHeaders).length) o.reqHeaders=r.reqHeaders; if(r.reqBody) o.reqBody=String(r.reqBody).slice(0,800); if(r.body) o.body=String(r.body).slice(0,200); return o; };
    var hooked = (window.__MNET__||[]).slice(-10).map(slim);
    var apiFailCount = hooked.filter(function(r){ return !r.ok; }).length;
    return JSON.stringify({
      url: location.href,
      nav: nav ? { domContentLoaded:Math.round(nav.domContentLoadedEventEnd||0), load:Math.round(nav.loadEventEnd||0), type:nav.type } : null,
      total: res.length, counts: byType,
      failures: fails.slice(0, 12),
      apiCalls: hooked, apiFailCount: apiFailCount,
      consoleErrors: (window.__MERR__||[]).slice(-8),
      slowest: res.slice().sort(function(a,b){ return b.ms-a.ms; }).slice(0, 5),
      hint: (fails.length||apiFailCount||(window.__MERR__||[]).length) ? '有资源/接口加载失败或控制台报错(看 failures、apiCalls 里 ok:false 的、consoleErrors)，多半就是问题根因' : '本次未发现加载失败或控制台错误'
    });
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`;

// Fused health check (一次性协同观察): one call returns a unified verdict combining
// the four signals — console errors, failed network/API, critical visual defects,
// and how testable the page is (interactive-node count). The agent's "is this page/
// app actually working?" probe; drills into network/inspect/nodes/assert for detail.
// Grounded in ReAct (observe-after-act) + browser-agent harnesses that fuse
// console+network+DOM. No regex / no ${ } beyond the hook (template-literal safe).
export function _checkJS() {
  return `(() => {
    try {
      ${_pageHookSrc()}
      var res = [], entries = []; try { entries = performance.getEntriesByType('resource') || []; } catch(e){}
      for (var i=0;i<entries.length;i++){ var e=entries[i], sz=e.transferSize||0, enc=e.encodedBodySize||0; res.push({ url:String(e.name).slice(0,170), type:e.initiatorType, status:(e.responseStatus||0), tk:Math.round(sz/102.4)/10, ek:Math.round(enc/102.4)/10 }); }
      var at = { script:1, link:1, css:1, img:1, image:1, font:1, fetch:1, xmlhttprequest:1 };
      var netFails = res.filter(function(r){ return (r.status>=400) || (r.status===0 && r.tk===0 && r.ek===0 && at[r.type]); }).map(function(r){ return { url:r.url, type:r.type, status:r.status }; }).slice(0,10);
      var apiFails = (window.__MNET__||[]).filter(function(r){ return !r.ok; }).map(function(r){ return { url:String(r.url||'').slice(0,140), method:r.method, status:r.status }; }).slice(0,8);
      var errs = (window.__MERR__||[]).slice(-12);
      var errCount = errs.filter(function(x){ return x.level==='error'; }).length;
      var visual = [];
      try { var imgs = document.querySelectorAll('img'); for (var k=0;k<imgs.length && visual.length<8;k++){ var im=imgs[k]; if (im.complete && im.naturalWidth===0 && (im.getAttribute('src')||'')) visual.push({ type:'broken-image', src:(im.currentSrc||im.src||'').slice(0,120) }); } } catch(e){}
      var nodeCount = 0; try { nodeCount = document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[role=button],[onclick]').length; } catch(e){}
      var bodyText = ''; try { bodyText = String((document.body && document.body.innerText)||'').replace(/\\s+/g,' ').trim(); } catch(e){}
      var mediaCount = 0; try { mediaCount = document.querySelectorAll('main,header,nav,section,article,img,svg,canvas,video,[role=main]').length; } catch(e){}
      var blank = location.href==='about:blank' || !document.body || (bodyText.length<2 && mediaCount===0);
      if (blank) visual.push({ type:'blank-page', url:location.href });
      var overflow = false; try { overflow = document.documentElement.scrollWidth > innerWidth + 3; } catch(e){}
      if (overflow) visual.push({ type:'horizontal-overflow', scrollWidth:document.documentElement.scrollWidth, viewportWidth:innerWidth });
      // 裸页/样式失效检测：页面有内容但整体只剩 UA 默认样式 = 前端"完成"是假象。
      // 典型翻车：Tailwind v4 没接 @tailwindcss/vite、CSS 入口没 @import "tailwindcss"、
      // 或 CSS 没被 main 入口 import——写了一堆 utility class 全是死的。
      try {
        var cssRules = 0;
        for (var si=0; si<document.styleSheets.length; si++){ try { cssRules += (document.styleSheets[si].cssRules||[]).length; } catch(eS){ cssRules += 50; } }
        var utilEls = 0, deadUtil = false;
        var clsEls = document.querySelectorAll('[class]');
        for (var ui=0; ui<clsEls.length && ui<400; ui++){
          var cls = ' ' + String(clsEls[ui].getAttribute('class')||'') + ' ';
          if (cls.indexOf(' flex ')>=0 || cls.indexOf(' grid ')>=0 || cls.indexOf(' px-')>=0 || cls.indexOf(' py-')>=0 || cls.indexOf(' bg-')>=0 || cls.indexOf(' text-')>=0 || cls.indexOf(' rounded')>=0 || cls.indexOf(' mx-auto ')>=0) utilEls++;
        }
        var flexProbe = document.querySelector('.flex');
        if (flexProbe && getComputedStyle(flexProbe).display !== 'flex') deadUtil = true;
        if (!blank && bodyText.length > 40 && (cssRules < 5 || (utilEls >= 5 && deadUtil))) {
          visual.push({ type:'no-styles-applied', cssRules: cssRules, utilityClassEls: utilEls, utilityDead: deadUtil,
            hint: '页面基本是裸 HTML——样式没生效，这个界面不算完成，禁止"后续优化"收尾。排查：① Tailwind v4 要 vite.config 里加 @tailwindcss/vite 插件；② CSS 入口第一行 @import "tailwindcss"；③ main 入口要 import 这份 CSS；④ 重启 dev server 后重新 check。' });
        }
      } catch(e){}
      var ok = !blank && netFails.length===0 && apiFails.length===0 && errCount===0 && visual.length===0;
      return JSON.stringify({
        url: location.href, title: String(document.title||'').slice(0,80),
        healthy: ok,
        verdict: ok ? '✓ 未发现控制台错误 / 资源失败 / 关键视觉缺陷——页面看起来正常运行' : '✗ 发现问题（见下），先把这些修掉再继续验证',
        consoleErrors: errs,
        networkFailures: netFails,
        apiFailures: apiFails,
        visualDefects: visual,
        interactiveNodes: nodeCount, bodyTextChars: bodyText.length, meaningfulElements: mediaCount,
        observerInstalledBeforeLoad: window.__MICHAEL_IDE_OBSERVER__===true,
        drillDown: '要细节：network(完整请求+控制台) · inspect(完整视觉体检) · nodes(可点节点清单) · assert(查某文本/元素是否出现)'
      });
    } catch (e) { return JSON.stringify({ error: String(e) }); }
  })()`;
}

// Visual / style parser (样式·视觉解析器): reads COMPUTED styles + layout and runs
// a structured "visual lint" — invisible / low-contrast text, broken images,
// collapsed (zero-size) containers, clipped text, off-screen controls, horizontal
// overflow. This is the antidote to flaky pixel-vision (the user's "视觉特别容易
// 出问题"): the model reasons over real numbers (contrast ratios, box rects,
// naturalWidth) instead of guessing from a screenshot. Pass a CSS selector to
// deep-inspect one element; empty = scan the page. No regex (template-literal safe).
export function _visualInspectJS(selector) {
  return `(() => {
    try {
      var SEL = ${JSON.stringify(selector || "")};
      var lum = function(c){ var s=String(c), i=s.indexOf('('), j=s.indexOf(')'); if(i<0||j<0) return null; var p=s.slice(i+1,j).split(',').map(function(x){return parseFloat(x);}); if(p.length<3) return null; var f=function(v){ v/=255; return v<=0.03928? v/12.92 : Math.pow((v+0.055)/1.055,2.4); }; return 0.2126*f(p[0])+0.7152*f(p[1])+0.0722*f(p[2]); };
      var contrast = function(a,b){ var la=lum(a), lb=lum(b); if(la==null||lb==null) return null; var hi=Math.max(la,lb), lo=Math.min(la,lb); return Math.round(((hi+0.05)/(lo+0.05))*100)/100; };
      var path = function(el){ try{ if(!el||el===document.body) return 'body'; var p=el.tagName.toLowerCase(); if(el.id) return p+'#'+el.id; if(el.className && typeof el.className==='string'){ var c=el.className.trim().split(' ').filter(Boolean).slice(0,2).join('.'); if(c) p+='.'+c; } return p; }catch(e){ return '?'; } };
      var rectOf = function(el){ try{ var r=el.getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; }catch(e){ return null; } };
      var effBg = function(el){ var n=el; while(n){ var b=getComputedStyle(n).backgroundColor; if(b && b!=='rgba(0, 0, 0, 0)' && b!=='transparent') return b; n=n.parentElement; } return 'rgb(255, 255, 255)'; };
      var vw = innerWidth, vh = innerHeight;
      if (SEL) {
        var el = document.querySelector(SEL);
        if (!el) return JSON.stringify({ error: '没有元素匹配 '+SEL });
        var cs = getComputedStyle(el), r = el.getBoundingClientRect(), bg = effBg(el);
        return JSON.stringify({ selector:SEL, box:rectOf(el),
          visible: !(cs.display==='none'||cs.visibility==='hidden'||cs.opacity==='0'||r.width<1||r.height<1),
          color:cs.color, background:bg, contrast:contrast(cs.color,bg),
          fontFamily:cs.fontFamily.slice(0,60), fontSize:cs.fontSize, fontWeight:cs.fontWeight, lineHeight:cs.lineHeight,
          display:cs.display, position:cs.position, zIndex:cs.zIndex, overflow:cs.overflow,
          padding:cs.padding, margin:cs.margin, border:cs.border, borderRadius:cs.borderRadius, boxShadow:cs.boxShadow.slice(0,90), opacity:cs.opacity,
          offscreen:(r.right<=0||r.bottom<=0||r.left>=vw||r.top>=vh) });
      }
      var issues = [];
      var add = function(sev,type,el,msg,extra){ if(issues.length<60){ var o={ sev:sev, type:type, at:path(el), box:rectOf(el), msg:msg }; if(extra){ for(var k in extra) o[k]=extra[k]; } issues.push(o); } };
      var all = Array.prototype.slice.call(document.querySelectorAll('body *'), 0, 2500);
      var docOverflowX = (document.documentElement.scrollWidth||0) > vw + 2;
      for (var i=0;i<all.length;i++){
        var el2 = all[i], r2; try { r2 = el2.getBoundingClientRect(); } catch(e){ continue; }
        var cs2 = getComputedStyle(el2);
        var hidden = cs2.display==='none' || cs2.visibility==='hidden';
        if (el2.tagName==='IMG' && el2.complete && el2.naturalWidth===0 && (el2.getAttribute('src')||'')) add('error','broken-image',el2,'图片加载失败(naturalWidth=0)',{src:(el2.currentSrc||el2.src||'').slice(0,160)});
        if (hidden || cs2.opacity==='0') continue;
        var ownText = '';
        try { if (Array.prototype.some.call(el2.childNodes, function(n){ return n.nodeType===3 && n.textContent.trim(); })) ownText=(el2.textContent||'').trim(); } catch(e){}
        if (ownText && r2.width>1 && r2.height>1) {
          var bg2 = effBg(el2), cr = contrast(cs2.color, bg2);
          if (cr!=null) {
            var big = parseFloat(cs2.fontSize)>=24 || (parseFloat(cs2.fontSize)>=18.66 && (+cs2.fontWeight>=700));
            var min = big?3:4.5;
            if (cr < 1.6) add('error','invisible-text',el2,'文字与背景几乎同色，看不见',{contrast:cr,color:cs2.color,bg:bg2,text:ownText.slice(0,40)});
            else if (cr < min) add('warn','low-contrast',el2,'对比度不足 WCAG AA('+min+':1)',{contrast:cr,color:cs2.color,bg:bg2,text:ownText.slice(0,40)});
          }
        }
        if (docOverflowX && r2.right > vw + 4 && r2.width <= vw + 60 && r2.left >= -2) add('warn','x-overflow',el2,'元素超出视口右边，造成横向滚动',{right:Math.round(r2.right),vw:vw});
        if ((r2.width<1 || r2.height<1) && el2.children.length>0 && cs2.position!=='absolute' && cs2.position!=='fixed' && cs2.display!=='inline') add('warn','zero-size',el2,'有子节点但自身尺寸为 0(可能塌陷/未撑开)');
        if ((el2.tagName==='BUTTON'||el2.tagName==='A'||el2.getAttribute('role')==='button') && r2.width>0 && (r2.right<=0||r2.bottom<=0||r2.left>=vw||r2.top>=vh)) add('warn','offscreen-control',el2,'可交互元素在视口外');
        if (ownText && (cs2.overflow==='hidden'||cs2.overflowX==='hidden') && cs2.whiteSpace==='nowrap' && el2.scrollWidth>el2.clientWidth+2) add('warn','clipped-text',el2,'文字被裁切(nowrap + overflow:hidden 且溢出)',{text:ownText.slice(0,40)});
      }
      if (docOverflowX) issues.unshift({ sev:'warn', type:'page-x-overflow', at:'html', msg:'页面有横向滚动(scrollWidth='+document.documentElement.scrollWidth+' > 视口 '+vw+')' });
      var counts = {}; for (var c2=0;c2<issues.length;c2++){ counts[issues[c2].sev]=(counts[issues[c2].sev]||0)+1; }
      return JSON.stringify({ url:location.href, viewport:{w:vw,h:vh}, issueCount:issues.length, severity:counts, issues:issues.slice(0,22) });
    } catch (e) { return JSON.stringify({ error: String(e) }); }
  })()`;
}


export function _rgbToHex(rgb) {
  const m = String(rgb || "").match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!m) return "#000000";
  const h = (n) => ("0" + (parseInt(n, 10) & 255).toString(16)).slice(-2);
  return "#" + h(m[1]) + h(m[2]) + h(m[3]);
}

// 把 Tailwind class 串里某属性的类换成精确的任意值类（text-[#hex] / bg-[#hex] / p-[Npx]…），确定性、无歧义。
export function _swapTwClass(classStr, prop, value) {
  const parts = (classStr || "").split(/\s+/).filter(Boolean);
  const sizeRe = /^text-(xs|sm|base|lg|[0-9]?xl|\[[\d.]+(px|rem|em)\])$/;
  let keep, add;
  if (prop === "color") { keep = (c) => !(c.indexOf("text-") === 0 && !sizeRe.test(c)); add = "text-[" + value + "]"; }
  else if (prop === "bg") { keep = (c) => c.indexOf("bg-") !== 0; add = "bg-[" + value + "]"; }
  else if (prop === "fontSize") { keep = (c) => !sizeRe.test(c); add = "text-[" + value + "]"; }
  else if (prop === "padding") { keep = (c) => !/^p[xytblrse]?-/.test(c); add = "p-[" + value + "]"; }
  else if (prop === "radius") { keep = (c) => !/^rounded(-|$)/.test(c); add = "rounded-[" + value + "]"; }
  else return classStr;
  const out = parts.filter(keep); out.push(add); return out.join(" ");
}

export const _NODES_EXTRACT_JS = `(() => {
  try {
    var clean = function(s){ s=String(s||''); var out='', sp=false; for (var k=0;k<s.length;k++){ var ch=s[k]; if (ch===' '||ch==='\\n'||ch==='\\t'||ch==='\\r'){ if(!sp){ out+=' '; sp=true; } } else { out+=ch; sp=false; } } return out.trim(); };
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
    var qsa = function(sel){
      var out = [], rs = rootList();
      for (var d=0; d<rs.length; d++){ try { out = out.concat(Array.prototype.slice.call(rs[d].querySelectorAll(sel))); } catch(e){} }
      return out.filter(function(el, i){ return el && out.indexOf(el) === i; });
    };
    var rootOf = function(el){ try { return el && el.getRootNode ? el.getRootNode() : document; } catch(e){ return document; } };
    var parentDeep = function(el){ try { return el && (el.parentElement || (rootOf(el).host || null)); } catch(e){ return null; } };
    var closestDeep = function(el, sel){ var cur = el, guard = 0; while (cur && cur.nodeType === 1 && guard++ < 80) { try { if (cur.matches && cur.matches(sel)) return cur; } catch(e){} cur = parentDeep(cur); } return null; };
    qsa('[data-mnode]').forEach(function(e){ e.removeAttribute('data-mnode'); });
    var SEL = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=menu],[role=menuitem],[role=menuitemcheckbox],[role=listbox],[role=option],[role=checkbox],[role=switch],[role=radio],[role=combobox],[role=slider],[onclick],[draggable=true],[data-radix-collection-item],[data-state],[data-value],[cmdk-item],[contenteditable=""],[contenteditable=true],summary,label';
    var nameOf = function(el){ var t = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || (el.tagName==='INPUT'||el.tagName==='SELECT'||el.tagName==='TEXTAREA'? '' : (el.innerText||el.textContent||'')) || el.getAttribute('name') || ''; try { var lab = closestDeep(el, 'label'); if (lab && !t) t = lab.innerText || lab.textContent || ''; } catch(e){} try { var host = rootOf(el).host; if (host && !t) t = host.getAttribute('aria-label') || host.getAttribute('title') || host.getAttribute('data-testid') || host.getAttribute('id') || ''; } catch(e2){} return clean(t).slice(0,52); };
    var isH = function(tag){ return tag.length===2 && tag.charAt(0)==='h' && tag.charAt(1)>='1' && tag.charAt(1)<='6'; };
    var roleOf = function(el){ var r=el.getAttribute('role'); if (r) return r; var tag=el.tagName.toLowerCase();
      if (tag==='a') return 'link'; if (tag==='button') return 'button';
      if (tag==='input'){ var ty=(el.getAttribute('type')||'text').toLowerCase(); if (ty==='checkbox') return 'checkbox'; if (ty==='radio') return 'radio'; if (ty==='submit'||ty==='button'||ty==='reset'||ty==='image') return 'button'; if (ty==='range') return 'slider'; if (ty==='file') return 'file'; return 'textbox'; }
      if (tag==='select') return 'combobox'; if (tag==='textarea') return 'textbox';
      if (isH(tag)) return 'heading'; if (tag==='summary') return 'summary'; if (tag==='label') return 'label';
      return tag; };
    var stateOf = function(el){ var s={};
      if (el.disabled || el.getAttribute('aria-disabled')==='true') s.disabled=true;
      if (el.checked || el.getAttribute('aria-checked')==='true') s.checked=true;
      var exp=el.getAttribute('aria-expanded'); if (exp!=null) s.expanded=(exp==='true');
      if (el.getAttribute('aria-selected')==='true') s.selected=true;
      if ((el.tagName==='INPUT'||el.tagName==='TEXTAREA'||el.tagName==='SELECT') && el.value) s.value=String(el.value).slice(0,32);
      if (el.tagName==='A' && el.getAttribute('href')) s.href=el.getAttribute('href').slice(0,70);
      return s; };
    var roots = rootList(), nodes=[], id=0;
    var els = qsa(SEL).slice(0, 1500);
    for (var i=0;i<els.length;i++){
      if (id>=110) break;
      var el=els[i], r; try { r=el.getBoundingClientRect(); } catch(e){ continue; }
      var cs=getComputedStyle(el);
      if (r.width<1||r.height<1||cs.visibility==='hidden'||cs.display==='none'||cs.opacity==='0') continue;
      el.setAttribute('data-mnode', String(id));
      var inView = !(r.bottom<=0||r.right<=0||r.top>=innerHeight||r.left>=innerWidth);
      var node={ i:id, r:roleOf(el), n:nameOf(el) };
      var st=stateOf(el); for (var kk in st){ node.s=st; break; }
      if (!inView) node.off=1;
      nodes.push(node); id++;
    }
    var heads = qsa('h1,h2,h3').slice(0, 20)
      .map(function(h){ return { r:'h'+(h.tagName.charAt(1)), n:clean(h.innerText||'').slice(0,56) }; })
      .filter(function(h){ return h.n; }).slice(0,12);
    return JSON.stringify({ url:location.href, title:clean(document.title).slice(0,80), ready:document.readyState, active:document.activeElement ? nameOf(document.activeElement) : '', contexts:{ roots:roots.length, iframes:roots.iframeCount||0, shadowRoots:roots.shadowCount||0, crossOriginFrames:(roots.blockedFrames||[]).slice(0,6) }, total:id, structure:heads, nodes:nodes,
      legend:'i=节点号(用 browser click/type node=i 操作)·r=角色·n=名称·s=状态(disabled/checked/expanded/value/href)·off=1 表示在视口外(先 scroll 再点)·contexts.iframes/shadowRoots=同源的已纳入观察；contexts.crossOriginFrames=**够不着**的跨域 iframe，里面的元素在这份快照里一个都没有，别对它们换选择器——改成 navigate 到那个 src，或换用接口/其它路径' });
  } catch (e) { return JSON.stringify({ error: String(e) }); }
})()`;

/// @param hadLocator 调用方**给了**定位符（selector / node / index）。
///   给了却解析不出目标 → 直接判不存在，绝不回落到 'body *'。
///   一个字都没给、只给了 text → 'body *' 是正当的（纯文本断言就是全页找那句话）。
export function _assertJS(selector, text, hadLocator = false) {
  return `(() => {
    try {
      var SEL = ${JSON.stringify(selector || "")}, TXT = ${JSON.stringify(text || "")};
      var HAD_LOCATOR = ${hadLocator ? "true" : "false"};
      // 给了定位符却是空串：node/index 没能翻成选择器，或选择器被清成了空。
      // 这时回落到全页匹配就是凭空通过——直接如实说目标没解析出来。
      if (HAD_LOCATOR && !SEL) return JSON.stringify({ exists:false, visible:false, reason:'target_unresolved', note:'给了 node/index/selector 但没能解析成目标；先用 nodes 拿当前节点号，别用这次结果下结论' });
      var clean = function(s){ s=String(s||''); var out='', sp=false; for (var k=0;k<s.length;k++){ var ch=s[k]; if (ch===' '||ch==='\\n'||ch==='\\t'||ch==='\\r'){ if(!sp){ out+=' '; sp=true; } } else { out+=ch; sp=false; } } return out.trim(); };
      var pool; try { pool = Array.prototype.slice.call(document.querySelectorAll(SEL || 'body *'), 0, 4000); } catch(e){ return JSON.stringify({ error:'无效 selector: '+SEL }); }
      var want = TXT ? TXT.toLowerCase() : '';
      var matches=0, visibleCount=0, first=null;
      for (var i=0;i<pool.length;i++){
        var el=pool[i];
        if (want){
          var t = clean(el.innerText||el.textContent||el.value||'').toLowerCase();
          if (t.indexOf(want)<0) continue;
          // prefer the tightest element containing the text (skip if a child also has it)
          var childHas=false; try { childHas = Array.prototype.some.call(el.children, function(c){ return clean(c.innerText||c.textContent||'').toLowerCase().indexOf(want)>=0; }); } catch(e){}
          if (childHas) continue;
        }
        matches++;
        var r; try { r=el.getBoundingClientRect(); } catch(e){ continue; }
        var cs=getComputedStyle(el);
        var vis=!(r.width<1||r.height<1||cs.visibility==='hidden'||cs.display==='none'||cs.opacity==='0');
        if (vis) visibleCount++;
        if (!first) first={ tag:el.tagName.toLowerCase(), node:(el.getAttribute('data-mnode')||null), text:clean(el.innerText||el.textContent||el.value||'').slice(0,80), visible:vis, disabled:!!el.disabled, box:{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)} };
      }
      return JSON.stringify({ query:{selector:SEL,text:TXT}, exists:matches>0, visible:visibleCount>0, matches:matches, first:first });
    } catch(e){ return JSON.stringify({ error:String(e) }); }
  })()`;
}

export function _browserAutofillJS(fields, submit = false, submitText = "") {
  const safeFields = {};
  if (fields && typeof fields === "object" && !Array.isArray(fields)) {
    for (const [key, value] of Object.entries(fields).slice(0, 24)) {
      if (value == null) continue;
      safeFields[String(key).slice(0, 80)] = String(value).slice(0, 2000);
    }
  }
  return `(() => {
    var FIELDS = ${JSON.stringify(safeFields)};
    var SUBMIT = ${submit ? "true" : "false"};
    var SUBMIT_TEXT = ${JSON.stringify(String(submitText || "").slice(0, 120))};
    var clean = function(s){ s=String(s||''); var out='', sp=false; for (var k=0;k<s.length;k++){ var ch=s[k]; if (ch===' '||ch==='\\n'||ch==='\\t'||ch==='\\r'){ if(!sp){ out+=' '; sp=true; } } else { out+=ch; sp=false; } } return out.trim(); };
    var lower = function(s){ return clean(s).toLowerCase(); };
    var visible = function(el){ try { var r=el.getBoundingClientRect(); var cs=getComputedStyle(el); return r.width>1 && r.height>1 && cs.visibility!=='hidden' && cs.display!=='none' && Number(cs.opacity||1)>0.01; } catch(e){ return false; } };
    var labelText = function(el){
      var bits = [];
      try { bits.push(el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title'), el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('autocomplete'), el.getAttribute('type')); } catch(e){}
      try { if (el.id) { var lf = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (lf) bits.push(lf.innerText || lf.textContent); } } catch(e){}
      try { var lab = el.closest && el.closest('label'); if (lab) bits.push(lab.innerText || lab.textContent); } catch(e){}
      try { var wrap = el.closest && el.closest('[aria-label],[data-testid],[class],[id]'); if (wrap && wrap !== el) bits.push(wrap.getAttribute('aria-label'), wrap.getAttribute('data-testid'), wrap.getAttribute('class'), wrap.getAttribute('id')); } catch(e){}
      return lower(bits.filter(Boolean).join(' '));
    };
    var tokens = {
      email:['email','e-mail','mail','邮箱','邮件','电子邮件','账号','account','login'],
      password:['password','pass','pwd','密码','口令','current-password','new-password'],
      username:['username','user name','user','用户名','账号','账户','昵称','name','login'],
      phone:['phone','mobile','tel','telephone','手机','手机号','电话'],
      search:['search','query','keyword','q','搜索','查找','关键词'],
      title:['title','标题'],
      content:['content','body','正文','内容'],
      name:['name','姓名','名称'],
      code:['code','otp','captcha','verification','验证码','校验码','确认码']
    };
    var kindForKey = function(key){
      var k = lower(key);
      for (var name in tokens) {
        if (name === k) return name;
        for (var i=0;i<tokens[name].length;i++) if (k.indexOf(tokens[name][i]) >= 0) return name;
      }
      return k;
    };
    var controls = Array.prototype.slice.call(document.querySelectorAll('input:not([type=hidden]),textarea,select,[contenteditable=""],[contenteditable=true]'), 0, 600).filter(visible);
    var score = function(el, rawKey){
      var kind = kindForKey(rawKey), text = labelText(el), tag = el.tagName.toLowerCase(), type = lower(el.getAttribute('type') || (tag === 'textarea' ? 'textarea' : 'text'));
      var sc = 0;
      if (kind === 'password') sc += type === 'password' ? 100 : -30;
      if (kind === 'email') sc += type === 'email' ? 80 : (type === 'password' ? -50 : 0);
      if (kind === 'search') sc += type === 'search' ? 70 : 0;
      if (kind === 'phone') sc += (type === 'tel' || text.indexOf('phone') >= 0 || text.indexOf('手机') >= 0) ? 70 : 0;
      if ((kind === 'content' || kind === 'body') && (tag === 'textarea' || el.isContentEditable)) sc += 45;
      var arr = tokens[kind] || [kind];
      for (var i=0;i<arr.length;i++) if (arr[i] && text.indexOf(arr[i]) >= 0) sc += 28;
      if (text.indexOf(lower(rawKey)) >= 0) sc += 45;
      if (el.required || el.getAttribute('aria-required') === 'true') sc += 4;
      if (el.value) sc -= 2;
      return sc;
    };
    var nativeSet = function(el, value){
      try { el.scrollIntoView({ block:'center', inline:'center' }); } catch(e){}
      try { el.focus(); } catch(e){}
      try { el.click(); } catch(e){}
      if (el.isContentEditable) {
        el.textContent = value;
      } else if ('value' in el) {
        var proto = Object.getPrototypeOf(el), desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
        var base = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        var desc2 = Object.getOwnPropertyDescriptor(base, 'value');
        try { (desc && desc.set ? desc : desc2).set.call(el, value); } catch(e){ el.value = value; }
      } else return false;
      try { el.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'insertText', data:value })); } catch(e){ try { el.dispatchEvent(new Event('input', { bubbles:true })); } catch(e2){} }
      try { el.dispatchEvent(new Event('change', { bubbles:true })); } catch(e){}
      try { el.dispatchEvent(new Event('blur', { bubbles:true })); } catch(e){}
      return true;
    };
    var used = new Set(), filled = [], missing = [];
    Object.keys(FIELDS).forEach(function(key){
      var best = null, bestScore = -999;
      for (var i=0;i<controls.length;i++) {
        var el = controls[i];
        if (used.has(el)) continue;
        var sc = score(el, key);
        if (sc > bestScore) { bestScore = sc; best = el; }
      }
      if (!best || bestScore < 10) { missing.push({ field:key, reason:'没有找到语义匹配的可见输入框', bestScore:bestScore }); return; }
      if (!nativeSet(best, FIELDS[key])) { missing.push({ field:key, reason:'目标不可输入' }); return; }
      used.add(best);
      var masked = /pass|密码|pwd|secret|token/i.test(key) ? '••••••' : String(FIELDS[key]).slice(0,48);
      filled.push({ field:key, node:best.getAttribute('data-mnode') || null, tag:best.tagName.toLowerCase(), type:(best.getAttribute('type')||'').slice(0,20), label:labelText(best).slice(0,80), value:masked, score:bestScore });
    });
    var invalid = [];
    controls.forEach(function(el){
      try {
        if (typeof el.checkValidity === 'function' && !el.checkValidity()) {
          invalid.push({ label:labelText(el).slice(0,80), type:(el.getAttribute('type')||'').slice(0,20), required:!!el.required, value: /password/i.test(el.getAttribute('type')||'') ? (el.value ? '••••••' : '') : String(el.value||'').slice(0,48), message:String(el.validationMessage||'字段校验未通过').slice(0,120) });
        } else if ((el.required || el.getAttribute('aria-required') === 'true') && !String(el.value||'').trim()) {
          invalid.push({ label:labelText(el).slice(0,80), type:(el.getAttribute('type')||'').slice(0,20), required:true, value:'', message:'required empty' });
        }
      } catch(e){}
    });
    var submitted = false, submitTarget = null;
    var clickSubmit = function(){
      var want = lower(SUBMIT_TEXT);
      var btns = Array.prototype.slice.call(document.querySelectorAll('button,input[type=submit],input[type=button],[role=button],[onclick]'), 0, 400).filter(visible);
      var re = /(login|log in|sign in|submit|continue|save|create|register|登录|登陆|提交|继续|下一步|保存|注册|创建)/i;
      var scored = btns.map(function(b){
        var t = lower(b.innerText || b.value || b.getAttribute('aria-label') || b.getAttribute('title') || '');
        var s = 0;
        if (want && t.indexOf(want) >= 0) s += 100;
        if (!want && re.test(t)) s += 60;
        if ((b.getAttribute('type') || '').toLowerCase() === 'submit') s += 20;
        if (b.disabled || b.getAttribute('aria-disabled') === 'true') s -= 200;
        return { el:b, text:t, score:s };
      }).sort(function(a,b){ return b.score - a.score; });
      var pick = scored[0] && scored[0].score > 0 ? scored[0] : null;
      if (pick) { submitTarget = { text:pick.text.slice(0,80), tag:pick.el.tagName.toLowerCase() }; try { pick.el.scrollIntoView({ block:'center' }); } catch(e){} try { pick.el.click(); submitted = true; return; } catch(e){} }
      var form = controls[0] && controls[0].form;
      if (form && typeof form.requestSubmit === 'function') { try { form.requestSubmit(); submitted = true; submitTarget = { text:'form.requestSubmit()', tag:'form' }; } catch(e){} }
    };
    if (SUBMIT) clickSubmit();
    return JSON.stringify({
      url:location.href,
      title:clean(document.title).slice(0,80),
      ok: missing.length===0 && invalid.length===0,
      filled:filled,
      missing:missing,
      invalid:invalid,
      submitted:submitted,
      submitTarget:submitTarget,
      hint: invalid.length ? '表单还有浏览器/HTML5 校验失败字段；根据 invalid[].label/message 补齐后再提交，别只看截图。' : (missing.length ? '有字段没匹配到；先 nodes 看真实输入框名称，或显式传 selector/node。' : '字段已填入；如果 submitted=false，下一步 click/press Enter 或 submit:true。')
    });
  })()`;
}
