/**
 * 长命令的实时输出尾巴：攒块、节流、只留尾部。
 *
 * run_cmd 的卡片原来在命令结束前只有一个跳秒计时器——一次五分钟的构建，用户看到的是
 * 「Running 213.4s」和一片空白（生产 7 天里 581 步超过 60 秒）。现在 Rust 每读到一块就发
 * 一个事件（tasks.rs 的 CaptureLive），这个对象负责把块攒起来、按节流间隔渲染一次、
 * 并且只保留尾部——一条刷屏的构建不能把 innerHTML 拼成兆级字符串。
 *
 * 纯函数式：渲染函数和定时器都从参数传（测试里注入假定时器做真往返），不碰 DOM。
 *
 * @param {{render:(tail:string)=>void, keep?:number, throttleMs?:number,
 *          schedule?:(fn:Function, ms:number)=>any, cancel?:(handle:any)=>void}} opts
 */
export function createLiveTail(opts = {}) {
  const render = typeof opts.render === "function" ? opts.render : () => {};
  const keep = Number.isFinite(opts.keep) && opts.keep > 0 ? Math.floor(opts.keep) : 6000;
  const throttleMs = Number.isFinite(opts.throttleMs) && opts.throttleMs >= 0 ? opts.throttleMs : 80;
  const schedule = typeof opts.schedule === "function" ? opts.schedule : (fn, ms) => setTimeout(fn, ms);
  const cancelTimer = typeof opts.cancel === "function" ? opts.cancel : (h) => clearTimeout(h);
  let buf = "";
  let timer = null;
  let renders = 0;
  const fire = () => {
    timer = null;
    renders++;
    // 尾部截取按字符数；ANSI 序列可能被切在中间，渲染层会把残缺序列当普通文本转义，
    // 只影响预览的第一行颜色，不影响最终结果（命令结束后整份重渲）。
    try { render(buf.length > keep ? buf.slice(-keep) : buf); } catch { /* 预览渲染失败不许影响命令本身 */ }
  };
  return {
    /** 又来了一块。第一块立刻排一次渲染，之后在节流间隔内合并。 */
    push(text) {
      const t = String(text ?? "");
      if (!t) return;
      buf += t;
      // 缓冲区本身也封顶（留两倍尾巴），否则一条刷屏命令会让内存随输出线性长。
      if (buf.length > keep * 2) buf = buf.slice(-keep);
      if (timer == null) timer = schedule(fire, throttleMs);
    },
    /** 命令结束、要用整份结果重渲之前调：掐掉还没醒的定时器，免得它把最终输出盖回预览。 */
    cancel() {
      if (timer != null) { cancelTimer(timer); timer = null; }
    },
    /** 同一张卡片要重跑一次（沙箱逃生门）：清空重来。 */
    reset() {
      this.cancel();
      buf = "";
    },
    /** 测试与诊断用：目前攒了多少、渲染了几次。 */
    get size() { return buf.length; },
    get renders() { return renders; },
  };
}
