<script lang="ts">
  /**
   * What the cut looks like, three ways, each said for what it is.
   *
   * - **Draft**: the timeline played in the browser from its sources, as it is
   *   being edited. Cuts and timing only: the topmost picture and its own
   *   sound, no effects, no transitions, no mix. It answers "does the edit
   *   work" at once and for free.
   * - **Render**: the unit's last render, the real thing — of the revision it
   *   was made from, which the monitor names when the cut has moved on.
   * - **Frame**: the frame at the playhead composed by the renderer, with
   *   every effect, of the saved cut. A grade is judged here.
   *
   * The monitor never passes one off as another: a draft is labelled a draft,
   * and a render of an older cut says so.
   */
  import { cut } from "$lib/cut-store.svelte.ts";
  import { film, type Unit } from "$lib/film-store.svelte.ts";
  import { gatewayUrl } from "$lib/film-api";
  import { clipEnd, sourceKind, type CutClip } from "@studio/contracts/src/cut-timeline.mjs";
  import { timecode } from "@studio/contracts/src/film.mjs";

  interface Props {
    unit: Unit;
  }

  let { unit }: Props = $props();

  type Mode = "draft" | "render" | "frame";
  let mode = $state<Mode>("draft");

  const node = $derived(film.node(unit));
  const fps = $derived(cut.fps);
  const frames = $derived(cut.frames);
  const renderUrl = $derived(gatewayUrl(node?.renderUrl));
  const renderOf = $derived(node?.render ?? null);

  const VIDEO = /\.(mp4|mov|mkv|webm|m4v)$/i;
  const IMAGE = /\.(png|jpe?g|webp|gif|avif)$/i;
  const AUDIO = /\.(wav|mp3|m4a|flac|aac|ogg|opus)$/i;

  /** Where a clip's source can be loaded from, and what it is. */
  function resolve(clip: CutClip): { kind: "video" | "image" | "audio" | "color" | "missing"; url: string | null; why?: string } {
    const kind = sourceKind(clip.source);
    if (kind === "color") return { kind: "color", url: null };
    if (kind === "unit") {
      const child = unit.scene === "_" ? film.scene(clip.source.unit!) : film.shot(unit.scene, clip.source.unit!);
      if (!child) return { kind: "missing", url: null, why: `there is no ${unit.scene === "_" ? "scene" : "shot"} "${clip.source.unit}"` };
      if (!child.renderUrl) return { kind: "missing", url: null, why: `${child.title} has no render yet` };
      return { kind: "video", url: gatewayUrl(child.renderUrl) };
    }
    const path = clip.source.path ?? clip.source.project ?? "";
    let url: string | null = null;
    if (kind === "project") {
      // Camera originals rarely play in a browser: the footage log has a proxy that does.
      const logged = film.footage.find((entry) => entry.path === path);
      url = gatewayUrl(logged?.proxyUrl ?? logged?.url ?? (film.tree?.url ? `${film.tree.url}/${path.split("/").map(encodeURIComponent).join("/")}` : null));
    } else {
      url = gatewayUrl(node?.url ? `${node.url}/${path.split("/").map(encodeURIComponent).join("/")}` : null);
    }
    if (!url) return { kind: "missing", url: null, why: "the film is not loaded" };
    if (VIDEO.test(path)) return { kind: "video", url };
    if (IMAGE.test(path)) return { kind: "image", url };
    if (AUDIO.test(path)) return { kind: "audio", url };
    return { kind: "missing", url: null, why: `${path.split("/").pop()} is not something a browser plays` };
  }

  /** The topmost picture clip under the playhead: what the frame shows, before effects. */
  const active = $derived.by(() => {
    const draft = cut.draft;
    if (!draft) return null;
    const at = cut.playhead;
    const pictures = draft.tracks.filter((track) => track.kind === "video" && !track.muted);
    for (const track of [...pictures].reverse()) {
      // With a transition two clips overlap: the incoming one is on top.
      const clip = [...track.clips].reverse().find((c) => at >= c.at && at < clipEnd(c));
      if (clip) return { clip, track, source: resolve(clip) };
    }
    return null;
  });

  /** Seconds into the active clip's source at the playhead. */
  const sourceTime = $derived(active ? (active.clip.in ?? 0) + ((cut.playhead - active.clip.at) / fps) * (active.clip.speed ?? 1) : 0);

  let draftVideo = $state<HTMLVideoElement | null>(null);
  let renderVideo = $state<HTMLVideoElement | null>(null);
  let playing = $state(false);
  let lastTick = 0;
  let raf = 0;

  function stop() {
    playing = false;
    cancelAnimationFrame(raf);
    draftVideo?.pause();
    renderVideo?.pause();
  }

  /** Where playback is, in frames and fractions of one: the playhead shows its whole part. */
  let position = 0;

  function tick(now: number) {
    if (!playing) return;
    // The person moved the playhead while it played: carry on from there.
    if (Math.floor(position) !== cut.playhead) position = cut.playhead;
    position += ((now - lastTick) / 1000) * fps;
    lastTick = now;
    if (position >= frames) {
      cut.playhead = Math.max(0, frames - 1);
      stop();
      return;
    }
    cut.playhead = Math.floor(position);
    raf = requestAnimationFrame(tick);
  }

  function play() {
    if (mode === "frame") mode = renderUrl && !cut.dirty ? "render" : "draft";
    if (mode === "render") {
      void renderVideo?.play();
      return;
    }
    if (frames === 0) return;
    if (cut.playhead >= frames - 1) cut.playhead = 0;
    playing = true;
    position = cut.playhead;
    lastTick = performance.now();
    raf = requestAnimationFrame(tick);
  }

  function toggle() {
    if (mode === "render") {
      if (renderVideo?.paused) void renderVideo.play();
      else renderVideo?.pause();
      return;
    }
    if (playing) stop();
    else play();
  }

  function step(by: number) {
    stop();
    cut.playhead = Math.max(0, Math.min(Math.max(0, frames - 1), cut.playhead + by));
  }

  /* The draft's picture follows the playhead: the source is sought to where the
     clip is in it, and while playing it runs on its own and is only pulled
     back when it drifts — seeking every frame would stutter. */
  $effect(() => {
    const video = draftVideo;
    const current = active;
    const time = sourceTime;
    if (mode !== "draft" || !video || !current || current.source.kind !== "video") return;
    video.playbackRate = Math.min(4, Math.max(0.25, current.clip.speed ?? 1));
    video.muted = current.clip.audio?.mute === true || current.track.muted === true;
    const drift = Math.abs(video.currentTime - time);
    if (!playing || drift > 0.25) {
      if (drift > 0.02) video.currentTime = time;
    }
    if (playing && video.paused) void video.play().catch(() => { /* not ready yet: the next tick tries again */ });
    if (!playing && !video.paused) video.pause();
  });

  /* The render's own clock moves the playhead while it plays, and the playhead
     moves the render when the person scrubs the timeline. */
  let renderPlaying = $state(false);

  function renderTime() {
    if (mode !== "render" || !renderVideo || renderVideo.paused) return;
    cut.playhead = Math.min(Math.max(0, frames - 1), Math.round(renderVideo.currentTime * fps));
  }

  $effect(() => {
    const video = renderVideo;
    const at = cut.playhead / fps;
    if (mode !== "render" || !video || !video.paused) return;
    if (Math.abs(video.currentTime - at) > 0.5 / fps) video.currentTime = at;
  });

  /* Leaving a mode stops what it was playing; another unit starts on its render when it has a current one. */
  $effect(() => {
    void mode;
    return () => stop();
  });

  let openedFor = $state("");
  $effect(() => {
    const key = `${unit.film}/${unit.scene}/${unit.shot}`;
    if (key === openedFor || !node) return;
    openedFor = key;
    mode = node.render?.fresh && node.renderUrl ? "render" : "draft";
  });

  const frameStale = $derived(!!cut.frame && (cut.frame.frame !== cut.playhead || cut.frame.revision !== (cut.saved?.revision ?? -1) || cut.dirty));

  async function composed() {
    stop();
    mode = "frame";
    await cut.showFrame();
  }

  /** The transport's keys, for the view to pass on from wherever focus is in the cut. */
  export function handleKey(event: KeyboardEvent) {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable]")) return;
    if (event.key === " " || event.key === "k") toggle();
    else if (event.key === "ArrowLeft" && !target.closest(".tl-clip")) step(event.shiftKey ? -fps : -1);
    else if (event.key === "ArrowRight" && !target.closest(".tl-clip")) step(event.shiftKey ? fps : 1);
    else if (event.key === "Home" && !target.closest(".tl-clip")) step(-Infinity);
    else if (event.key === "End" && !target.closest(".tl-clip")) step(Infinity);
    else return;
    event.preventDefault();
  }

  const caption = $derived.by(() => {
    if (mode === "render") {
      if (!renderOf) return "Not rendered yet.";
      const which = `${renderOf.quality === "preview" ? "Preview render" : "Final render"} ${renderOf.renderId}`;
      if (cut.dirty) return `${which} — of the saved cut, not of your unsaved changes.`;
      return renderOf.fresh ? `${which} — current.` : `${which} — the cut or its sources changed since.`;
    }
    if (mode === "frame") {
      if (cut.frameLoading) return "Composing the frame…";
      if (!cut.frame) return "The frame at the playhead, composed with every effect.";
      if (frameStale) return `Composed frame ${cut.frame.frame} of revision ${cut.frame.revision} — the playhead or the cut moved since. Compose again to see it now.`;
      return `Composed frame ${cut.frame.frame}, revision ${cut.frame.revision}: every effect, as a render would show it.`;
    }
    if (frames === 0) return "The cut is empty: add a clip from the sources.";
    if (!active) return "Nothing on a picture track here: the render shows black.";
    if (active.source.kind === "missing") return `${active.clip.label ?? active.clip.id}: ${active.source.why}.`;
    return "Draft: cuts and timing from the sources. No effects, transitions or mix — compose a frame or render for those.";
  });
