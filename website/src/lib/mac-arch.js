/**
 * 一台 Mac 是 Apple Silicon 还是 Intel —— 这里放**纯逻辑**那一半。
 *
 * 为什么单独成文件：两个信号源（Chromium 的客户端提示、WebGL 的 unmasked renderer）
 * 都必须有浏览器才拿得到，但「拿到信号之后怎么判」是纯函数，而恰恰是这一半会悄悄判错。
 * 拆出来就能在 Node 里拿真实机器上抓到的字符串跑一遍，而不是只靠读代码相信它。
 *
 * 写成 .js 而不是 .ts：CI 钉的是 node 20，它 import 不了 TypeScript，
 * 测试文件会整份静默不执行 —— 那种"测试全绿"比没有测试更糟。
 */

/**
 * Chromium 客户端提示的 `architecture` → 架构名。判不出来给 null。
 *
 * 这个 API 只有 Chromium 系有，但在那里是**权威**的：它读的是真实 CPU，
 * 不像 UA 那样为兼容性说谎。
 *
 * @param {string | undefined | null} architecture
 * @returns {"arm64" | "x64" | null}
 */
export function archFromClientHint(architecture) {
  if (architecture === "arm") return "arm64";
  if (architecture === "x86") return "x64";
  return null;
}

/** Intel 时代的 Mac 上会出现的 GPU 厂商。M 系一台也不会报这些。 */
const INTEL_ERA_GPU = /\b(intel|amd|radeon|nvidia|geforce)\b/i;
/** M 系的 GPU 名字：Safari 报通用的「Apple GPU」，Chromium 报「Apple M1」这类。 */
const APPLE_GPU = /\bapple\b/i;

/**
 * WebGL 的 unmasked renderer → 架构名。判不出来给 null。
 *
 * Mac 上 GPU 厂商和 CPU 架构是绑定的，所以 GPU 名字可以反推架构。
 * **顺序要紧**：先判 Intel 那一组。Intel Mac 上的字符串可能同时含 "Apple"
 * （例如 "Intel Iris OpenGL Engine" 之外还有带 Apple 字样的变体），
 * 而 M 系的字符串里**永远不会**出现 intel/amd/nvidia —— 所以含这些词是更硬的判据。
 *
 * @param {string | undefined | null} renderer
 * @returns {"arm64" | "x64" | null}
 */
export function archFromRenderer(renderer) {
  const s = typeof renderer === "string" ? renderer : "";
  if (!s) return null;
  if (INTEL_ERA_GPU.test(s)) return "x64";
  if (APPLE_GPU.test(s)) return "arm64";
  return null;
}

/**
 * 综合两个信号给出架构；两个都没结论时返回 null。
 *
 * **GPU 先判，客户端提示垫后** —— 这个顺序是反直觉的，但对：
 *
 * 客户端提示读的是**当前进程**的架构，不是机器的。M 系 Mac 上用 Rosetta 跑的 Chrome
 * 会老老实实报 "x86"，而那台机器是 M 系。GPU 不经 Rosetta 翻译，所以「GPU 是 Apple 的」
 * 是比进程架构更硬的事实。反过来，Intel Mac 上的 Chromium 一定把 GPU 报成
 * Intel/AMD/NVIDIA，先判 GPU 不会把 Intel 机器认成 M 系。
 *
 * GPU 判不出来时（WebGL 被禁、字符串被抹成通用串）才用客户端提示，那时它是权威的。
 *
 * 两条都没结论就返回 null。调用方必须为「判不出来」准备一条出路（页面上是那个
 * 「换另一个架构」的链接），别在这里硬猜一个了事：猜错而用户不知道，比明说不确定更糟。
 *
 * @param {{ architecture?: string | null, renderer?: string | null }} signals
 * @returns {"arm64" | "x64" | null}
 */
export function pickMacArch(signals) {
  return (
    archFromRenderer(signals && signals.renderer) ??
    archFromClientHint(signals && signals.architecture)
  );
}
