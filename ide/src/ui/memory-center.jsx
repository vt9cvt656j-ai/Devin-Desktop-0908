import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./components/dialog.jsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/tabs.jsx";
import { Button } from "./components/button.jsx";
import { cn } from "./lib/cn.js";

/**
 * Memory Center — project memory, global preferences, and the memory graph.
 *
 * The previous layout gave roughly 60% of the dialog to the 3D graph and squeezed the two
 * editors into a strip at the bottom, cut off mid-sentence. The graph is real functionality —
 * clicking a node selects that line in the editor — but it is something you look at
 * occasionally, while the editors are what you opened the panel to use. So they swap billing:
 * the editors are the default tab and get the full height, and the graph is one tab away at a
 * size where it is actually legible.
 *
 * The graph itself stays imperative (main.js owns _mcGlobeInit and its WebGL lifecycle). This
 * component just hands over a container node and tells main.js when the text changed so it can
 * rebuild. React owns layout; the widget owns itself.
 */
// Listed here rather than inline so the rail stays a list of sections, not markup.
// Core comes first: it is the layer that is present on every turn, so it is the one to check
// when the assistant "keeps forgetting" something. Memory and Preferences are retrieved by
// relevance; Core is not retrieved at all — it is simply always there.
const SECTIONS = [
  { value: "core", label: "Core" },
  { value: "memory", label: "Memory" },
  { value: "preferences", label: "Preferences" },
  { value: "graph", label: "Graph" },
];
/** Counters the host records about memory traffic; shown as plain numbers, no verdicts. */
const STAT_ROWS = [
  ["core.user", "Core entries (every project)"],
  ["core.project", "Core entries (this project)"],
  ["reflect.opened", "Run-end reflections that considered memory"],
  ["reflect.accepted", "Entries those reflections wrote"],
  ["capture.core.accepted", "Core entries captured from what you said"],
  ["render.core", "Turns that carried the core block"],
  ["retrieve.kg.hit", "Turns with a relevant memory hit"],
  ["retrieve.kg.empty", "Turns with no relevant memory hit"],
  ["retrieve.ep.hit", "Turns with a matching past task"],
  ["retrieve.wf.hit", "Turns with a matching workflow"],
];

