<script lang="ts">
  /**
   * A scene, or a shot: what it is, what it is made of, and who decides.
   *
   * A scene is its heading and summary, and its shots in cutting order. A shot
   * is its plan — what it shows and how it is framed — and its takes: the
   * media made or brought in for it, any of which a person can put in the
   * cut. Both carry the same three things in the same places, because the
   * question at both levels is the same.
   */
  import { film, type Unit } from "$lib/film-store.svelte.ts";
  import { files } from "$lib/files-store.svelte.ts";
  import { library } from "$lib/library-store.svelte.ts";
  import { studio } from "$lib/studio-store.svelte.ts";
  import { filmApi, FilmApiError, gatewayUrl } from "$lib/film-api";
  import { bytes, clock, nextNumber, slugify } from "$lib/film-format";
  import { unitPath, type SceneNode, type ShotNode } from "$lib/film-types";
  import { SHOT_SOURCES, type ShotSource } from "@studio/contracts/src/film.mjs";
  import StateChip from "./StateChip.svelte";
  import ManifestForm from "./ManifestForm.svelte";
  import ControlPanel from "./ControlPanel.svelte";
  import StylePanel from "../style/StylePanel.svelte";

  interface Props {
    unit: Unit;
  }

  let { unit }: Props = $props();

  const level = $derived(unit.shot === "_" ? "scene" as const : "shot" as const);
  const node = $derived(film.node(unit) as SceneNode | ShotNode | null);
  const scene = $derived(level === "scene" ? (node as SceneNode | null) : null);
  const sceneUnit = $derived({ film: unit.film, scene: unit.scene, shot: "_" });

  // ── A scene's shots ───────────────────────────────────────────────────

  let adding = $state(false);
  let draft = $state({ title: "", slug: "", source: "generated" as ShotSource });
  let slugTouched = $state(false);

  $effect(() => {
    if (!adding || slugTouched) return;
    const words = slugify(draft.title);
    draft.slug = words ? `${nextNumber(scene?.shots.map((s) => s.slug) ?? [])}-${words}`.slice(0, 64) : "";
  });

  async function createShot(event: SubmitEvent) {
    event.preventDefault();
    if (!draft.title.trim() || !draft.slug) return;
    if (await film.createShot(unit.scene, { slug: draft.slug, title: draft.title.trim(), source: draft.source })) {
      adding = false;
      draft = { title: "", slug: "", source: "generated" };
      slugTouched = false;
    }
  }

  // ── A shot's takes ────────────────────────────────────────────────────

  const MEDIA = /\.(mp4|mov|mkv|webm|m4v|png|jpe?g|webp|wav|mp3|m4a|flac|aac|ogg)$/i;
  const PICTURE = /\.(mp4|mov|mkv|webm|m4v|png|jpe?g|webp)$/i;
  const VIDEO = /\.(mp4|mov|mkv|webm|m4v)$/i;
  const IMAGE = /\.(png|jpe?g|webp)$/i;

  /** The media under the shot's assets/, newest first: what was made or brought in for it. */
  const takes = $derived(
    level === "shot"
      ? files.entries
          .filter((entry) => entry.kind === "file" && entry.path.startsWith("assets/") && MEDIA.test(entry.name))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      : [],
  );

  /** The files the shot's cut is made of. */
  let cutSources = $state<string[]>([]);
  const usedPaths = $derived(new Set(node?.status.children.length === 0 ? cutSources : []));

  $effect(() => {
    const key = `${unit.film}/${unit.scene}/${unit.shot}/${node?.status.cut.revision ?? 0}`;
    if (level !== "shot" || !key) return;
    void filmApi<{ cut: { tracks: { clips: { source: { path?: string; project?: string } }[] }[] } | null }>(`${unitPath(unit)}/cut`)
      .then((view) => {
        cutSources = (view.cut?.tracks ?? []).flatMap((track) => track.clips.map((clip) => clip.source.path ?? (clip.source.project ? `project:${clip.source.project}` : ""))).filter(Boolean);
      })
      .catch(() => { cutSources = []; });
  });

  let takeNotice = $state<{ tone: "error" | "info"; text: string } | null>(null);

  async function useTake(path: string) {
    takeNotice = null;
    try {
      const result = await filmApi<{ notes?: string[] }>(`${unitPath(unit)}/cut/assemble`, { method: "POST", body: { media: path, replace: true } });
      takeNotice = { tone: "info", text: (result.notes ?? []).join(" · ") || "The shot is cut from this take." };
      await film.refresh();
    } catch (error) {
      takeNotice = { tone: "error", text: error instanceof FilmApiError ? error.message : String(error) };
    }
  }

  function openFile(path: string) {
    const entry = files.entries.find((e) => e.path === path);
    if (entry) void files.open(entry);
    studio.openFile(path);
  }

  const rendering = $derived(film.rendering);
