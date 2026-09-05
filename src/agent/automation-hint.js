// CDP sidecar（automation 工具）失败时的下一步。sidecar 回的是底层原文（2026-09-05 冒烟实测：
// 点不存在的元素回「元素未找到: #nope: Error -32000: Could not find node with given id」，等元素
// 超时回「超时: 等待元素 #h 超时」），模型拿到后常见的反应是换几个猜的选择器逐个试。
// 返回值非空时带前导换行，直接接在失败文案后面；判定不了返回空串。
export function automationNextStep(method, message) {
  const m = String(message || "");
  const isBrowser = /^browser\./.test(String(method || ""));
  if (isBrowser && /元素未找到|Could not find node|找不到/.test(m)) {
    return "\n选择器没匹配到元素——别换几个猜的选择器逐个试。先 browser.eval 列出真实可点项："
      + "`[...document.querySelectorAll('a[href],button,input,select,textarea,[role=button]')].map(e=>e.tagName.toLowerCase()+(e.id?'#'+e.id:'')+' '+(e.textContent||e.value||'').trim().slice(0,30))`，"
      + "或 browser.content 看 HTML，再按真实 id/文本改选择器。";
  }
  if (isBrowser && /超时.*等待元素|等待元素.*超时/.test(m)) {
    return "\n等到超时它也没出现，等更久多半没用：用 browser.content 确认它会不会渲染（可能在 iframe 里、或要先点别的东西才出现）。";
  }
  if (isBrowser && /未启动|not started|no browser|尚未|先调用 browser\.start/i.test(m)) {
    return "\n先 browser.start（要用用户自己的登录态就 profile:\"session\"，否则 isolated），再 goto。";
  }
  return "";
}
