import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * 模型 id 的大小写不算区别。**和服务端 route_endpoints::same_model 是同一把尺，改一处要改两处。**
 *
 * 线上实测（2026-09-08）：MiniMax 线路自己写的是 `minimax-m3`，而「极速API」那个出口里存的是
 * `MiniMax-M3`（运维照抄中转控制台上的写法）。逐字节比的话，这两页会把同一款货画成两行，
 * IDE 的模型列表里也会重复出现 —— 所有者：「明明添加的模型不是新增的，IDE 里却当成重复的显示」。
 */
export const sameModel = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** 这份名单里有没有这个模型（忽略大小写）。 */
export const hasModel = (list: readonly string[], id: string) => list.some((x) => sameModel(x, id));

/** 忽略大小写去重，保留先出现的那个拼法（调用方把权威的那一份排在前面）。 */
export function dedupeModels(ids: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of ids) if (!hasModel(out, id)) out.push(id);
  return out;
}
