<script lang="ts">
  /**
   * The film's footage: what was shot, recorded or bought for it, as it was
   * logged when it came in.
   *
   * A clip is read here before it is cut: its contact sheet shows a take at a
   * glance, its proxy plays in the browser whatever the camera wrote, and its
   * log entry — tags, notes, the scene and shot it was shot for — is edited in
   * place. Bringing files in names them where they are on this machine: the
   * studio is a localhost tool, and camera originals are too large to pass
   * through a browser upload.
   */
  import { film } from "$lib/film-store.svelte.ts";
  import { gatewayUrl } from "$lib/film-api";
  import { bytes, clock } from "$lib/film-format";
  import type { FootageClip } from "$lib/film-types";

  let query = $state("");
  let kind = $state<"" | FootageClip["kind"]>("");
  let selectedId = $state<string | null>(null);
  let showSheet = $state(true);

  $effect(() => {
    if (film.film) void film.loadFootage();
  });

  const clips = $derived.by(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return film.footage.filter((clip) => {
      if (kind && clip.kind !== kind) return false;
      const text = [clip.id, clip.originalName, clip.notes, clip.scene ?? "", clip.shot ?? "", clip.origin, ...clip.tags].join(" ").toLowerCase();
      return words.every((word) => text.includes(word));
    });
  });

  const selected = $derived(film.footage.find((clip) => clip.id === selectedId) ?? null);
  const totalSeconds = $derived(film.footage.reduce((sum, clip) => sum + (clip.durationSeconds ?? 0), 0));

  /* The log entry being edited: taken from the clip when another is selected. */
  let entry = $state({ tags: "", notes: "", scene: "", shot: "", licence: "", origin: "camera" as FootageClip["origin"] });
  let entryFor = $state<string | null>(null);

  $effect(() => {
    if (!selected || entryFor === selected.id) return;
    entryFor = selected.id;
    entry = { tags: selected.tags.join(", "), notes: selected.notes, scene: selected.scene ?? "", shot: selected.shot ?? "", licence: selected.licence ?? "", origin: selected.origin };
  });

  async function saveEntry(event: SubmitEvent) {
    event.preventDefault();
    if (!selected) return;
    await film.annotate(selected.id, {
      tags: entry.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
      notes: entry.notes.trim(),
      origin: entry.origin,
      ...(entry.scene.trim() ? { scene: entry.scene.trim() } : {}),
      ...(entry.shot.trim() ? { shot: entry.shot.trim() } : {}),
      ...(entry.licence.trim() ? { licence: entry.licence.trim() } : {}),
    });
  }

  let bringing = $state(false);
  let paths = $state("");
  let bringOrigin = $state<FootageClip["origin"]>("camera");
  let link = $state(false);
  let busy = $state(false);

  async function bring(event: SubmitEvent) {
    event.preventDefault();
    const files = paths.split("\n").map((line) => line.trim()).filter(Boolean);
    if (files.length === 0) return;
    busy = true;
    const done = await film.ingest(files, { origin: bringOrigin, link });
    busy = false;
    if (done) {
      bringing = false;
      paths = "";
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch { /* the text is on screen to be copied by hand */ }
  }
</script>

<div class="footage">
  <header class="fo-bar">
    <input type="search" placeholder="Filter by name, tag, note, scene" aria-label="Filter footage" bind:value={query} />
    <select aria-label="Kind" bind:value={kind}>
      <option value="">All kinds</option>
      <option value="video">Picture</option>
      <option value="audio">Sound</option>
      <option value="image">Stills</option>
    </select>
    <span class="fo-total">{clips.length} of {film.footage.length} · {clock(totalSeconds)}</span>
    <button class="fo-btn" onclick={() => (bringing = !bringing)} aria-expanded={bringing}>Bring files in</button>
  </header>

  {#if bringing}
    <form class="fo-bring" onsubmit={bring}>
      <label for="fo-paths">Files on this machine, one full path per line</label>
      <textarea id="fo-paths" rows="3" bind:value={paths} placeholder="/Volumes/CARD_A/CLIPS/A001_C004.mov" spellcheck="false"></textarea>
      <div class="fo-bring-row">
        <label>From
          <select bind:value={bringOrigin}>
            <option value="camera">the camera</option>
            <option value="recording">a sound recording</option>
            <option value="stock">stock or archive</option>
            <option value="generated">a generator</option>
            <option value="other">elsewhere</option>
          </select>
        </label>
        <label class="fo-check" title="For originals too large to keep twice: the film then needs that disk">
          <input type="checkbox" bind:checked={link} /> link instead of copying
        </label>
        <button type="submit" class="fo-btn fo-primary" disabled={busy}>{busy ? "Reading…" : "Bring in"}</button>
        <button type="button" class="fo-btn" onclick={() => (bringing = false)}>Cancel</button>
      </div>
      <p class="fo-note">Each file is named by its content, measured, and given a contact sheet, its cuts, a proxy and its loudness. The same file twice is found, not copied.</p>
    </form>
  {/if}

  {#if film.notice}
    <p class="fo-notice" class:fo-error={film.notice.tone === "error"} role={film.notice.tone === "error" ? "alert" : "status"}>{film.notice.text}</p>
  {/if}

  <div class="fo-body">
    <div class="fo-list">
      {#if film.footage.length === 0}
        <p class="fo-empty">No footage yet. Bring in what was shot or recorded for the film, or ask the agent to find archive media for a shot.</p>
      {:else if clips.length === 0}
        <p class="fo-empty">Nothing matches.</p>
      {/if}
      {#each clips as clip (clip.id)}
        <button class="fo-clip" class:selected={clip.id === selectedId} onclick={() => (selectedId = clip.id)} aria-current={clip.id === selectedId ? "true" : undefined}>
          <span class="fo-thumb">
            {#if clip.sheetUrl}
              <img src={gatewayUrl(clip.sheetUrl)} alt="" loading="lazy" />
            {:else if clip.kind === "image" && clip.url}
              <img src={gatewayUrl(clip.url)} alt="" loading="lazy" />
            {:else}
              <span class="fo-thumb-none">{clip.kind === "audio" ? "sound" : clip.kind}</span>
            {/if}
          </span>
          <span class="fo-clip-text">
            <span class="fo-name">{clip.originalName}</span>
            <span class="fo-meta">
              {clip.kind === "audio" ? "sound" : `${clip.width}×${clip.height}${clip.fps ? ` · ${clip.fps} fps` : ""}`}
              {#if clip.durationSeconds} · {clock(clip.durationSeconds)}{/if}
              · {clip.origin}{clip.linked ? " · linked" : ""}
            </span>
            {#if clip.scene || clip.tags.length > 0}
              <span class="fo-tags">
                {#if clip.scene}<span class="fo-for">{clip.scene}{clip.shot ? `/${clip.shot}` : ""}</span>{/if}
                {#each clip.tags as tag (tag)}<span class="fo-tag">{tag}</span>{/each}
              </span>
            {/if}
          </span>
        </button>
      {/each}
    </div>

    <div class="fo-detail">
      {#if !selected}
        <p class="fo-empty">Select a clip to look at it and edit its log entry.</p>
      {:else}
        <div class="fo-view">
          {#if selected.kind === "video"}
            {#if showSheet && selected.sheetUrl}
              <img class="fo-sheet" src={gatewayUrl(selected.sheetUrl)} alt="Contact sheet of {selected.originalName}" />
            {:else}
              <!-- svelte-ignore a11y_media_has_caption -->
              <video src={gatewayUrl(selected.proxyUrl ?? selected.url)} controls preload="metadata"></video>
            {/if}
            {#if selected.sheetUrl}
              <div class="fo-toggle" role="group" aria-label="How to look at the clip">
                <button aria-pressed={showSheet} onclick={() => (showSheet = true)}>Sheet</button>
                <button aria-pressed={!showSheet} onclick={() => (showSheet = false)}>Play{selected.proxyUrl ? " proxy" : ""}</button>
              </div>
            {/if}
          {:else if selected.kind === "image"}
            <img class="fo-sheet" src={gatewayUrl(selected.url)} alt={selected.originalName} />
          {:else}
            <audio src={gatewayUrl(selected.url)} controls></audio>
          {/if}
        </div>

        <dl class="fo-facts">
          <div><dt>in a cut as</dt><dd><code>{`{ "project": "${selected.path}" }`}</code> <button class="fo-copy" onclick={() => copy(`{ "project": "${selected.path}" }`)}>copy</button></dd></div>
          <div><dt>size</dt><dd>{bytes(selected.bytes)}</dd></div>
          {#if selected.videoCodec}<div><dt>picture</dt><dd>{selected.videoCodec} · {selected.width}×{selected.height}{selected.fps ? ` · ${selected.fps} fps` : ""}</dd></div>{/if}
          {#if selected.audio}<div><dt>sound</dt><dd>{selected.audio.codec} · {selected.audio.channels} ch · {selected.audio.sampleRate} Hz</dd></div>{/if}
          {#if selected.loudness?.integrated != null}<div><dt>loudness</dt><dd>{selected.loudness.integrated.toFixed(1)} LUFS · peak {selected.loudness.truePeak?.toFixed(1) ?? "–"} dBTP</dd></div>{/if}
          {#if selected.segments && selected.segments.length > 1}
            <div><dt>cuts at</dt><dd>{selected.segments.slice(1).map((segment) => `${segment.start}s`).join(" · ")}</dd></div>
          {/if}
          <div><dt>came in</dt><dd>{new Date(selected.ingestedAt).toLocaleString()}</dd></div>
        </dl>

        <form class="fo-entry" onsubmit={saveEntry}>
          <h3>Log entry</h3>
          <label>Notes <textarea rows="2" bind:value={entry.notes}></textarea></label>
          <label>Tags <input type="text" bind:value={entry.tags} placeholder="comma, separated" /></label>
          <div class="fo-entry-row">
            <label>For scene <input type="text" bind:value={entry.scene} list="fo-scenes" /></label>
            <label>shot <input type="text" bind:value={entry.shot} /></label>
            <label>From
              <select bind:value={entry.origin}>
                <option value="camera">camera</option>
                <option value="recording">recording</option>
                <option value="stock">stock</option>
                <option value="generated">generated</option>
                <option value="other">other</option>
              </select>
            </label>
          </div>
          <datalist id="fo-scenes">
            {#each film.tree?.scenes ?? [] as scene (scene.slug)}<option value={scene.slug}>{scene.title}</option>{/each}
          </datalist>
          <label>Licence <input type="text" bind:value={entry.licence} placeholder="Who made it, and its terms — for material that is not the film's own" /></label>
          <div><button type="submit" class="fo-btn fo-primary">Save entry</button></div>
        </form>
      {/if}
    </div>
  </div>
</div>

<style>
  .footage {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }

  .fo-bar {
    display: flex;
    align-items: center;
    gap: var(--vs-space-2);
    padding: var(--vs-space-2) var(--vs-space-3);
    border-bottom: 1px solid var(--vs-border);
    flex-shrink: 0;
  }

  .fo-bar input[type="search"] {
    flex: 1;
    max-width: 360px;
  }

  input[type="search"],
  input[type="text"],
  select,
  textarea {
    padding: 5px var(--vs-space-2);
    background: var(--vs-bg-inset);
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-primary);
    font: inherit;
    font-size: var(--vs-text-sm);
  }

  input:focus,
  select:focus,
  textarea:focus {
    outline: none;
    border-color: var(--vs-border-focus);
  }

  .fo-total {
    margin-left: auto;
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-xs);
    color: var(--vs-text-tertiary);
  }

  .fo-btn {
    padding: 5px var(--vs-space-3);
    background: var(--vs-bg-surface);
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-md);
    color: var(--vs-text-primary);
    font: inherit;
    font-size: var(--vs-text-sm);
    cursor: pointer;
    white-space: nowrap;
  }

  .fo-btn:hover:not(:disabled) { background: var(--vs-bg-hover); }
  .fo-btn:disabled { opacity: 0.5; cursor: default; }

  .fo-primary {
    background: var(--vs-accent-strong);
    border-color: var(--vs-accent-strong);
    color: var(--vs-accent-text);
  }

  .fo-primary:hover:not(:disabled) { background: var(--vs-accent-strong-hover); }

  .fo-bring {
    display: flex;
    flex-direction: column;
    gap: var(--vs-space-2);
    padding: var(--vs-space-3);
    background: var(--vs-bg-raised);
    border-bottom: 1px solid var(--vs-border);
    font-size: var(--vs-text-sm);
    flex-shrink: 0;
  }

  .fo-bring textarea {
    font-family: var(--vs-font-mono);
    resize: vertical;
  }

  .fo-bring-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--vs-space-3);
  }

  .fo-check {
    display: inline-flex;
    align-items: center;
    gap: var(--vs-space-1);
  }

  .fo-note,
  .fo-empty {
    margin: 0;
    font-size: var(--vs-text-xs);
    color: var(--vs-text-tertiary);
  }

  .fo-empty {
    padding: var(--vs-space-5);
    font-size: var(--vs-text-sm);
  }

  .fo-notice {
    margin: 0;
    padding: var(--vs-space-2) var(--vs-space-3);
    background: var(--vs-bg-raised);
    border-bottom: 1px solid var(--vs-border);
    font-size: var(--vs-text-sm);
  }

  .fo-error {
    background: var(--vs-state-blocked-bg);
    color: var(--vs-state-blocked);
  }

  .fo-body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(280px, 380px) minmax(0, 1fr);
  }

  .fo-list {
    overflow-y: auto;
    border-right: 1px solid var(--vs-border);
  }

  .fo-clip {
    display: flex;
    gap: var(--vs-space-3);
    width: 100%;
    padding: var(--vs-space-2) var(--vs-space-3);
    background: none;
    border: none;
    border-bottom: 1px solid var(--vs-border-subtle);
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .fo-clip:hover { background: var(--vs-bg-hover); }
  .fo-clip.selected { background: var(--vs-bg-selected); }

  .fo-thumb {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 96px;
    aspect-ratio: 16 / 9;
    background: var(--vs-bg-inset);
    border: 1px solid var(--vs-border);
    border-radius: 2px;
    overflow: hidden;
  }

  .fo-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: top left;
  }

  .fo-thumb-none {
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--vs-text-disabled);
  }

  .fo-clip-text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .fo-name {
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .fo-meta {
    font-size: var(--vs-text-xs);
    color: var(--vs-text-tertiary);
  }

  .fo-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .fo-tag,
  .fo-for {
    padding: 0 5px;
    border: 1px solid var(--vs-border);
    border-radius: 2px;
    font-size: 10px;
    color: var(--vs-text-secondary);
  }

  .fo-for {
    border-color: var(--vs-accent-strong);
    color: var(--vs-accent-strong);
    font-family: var(--vs-font-mono);
  }

  .fo-detail {
    overflow-y: auto;
    padding: var(--vs-space-4);
    display: flex;
    flex-direction: column;
    gap: var(--vs-space-4);
  }

  .fo-view {
    display: flex;
    flex-direction: column;
    gap: var(--vs-space-2);
  }

  .fo-view video,
  .fo-sheet {
    display: block;
    max-width: 100%;
    max-height: 52vh;
    object-fit: contain;
    background: oklch(0% 0 0);
    border-radius: var(--vs-radius-sm);
    align-self: flex-start;
  }

  .fo-view audio {
    width: 100%;
    max-width: 520px;
  }

  .fo-toggle {
    display: inline-flex;
    align-self: flex-start;
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-md);
    overflow: hidden;
  }

  .fo-toggle button {
    padding: 3px var(--vs-space-3);
    background: none;
    border: none;
    color: var(--vs-text-secondary);
    font: inherit;
    font-size: var(--vs-text-xs);
    cursor: pointer;
  }

  .fo-toggle button[aria-pressed="true"] {
    background: var(--vs-bg-selected);
    color: var(--vs-text-primary);
  }

  .fo-facts {
    margin: 0;
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px var(--vs-space-4);
    font-size: var(--vs-text-sm);
  }

  .fo-facts div { display: contents; }

  .fo-facts dt {
    font-size: var(--vs-text-xs);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--vs-text-tertiary);
    padding-top: 2px;
  }

  .fo-facts dd {
    margin: 0;
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-xs);
    overflow-wrap: anywhere;
  }

  .fo-copy {
    padding: 0 6px;
    background: none;
    border: 1px solid var(--vs-border);
    border-radius: 2px;
    color: var(--vs-text-secondary);
    font: inherit;
    font-size: 10px;
    cursor: pointer;
  }

  .fo-entry {
    display: flex;
    flex-direction: column;
    gap: var(--vs-space-2);
    max-width: 640px;
  }

  .fo-entry h3 {
    margin: 0;
    font-size: var(--vs-text-xs);
    font-weight: var(--vs-font-weight-semibold);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--vs-text-tertiary);
  }

  .fo-entry label {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: var(--vs-text-xs);
    color: var(--vs-text-secondary);
  }

  .fo-entry-row {
    display: grid;
    /* A column may shrink below its content: the last one was pushed out of the panel. */
    grid-template-columns: minmax(0, 2fr) minmax(0, 2fr) minmax(88px, 1fr);
    gap: var(--vs-space-2);
  }

  .fo-entry-row :is(input, select) {
    min-width: 0;
    width: 100%;
    box-sizing: border-box;
  }

  @media (max-width: 900px) {
    .fo-body {
      grid-template-columns: 1fr;
      grid-template-rows: 40% 60%;
    }

    .fo-list {
      border-right: none;
      border-bottom: 1px solid var(--vs-border);
    }
  }
</style>
