<script lang="ts">
  /**
   * What a cut can be made of, ready to put on the timeline.
   *
   * - what is under the unit: a film's scenes, a scene's shots — each as its
   *   current render, so the cut follows them as they are rendered again;
   * - the unit's own files: what was generated, drawn, recorded for it;
   * - the film's footage and music: what was shot, bought or licensed;
   * - a solid colour: black before a title, a flash, a matte.
   *
   * A source goes to the track that is selected when it can carry it, or to
   * the first track that can: picture to a picture track, sound to a sound
   * track. It lands at the playhead.
   */
  import { cut } from "$lib/cut-store.svelte.ts";
  import { film, type Unit } from "$lib/film-store.svelte.ts";
  import { files } from "$lib/files-store.svelte.ts";
  import { gatewayUrl } from "$lib/film-api";
  import { clock } from "$lib/film-format";
  import type { CutSource, CutTrack } from "@studio/contracts/src/cut-timeline.mjs";
  import StateChip from "../film/StateChip.svelte";

  interface Props {
    unit: Unit;
  }

  let { unit }: Props = $props();

  const level = $derived(unit.scene === "_" ? "film" : unit.shot === "_" ? "scene" : "shot");
  const fps = $derived(cut.fps);

  type Tab = "units" | "files" | "footage" | "colour";
  let tab = $state<Tab>("files");
  let tabFor = $state("");

  /* A film and a scene open on what they are cut from; a shot on its own files. */
  $effect(() => {
    const key = `${unit.film}/${unit.scene}/${unit.shot}`;
    if (key === tabFor) return;
    tabFor = key;
    tab = level === "shot" ? "files" : "units";
  });

  $effect(() => {
    if (tab === "footage" && film.film) void film.loadFootage();
  });

  const children = $derived(level === "film" ? (film.tree?.scenes ?? []) : level === "scene" ? (film.scene(unit.scene)?.shots ?? []) : []);

  const VIDEO = /\.(mp4|mov|mkv|webm|m4v)$/i;
  const IMAGE = /\.(png|jpe?g|webp|gif|avif)$/i;
  const AUDIO = /\.(wav|mp3|m4a|flac|aac|ogg|opus)$/i;
  const mediaKind = (name: string) => (VIDEO.test(name) ? "video" : IMAGE.test(name) ? "image" : AUDIO.test(name) ? "audio" : null);

  /**
   * The unit's media files, newest first. Not its renders — a cut is not made
   * of its own output — nor what belongs to the levels under it or to the
   * footage log, which have tabs of their own.
   */
  const media = $derived(
    files.entries
      .filter((entry) => entry.kind === "file" && mediaKind(entry.name) && !/^(output|artifacts|scenes|shots|footage)\//.test(entry.path))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  );

  let query = $state("");
  const matches = (text: string) => query.trim() === "" || query.toLowerCase().split(/\s+/).every((word) => text.toLowerCase().includes(word));

  /** In the cut already: how many clips use a source. */
  const uses = $derived.by(() => {
    const count = new Map<string, number>();
    for (const track of cut.draft?.tracks ?? []) {
      for (const clip of track.clips) {
        const key = clip.source.unit ? `unit:${clip.source.unit}` : clip.source.path ? `path:${clip.source.path}` : clip.source.project ? `project:${clip.source.project}` : "";
        if (key) count.set(key, (count.get(key) ?? 0) + 1);
      }
    }
    return count;
  });

  let notice = $state<string | null>(null);

  function trackFor(kind: "video" | "audio"): CutTrack | null {
    const chosen = cut.selectedTrack ?? cut.selectedClip?.track ?? null;
    if (chosen && chosen.kind === kind && !chosen.locked) return chosen;
    const open = (cut.draft?.tracks ?? []).filter((track) => track.kind === kind && !track.locked);
    return open.find((track) => track.role !== "overlay") ?? open[0] ?? null;
  }

  function put(kind: "video" | "audio", source: CutSource, seconds: number, label?: string) {
    const track = trackFor(kind);
    if (!track) {
      notice = `There is no unlocked ${kind === "video" ? "picture" : "sound"} track to put it on: add one, or unlock one.`;
      return;
    }
    notice = null;
    cut.addClip(track.id, source, Math.max(1, Math.round(seconds * fps)), label);
  }

  /** How long a file runs, read from the file itself by the browser. Stills hold four seconds. */
  function lengthOf(url: string, kind: "video" | "audio" | "image"): Promise<number> {
    if (kind === "image") return Promise.resolve(4);
    return new Promise((resolve) => {
      const element = document.createElement(kind);
      const done = (seconds: number) => {
        element.removeAttribute("src");
        resolve(seconds);
      };
      element.preload = "metadata";
      element.onloadedmetadata = () => done(Number.isFinite(element.duration) && element.duration > 0 ? element.duration : 4);
      element.onerror = () => done(4);
      setTimeout(() => done(4), 4000);
      element.src = url;
    });
  }

  let adding = $state<string | null>(null);

  async function putFile(path: string, name: string) {
    const kind = mediaKind(name);
    const url = files.mediaUrl(path);
    if (!kind || !url) return;
    adding = path;
    const seconds = await lengthOf(url, kind);
    adding = null;
    // A film's own files are the project's: scenes and shots name them the same way.
    put(kind === "audio" ? "audio" : "video", level === "film" ? { project: path } : { path }, seconds);
  }

  let colour = $state("#000000");
  let colourSeconds = $state(2);
</script>

<section class="sources" aria-label="Sources">
  <div class="so-tabs" role="tablist" aria-label="Kinds of source">
    {#if level !== "shot"}
      <button role="tab" aria-selected={tab === "units"} onclick={() => (tab = "units")}>{level === "film" ? "Scenes" : "Shots"}</button>
    {/if}
    <button role="tab" aria-selected={tab === "files"} onclick={() => (tab = "files")}>Files</button>
    <button role="tab" aria-selected={tab === "footage"} onclick={() => (tab = "footage")}>Footage</button>
    <button role="tab" aria-selected={tab === "colour"} onclick={() => (tab = "colour")}>Colour</button>
  </div>

  {#if tab !== "colour"}
    <input class="so-filter" type="search" placeholder="Filter" aria-label="Filter sources" bind:value={query} />
  {/if}

  {#if notice}<p class="so-notice" role="alert">{notice}</p>{/if}

  <div class="so-list">
    {#if tab === "units"}
      {#each children.filter((child) => matches(`${child.slug} ${child.title}`)) as child (child.slug)}
        {@const used = uses.get(`unit:${child.slug}`) ?? 0}
        <article class="so-item">
          <div class="so-thumb">
            {#if child.posterUrl}<img src={gatewayUrl(child.posterUrl)} alt="" loading="lazy" />{/if}
          </div>
          <div class="so-meta">
            <span class="so-name" title={child.title}>{child.title}</span>
            <span class="so-sub">{child.slug} · {clock(child.status.cut.seconds)}</span>
            <StateChip state={child.status.state} title={child.status.reason} />
          </div>
          <button
            class="so-add"
            disabled={child.status.cut.frames === 0}
            title={child.status.cut.frames === 0 ? "It has no cut yet: nothing to take its length from" : `Put its render on the timeline${used ? ` (already there ${used}×)` : ""}`}
            onclick={() => put("video", { unit: child.slug }, child.status.cut.seconds, child.title)}
          >{used ? "Add again" : "Add"}</button>
        </article>
      {:else}
        <p class="so-empty">{children.length === 0 ? `This ${level} has no ${level === "film" ? "scenes" : "shots"} yet.` : "Nothing matches."}</p>
      {/each}
      {#if children.length > 0}
        <p class="so-hint">To lay them all out in order, use <strong>Assemble</strong>: it keeps the cut in step as {level === "film" ? "scenes" : "shots"} are added or reordered.</p>
      {/if}
    {:else if tab === "files"}
      {#each media.filter((entry) => matches(entry.path)) as entry (entry.path)}
        {@const kind = mediaKind(entry.name)}
        {@const used = uses.get(`${level === "film" ? "project" : "path"}:${entry.path}`) ?? 0}
        <article class="so-item">
          <div class="so-thumb" data-kind={kind}>
            {#if kind === "image"}<img src={files.mediaUrl(entry.path)} alt="" loading="lazy" />
            {:else if kind === "video"}<video src={files.mediaUrl(entry.path)} preload="metadata" muted></video>
            {:else}<span aria-hidden="true">♪</span>{/if}
          </div>
          <div class="so-meta">
            <span class="so-name" title={entry.path}>{entry.name}</span>
            <span class="so-sub">{entry.path.split("/").slice(0, -1).join("/") || "."}{used ? ` · in the cut ${used}×` : ""}</span>
          </div>
          <button class="so-add" disabled={adding !== null} onclick={() => putFile(entry.path, entry.name)}>{adding === entry.path ? "…" : "Add"}</button>
        </article>
      {:else}
        <p class="so-empty">{files.loading ? "Reading the files…" : media.length === 0 ? `No media among this ${level}'s files yet. Upload some in Files, or ask the agent to make it.` : "Nothing matches."}</p>
      {/each}
    {:else if tab === "footage"}
      {#each film.footage.filter((clip) => matches([clip.id, clip.originalName, clip.notes, clip.scene ?? "", clip.shot ?? "", ...clip.tags].join(" "))) as clip (clip.id)}
        {@const used = uses.get(`project:${clip.path}`) ?? 0}
        <article class="so-item">
          <div class="so-thumb" data-kind={clip.kind}>
            {#if clip.sheetUrl}<img src={gatewayUrl(clip.sheetUrl)} alt="" loading="lazy" />
            {:else if clip.kind === "image" && clip.url}<img src={gatewayUrl(clip.url)} alt="" loading="lazy" />
            {:else}<span aria-hidden="true">{clip.kind === "audio" ? "♪" : "▭"}</span>{/if}
          </div>
          <div class="so-meta">
            <span class="so-name" title={clip.originalName}>{clip.originalName}</span>
            <span class="so-sub">{clip.origin} · {clock(clip.durationSeconds ?? 0)}{clip.tags.length ? ` · ${clip.tags.join(", ")}` : ""}{used ? ` · in the cut ${used}×` : ""}</span>
          </div>
          <button class="so-add" onclick={() => put(clip.kind === "audio" ? "audio" : "video", { project: clip.path }, clip.durationSeconds ?? 4, clip.originalName.replace(/\.[^.]+$/, ""))}>Add</button>
        </article>
      {:else}
        <p class="so-empty">{film.footage.length === 0 ? "No footage has been brought into this film. Bring files in from the film's Footage view." : "Nothing matches."}</p>
      {/each}
    {:else}
      <form class="so-colour" onsubmit={(e) => { e.preventDefault(); put("video", { color: colour }, colourSeconds, colour === "#000000" ? "Black" : undefined); }}>
        <label>Colour <input type="color" bind:value={colour} /></label>
        <label>Holds for <input type="number" min="0.1" step="0.1" bind:value={colourSeconds} /> s</label>
        <button class="so-add" type="submit">Add</button>
        <p class="so-hint">A solid frame: black before a title, a white flash, a colour to key a matte over.</p>
      </form>
    {/if}
  </div>
</section>

<style>
  .sources {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--vs-bg-surface);
  }

  .so-tabs {
    display: flex;
    border-bottom: 1px solid var(--vs-border);
    flex-shrink: 0;
  }

  .so-tabs button {
    flex: 1;
    padding: 7px 2px;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    color: var(--vs-text-secondary);
    font: inherit;
    font-size: var(--vs-text-xs);
    cursor: pointer;
  }

  .so-tabs button:hover {
    color: var(--vs-text-primary);
  }

  .so-tabs button[aria-selected="true"] {
    color: var(--vs-accent-strong);
    border-bottom-color: var(--vs-accent-strong);
    font-weight: var(--vs-font-weight-semibold);
  }

  .so-filter {
    margin: var(--vs-space-2);
    padding: 3px 6px;
    background: var(--vs-bg-canvas);
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-primary);
    font: inherit;
    font-size: var(--vs-text-xs);
    flex-shrink: 0;
  }

  .so-notice {
    margin: 0 var(--vs-space-2) var(--vs-space-2);
    padding: var(--vs-space-1) var(--vs-space-2);
    background: var(--vs-state-blocked-bg);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-state-blocked);
    font-size: var(--vs-text-xs);
    line-height: var(--vs-leading-normal);
  }

  .so-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .so-item {
    display: grid;
    grid-template-columns: 56px minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--vs-space-2);
    padding: var(--vs-space-1) var(--vs-space-2);
    border-bottom: 1px solid var(--vs-border-subtle);
  }

  .so-thumb {
    width: 56px;
    aspect-ratio: 16 / 9;
    background: var(--vs-bg-inset);
    border-radius: 2px;
    overflow: hidden;
    display: grid;
    place-items: center;
    color: var(--vs-text-tertiary);
    font-size: var(--vs-text-sm);
  }

  .so-thumb img,
  .so-thumb video {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .so-meta {
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
  }

  .so-name {
    max-width: 100%;
    font-size: var(--vs-text-xs);
    color: var(--vs-text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .so-sub {
    max-width: 100%;
    font-family: var(--vs-font-mono);
    font-size: 10px;
    color: var(--vs-text-tertiary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .so-add {
    padding: 2px var(--vs-space-2);
    background: none;
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-secondary);
    font: inherit;
    font-size: var(--vs-text-xs);
    cursor: pointer;
    white-space: nowrap;
  }

  .so-add:hover:not(:disabled) {
    border-color: var(--vs-accent);
    color: var(--vs-accent-strong);
  }

  .so-add:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .so-empty,
  .so-hint {
    margin: 0;
    padding: var(--vs-space-3);
    font-size: var(--vs-text-xs);
    color: var(--vs-text-tertiary);
    line-height: var(--vs-leading-normal);
  }

  .so-hint strong {
    color: var(--vs-text-secondary);
    font-weight: var(--vs-font-weight-semibold);
  }

  .so-colour {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--vs-space-2);
    padding: var(--vs-space-3);
    font-size: var(--vs-text-xs);
    color: var(--vs-text-secondary);
  }

  .so-colour label {
    display: flex;
    align-items: center;
    gap: var(--vs-space-2);
  }

  .so-colour input[type="number"] {
    width: 64px;
    padding: 2px 4px;
    background: var(--vs-bg-canvas);
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-primary);
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-xs);
  }

  .so-colour .so-hint {
    padding: 0;
  }

  :is(button, input):focus-visible {
    outline: 2px solid var(--vs-border-focus);
    outline-offset: 1px;
  }
</style>