</script>

{#if !node}
  <div class="uo-empty" role={film.error ? "alert" : "status"}>
    {film.error ?? (film.loading || !film.tree ? "Reading the film…" : `There is no ${level} here.`)}
  </div>
{:else}
  <div class="unit-overview">
    <header class="uo-head">
      <div>
        <span class="uo-kicker">{level}{node.manifest && "number" in node.manifest && node.manifest.number ? ` ${node.manifest.number}` : ""}</span>
        <h2>{node.title}</h2>
        {#if scene?.manifest?.heading}<p class="uo-heading">{scene.manifest.heading}</p>{/if}
        <dl class="uo-facts">
          <div><dt>cut</dt><dd>{node.status.cut.exists ? `revision ${node.status.cut.revision} · ${clock(node.status.cut.seconds)}` : "none yet"}</dd></div>
          {#if scene}<div><dt>shots</dt><dd>{scene.shots.length}</dd></div>{/if}
          <div><dt>address</dt><dd>{node.key}</dd></div>
        </dl>
      </div>
      <div class="uo-actions">
        <StateChip state={node.status.state} />
        <button class="uo-btn" onclick={() => studio.show("cut")}>Open cut</button>
        {#if rendering}
          <button class="uo-btn" onclick={() => film.stopRender()}>Stop render</button>
        {:else}
          <button class="uo-btn uo-primary" disabled={node.status.cut.frames === 0 || node.status.state === "current"} onclick={() => film.render(unit, { quality: "final" })}>Render</button>
        {/if}
      </div>
    </header>

    <p class="uo-reason" data-state={node.status.state}>{node.status.reason}</p>

    {#if film.notice}
      <p class="uo-notice" class:uo-error={film.notice.tone === "error"} role={film.notice.tone === "error" ? "alert" : "status"}>{film.notice.text}</p>
    {/if}

    <div class="uo-columns">
      <div class="uo-main">
        {#if node.renderUrl}
          <section aria-label="The {level}'s render">
            <!-- svelte-ignore a11y_media_has_caption -->
            <video class="uo-video" src={gatewayUrl(node.renderUrl)} poster={gatewayUrl(node.posterUrl) ?? undefined} controls preload="metadata"></video>
            <p class="uo-caption">
              {node.render?.quality} render <span class="uo-mono">{node.render?.renderId}</span>
              {#if !node.render?.fresh}— made before the last change to the cut or its sources{/if}
            </p>
          </section>
        {/if}

        {#if scene}
          <section aria-labelledby="uo-shots-title">
            <h3 id="uo-shots-title">Shots, in cutting order</h3>
            {#if scene.shots.length === 0}
              <p class="uo-note">No shot yet. A scene is cut from its shots.</p>
            {:else}
              <table class="uo-table">
                <thead>
                  <tr><th></th><th>shot</th><th>framing</th><th>from</th><th class="num">length</th><th>state</th><th><span class="sr-only">order</span></th></tr>
                </thead>
                <tbody>
                  {#each scene.shots as shot, index (shot.slug)}
                    <tr>
                      <td class="uo-thumb">
                        {#if shot.posterUrl}<img src={gatewayUrl(shot.posterUrl)} alt="" loading="lazy" />{:else}<span></span>{/if}
                      </td>
                      <td>
                        <button class="uo-link" onclick={() => library.select(unit.film, unit.scene, shot.slug)}>{shot.title}</button>
                        <span class="uo-sub uo-mono">{shot.slug}</span>
                      </td>
                      <td class="uo-dim">{[shot.manifest?.size, shot.manifest?.angle, shot.manifest?.movement, shot.manifest?.lens].filter(Boolean).join(" · ") || "—"}</td>
                      <td class="uo-dim">{shot.manifest?.source ?? "—"}</td>
                      <td class="num uo-mono">{clock(shot.status.cut.seconds || shot.manifest?.durationSeconds || 0)}</td>
                      <td><StateChip state={shot.status.state} title={shot.status.reason} /></td>
                      <td class="uo-move">
                        <button aria-label="Move {shot.title} earlier" disabled={index === 0} onclick={() => film.move(sceneUnit, shot.slug, -1)}>↑</button>
                        <button aria-label="Move {shot.title} later" disabled={index === scene.shots.length - 1} onclick={() => film.move(sceneUnit, shot.slug, 1)}>↓</button>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {/if}
            {#each scene.missingShots as missing (missing)}
              <p class="uo-problem">✕ <span class="uo-mono">{missing}</span> — scene.yaml names this shot and it is not on disk</p>
            {/each}

            {#if adding}
              <form class="uo-add" onsubmit={createShot}>
                <!-- svelte-ignore a11y_autofocus -->
                <input bind:value={draft.title} placeholder="What the shot is" aria-label="Shot title" autofocus required />
                <input bind:value={draft.slug} oninput={() => (slugTouched = true)} class="uo-mono" placeholder="slug" aria-label="Shot slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" />
                <select bind:value={draft.source} aria-label="Where its picture comes from">
                  {#each SHOT_SOURCES as source (source)}<option value={source}>{source}</option>{/each}
                </select>
                <button type="submit" class="uo-btn uo-primary">Add shot</button>
                <button type="button" class="uo-btn" onclick={() => (adding = false)}>Cancel</button>
              </form>
            {:else}
              <button class="uo-btn" onclick={() => (adding = true)}>+ Shot</button>
            {/if}
          </section>
        {:else}
          <section aria-labelledby="uo-takes-title">
            <h3 id="uo-takes-title">Takes</h3>
            <p class="uo-note">
              What was made or brought in for this shot, under its <code>assets/</code>. Putting one in the cut replaces the shot's picture with it.
            </p>
            {#if takeNotice}
              <p class="uo-notice" class:uo-error={takeNotice.tone === "error"} role={takeNotice.tone === "error" ? "alert" : "status"}>{takeNotice.text}</p>
            {/if}
            {#if files.loading}
              <p class="uo-note" role="status">Reading the shot's files…</p>
            {:else if takes.length === 0}
              <p class="uo-note">No media yet. Ask the agent to make the shot, upload a file, or cut it from the film's footage.</p>
            {:else}
              <ul class="uo-takes">
                {#each takes as take (take.path)}
                  {@const used = usedPaths.has(take.path)}
                  <li class="uo-take" class:used>
                    <div class="uo-take-media">
                      {#if VIDEO.test(take.name)}
                        <!-- svelte-ignore a11y_media_has_caption -->
                        <video src={files.mediaUrl(take.path)} preload="metadata" controls></video>
                      {:else if IMAGE.test(take.name)}
                        <img src={files.mediaUrl(take.path)} alt={take.name} loading="lazy" />
                      {:else}
                        <audio src={files.mediaUrl(take.path)} controls preload="none"></audio>
                      {/if}
                    </div>
                    <div class="uo-take-meta">
                      <button class="uo-link uo-mono" onclick={() => openFile(take.path)}>{take.path.replace(/^assets\//, "")}</button>
                      <span class="uo-sub">{bytes(take.size)} · {new Date(take.updatedAt).toLocaleString()}</span>
                    </div>
                    <div class="uo-take-actions">
                      {#if used}
                        <span class="uo-in-cut">● in the cut</span>
                      {:else if PICTURE.test(take.name)}
                        <button class="uo-btn" onclick={() => useTake(take.path)}>Use in cut</button>
                      {/if}
                    </div>
                  </li>
                {/each}
              </ul>
            {/if}
          </section>
        {/if}
      </div>

      <div class="uo-side">
        <section aria-labelledby="uo-plan-title">
          <h3 id="uo-plan-title">{level === "scene" ? "The scene" : "The shot"}</h3>
          <ManifestForm {unit} {level} manifest={node.manifest as Record<string, unknown> | null} problems={node.manifestProblems} />
        </section>
        {#if level === "scene"}
          <StylePanel project={unit.film} series={unit.scene} context={{ title: node.title, idea: scene?.manifest?.summary }} />
        {/if}
        <ControlPanel {unit} {level} />
      </div>
    </div>
  </div>
{/if}

<style>
  .unit-overview {
    overflow-y: auto;
    padding: var(--vs-space-5);
    display: flex;
    flex-direction: column;
    gap: var(--vs-space-3);
  }

  .uo-empty {
    margin: auto;
    padding: var(--vs-space-5);
    font-size: var(--vs-text-sm);
    color: var(--vs-text-tertiary);
  }

  .uo-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--vs-space-4);
    flex-wrap: wrap;
  }

  .uo-kicker {
    font-size: var(--vs-text-xs);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--vs-text-tertiary);
  }

  .uo-head h2 {
    margin: 2px 0 0;
    font-size: var(--vs-text-xl);
    font-weight: var(--vs-font-weight-semibold);
    line-height: var(--vs-leading-tight);
  }

  .uo-heading {
    margin: var(--vs-space-1) 0 0;
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-sm);
    color: var(--vs-text-secondary);
  }

  .uo-facts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--vs-space-1) var(--vs-space-5);
    margin: var(--vs-space-2) 0 0;
  }

  .uo-facts div {
    display: flex;
    align-items: baseline;
    gap: var(--vs-space-2);
  }

  .uo-facts dt {
    font-size: var(--vs-text-xs);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--vs-text-tertiary);
  }

  .uo-facts dd {
    margin: 0;
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-sm);
  }

  .uo-actions {
    display: flex;
    align-items: center;
    gap: var(--vs-space-2);
  }

  .uo-btn {
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

  .uo-btn:hover:not(:disabled) { background: var(--vs-bg-hover); }
  .uo-btn:disabled { opacity: 0.5; cursor: default; }

  .uo-primary {
    background: var(--vs-accent-strong);
    border-color: var(--vs-accent-strong);
    color: var(--vs-accent-text);
  }

  .uo-primary:hover:not(:disabled) { background: var(--vs-accent-strong-hover); }

  .uo-reason {
    margin: 0;
    font-size: var(--vs-text-sm);
    color: var(--vs-text-secondary);
  }

  .uo-reason[data-state="blocked"],
  .uo-reason[data-state="invalid-cut"] {
    color: var(--vs-state-blocked);
  }

  .uo-notice {
    margin: 0;
    padding: var(--vs-space-2) var(--vs-space-3);
    background: var(--vs-bg-raised);
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-md);
    font-size: var(--vs-text-sm);
    color: var(--vs-text-secondary);
  }

  .uo-error {
    background: var(--vs-state-blocked-bg);
    color: var(--vs-state-blocked);
  }

  .uo-columns {
    display: grid;
    grid-template-columns: minmax(0, 1.25fr) minmax(320px, 1fr);
    gap: var(--vs-space-6);
    align-items: start;
  }

  .uo-main,
  .uo-side {
    display: flex;
    flex-direction: column;
    gap: var(--vs-space-5);
    min-width: 0;
  }

  h3 {
    margin: 0 0 var(--vs-space-2);
    font-size: var(--vs-text-xs);
    font-weight: var(--vs-font-weight-semibold);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--vs-text-tertiary);
  }

  .uo-video {
    display: block;
    width: 100%;
    max-height: 46vh;
    background: oklch(0% 0 0);
    border-radius: var(--vs-radius-sm);
  }

  .uo-caption,
  .uo-note {
    margin: var(--vs-space-1) 0 var(--vs-space-2);
    font-size: var(--vs-text-xs);
    color: var(--vs-text-tertiary);
  }

  .uo-mono {
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-xs);
  }

  .uo-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--vs-text-sm);
    margin-bottom: var(--vs-space-3);
  }

  .uo-table th {
    padding: var(--vs-space-1) var(--vs-space-2);
    border-bottom: 1px solid var(--vs-border);
    font-size: var(--vs-text-xs);
    font-weight: var(--vs-font-weight-medium);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    text-align: left;
    color: var(--vs-text-tertiary);
  }

  .uo-table td {
    padding: var(--vs-space-2);
    border-bottom: 1px solid var(--vs-border-subtle);
    vertical-align: middle;
  }

  .num { text-align: right; }

  .uo-thumb {
    width: 72px;
  }

  .uo-thumb img,
  .uo-thumb span {
    display: block;
    width: 64px;
    aspect-ratio: 16 / 9;
    object-fit: cover;
    background: var(--vs-bg-inset);
    border: 1px solid var(--vs-border);
    border-radius: 2px;
  }

  .uo-link {
    padding: 0;
    background: none;
    border: none;
    color: var(--vs-text-primary);
    font: inherit;
    font-weight: var(--vs-font-weight-medium);
    text-align: left;
    cursor: pointer;
  }

  .uo-link:hover {
    color: var(--vs-accent-strong);
    text-decoration: underline;
  }

  .uo-sub {
    display: block;
    color: var(--vs-text-tertiary);
    font-size: var(--vs-text-xs);
  }

  .uo-dim { color: var(--vs-text-secondary); }

  .uo-move {
    white-space: nowrap;
    text-align: right;
  }

  .uo-move button {
    width: 22px;
    height: 22px;
    padding: 0;
    background: none;
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-secondary);
    font-size: var(--vs-text-xs);
    cursor: pointer;
  }

  .uo-move button:hover:not(:disabled) { background: var(--vs-bg-hover); }
  .uo-move button:disabled { opacity: 0.35; cursor: default; }

  .uo-problem {
    margin: 0 0 var(--vs-space-2);
    font-size: var(--vs-text-xs);
    color: var(--vs-state-blocked);
  }

  .uo-add {
    display: flex;
    flex-wrap: wrap;
    gap: var(--vs-space-2);
    align-items: center;
  }

  .uo-add input,
  .uo-add select {
    flex: 1;
    min-width: 140px;
    padding: 5px var(--vs-space-2);
    background: var(--vs-bg-inset);
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-primary);
    font: inherit;
    font-size: var(--vs-text-sm);
  }

  .uo-add input:focus,
  .uo-add select:focus {
    outline: none;
    border-color: var(--vs-border-focus);
  }

  .uo-takes {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: var(--vs-space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .uo-take {
    display: flex;
    flex-direction: column;
    gap: var(--vs-space-1);
    padding-bottom: var(--vs-space-2);
    border-bottom: 1px solid var(--vs-border-subtle);
  }

  .uo-take-media video,
  .uo-take-media img {
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    object-fit: contain;
    background: oklch(0% 0 0);
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
  }

  .uo-take.used .uo-take-media video,
  .uo-take.used .uo-take-media img {
    border-color: var(--vs-state-current);
  }

  .uo-take-media audio {
    width: 100%;
  }

  .uo-take-actions {
    min-height: 28px;
    display: flex;
    align-items: center;
  }

  .uo-in-cut {
    font-size: var(--vs-text-xs);
    color: var(--vs-state-current);
  }

  code {
    font-family: var(--vs-font-mono);
    font-size: 0.95em;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  @media (max-width: 1100px) {
    .uo-columns {
      grid-template-columns: 1fr;
    }
  }
</style>
