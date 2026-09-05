import { mountIsland, unmountIsland } from "./island.jsx";
import { MemoryCenter } from "./memory-center.jsx";

/**
 * vanilla → React seam for the Memory Center. Same shape as the other mounts: the JSX stays out
 * of main.js, which vite deliberately does not run through the React plugin.
 */
const HOST_ID = "memory-center-host";

export function openMemoryCenterIsland(props) {
  const existing = document.getElementById(HOST_ID);
  if (existing) { close(existing); return; }

  const host = document.createElement("div");
  host.id = HOST_ID;
  document.body.appendChild(host);

  mountIsland(host, (
    <MemoryCenter
      {...props}
      onSave={(project, global) => { close(host); props.onSave?.(project, global); }}
      onSaveCore={(user, project) => { close(host); props.onSaveCore?.(user, project); }}
      onClose={() => { close(host); props.onClose?.(); }}
    />
  ));
}

function close(host) {
  unmountIsland(host);
  // unmountIsland defers to a microtask; the host must outlive it, or React unmounts against a
  // node already detached from the document. This also lets the graph's cleanup effect run.
  queueMicrotask(() => queueMicrotask(() => host.remove()));
}
