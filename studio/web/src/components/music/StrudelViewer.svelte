<script lang="ts">
  /**
   * A piece of music written as code (ADR-0053): read it, edit it, hear it.
   *
   * The text is the file viewer's: saved, versioned and restored like any
   * other. Around it, the piece plays in the browser on the engine a render
   * uses, its events are drawn part by part as it goes, parts can be silenced
   * to hear the others, and the piece as it is on disk can be rendered to a
   * file the edit uses.
   *
   * Ctrl+Enter plays, or replaces what plays with the text as it now stands;
   * Ctrl+. stops.
   */
  import { onDestroy } from "svelte";
  import type { ViewerProps } from "$lib/viewer-registry";
  import { files, apiPrefix } from "$lib/files-store.svelte.ts";
  import { getGatewayClient } from "$lib/gateway.svelte.ts";
  import { player } from "$lib/strudel-player.svelte.ts";
  import {
    DEFAULT_RENDER_FORM, inLevel, musicWorkspace, pianoRoll, renderRequest, rollPage,
    type MusicAnswer, type MusicRenderEntry, type PieceNote, type RenderForm,
  } from "$lib/music";
  import TextViewer from "../viewers/TextViewer.svelte";
  import MusicRenders from "./MusicRenders.svelte";

  let { path, contentType, content, mediaSrc, readOnly, onEdit }: ViewerProps = $props();

  const workspace = $derived(musicWorkspace(path));
  const owner = $derived(`${files.ref ? apiPrefix(files.ref) : ""}/${path}`);
  const playing = $derived(player.owner === owner);
  /** The text that is playing: an edit since then is not heard until it is played again. */
  let heard = $state<string | null>(null);
  let muted = $state<string[]>([]);
  let busy = $state(false);

  // ── The roll ────────────────────────────────────────────────────────────
  const SPANS = [4, 8, 16, 32];
  let span = $state(8);
  let page = $state(0);
  let cursor = $state<number | null>(null);
  let notes = $state<PieceNote[]>([]);
  let canvas = $state<HTMLCanvasElement | null>(null);
  let rollWidth = $state(600);
  const ROLL_HEIGHT = 150;
  const shownParts = $derived(player.parts.filter((p) => p.selected).map((p) => p.name));

  function token(name: string, fallback: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }

  async function readNotes() {
    notes = await player.notes(page * span, (page + 1) * span);
  }

  $effect(() => {
    const c = canvas;
    if (!c) return;
    const width = rollWidth;
    const { lanes, rects } = pianoRoll(notes, shownParts, { from: page * span, to: (page + 1) * span, width, height: ROLL_HEIGHT });
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * dpr);
    c.height = Math.round(ROLL_HEIGHT * dpr);
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, ROLL_HEIGHT);
    const colors = ["--vs-accent", "--vs-state-running", "--vs-state-current", "--vs-state-attention", "--vs-state-blocked", "--vs-text-secondary"].map((name) => token(name, "#888"));
    const faint = token("--vs-border-subtle", "#ccc");
    const text = token("--vs-text-tertiary", "#888");
    g.strokeStyle = faint;
    g.fillStyle = text;
    g.font = "10px system-ui, sans-serif";
    for (let cycle = 0; cycle <= span; cycle += span > 8 ? 4 : 1) {
      const x = (cycle / span) * width;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, ROLL_HEIGHT); g.stroke();
      if (cycle < span) g.fillText(String(page * span + cycle), x + 3, 10);
    }
    for (const lane of lanes) {
      if (lane.index > 0) { g.beginPath(); g.moveTo(0, lane.top); g.lineTo(width, lane.top); g.stroke(); }
      g.fillStyle = text;
      g.fillText(lane.part, 3, lane.top + lane.height - 4);
    }
    for (const rect of rects) {
      g.globalAlpha = rect.weight;
      g.fillStyle = colors[rect.lane % colors.length]!;
      g.fillRect(rect.x, rect.y, rect.w, rect.h);
    }
    g.globalAlpha = 1;
    if (cursor !== null && playing) {
      const x = ((cursor - page * span) / span) * width;
      g.fillStyle = token("--vs-text-primary", "#000");
      g.fillRect(x, 0, 1.5, ROLL_HEIGHT);
    }
  });

  // While it plays, the roll follows: a page of `span` cycles at a time.
  let frame = 0;
  $effect(() => {
    if (!playing) { cursor = null; return; }
    let live = true;
    const tick = async () => {
      const at = await player.position();
      if (!live) return;
      if (at !== null) {
        cursor = at;
        const now = Math.floor(rollPage(at, span).from / span);
        if (now !== page) { page = now; await readNotes(); }
      }
      frame = requestAnimationFrame(() => void tick());
    };
    void tick();
    return () => { live = false; cancelAnimationFrame(frame); };
  });

  // ── Playing ─────────────────────────────────────────────────────────────
  function sampleBase(): string | null {
    if (!workspace) return null;
    const probe = files.mediaUrl(inLevel(workspace.within, "_"));
    return probe ? probe.slice(0, -1) : null;
  }

  async function evaluate(play: boolean) {
    busy = true;
    const ok = await player.evaluate({ owner, code: content, mute: muted, sampleBase: sampleBase(), play });
    busy = false;
    if (ok) {
      if (play) heard = content;
      await readNotes();
    }
  }

  async function stop() {
    await player.stop();
    heard = null;
  }

  function togglePart(name: string) {
    muted = muted.includes(name) ? muted.filter((m) => m !== name) : [...muted, name];
    void evaluate(playing);
  }

  function soloPart(name: string) {
    const others = player.parts.filter((p) => !p.muted && p.name !== name).map((p) => p.name);
    muted = others.every((o) => muted.includes(o)) && !muted.includes(name) ? [] : others;
    void evaluate(playing);
  }

  function onKey(event: KeyboardEvent) {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key === "Enter") { event.preventDefault(); void evaluate(true); }
    else if (event.key === ".") { event.preventDefault(); void stop(); }
  }

  // Another piece opened in this viewer: what was playing belonged to the one before.
  let shownOwner = "";
  $effect(() => {
    const now = owner;
    if (shownOwner && shownOwner !== now && player.owner === shownOwner) void player.stop();
    if (shownOwner !== now) { shownOwner = now; heard = null; muted = []; notes = []; page = 0; asked += 1; made = null; renderError = null; }
  });
  onDestroy(() => {
    if (player.owner === shownOwner) void player.stop();
  });

  // ── Rendering ───────────────────────────────────────────────────────────
  let form = $state<RenderForm>({ ...DEFAULT_RENDER_FORM });
  let rendering = $state(false);
  let renderError = $state<string | null>(null);
  let made = $state<string | null>(null);
  let renders = $state<MusicRenderEntry[]>([]);
  let readiness = $state<{ available: boolean; detail: string } | null>(null);
  let asked = $state(0);

  $effect(() => {
    void asked;
    const ref = files.ref;
    const at = workspace;
    if (!ref || !at) { renders = []; return; }
    let live = true;
    getGatewayClient().fetchJSON<MusicAnswer>(`${apiPrefix(ref)}/music${at.within ? `?within=${encodeURIComponent(at.within)}` : ""}`)
      .then((answer) => {
        if (!live) return;
        readiness = answer.readiness;
        renders = answer.pieces.find((p) => p.path === at.piece)?.renders ?? [];
      })
      .catch(() => { if (live) renders = []; });
    return () => { live = false; };
  });

  async function render() {
    const ref = files.ref;
    const at = workspace;
    if (!ref || !at) return;
    const built = renderRequest(at.piece, at.within, form);
    if ("error" in built) { renderError = built.error; return; }
    rendering = true;
    renderError = null;
    made = null;
    try {
      const answer = await getGatewayClient().fetchJSON<{ recordPath: string; record: { output: { path: string } } }>(`${apiPrefix(ref)}/music/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(built.request),
      });
      made = answer.record.output.path;
      asked += 1;
      void files.refreshListing();
    } catch (error) {
      renderError = error instanceof Error ? error.message : String(error);
    } finally {
      rendering = false;
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="sv" onkeydown={onKey}>
  <div class="sv-bar" role="toolbar" aria-label="Playback">
    <button class="sv-btn sv-primary" onclick={() => evaluate(true)} disabled={busy || player.phase === "loading"} title="Play the text as it stands (Ctrl+Enter)">
      {player.phase === "loading" ? "Loading…" : playing ? "Update" : "Play"}
    </button>
    <button class="sv-btn" onclick={stop} disabled={!playing} title="Stop (Ctrl+.)">Stop</button>
    <span class="sv-status" role="status" aria-live="polite">
      {#if player.error}
        <span class="sv-bad">does not evaluate</span>
      {:else if playing && heard !== content}
        <span class="sv-warn">playing an earlier text · Ctrl+Enter to hear this one</span>
      {:else if playing}
        playing · {+(player.cps * 60).toFixed(2)} cycles/min
      {:else if player.phase === "failed"}
        <span class="sv-bad">the engine did not load</span>
      {:else}
        stopped
      {/if}
    </span>
    <label class="sv-span">
      Show
      <select bind:value={span} onchange={() => { page = 0; void readNotes(); }} aria-label="Cycles shown">
        {#each SPANS as n (n)}<option value={n}>{n} cycles</option>{/each}
      </select>
    </label>
  </div>

  {#if player.error}
    <p class="sv-error" role="alert">{player.error}</p>
  {/if}

  <div class="sv-code">
    <TextViewer {path} {contentType} {content} {mediaSrc} {readOnly} {onEdit} nowrap />
  </div>

  <div class="sv-roll" bind:clientWidth={rollWidth}>
    {#if notes.length === 0}
      <p class="sv-hint">Play the piece, or press <button class="sv-link" onclick={() => evaluate(false)}>Read</button> to see its events without a sound.</p>
    {/if}
    <canvas bind:this={canvas} style:height="{ROLL_HEIGHT}px" aria-label="The piece's events, part by part, over {span} cycles from cycle {page * span}"></canvas>
  </div>

  {#if player.parts.length > 0 && (playing || notes.length > 0)}
    <div class="sv-parts" role="group" aria-label="Parts">
      {#each player.parts as part (part.name)}
        <span class="sv-part">
          <button
            class="sv-chip"
            aria-pressed={part.selected}
            disabled={part.muted}
            onclick={() => togglePart(part.name)}
            title={part.muted ? "muted in the code (_label)" : part.selected ? "Silence this part" : "Let this part play"}
          >{part.name}{part.muted ? " (muted in code)" : part.selected ? "" : " (off)"}{part.solo ? " · solo" : ""}</button>
          {#if !part.muted}
            <button class="sv-solo" onclick={() => soloPart(part.name)} title="Hear this part alone; again for all of them" aria-label="Solo {part.name}">S</button>
          {/if}
        </span>
      {/each}
    </div>
  {/if}

  <details class="sv-render">
    <summary>Render to a file <span class="sv-count">{renders.length}</span></summary>
    {#if !workspace}
      <p class="sv-hint">A piece is rendered from a <code>music/</code> folder: move this file to <code>music/</code> in the episode, the source or the film.</p>
    {:else}
      <form class="sv-form" onsubmit={(e) => { e.preventDefault(); void render(); }}>
        <label>Length
          <span class="sv-pair">
            <input type="number" min="0" step="any" bind:value={form.amount} aria-label="How many" />
            <select bind:value={form.length} aria-label="Cycles or seconds">
              <option value="cycles">cycles</option>
              <option value="seconds">seconds</option>
            </select>
          </span>
        </label>
        <label>From cycle <input type="number" min="0" step="any" bind:value={form.from} /></label>
        <label>Tail (s) <input type="number" min="0" max="60" step="any" bind:value={form.tail} /></label>
        <label class="sv-check"><input type="checkbox" bind:checked={form.loop} /> Seamless loop</label>
        <label class="sv-check"><input type="checkbox" bind:checked={form.stems} /> Stems</label>
        <label class="sv-wide">Output <input type="text" placeholder="assets/sounds/{workspace.piece.split('/').pop()?.replace('.strudel', '')}.wav" bind:value={form.output} /></label>
        <button class="sv-btn sv-primary" type="submit" disabled={rendering || files.dirty || readOnly || readiness?.available === false}>
          {rendering ? "Rendering…" : "Render"}
        </button>
      </form>
      {#if files.dirty}
        <p class="sv-hint">Save first: a render is made from the piece on disk.</p>
      {/if}
      {#if readiness && !readiness.available}
        <p class="sv-error" role="alert">{readiness.detail}</p>
      {/if}
      {#if renderError}
        <p class="sv-error" role="alert">{renderError}</p>
      {/if}
      {#if made}
        <p class="sv-hint" role="status">Rendered {made}.</p>
      {/if}
      <MusicRenders {renders} within={workspace.within} />
    {/if}
  </details>
</div>

<style>
  .sv { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; background: var(--vs-bg-surface); }
  .sv-bar { display: flex; align-items: center; gap: var(--vs-space-3); padding: var(--vs-space-2) var(--vs-space-3); border-bottom: 1px solid var(--vs-border); font-size: var(--vs-text-xs); }
  .sv-btn { padding: var(--vs-space-1) var(--vs-space-3); border: 1px solid var(--vs-border); border-radius: var(--vs-radius-sm); background: var(--vs-bg-surface); color: var(--vs-text-primary); font-size: var(--vs-text-xs); cursor: pointer; }
  .sv-btn:hover:not(:disabled) { background: var(--vs-bg-hover); }
  .sv-btn:focus-visible, .sv-chip:focus-visible, .sv-solo:focus-visible, .sv-link:focus-visible { outline: 2px solid var(--vs-border-focus); outline-offset: 1px; }
  .sv-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .sv-primary:not(:disabled) { background: var(--vs-accent-strong); border-color: var(--vs-accent-strong); color: var(--vs-accent-text); }
  .sv-primary:hover:not(:disabled) { background: var(--vs-accent-strong-hover); border-color: var(--vs-accent-strong-hover); }
  .sv-status { flex: 1; color: var(--vs-text-secondary); }
  .sv-warn { color: var(--vs-state-attention); }
  .sv-bad { color: var(--vs-state-blocked); }
  .sv-span { display: flex; align-items: center; gap: var(--vs-space-2); color: var(--vs-text-secondary); }
  .sv-error { margin: 0; padding: var(--vs-space-2) var(--vs-space-3); background: var(--vs-state-blocked-bg); color: var(--vs-state-blocked); font-family: var(--vs-font-mono); font-size: var(--vs-text-xs); white-space: pre-wrap; }
  .sv-code { flex: 1; min-height: 120px; display: flex; }
  .sv-roll { position: relative; border-top: 1px solid var(--vs-border); background: var(--vs-bg-inset); }
  .sv-roll canvas { display: block; width: 100%; }
  .sv-hint { margin: 0; padding: var(--vs-space-2) var(--vs-space-3); color: var(--vs-text-tertiary); font-size: var(--vs-text-xs); }
  .sv-roll .sv-hint { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: 0.3em; }
  .sv-link { border: none; background: none; padding: 0; color: var(--vs-accent-strong); font: inherit; text-decoration: underline; cursor: pointer; }
  .sv-parts { display: flex; flex-wrap: wrap; gap: var(--vs-space-2); padding: var(--vs-space-2) var(--vs-space-3); border-top: 1px solid var(--vs-border-subtle); }
  .sv-part { display: inline-flex; }
  .sv-chip, .sv-solo { border: 1px solid var(--vs-border); background: var(--vs-bg-surface); color: var(--vs-text-secondary); font-family: var(--vs-font-mono); font-size: var(--vs-text-xs); padding: 2px var(--vs-space-2); cursor: pointer; }
  .sv-chip { border-radius: var(--vs-radius-sm) 0 0 var(--vs-radius-sm); }
  .sv-solo { border-left: none; border-radius: 0 var(--vs-radius-sm) var(--vs-radius-sm) 0; }
  .sv-chip[aria-pressed="true"] { background: var(--vs-bg-selected); color: var(--vs-text-primary); }
  .sv-chip:disabled { opacity: 0.5; cursor: not-allowed; border-radius: var(--vs-radius-sm); }
  .sv-render { border-top: 1px solid var(--vs-border); max-height: 45%; overflow: auto; }
  .sv-render summary { padding: var(--vs-space-2) var(--vs-space-3); font-size: var(--vs-text-sm); color: var(--vs-text-primary); cursor: pointer; }
  .sv-render[open] { padding-bottom: var(--vs-space-3); }
  .sv-render :global(.mr), .sv-render :global(.mr-none) { margin: 0 var(--vs-space-3); }
  .sv-count { margin-left: var(--vs-space-2); color: var(--vs-text-tertiary); font-size: var(--vs-text-xs); }
  .sv-form { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--vs-space-3); padding: var(--vs-space-2) var(--vs-space-3) var(--vs-space-3); font-size: var(--vs-text-xs); color: var(--vs-text-secondary); }
  .sv-form label { display: flex; flex-direction: column; gap: 2px; }
  .sv-form .sv-check { flex-direction: row; align-items: center; gap: var(--vs-space-1); padding-bottom: var(--vs-space-1); }
  .sv-form .sv-wide { flex: 1; min-width: 220px; }
  .sv-pair { display: flex; gap: var(--vs-space-1); }
  .sv-form input[type="number"] { width: 72px; }
  .sv-form input[type="number"], .sv-form input[type="text"], .sv-form select, .sv-span select {
    border: 1px solid var(--vs-border); border-radius: var(--vs-radius-sm); background: var(--vs-bg-inset); color: var(--vs-text-primary);
    font-size: var(--vs-text-xs); padding: 2px var(--vs-space-2);
  }
  code { font-family: var(--vs-font-mono); }
</style>
