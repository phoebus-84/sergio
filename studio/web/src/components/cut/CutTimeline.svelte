<script lang="ts">
  /**
   * The cut as tracks over time.
   *
   * Picture tracks are drawn with the topmost on top, as they are stacked in
   * the frame; sound tracks follow in the order they are mixed. A clip is
   * dragged to move it and by its edges to trim it, and both snap to the edges
   * of other clips, the markers and the playhead. Everything the pointer can
   * do, the keyboard can: a focused clip moves with the arrows, trims to the
   * playhead with [ and ], splits with S and goes with Delete.
   *
   * A clip a person locked — or one on a locked track — does not move: it
   * shows its lock, and unlocking it is one key away.
   */
  import { cut } from "$lib/cut-store.svelte.ts";
  import { clock } from "$lib/film-format";
  import { clipEnd, sourceKind, type CutClip, type CutTrack } from "@studio/contracts/src/cut-timeline.mjs";
  import { timecode } from "@studio/contracts/src/film.mjs";

  interface Props {
    /** Called when the person moves the playhead, so the monitor can follow. */
    onseek?: (frame: number) => void;
  }

  let { onseek }: Props = $props();

  const HEADER = 148;
  const LANE = 44;
  const RULER = 26;

  const draft = $derived(cut.draft);
  const fps = $derived(cut.fps);
  const zoom = $derived(cut.zoom);

  /** Picture tracks top-down as they stack in the frame, then sound. */
  const lanes = $derived.by(() => {
    const tracks = draft?.tracks ?? [];
    return [...tracks.filter((t) => t.kind === "video").reverse(), ...tracks.filter((t) => t.kind === "audio")];
  });

  /** A little room after the last clip, so there is somewhere to drop one. */
  const span = $derived(Math.max(cut.frames + fps * 4, fps * 12));
  const width = $derived(span * zoom);

  /** Ruler ticks: a label about every 90 pixels, on a round number of seconds. */
  const ticks = $derived.by(() => {
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const seconds = steps.find((s) => s * fps * zoom >= 90) ?? 600;
    const out: { frame: number; label: string }[] = [];
    for (let s = 0; s * fps <= span; s += seconds) out.push({ frame: s * fps, label: clock(s) === "–" ? "0:00" : clock(s) });
    return out;
  });

  /** Clips a problem of the draft points at, by where the problem says it is. */
  const flawed = $derived.by(() => {
    const ids = new Set<string>();
    for (const problem of [...cut.problems, ...(cut.deepProblems ?? [])]) {
      const match = /^\$\.tracks\[(\d+)\]\.clips\[(\d+)\]/.exec(problem.path);
      const clip = match ? draft?.tracks[Number(match[1])]?.clips[Number(match[2])] : undefined;
      if (clip && problem.severity === "error") ids.add(clip.id);
    }
    return ids;
  });

  function label(clip: CutClip): string {
    if (clip.label) return clip.label;
    const kind = sourceKind(clip.source);
    if (kind === "unit") return clip.source.unit!;
    if (kind === "color") return clip.source.color!;
    return (clip.source.path ?? clip.source.project ?? clip.id).split("/").pop()!;
  }

  let scroller = $state<HTMLDivElement | null>(null);

  function frameAt(clientX: number): number {
    if (!scroller) return 0;
    const box = scroller.getBoundingClientRect();
    return Math.max(0, Math.round((clientX - box.left + scroller.scrollLeft - HEADER) / zoom));
  }

  function seek(frame: number) {
    cut.playhead = Math.max(0, Math.min(Math.max(cut.frames, 1), Math.round(frame)));
    onseek?.(cut.playhead);
  }

  // ── The playhead ──────────────────────────────────────────────────────

  let scrubbing = $state(false);

  function rulerDown(event: PointerEvent) {
    if (event.button !== 0) return;
    scrubbing = true;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    seek(frameAt(event.clientX));
  }

  function rulerMove(event: PointerEvent) {
    if (scrubbing) seek(frameAt(event.clientX));
  }

  function rulerUp() {
    scrubbing = false;
  }

  // ── Moving and trimming clips ─────────────────────────────────────────

  type Drag = { id: string; mode: "move" | "start" | "end"; originX: number; at: number; duration: number; key: string; moved: boolean };
  let drag = $state<Drag | null>(null);

  function clipDown(event: PointerEvent, track: CutTrack, clip: CutClip, mode: Drag["mode"]) {
    if (event.button !== 0) return;
    event.stopPropagation();
    cut.selection = { kind: "clip", id: clip.id };
    if (clip.locked || track.locked) return;
    drag = { id: clip.id, mode, originX: event.clientX, at: clip.at, duration: clip.duration, key: `drag-${clip.id}-${Date.now()}`, moved: false };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function clipMove(event: PointerEvent) {
    const d = drag;
    if (!d) return;
    const delta = Math.round((event.clientX - d.originX) / zoom);
    if (!d.moved && Math.abs(event.clientX - d.originX) < 3) return;
    d.moved = true;
    if (d.mode === "move") {
      // Either edge may snap: whichever is nearer a point wins.
      const start = cut.snap(d.at + delta, 8, d.id);
      const end = cut.snap(d.at + delta + d.duration, 8, d.id);
      const byStart = Math.abs(start - (d.at + delta));
      const byEnd = Math.abs(end - (d.at + delta + d.duration));
      const at = byEnd < byStart && end !== d.at + delta + d.duration ? end - d.duration : start;
      const lane = laneUnder(event.clientY);
      cut.moveClip(d.id, at, lane?.id, d.key);
    } else if (d.mode === "start") {
      cut.trimClip(d.id, "start", cut.snap(d.at + delta, 8, d.id), d.key);
    } else {
      cut.trimClip(d.id, "end", cut.snap(d.at + d.duration + delta, 8, d.id), d.key);
    }
  }

  function clipUp() {
    if (drag) cut.commit();
    drag = null;
  }

  /** The lane the pointer is over, for dragging a clip to another track of its kind. */
  function laneUnder(clientY: number): CutTrack | null {
    if (!scroller) return null;
    const box = scroller.getBoundingClientRect();
    const index = Math.floor((clientY - box.top + scroller.scrollTop - RULER) / LANE);
    return lanes[index] ?? null;
  }

  function clipKey(event: KeyboardEvent, track: CutTrack, clip: CutClip) {
    const step = event.shiftKey ? fps : 1;
    const locked = clip.locked || track.locked;
    switch (event.key) {
      case "ArrowLeft":
        if (!locked) cut.moveClip(clip.id, clip.at - step);
        break;
      case "ArrowRight":
        if (!locked) cut.moveClip(clip.id, clip.at + step);
        break;
      case "[":
        if (!locked && cut.playhead < clipEnd(clip)) cut.trimClip(clip.id, "start", cut.playhead);
        break;
      case "]":
        if (!locked && cut.playhead > clip.at) cut.trimClip(clip.id, "end", cut.playhead);
        break;
      case "s":
      case "S":
        if (!locked) cut.splitAtPlayhead();
        break;
      case "l":
      case "L":
        cut.setClip(clip.id, { locked: clip.locked ? null : true } as never);
        break;
      case "Delete":
      case "Backspace":
        if (!locked) cut.removeClip(clip.id, event.shiftKey);
        break;
      case "Home":
        seek(clip.at);
        break;
      case "End":
        seek(clipEnd(clip) - 1);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  function fit() {
    if (!scroller || cut.frames === 0) return;
    cut.zoom = Math.max(0.05, Math.min(40, (scroller.clientWidth - HEADER - 24) / cut.frames));
  }

  /* A cut opens fitted to the width: a feature at four pixels a frame would open on its first ten seconds. */
  let fittedFor = $state("");
  $effect(() => {
    const key = cut.unit ? `${cut.unit.film}/${cut.unit.scene}/${cut.unit.shot}` : "";
    if (!scroller || !draft || key === fittedFor) return;
    fittedFor = key;
    fit();
  });

  /* While the cut plays, the playhead stays in view. */
  $effect(() => {
    const x = cut.playhead * zoom + HEADER;
    if (!scroller || drag || scrubbing) return;
    if (x < scroller.scrollLeft + HEADER || x > scroller.scrollLeft + scroller.clientWidth - 24) {
      scroller.scrollLeft = Math.max(0, x - HEADER - 48);
    }
  });

  function wheel(event: WheelEvent) {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    const anchor = frameAt(event.clientX);
    const next = Math.max(0.05, Math.min(40, cut.zoom * (event.deltaY < 0 ? 1.2 : 1 / 1.2)));
    cut.zoom = next;
    if (scroller) scroller.scrollLeft = Math.max(0, anchor * next - (event.clientX - scroller.getBoundingClientRect().left - HEADER));
  }
</script>

{#if draft}
  <div class="timeline">
    <div class="tl-bar">
      <span class="tl-time" aria-label="Playhead">{timecode(cut.playhead, fps)}</span>
      <span class="tl-length">of {timecode(cut.frames, fps)} · {cut.frames} frames</span>
      <div class="tl-tools">
        <button onclick={() => cut.splitAtPlayhead()} disabled={!cut.selectedClip} title="Split the selected clip at the playhead (S)">Split</button>
        <button onclick={() => cut.setMarker({ id: `m${Date.now().toString(36)}`, at: cut.playhead, label: "Marker" })} title="Put a marker at the playhead">Marker</button>
        <span class="tl-sep" aria-hidden="true"></span>
        <button onclick={() => cut.addTrack("video", "overlay")} title="A picture track over the others: titles, inserts">+ Picture</button>
        <select aria-label="Add a sound track" onchange={(e) => { const role = e.currentTarget.value; if (role) cut.addTrack("audio", role as "dialogue"); e.currentTarget.value = ""; }}>
          <option value="">+ Sound</option>
          <option value="dialogue">Dialogue</option>
          <option value="music">Music</option>
          <option value="effects">Effects</option>
          <option value="ambience">Ambience</option>
        </select>
        <span class="tl-sep" aria-hidden="true"></span>
        <label class="tl-zoom">
          <span class="sr-only">Zoom</span>
          <input type="range" min="-3" max="3.7" step="0.05" value={Math.log(zoom)} oninput={(e) => (cut.zoom = Math.exp(e.currentTarget.valueAsNumber))} />
        </label>
        <button onclick={fit} title="Show the whole cut">Fit</button>
      </div>
    </div>

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="tl-scroll" bind:this={scroller} onwheel={wheel} onpointerdown={() => (cut.selection = null)}>
      <div class="tl-content" style="width: {width + HEADER}px">
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="tl-ruler" style="height: {RULER}px" onpointerdown={rulerDown} onpointermove={rulerMove} onpointerup={rulerUp} onpointercancel={rulerUp}>
          <div class="tl-corner" style="width: {HEADER}px"></div>
          {#each ticks as tick (tick.frame)}
            <span class="tl-tick" style="left: {HEADER + tick.frame * zoom}px">{tick.label}</span>
          {/each}
          {#each draft.markers ?? [] as marker (marker.id)}
            <button
              class="tl-marker"
              style="left: {HEADER + marker.at * zoom}px"
              title="{marker.label ?? "Marker"} — {timecode(marker.at, fps)}. Double-click to remove."
              onpointerdown={(e) => { e.stopPropagation(); seek(marker.at); }}
              ondblclick={() => cut.removeMarker(marker.id)}
            ><span class="sr-only">{marker.label ?? "Marker"} at {timecode(marker.at, fps)}</span></button>
          {/each}
        </div>

        {#each lanes as track (track.id)}
          <div class="tl-lane" class:audio={track.kind === "audio"} class:muted={track.muted} style="height: {LANE}px">
            <div class="tl-head" class:selected={cut.selection?.kind === "track" && cut.selection.id === track.id} style="width: {HEADER}px">
              <button class="tl-head-name" onpointerdown={(e) => e.stopPropagation()} onclick={() => (cut.selection = { kind: "track", id: track.id })} title="{track.kind === "video" ? "Picture" : "Sound"} track {track.id}{track.role ? ` · ${track.role}` : ""}">
                <span class="tl-kind" aria-hidden="true">{track.kind === "video" ? "▭" : "♪"}</span>
                <span class="tl-name">{track.name ?? track.id}</span>
              </button>
              <button class="tl-flag" aria-pressed={track.muted === true} aria-label="Mute {track.name ?? track.id}" title="Mute" onpointerdown={(e) => e.stopPropagation()} onclick={() => cut.setTrack(track.id, { muted: track.muted ? null : true } as never)}>M</button>
              <button class="tl-flag" aria-pressed={track.locked === true} aria-label="Lock {track.name ?? track.id}" title="Lock: the agent leaves this track as it is" onpointerdown={(e) => e.stopPropagation()} onclick={() => cut.setTrack(track.id, { locked: track.locked ? null : true } as never)}>L</button>
            </div>

            {#each track.clips as clip (clip.id)}
              {@const selected = cut.selection?.kind === "clip" && cut.selection.id === clip.id}
              {@const kind = sourceKind(clip.source)}
              {@const effects = (clip.effects ?? []).filter((e) => e.enabled !== false).length + (clip.audio?.effects ?? []).filter((e) => e.enabled !== false).length}
              <div
                class="tl-clip"
                class:selected
                class:locked={clip.locked || track.locked}
                class:flawed={flawed.has(clip.id)}
                class:dragging={drag?.id === clip.id && drag.moved}
                data-source={kind}
                style="left: {HEADER + clip.at * zoom}px; width: {Math.max(2, clip.duration * zoom)}px"
                role="button"
                tabindex="0"
                aria-pressed={selected}
                aria-label="{label(clip)}, {clip.duration} frames at {timecode(clip.at, fps)}{clip.locked ? ", locked" : ""}"
                onpointerdown={(e) => clipDown(e, track, clip, "move")}
                onpointermove={clipMove}
                onpointerup={clipUp}
                onpointercancel={clipUp}
                onkeydown={(e) => clipKey(e, track, clip)}
                onfocus={() => (cut.selection = { kind: "clip", id: clip.id })}
              >
                {#if clip.transitionIn}
                  <span class="tl-transition in" style="width: {Math.min(clip.duration, clip.transitionIn.duration) * zoom}px" title="{clip.transitionIn.type} in, {clip.transitionIn.duration} frames"></span>
                {/if}
                {#if clip.transitionOut}
                  <span class="tl-transition out" style="width: {Math.min(clip.duration, clip.transitionOut.duration) * zoom}px" title="{clip.transitionOut.type} out, {clip.transitionOut.duration} frames"></span>
                {/if}
                {#if kind === "color"}<span class="tl-swatch" style="background: {clip.source.color}"></span>{/if}
                <span class="tl-clip-label">{label(clip)}</span>
                <span class="tl-clip-badges">
                  {#if effects > 0}<span title="{effects} effect{effects === 1 ? "" : "s"}">fx{effects}</span>{/if}
                  {#if clip.speed && clip.speed !== 1}<span title="Speed">×{clip.speed}</span>{/if}
                  {#if clip.locked || track.locked}<span title="Locked: the agent leaves it as it is">🔒</span>{/if}
                </span>
                {#if !(clip.locked || track.locked)}
                  <span class="tl-edge start" onpointerdown={(e) => clipDown(e, track, clip, "start")} onpointermove={clipMove} onpointerup={clipUp} onpointercancel={clipUp}></span>
                  <span class="tl-edge end" onpointerdown={(e) => clipDown(e, track, clip, "end")} onpointermove={clipMove} onpointerup={clipUp} onpointercancel={clipUp}></span>
                {/if}
              </div>
            {/each}
          </div>
        {/each}

        <div class="tl-playhead" style="left: {HEADER + cut.playhead * zoom}px" aria-hidden="true"></div>
        <div class="tl-end" style="left: {HEADER + cut.frames * zoom}px" aria-hidden="true"></div>
      </div>
    </div>
  </div>
{/if}

<style>
  .timeline {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--vs-bg-surface);
    border-top: 1px solid var(--vs-border);
  }

  .tl-bar {
    display: flex;
    align-items: center;
    gap: var(--vs-space-3);
    padding: 4px var(--vs-space-3);
    border-bottom: 1px solid var(--vs-border);
    flex-shrink: 0;
  }

  .tl-time {
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-base);
    font-variant-numeric: tabular-nums;
  }

  .tl-length {
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-xs);
    color: var(--vs-text-tertiary);
  }

  .tl-tools {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: var(--vs-space-1);
  }

  .tl-tools button,
  .tl-tools select {
    padding: 3px var(--vs-space-2);
    background: none;
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-secondary);
    font: inherit;
    font-size: var(--vs-text-xs);
    cursor: pointer;
  }

  .tl-tools button:hover:not(:disabled),
  .tl-tools select:hover {
    background: var(--vs-bg-hover);
    color: var(--vs-text-primary);
  }

  .tl-tools button:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .tl-sep {
    width: 1px;
    height: 16px;
    margin: 0 var(--vs-space-1);
    background: var(--vs-border);
  }

  .tl-zoom input {
    width: 110px;
    accent-color: var(--vs-accent);
  }

  .tl-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    position: relative;
  }

  .tl-content {
    position: relative;
    min-height: 100%;
    /* The lanes reach the edge of the panel however short the cut is. */
    min-width: 100%;
  }

  .tl-ruler {
    position: sticky;
    top: 0;
    z-index: 3;
    background: var(--vs-bg-raised);
    border-bottom: 1px solid var(--vs-border);
    cursor: ew-resize;
    touch-action: none;
  }

  .tl-corner {
    position: sticky;
    left: 0;
    box-sizing: border-box;
    height: 100%;
    z-index: 4;
    background: var(--vs-bg-raised);
    border-right: 1px solid var(--vs-border);
  }

  .tl-tick {
    position: absolute;
    top: 0;
    bottom: 0;
    padding: 5px 0 0 4px;
    border-left: 1px solid var(--vs-border);
    font-family: var(--vs-font-mono);
    font-size: 10px;
    color: var(--vs-text-tertiary);
    pointer-events: none;
  }

  .tl-marker {
    position: absolute;
    bottom: 0;
    width: 10px;
    height: 10px;
    padding: 0;
    margin-left: -5px;
    background: var(--vs-state-attention);
    border: none;
    clip-path: polygon(0 0, 100% 0, 50% 100%);
    cursor: pointer;
  }

  .tl-lane {
    position: relative;
    border-bottom: 1px solid var(--vs-border-subtle);
    background:
      repeating-linear-gradient(90deg, transparent 0, transparent calc(100% - 1px)),
      var(--vs-bg-canvas);
  }

  .tl-lane.audio {
    background: var(--vs-bg-inset);
  }

  .tl-lane.muted .tl-clip {
    opacity: 0.4;
  }

  .tl-head {
    position: sticky;
    left: 0;
    z-index: 2;
    box-sizing: border-box;
    height: 100%;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 var(--vs-space-1) 0 var(--vs-space-2);
    background: var(--vs-bg-raised);
    border-right: 1px solid var(--vs-border);
  }

  .tl-head.selected {
    background: var(--vs-bg-selected);
  }

  .tl-head-name {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--vs-space-1);
    padding: 0;
    background: none;
    border: none;
    color: var(--vs-text-primary);
    font: inherit;
    font-size: var(--vs-text-xs);
    text-align: left;
    cursor: pointer;
  }

  .tl-kind {
    color: var(--vs-text-tertiary);
  }

  .tl-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tl-flag {
    width: 18px;
    height: 18px;
    padding: 0;
    background: none;
    border: 1px solid transparent;
    border-radius: 2px;
    color: var(--vs-text-disabled);
    font: inherit;
    font-size: 10px;
    font-weight: var(--vs-font-weight-semibold);
    cursor: pointer;
  }

  .tl-flag:hover {
    border-color: var(--vs-border);
    color: var(--vs-text-secondary);
  }

  .tl-flag[aria-pressed="true"] {
    background: var(--vs-state-attention-bg);
    border-color: var(--vs-state-attention);
    color: var(--vs-state-attention);
  }

  .tl-clip {
    position: absolute;
    top: 4px;
    bottom: 4px;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 6px;
    background: oklch(58% 0.06 250 / 0.28);
    border: 1px solid oklch(58% 0.06 250 / 0.7);
    border-radius: 3px;
    color: var(--vs-text-primary);
    font-size: var(--vs-text-xs);
    overflow: hidden;
    cursor: grab;
    touch-action: none;
    user-select: none;
  }

  .tl-lane.audio .tl-clip {
    background: oklch(58% 0.07 160 / 0.24);
    border-color: oklch(58% 0.07 160 / 0.7);
  }

  .tl-clip[data-source="unit"] {
    background: oklch(58% 0.09 48 / 0.24);
    border-color: oklch(58% 0.09 48 / 0.75);
  }

  .tl-clip[data-source="color"] {
    background: var(--vs-bg-raised);
    border-color: var(--vs-border);
  }

  .tl-clip:focus-visible,
  .tl-clip.selected {
    outline: 2px solid var(--vs-accent);
    outline-offset: -1px;
    z-index: 1;
  }

  .tl-clip.flawed {
    border-color: var(--vs-state-blocked);
    background: var(--vs-state-blocked-bg);
  }

  .tl-clip.locked {
    cursor: default;
    background-image: repeating-linear-gradient(135deg, transparent 0 6px, oklch(50% 0 0 / 0.12) 6px 7px);
  }

  .tl-clip.dragging {
    cursor: grabbing;
    opacity: 0.85;
  }

  .tl-clip-label {
    position: relative;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tl-clip-badges {
    position: relative;
    margin-left: auto;
    display: flex;
    gap: 4px;
    font-family: var(--vs-font-mono);
    font-size: 10px;
    color: var(--vs-text-secondary);
    white-space: nowrap;
  }

  .tl-swatch {
    position: relative;
    width: 10px;
    height: 10px;
    border: 1px solid var(--vs-border);
    border-radius: 2px;
    flex-shrink: 0;
  }

  .tl-transition {
    position: absolute;
    top: 0;
    bottom: 0;
    background: oklch(100% 0 0 / 0.16);
    pointer-events: none;
  }

  .tl-transition.in {
    left: 0;
    clip-path: polygon(0 100%, 100% 0, 100% 100%);
  }

  .tl-transition.out {
    right: 0;
    clip-path: polygon(0 0, 100% 100%, 0 100%);
  }

  .tl-edge {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 7px;
    cursor: ew-resize;
    touch-action: none;
  }

  .tl-edge.start { left: 0; }
  .tl-edge.end { right: 0; }

  .tl-edge:hover,
  .tl-clip.selected .tl-edge {
    background: var(--vs-accent);
    opacity: 0.7;
  }

  .tl-playhead {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--vs-accent);
    z-index: 5;
    pointer-events: none;
  }

  .tl-playhead::before {
    content: "";
    position: absolute;
    top: 0;
    left: -5px;
    width: 11px;
    height: 9px;
    background: var(--vs-accent);
    clip-path: polygon(0 0, 100% 0, 50% 100%);
  }

  .tl-end {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 0;
    border-left: 1px dashed var(--vs-border);
    pointer-events: none;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
