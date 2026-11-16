<script lang="ts">
  /**
   * A unit's cut: the same editor at every level of a film.
   *
   * A shot's cut is its take with its trim and grade; a scene's is its shots
   * in cutting order with the scene's sound; the film's is its scenes with
   * the score and the mix. One surface for the three, because the work is the
   * same: sources on the left, the monitor in the middle, what is selected on
   * the right, time underneath.
   *
   * The person edits a draft. Saving writes it as the next revision and is
   * refused if the agent wrote one meanwhile; rendering renders what is
   * saved, never the draft, and says so when the two differ.
   */
  import { untrack } from "svelte";
  import { cut } from "$lib/cut-store.svelte.ts";
  import { film, type Unit } from "$lib/film-store.svelte.ts";
  import { studio } from "$lib/studio-store.svelte.ts";
  import { clock } from "$lib/film-format";
  import { unitKey } from "$lib/film-types";
  import StateChip from "../film/StateChip.svelte";
  import CutTimeline from "./CutTimeline.svelte";
  import CutMonitor from "./CutMonitor.svelte";
  import CutInspector from "./CutInspector.svelte";
  import CutSources from "./CutSources.svelte";

  interface Props {
    unit: Unit;
  }

  let { unit }: Props = $props();

  const level = $derived(unit.scene === "_" ? "film" : unit.shot === "_" ? "scene" : "shot");
  const node = $derived(film.node(unit));
  const key = $derived(unitKey(unit));
  const format = $derived(film.tree?.manifest?.format ?? null);

  /* The cut is read when the unit is entered, and read again when the library's
     copy moves on — the agent edited it, an assembly ran. A draft with changes
     of its own is kept, and the person is told the cut moved under it. */
  $effect(() => {
    const revision = node?.status.cut.revision ?? null;
    const shape = format ? { ...(format.id ? { id: format.id } : {}), width: format.width, height: format.height, fps: format.fps } : undefined;
    void revision;
    if (!film.tree || film.tree.slug !== unit.film) return;
    // The store reads its own state to tell a new unit from the same one: that is not this effect's concern.
    untrack(() => void cut.load(unit, shape));
  });

  // ── Panels ────────────────────────────────────────────────────────────

  const STORAGE = "vs-cut-layout";
  let showSources = $state(true);
  let showInspector = $state(true);
  let timelineHeight = $state(280);

  $effect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE) ?? "{}");
      if (typeof saved.sources === "boolean") showSources = saved.sources;
      if (typeof saved.inspector === "boolean") showInspector = saved.inspector;
      if (typeof saved.timeline === "number") timelineHeight = saved.timeline;
    } catch { /* first run */ }
  });

  function persist() {
    try {
      localStorage.setItem(STORAGE, JSON.stringify({ sources: showSources, inspector: showInspector, timeline: timelineHeight }));
    } catch { /* the session still works */ }
  }

  /* The inspector is the shell's own panel while that panel is showing — its
     Cut tab — and a column of this view when it is away, so there is always
     one and never two. */
  const inlineInspector = $derived(!studio.inspectorVisible && showInspector);

  let root = $state<HTMLDivElement | null>(null);
  let resizing = $state(false);

  function resizeDown(event: PointerEvent) {
    resizing = true;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function resizeMove(event: PointerEvent) {
    if (!resizing || !root) return;
    const box = root.getBoundingClientRect();
    timelineHeight = Math.round(Math.max(120, Math.min(box.height - 220, box.bottom - event.clientY)));
  }

  function resizeUp() {
    if (resizing) persist();
    resizing = false;
  }

  function resizeKey(event: KeyboardEvent) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    timelineHeight = Math.max(120, Math.min(720, timelineHeight + (event.key === "ArrowUp" ? 24 : -24)));
    persist();
  }

  // ── Saving, assembling, rendering ─────────────────────────────────────

  const errors = $derived(cut.problems.filter((problem) => problem.severity === "error").length);
  const rendering = $derived(film.rendering);
  const renderingThis = $derived(rendering?.unit === key);

  const ASSEMBLE_HELP = {
    film: "Lay the film's scenes out in running order. Scenes already in the cut keep their clip; new ones are added, removed ones go.",
    scene: "Lay the scene's shots out in cutting order. Shots already in the cut keep their clip; new ones are added, removed ones go.",
    shot: "Cut the shot from its newest picture under assets/.",
  } as const;

  async function save() {
    if (await cut.save()) await film.refresh();
  }

  async function assemble() {
    if (await cut.assemble(level === "shot" && cut.frames > 0 ? { replace: true } : {})) await film.refresh();
  }

  async function render(quality: "final" | "preview") {
    if (cut.dirty) {
      cut.notice = { tone: "error", text: "Save the cut first: a render is of what is saved, and your changes are not." };
      return;
    }
    // What the render says next is the news: an earlier "saved" must not sit in front of it.
    cut.notice = null;
    film.lastRender = null;
    await film.render(unit, { quality });
  }

  let monitor = $state<ReturnType<typeof CutMonitor> | null>(null);

  function keydown(event: KeyboardEvent) {
    const meta = event.metaKey || event.ctrlKey;
    const typing = (event.target as HTMLElement).closest("input, textarea, select, [contenteditable]");
    if (meta && event.key.toLowerCase() === "z") {
      if (typing) return;
      event.preventDefault();
      if (event.shiftKey) cut.redo();
      else cut.undo();
    } else if (meta && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (cut.dirty && errors === 0) void save();
    } else if (!meta && !event.altKey) {
      monitor?.handleKey(event);
    }
  }

  const notice = $derived(cut.notice ?? film.notice);
  const lastRender = $derived(film.lastRender && film.lastRender.unit === key ? film.lastRender : null);