export function MemoryCenter({
  hasRoot,
  initialProject,
  initialGlobal,
  initialCore,
  memoryStats,
  onSaveCore,
  onGlobeMount,
  onTextChange,
  onSave,
  onClearProject,
  onClearGlobal,
  onClose,
}) {
  const [project, setProject] = useState(initialProject ?? "");
  const [global, setGlobal] = useState(initialGlobal ?? "");
  const [coreUser, setCoreUser] = useState(initialCore?.user ?? "");
  const [coreProject, setCoreProject] = useState(initialCore?.project ?? "");
  const [tab, setTab] = useState("core");
  const globeHost = useRef(null);
  const globeHandle = useRef(null);
  const projectRef = useRef(null);
  const globalRef = useRef(null);

  // A callback ref rather than an effect: it fires exactly when the node attaches, and again
  // with null when it detaches. An effect keyed on the active tab looked equivalent and was not
  // — Radix attaches tab content on its own schedule, so the effect ran while the ref was still
  // null and the graph silently never got built.
  const attachGlobe = useCallback((node) => {
    globeHost.current = node;
    if (node) {
      globeHandle.current = onGlobeMount?.({
        host: node,
        projectEl: projectRef.current,
        globalEl: globalRef.current,
      });
    } else {
      try { globeHandle.current?.destroy?.(); } catch { /* already torn down */ }
      globeHandle.current = null;
    }
  }, [onGlobeMount]);

  // Tear the graph down with the dialog, not only when the tab changes.
  useEffect(() => () => {
    try { globeHandle.current?.destroy?.(); } catch { /* already torn down */ }
  }, []);

  const edit = useCallback((which, value) => {
    if (which === "project") setProject(value); else setGlobal(value);
    onTextChange?.(which, value);
  }, [onTextChange]);

  const editorClass = cn(
    "min-h-0 flex-1 resize-none rounded-lg border border-border bg-card px-3 py-2",
    "font-mono text-[12px] leading-6 text-foreground outline-none",
    "placeholder:text-muted-foreground focus:border-primary",
    "disabled:cursor-not-allowed disabled:opacity-60",
  );

  return (
    <Dialog defaultOpen onOpenChange={(open) => { if (!open) onClose?.(); }}>
      <DialogContent className="flex h-[78vh] sm:max-w-4xl flex-col gap-0 overflow-hidden rounded-2xl p-0 shadow-xl">
        <DialogHeader className="shrink-0 space-y-1 border-b border-border px-5 pt-5 pb-4">
          <DialogTitle className="text-base">Memory</DialogTitle>
          <DialogDescription className="text-[12px]">
            One entry per line. Project memory applies here; preferences travel with you.
          </DialogDescription>
        </DialogHeader>

        {/* A rail listing every section rather than a two-tab switcher: the point of this panel
            is to show what the assistant remembers and where each kind lives, so the sections
            should be visible at once instead of one being hidden behind the other. Text only —
            these are short, unambiguous words that an icon can only make vaguer. Same shape as
            the advanced-settings rail. */}
        <Tabs
          value={tab}
          onValueChange={setTab}
          orientation="vertical"
          className="flex min-h-0 flex-1 flex-row gap-0"
        >
          <TabsList className="h-auto w-40 shrink-0 flex-col items-stretch justify-start gap-0.5 rounded-none border-r border-border bg-transparent p-3">
            {SECTIONS.map((s) => (
              <TabsTrigger
                key={s.value}
                value={s.value}
                className={cn(
                  // flex-none: TabsTrigger ships flex-1 for a horizontal bar, which in a
                  // vertical rail makes every item stretch to fill the column height.
                  "h-9 flex-none justify-start rounded-lg px-3 text-[13px] font-normal",
                  "data-[state=active]:bg-primary/10 data-[state=active]:font-medium data-[state=active]:text-primary data-[state=active]:shadow-none",
                )}
              >
                {s.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="core" className="mt-0 flex min-h-0 min-w-0 flex-1 flex-col gap-3 px-5 py-4">
            <p className="text-[12px] text-muted-foreground">
              Always in context, every turn. Keep it short: a few rules and preferences, not notes.
              Lines starting with <code className="rounded bg-muted px-1">[你记的]</code> were written by the assistant — delete the tag to adopt one as your own.
            </p>
            <div className="flex min-h-0 flex-1 flex-col gap-1.5">
              <h3 className="text-[12px] font-medium text-foreground">My core (every project)</h3>
              <textarea
                className={editorClass}
                spellCheck={false}
                value={coreUser}
                onChange={(e) => setCoreUser(e.target.value)}
                placeholder="Reply in Chinese&#10;Keep answers short, lead with the conclusion"
              />
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-1.5">
              <h3 className="text-[12px] font-medium text-foreground">
                Project core
                {!hasRoot ? <span className="ml-2 font-normal text-muted-foreground">no folder open</span> : null}
              </h3>
              <textarea
                className={editorClass}
                spellCheck={false}
                disabled={!hasRoot}
                value={coreProject}
                onChange={(e) => setCoreProject(e.target.value)}
                placeholder="Goal: a movie site for one cinema&#10;API prefix is /api/v2&#10;Money is stored in cents"
              />
            </div>
            {memoryStats && Object.keys(memoryStats).length ? (
              <dl className="grid shrink-0 grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground">
                {STAT_ROWS.filter(([k]) => memoryStats[k] != null).map(([k, label]) => (
                  <div key={k} className="flex justify-between gap-2">
                    <dt className="truncate">{label}</dt>
                    <dd className="tabular-nums text-foreground">{memoryStats[k]}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </TabsContent>

          <TabsContent value="memory" className="mt-0 flex min-h-0 min-w-0 flex-1 flex-col gap-1.5 px-5 py-4">
            <h3 className="text-[12px] font-medium text-foreground">
              Project memory
              {!hasRoot ? (
                <span className="ml-2 font-normal text-muted-foreground">no folder open</span>
              ) : null}
            </h3>
            <textarea
              ref={projectRef}
              className={editorClass}
              spellCheck={false}
              disabled={!hasRoot}
              value={project}
              onChange={(e) => edit("project", e.target.value)}
              placeholder="This project uses pnpm&#10;UI goes through shadcn/ui"
            />
          </TabsContent>

          <TabsContent value="preferences" className="mt-0 flex min-h-0 min-w-0 flex-1 flex-col gap-1.5 px-5 py-4">
            <h3 className="text-[12px] font-medium text-foreground">Global preferences</h3>
            <textarea
              ref={globalRef}
              className={editorClass}
              spellCheck={false}
              value={global}
              onChange={(e) => edit("global", e.target.value)}
              placeholder="Answer truthfully&#10;Verify a fix before calling it done"
            />
          </TabsContent>

          {/* forceMount: Radix otherwise unmounts the inactive tab, so the graph's host node does
              not exist until you switch — and the globe is imperative code that needs a real,
              sized node to attach to. Mounting it up front is also what the previous panel did,
              so the graph's own lifecycle is unchanged; only where it sits on screen is. */}
          <TabsContent
            value="graph"
            forceMount
            className="mt-0 min-h-0 flex-1 px-5 py-4 data-[state=inactive]:hidden"
          >
            <div className="relative h-full overflow-hidden rounded-xl border border-border bg-muted/30">
              <div ref={attachGlobe} className="h-full w-full" />
              <p className="pointer-events-none absolute bottom-2 right-3 text-[11px] text-muted-foreground">
                Drag to rotate · hover to inspect · click to jump to that line
              </p>
            </div>
          </TabsContent>
        </Tabs>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">
          {/* Only the clear action for the section you are looking at. With Memory and
              Preferences now separate places, showing both destructive buttons at all times
              invites clearing the one you are not in. */}
          {tab === "memory" ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={!hasRoot}
              className="text-muted-foreground hover:text-destructive"
              onClick={() => { setProject(""); onClearProject?.(); }}
            >
              Clear project memory
            </Button>
          ) : null}
          {tab === "preferences" ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => { setGlobal(""); onClearGlobal?.(); }}
            >
              Clear preferences
            </Button>
          ) : null}
          <Button size="sm" onClick={() => (tab === "core" ? onSaveCore?.(coreUser, coreProject) : onSave?.(project, global))}>Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