</script>

<section class="monitor" aria-label="Monitor">
  <div class="mo-modes" role="tablist" aria-label="What the monitor shows">
    <button role="tab" aria-selected={mode === "draft"} onclick={() => (mode = "draft")} title="The timeline as it is being edited, played from its sources">Draft</button>
    <button role="tab" aria-selected={mode === "render"} onclick={() => (mode = "render")} disabled={!renderUrl} title={renderUrl ? "The unit's last render" : "Not rendered yet"}>Render</button>
    <button role="tab" aria-selected={mode === "frame"} onclick={composed} disabled={!cut.saved || cut.frameLoading} title="Compose the frame at the playhead with every effect (of the saved cut)">
      {mode === "frame" && frameStale ? "Compose again" : "Frame"}
    </button>
    <span class="mo-caption" data-mode={mode} role="status">{caption}</span>
  </div>

  <div class="mo-stage" style="--aspect: {cut.draft ? cut.draft.format.width / cut.draft.format.height : 16 / 9}">
    <div class="mo-frame">
      {#if mode === "render" && renderUrl}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          bind:this={renderVideo}
          src={renderUrl}
          poster={gatewayUrl(node?.posterUrl) ?? undefined}
          preload="metadata"
          playsinline
          ontimeupdate={renderTime}
          onplay={() => (renderPlaying = true)}
          onpause={() => (renderPlaying = false)}
          onended={() => (renderPlaying = false)}
        ></video>
      {:else if mode === "frame"}
        {#if cut.frame}
          <img src={cut.frame.url} alt="Frame {cut.frame.frame} of the cut, composed" class:stale={frameStale} />
        {:else}
          <p class="mo-note">{cut.frameLoading ? "Composing…" : "Save the cut to compose a frame of it."}</p>
        {/if}
      {:else if active?.source.kind === "video"}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video bind:this={draftVideo} src={active.source.url ?? undefined} preload="auto" playsinline style="opacity: {active.clip.opacity ?? 1}; object-fit: {active.clip.fit ?? 'cover'}"></video>
      {:else if active?.source.kind === "image"}
        <img src={active.source.url} alt={active.clip.label ?? active.clip.id} style="opacity: {active.clip.opacity ?? 1}; object-fit: {active.clip.fit ?? 'cover'}" />
      {:else if active?.source.kind === "color"}
        <div class="mo-color" style="background: {active.clip.source.color}; opacity: {active.clip.opacity ?? 1}"></div>
      {:else if active}
        <p class="mo-note">{active.source.why ?? "Nothing to show."}</p>
      {/if}
      {#if mode === "draft" && active}
        <span class="mo-tag">{active.clip.label ?? active.clip.id}</span>
      {/if}
    </div>
  </div>

  <div class="mo-transport">
    <button onclick={() => step(-Infinity)} aria-label="Go to the start" title="Start (Home)">⏮</button>
    <button onclick={() => step(-1)} aria-label="Back one frame" title="Back one frame (←)">◀</button>
    <button class="mo-play" onclick={toggle} aria-label={playing || renderPlaying ? "Pause" : "Play"} title="Play or pause (Space)">{playing || renderPlaying ? "❚❚" : "▶"}</button>
    <button onclick={() => step(1)} aria-label="Forward one frame" title="Forward one frame (→)">▶</button>
    <button onclick={() => step(Infinity)} aria-label="Go to the end" title="End (End)">⏭</button>
    <span class="mo-time">{timecode(cut.playhead, fps)}</span>
    <span class="mo-length">of {timecode(frames, fps)}</span>
  </div>
</section>

<style>
  .monitor {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--vs-bg-inset);
  }

  .mo-modes {
    display: flex;
    gap: 2px;
    padding: 4px var(--vs-space-2);
    border-bottom: 1px solid var(--vs-border);
    background: var(--vs-bg-surface);
    flex-shrink: 0;
  }

  .mo-modes button {
    padding: 3px var(--vs-space-2);
    background: none;
    border: 1px solid transparent;
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-secondary);
    font: inherit;
    font-size: var(--vs-text-xs);
    cursor: pointer;
  }

  .mo-modes button:hover:not(:disabled) {
    background: var(--vs-bg-hover);
    color: var(--vs-text-primary);
  }

  .mo-modes button[aria-selected="true"] {
    background: var(--vs-bg-selected);
    border-color: var(--vs-accent);
    color: var(--vs-accent-strong);
    font-weight: var(--vs-font-weight-semibold);
  }

  .mo-modes button:disabled {
    opacity: 0.45;
    cursor: default;
  }

  /* The frame keeps the cut's shape and takes what room there is: a portrait
     film is tall, a scope film is wide, neither is stretched. */
  .mo-stage {
    flex: 1;
    min-height: 0;
    display: grid;
    place-items: center;
    padding: var(--vs-space-2);
    container-type: size;
  }

  .mo-frame {
    position: relative;
    width: min(100cqw, 100cqh * var(--aspect));
    aspect-ratio: var(--aspect);
    background: #000;
    overflow: hidden;
    display: grid;
    place-items: center;
  }

  .mo-frame video,
  .mo-frame img,
  .mo-color {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .mo-frame img.stale {
    filter: saturate(0.4) brightness(0.75);
  }

  .mo-note {
    position: relative;
    margin: 0;
    padding: var(--vs-space-4);
    max-width: 40ch;
    text-align: center;
    font-size: var(--vs-text-sm);
    color: oklch(72% 0 0);
    line-height: var(--vs-leading-normal);
  }

  .mo-tag {
    position: absolute;
    left: 6px;
    top: 6px;
    padding: 1px 6px;
    background: oklch(0% 0 0 / 0.6);
    border-radius: 2px;
    color: oklch(92% 0 0);
    font-family: var(--vs-font-mono);
    font-size: 10px;
    pointer-events: none;
  }

  .mo-transport {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px var(--vs-space-2);
    border-top: 1px solid var(--vs-border);
    background: var(--vs-bg-surface);
    flex-shrink: 0;
    min-width: 0;
  }

  .mo-transport button {
    width: 28px;
    height: 26px;
    padding: 0;
    background: none;
    border: 1px solid transparent;
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-secondary);
    font: inherit;
    font-size: var(--vs-text-xs);
    cursor: pointer;
  }

  .mo-transport button:hover {
    background: var(--vs-bg-hover);
    color: var(--vs-text-primary);
  }

  .mo-transport .mo-play {
    width: 36px;
    border-color: var(--vs-border);
    color: var(--vs-text-primary);
  }

  .mo-time {
    margin: 0 var(--vs-space-2);
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-sm);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  .mo-length {
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-xs);
    color: var(--vs-text-tertiary);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  /* What is on the monitor, said beside the choice that put it there. Two
     lines at most: it is a caption, and the picture is what the room is for. */
  .mo-caption {
    flex: 1;
    min-width: 0;
    align-self: center;
    margin-left: var(--vs-space-2);
    font-size: var(--vs-text-xs);
    line-height: 1.3;
    color: var(--vs-text-tertiary);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .mo-caption[data-mode="draft"] {
    color: var(--vs-state-attention);
  }

  button:focus-visible {
    outline: 2px solid var(--vs-border-focus);
    outline-offset: 1px;
  }
</style>