</script>

{#if !node}
  <div class="cv-empty" role={film.error ? "alert" : "status"}>
    {film.error ?? (film.loading || !film.tree ? "Reading the film…" : `There is no ${level} here.`)}
  </div>
{:else}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="cut-view" bind:this={root} onkeydown={keydown} style="--timeline: {timelineHeight}px">
    <header class="cv-bar">
      <div class="cv-what">
        <span class="cv-title">{node.title}</span>
        <span class="cv-rev">
          {#if cut.saved}revision {cut.saved.revision} · {clock(cut.frames / cut.fps)}{:else}no cut yet{/if}
        </span>
        {#if cut.dirty}
          <span class="cv-dirty" title="The timeline differs from what is saved">Unsaved changes</span>
        {:else if cut.status}
          <StateChip state={cut.status.state} title={cut.status.reason} />
        {/if}
      </div>

      <div class="cv-tools">
        <button onclick={() => cut.undo()} disabled={cut.historyDepth.past === 0} title="Undo (⌘Z)">Undo</button>
        <button onclick={() => cut.redo()} disabled={cut.historyDepth.future === 0} title="Redo (⇧⌘Z)">Redo</button>
        <span class="cv-sep" aria-hidden="true"></span>
        <button onclick={() => cut.discard()} disabled={!cut.dirty} title="Throw the unsaved changes away and take the saved cut">Discard</button>
        <button class="cv-primary" onclick={save} disabled={!cut.dirty || cut.saving || errors > 0} title={errors > 0 ? `${errors} problem${errors === 1 ? "" : "s"} to fix before it can be saved` : "Save as the next revision (⌘S)"}>
          {cut.saving ? "Saving…" : "Save"}
        </button>
        <span class="cv-sep" aria-hidden="true"></span>
        <button onclick={assemble} disabled={cut.dirty} title={ASSEMBLE_HELP[level]}>Assemble</button>
        <button onclick={() => cut.check()} disabled={!cut.saved} title="Check the saved cut as a render would: its files, its effects, what is under it">Check</button>
        <span class="cv-sep" aria-hidden="true"></span>
        {#if rendering}
          <span class="cv-progress" role="status">
            {renderingThis ? "Rendering" : `Rendering ${rendering.unit.split("/").filter((part) => part !== "_").slice(1).join(" / ") || "the film"}`}
            {#if rendering.progress}
              <progress max={rendering.progress.total} value={rendering.progress.done}></progress>
              <span class="cv-phase">{rendering.progress.phase}</span>
            {/if}
          </span>
          <button onclick={() => film.stopRender()}>Stop</button>
        {:else}
          <button onclick={() => render("preview")} disabled={!cut.saved || cut.frames === 0} title="A quick, small render to judge the cut by">Preview</button>
          <button class="cv-primary" onclick={() => render("final")} disabled={!cut.saved || cut.frames === 0 || (cut.status?.state === "current" && !cut.dirty)} title={cut.status?.state === "current" ? "The final render is current" : "Render at delivery quality. What is under it and out of date is rendered first."}>Render</button>
        {/if}
        <span class="cv-sep" aria-hidden="true"></span>
        <button aria-pressed={showSources} onclick={() => { showSources = !showSources; persist(); }} title="Show or hide the sources">Sources</button>
        {#if studio.inspectorVisible}
          <button aria-pressed={studio.inspectorTab === "cut"} onclick={() => (studio.inspectorTab = "cut")} title="What is selected in the cut, in the inspector panel">Inspector</button>
        {:else}
          <button aria-pressed={showInspector} onclick={() => { showInspector = !showInspector; persist(); }} title="Show or hide the inspector">Inspector</button>
        {/if}
      </div>
    </header>

    {#if notice}
      <p class="cv-notice" class:error={notice.tone === "error"} role={notice.tone === "error" ? "alert" : "status"}>
        {notice.text}
        <button onclick={() => { cut.notice = null; film.notice = null; }} aria-label="Dismiss">×</button>
      </p>
    {:else if lastRender && lastRender.kind !== "progress"}
      <p class="cv-notice" class:error={lastRender.kind === "failed"} role="status">
        {lastRender.kind === "failed" ? "The render failed: " : `${lastRender.quality === "preview" ? "Preview" : "Final"} render — `}{lastRender.message}
        <button onclick={() => (film.lastRender = null)} aria-label="Dismiss">×</button>
      </p>
    {:else if cut.status && !cut.dirty && (cut.status.state === "blocked" || cut.status.state === "invalid-cut" || cut.status.state === "stale")}
      <p class="cv-notice" class:error={cut.status.state !== "stale"} role="status">{cut.status.reason}</p>
    {/if}

    {#if cut.loading && !cut.draft}
      <div class="cv-empty" role="status">Reading the cut…</div>
    {:else if cut.error && !cut.draft}
      <div class="cv-empty" role="alert">{cut.error}</div>
    {:else if !cut.draft}
      <div class="cv-empty">
        <p>This {level} has no cut yet.</p>
        <button class="cv-primary" onclick={assemble}>Assemble it</button>
        <p class="cv-help">{ASSEMBLE_HELP[level]}</p>
      </div>
    {:else}
      <div class="cv-top" class:no-sources={!showSources} class:no-inspector={!inlineInspector}>
        {#if showSources}<div class="cv-pane cv-sources"><CutSources {unit} /></div>{/if}
        <CutMonitor bind:this={monitor} {unit} />
        {#if inlineInspector}<div class="cv-pane cv-inspector"><CutInspector /></div>{/if}
      </div>

      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div
        class="cv-resize"
        class:active={resizing}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Timeline height"
        aria-valuenow={timelineHeight}
        tabindex="0"
        onpointerdown={resizeDown}
        onpointermove={resizeMove}
        onpointerup={resizeUp}
        onpointercancel={resizeUp}
        onkeydown={resizeKey}
      ></div>

      <div class="cv-timeline">
        <CutTimeline />
      </div>
    {/if}
  </div>
{/if}

<style>
  .cut-view {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    container-type: inline-size;
  }

  .cv-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--vs-space-2) var(--vs-space-4);
    flex-wrap: wrap;
    padding: 5px var(--vs-space-3);
    background: var(--vs-bg-surface);
    border-bottom: 1px solid var(--vs-border);
    flex-shrink: 0;
  }

  .cv-what {
    display: flex;
    align-items: baseline;
    gap: var(--vs-space-3);
    min-width: 0;
  }

  .cv-title {
    font-size: var(--vs-text-sm);
    font-weight: var(--vs-font-weight-semibold);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cv-rev {
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-xs);
    color: var(--vs-text-tertiary);
    white-space: nowrap;
  }

  .cv-dirty {
    font-size: var(--vs-text-xs);
    font-weight: var(--vs-font-weight-medium);
    color: var(--vs-state-attention);
    white-space: nowrap;
  }

  .cv-dirty::before {
    content: "◆ ";
  }

  .cv-tools {
    display: flex;
    align-items: center;
    gap: var(--vs-space-1);
    flex-wrap: wrap;
  }

  .cv-tools button,
  .cv-empty button {
    padding: 3px var(--vs-space-2);
    background: none;
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-primary);
    font: inherit;
    font-size: var(--vs-text-xs);
    cursor: pointer;
    white-space: nowrap;
  }

  .cv-tools button:hover:not(:disabled) {
    background: var(--vs-bg-hover);
  }

  .cv-tools button:disabled {
    color: var(--vs-text-disabled);
    cursor: default;
  }

  .cv-tools button[aria-pressed="true"] {
    background: var(--vs-bg-selected);
    border-color: var(--vs-accent);
    color: var(--vs-accent-strong);
  }

  .cv-tools button.cv-primary:not(:disabled),
  .cv-empty button.cv-primary {
    background: var(--vs-accent-strong);
    border-color: var(--vs-accent-strong);
    color: var(--vs-accent-text);
  }

  .cv-tools button.cv-primary:hover:not(:disabled),
  .cv-empty button.cv-primary:hover {
    background: var(--vs-accent-strong-hover);
  }

  .cv-sep {
    width: 1px;
    height: 16px;
    margin: 0 var(--vs-space-1);
    background: var(--vs-border);
  }

  .cv-progress {
    display: flex;
    align-items: center;
    gap: var(--vs-space-2);
    font-size: var(--vs-text-xs);
    color: var(--vs-state-running);
    white-space: nowrap;
  }

  .cv-progress progress {
    width: 90px;
    height: 6px;
    accent-color: var(--vs-state-running);
  }

  .cv-phase {
    font-family: var(--vs-font-mono);
    color: var(--vs-text-tertiary);
  }

  .cv-notice {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--vs-space-3);
    margin: 0;
    padding: 5px var(--vs-space-3);
    background: var(--vs-state-running-bg);
    border-bottom: 1px solid var(--vs-border);
    color: var(--vs-text-primary);
    font-size: var(--vs-text-xs);
    line-height: var(--vs-leading-normal);
    flex-shrink: 0;
  }

  .cv-notice.error {
    background: var(--vs-state-blocked-bg);
    color: var(--vs-state-blocked);
  }

  .cv-notice button {
    padding: 0 4px;
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .cv-top {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(200px, 260px) minmax(0, 1fr) minmax(240px, 320px);
  }

  .cv-top.no-sources {
    grid-template-columns: minmax(0, 1fr) minmax(240px, 320px);
  }

  .cv-top.no-inspector {
    grid-template-columns: minmax(200px, 260px) minmax(0, 1fr);
  }

  .cv-top.no-sources.no-inspector {
    grid-template-columns: minmax(0, 1fr);
  }

  .cv-pane {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--vs-bg-surface);
  }

  .cv-pane > :global(*) {
    flex: 1;
    min-height: 0;
  }

  .cv-sources {
    border-right: 1px solid var(--vs-border);
  }

  .cv-inspector {
    border-left: 1px solid var(--vs-border);
  }

  /* A narrow canvas cannot hold three columns and a picture worth looking at:
     the side panes go under the monitor's row instead of squeezing it. */
  @container (max-width: 760px) {
    .cv-top,
    .cv-top.no-sources,
    .cv-top.no-inspector {
      grid-template-columns: minmax(0, 1fr);
      grid-auto-rows: minmax(160px, 1fr);
      overflow-y: auto;
    }

    .cv-sources,
    .cv-inspector {
      border: none;
      border-top: 1px solid var(--vs-border);
    }

    .cv-sources {
      order: 2;
    }

    .cv-inspector {
      order: 3;
    }
  }

  .cv-resize {
    height: 7px;
    margin: -3px 0;
    position: relative;
    z-index: 6;
    cursor: ns-resize;
    touch-action: none;
    flex-shrink: 0;
  }

  .cv-resize:hover,
  .cv-resize.active,
  .cv-resize:focus-visible {
    background: var(--vs-accent-subtle);
    outline: none;
  }

  .cv-timeline {
    height: var(--timeline);
    min-height: 120px;
    max-height: calc(100% - 220px);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }

  .cv-timeline > :global(*) {
    flex: 1;
    min-height: 0;
  }

  .cv-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--vs-space-2);
    padding: var(--vs-space-5);
    font-size: var(--vs-text-sm);
    color: var(--vs-text-secondary);
    text-align: center;
  }

  .cv-empty p {
    margin: 0;
  }

  .cv-help {
    max-width: 52ch;
    font-size: var(--vs-text-xs);
    color: var(--vs-text-tertiary);
    line-height: var(--vs-leading-normal);
  }

  button:focus-visible {
    outline: 2px solid var(--vs-border-focus);
    outline-offset: 1px;
  }
</style>
