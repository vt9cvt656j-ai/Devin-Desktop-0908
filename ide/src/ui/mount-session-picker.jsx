import { mountIsland, unmountIsland } from "./island.jsx";
import { SessionPicker } from "./session-picker.jsx";

/**
 * vanilla → React seam for `/sessions`. Same shape as mount-gallery.jsx and
 * mount-slash-menu.jsx: the JSX stays out of main.js, which vite deliberately does not run
 * through the React plugin.
 *
 * 2026-09-07：改成拿一个 `load()` 而不是一份现成的 entries。所有者要「换了文件夹会话列表
 * 自动更新」——根目录一变（main.js 的 setActiveWorkspaceRoot 发 `mrday:root-changed`），
 * 这里再调一次 load() 重画同一个岛；岛里的搜索词和范围选择是 React 状态，重画不丢。
 * 老调用方式（直接给 entries）仍然认，只是没有自动刷新。
 */
const HOST_ID = "session-picker-host";
export const ROOT_CHANGED_EVENT = "mrday:root-changed";

export function openSessionPickerIsland({ load, entries, root, onPick }) {
  const existing = document.getElementById(HOST_ID);
  if (existing) { close(existing); return; }

  const host = document.createElement("div");
  host.id = HOST_ID;
  document.body.appendChild(host);

  const render = (data) => mountIsland(host, (
    <SessionPicker
      entries={data?.entries || []}
      root={data?.root || ""}
      onPick={(entry) => { close(host); onPick?.(entry); }}
      onClose={() => close(host)}
    />
  ));
  const refresh = async () => {
    if (!host.isConnected) return;
    try { render(await load()); }
    catch (e) { console.warn("[sessions] reload failed:", e); }
  };
  if (typeof load === "function") {
    const onRoot = () => { void refresh(); };
    window.addEventListener(ROOT_CHANGED_EVENT, onRoot);
    host._cleanup = () => window.removeEventListener(ROOT_CHANGED_EVENT, onRoot);
    void refresh();
  } else {
    render({ entries, root });
  }
}

function close(host) {
  try { host._cleanup?.(); } catch { /* listener already gone */ }
  host._cleanup = null;
  unmountIsland(host);
  // unmountIsland defers the unmount to a microtask; the host has to outlive it or React
  // unmounts against a node already detached from the document.
  queueMicrotask(() => queueMicrotask(() => host.remove()));
}
