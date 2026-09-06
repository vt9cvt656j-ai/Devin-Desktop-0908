# Prompt graph (v3)

Every production IDE request is assembled from `prompt_graph.json`. The graph and its modules are
required deployment artifacts; a missing or invalid graph fails the request instead of restoring a
monolithic prompt. The runtime lives in `src/prompt_modules.rs` (the data model and the head/tail
conditions) and `src/prompts.rs` (`assemble_into`, the only place that reads the graph).

## Two layers: 必须 and 按需

- **core** — what every agent request carries, in order: `system_invariants` (the instruction
  ladder and the two floors), `agent_core` (identity, execution contract, reasoning discipline),
  `truth_core`, `answer_core`. ≈ 9 KB / ≈ 2.3k tokens. The size is pinned by a test; it only shrinks.
- **modes** — chat / plan / explorer / reviewer each list their own blocks (they reuse `truth_core`,
  `truth_sources`, `no_flattery`, `answer_core`, `answer_professional`, `voice`).
- **modules** — everything else, one record each, delivered by one of three routes:
  - `head`: injected into the system prompt when the client's semantic profile carries one of
    `flags` (and none of `not_flags`, and every module in `requires` is already in the head).
    `modes` defaults to `["agent"]`; the design layer also opens for `plan`. `unjudged_default`
    loads the module while the intent verdict has not landed (engineering only). Head modules
    ride the client's sticky, grow-only profile, so the system prefix stays byte-stable in a session.
  - `tail`: attached as one harness message (the client's `〔系统编排提示…〕` envelope, label
    `〔按需指南·<title>〕`) right after the first tool run that matches `tools` (exact or `prefix_*`),
    `files` (path arguments ending in `*.tsx` etc.), or `commands` (substrings of a `run_cmd` /
    `run_in_terminal` command). `requires` must already be delivered. The position and text are a
    pure function of the conversation, so the upstream prefix cache is never broken by a mid-session
    load, and nothing is stored server-side. A module is delivered once per conversation.
  - `pull`: the model calls `load_guide {id}` (tools.json); the guide is attached after that call's
    result. The one-line `pull` text is what the tool description tells the model about the guide.
- `derived` names a code-generated body (`defect_classes_writing`) instead of files.

Runtime additions that are not modules: the model-family notes (`model_notes@<family>.txt`, after
the core), the michael-design blueprint packet (when the `design` module is in the head), the
bounded engineering knowledge block (engineering flag), and the trailing runtime context.

## Change rules

1. Add or reorder modules in `prompt_graph.json`; head order is prompt order.
2. Add every routed `.txt` module to `PROMPT_NAMES` in `src/prompts.rs` so prompt versions change.
3. A new head flag must also be in `IDE_SEMANTIC_PROFILE_FLAGS` (wire allow-list) and emitted by
   the client's `_ideSemanticProfile`; a new pullable id must appear in the `load_guide` description.
4. Keep module selection stable across follow-up turns; never put per-turn content into the head.
5. Add new runtime detail to the narrowest module and extend the strength-contract tests.
6. Run `cargo test prompts -- --test-threads=1`, then the full server test suite.

`knowledge/michael-design/` remains the full design corpus. UI assembly injects a bounded set of
relevant excerpts and leaves deeper retrieval to `knowledge_search`; the corpus files are not
rewritten or duplicated into prompts.
