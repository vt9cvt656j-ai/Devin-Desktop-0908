/** 见 mac-arch.js —— 那边是实现，这里只是给 TS 看的形状。 */
export type MacArch = "arm64" | "x64";
export declare function archFromClientHint(architecture?: string | null): MacArch | null;
export declare function archFromRenderer(renderer?: string | null): MacArch | null;
export declare function pickMacArch(signals: {
  architecture?: string | null;
  renderer?: string | null;
}): MacArch | null;
