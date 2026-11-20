<script lang="ts">
  /**
   * The film at a glance: its scenes in running order, each with its shots,
   * and where every one of them stands.
   *
   * It is a stripboard, not a dashboard. Order is the film's own order; a
   * unit's state is beside its name; what stands between the film and its
   * render is stated first, as a list that can be acted on. Nothing here is a
   * summary of something shown elsewhere.
   */
  import { film } from "$lib/film-store.svelte.ts";
  import { library } from "$lib/library-store.svelte.ts";
  import { studio } from "$lib/studio-store.svelte.ts";
  import { gatewayUrl } from "$lib/film-api";
  import { clock, formatRuntime, nextNumber, slugify } from "$lib/film-format";
  import { RENDER_STATE_LABELS, RENDER_STATE_TONE, type RenderState, type SceneNode } from "$lib/film-types";
  import { SHOT_SOURCES, SHOT_SOURCE_DESCRIPTIONS, type ShotSource } from "@studio/contracts/src/film.mjs";
  import StateChip from "./StateChip.svelte";
  import ControlPanel from "./ControlPanel.svelte";
  import StylePanel from "../style/StylePanel.svelte";

  const tree = $derived(film.tree);

  const STATE_ORDER: RenderState[] = ["current", "preview", "not-rendered", "stale", "blocked", "invalid-cut", "no-cut"];

  const units = $derived(tree ? tree.totals.scenes + tree.totals.shots : 0);

  /** The scenes grouped as the film's sequences group them, in running order. */
  const sequences = $derived.by(() => {
    const groups: { id: string | null; title: string; act: string | null; scenes: SceneNode[]; seconds: number }[] = [];
    for (const scene of tree?.scenes ?? []) {
      let group = groups[groups.length - 1];
      if (!group || group.id !== scene.sequence) {
        const declared = tree?.manifest?.sequences?.find((s) => s.id === scene.sequence);
        group = { id: scene.sequence, title: declared?.title ?? scene.sequence ?? "Not in a sequence", act: scene.act, scenes: [], seconds: 0 };
        groups.push(group);
      }
      group.scenes.push(scene);
      group.seconds += scene.status.cut.seconds;
    }
    return groups;
  });

  const filmUnit = $derived(tree ? { film: tree.slug, scene: "_", shot: "_" } : null);

  /* What is being added, and where: one form at a time. */
  let adding = $state<{ kind: "scene" } | { kind: "shot"; scene: string } | null>(null);
  let draft = $state({ title: "", slug: "", sequence: "", source: "generated" as ShotSource });
  let slugTouched = $state(false);

  function startScene() {
    adding = { kind: "scene" };
    draft = { title: "", slug: "", sequence: tree?.scenes.at(-1)?.sequence ?? "", source: "generated" };
    slugTouched = false;
  }

  function startShot(scene: SceneNode) {
    adding = { kind: "shot", scene: scene.slug };
    draft = { title: "", slug: "", sequence: "", source: "generated" };
    slugTouched = false;
  }

  /* The slug follows the title until the person writes their own. */
  $effect(() => {
    if (!adding || slugTouched) return;
    const siblings = adding.kind === "scene"
      ? (tree?.scenes.map((s) => s.slug) ?? [])
      : (film.scene(adding.scene)?.shots.map((s) => s.slug) ?? []);
    const words = slugify(draft.title);
    draft.slug = words ? `${nextNumber(siblings)}-${words}`.slice(0, 64) : "";
  });

  async function create(event: SubmitEvent) {
    event.preventDefault();
    if (!adding || !draft.title.trim() || !draft.slug) return;
    const made = adding.kind === "scene"
      ? await film.createScene({ slug: draft.slug, title: draft.title.trim(), ...(draft.sequence.trim() ? { sequence: slugify(draft.sequence), sequenceTitle: draft.sequence.trim() } : {}) })
      : await film.createShot(adding.scene, { slug: draft.slug, title: draft.title.trim(), source: draft.source });
    if (made) adding = null;
  }

  function openUnit(key: string) {
    const [channel, series, episode] = key.split("/");
    if (!channel || !series || !episode) return;
    if (series === "_") library.selectChannel(channel);
    else if (episode === "_") library.selectSeries(channel, series);
    else library.select(channel, series, episode);
  }

  function openCut() {
    studio.show("cut");
  }

  const rendering = $derived(film.rendering);
  const progress = $derived(rendering?.progress ?? null);
</script>

{#if !tree}
  <div class="fb-empty" role={film.error ? "alert" : "status"}>
    {film.error ?? (film.loading ? "Reading the film…" : "No film loaded.")}
  </div>
{:else}
  <div class="film-board">
    <header class="fb-head">
      <div class="fb-identity">
        <span class="fb-kicker">Film</span>
        <h2>{tree.title}</h2>
        {#if tree.manifest?.logline}
          <p class="fb-logline">{tree.manifest.logline}</p>
        {/if}
        <dl class="fb-facts">
          {#if tree.manifest?.format}
            <div><dt>format</dt><dd>{tree.manifest.format.width}×{tree.manifest.format.height} · {tree.manifest.format.fps} fps</dd></div>
          {/if}
          <div>
            <dt>runs</dt>
            <dd>
              {formatRuntime(tree.totals.seconds)}
              {#if tree.manifest?.runtimeTargetSeconds}
                <span class="fb-of">of {formatRuntime(tree.manifest.runtimeTargetSeconds)} planned</span>
              {/if}
            </dd>
          </div>
          <div><dt>scenes</dt><dd>{tree.totals.scenes}</dd></div>
          <div><dt>shots</dt><dd>{tree.totals.shots}</dd></div>
        </dl>
      </div>

      <div class="fb-actions">
        <StateChip state={tree.status.state} title={tree.status.reason} />
        {#if rendering}
          <button class="fb-btn" onclick={() => film.stopRender()}>Stop render</button>
        {:else}
          <button class="fb-btn" onclick={() => filmUnit && film.render(filmUnit, { quality: "preview" })} disabled={tree.status.cut.frames === 0} title="Render everything that changed, small and fast">Preview</button>
          <button class="fb-btn fb-primary" onclick={() => filmUnit && film.render(filmUnit, { quality: "final" })} disabled={tree.status.cut.frames === 0 || tree.status.state === "current"} title={tree.status.state === "current" ? "The film's render is current" : "Render every shot and scene that changed, then the film"}>Render film</button>
        {/if}
        <button class="fb-btn" onclick={openCut}>Open cut</button>
      </div>
    </header>

    {#if units > 0}
      <div class="fb-progress" role="img" aria-label={STATE_ORDER.filter((s) => tree.totals.byState[s] > 0).map((s) => `${tree.totals.byState[s]} ${RENDER_STATE_LABELS[s]}`).join(", ")}>
        <div class="fb-bar">
          {#each STATE_ORDER as state (state)}
            {#if tree.totals.byState[state] > 0}
              <span class="fb-seg" data-tone={RENDER_STATE_TONE[state]} style="flex: {tree.totals.byState[state]}"></span>
            {/if}
          {/each}
        </div>
        <ul class="fb-legend">
          {#each STATE_ORDER as state (state)}
            {#if tree.totals.byState[state] > 0}
              <li><StateChip {state} /> <span class="fb-count">{tree.totals.byState[state]}</span></li>
            {/if}
          {/each}
        </ul>
      </div>
    {/if}

    {#if rendering}
      <div class="fb-notice fb-running" role="status">
        <strong>Rendering {rendering.quality}</strong>
        <span class="fb-mono">{progress?.unit ?? rendering.unit}</span>
        {#if progress}
          <span>{progress.phase} {progress.done}/{progress.total}</span>
          <progress value={progress.done} max={Math.max(1, progress.total)}></progress>
        {/if}
      </div>
    {:else if film.lastRender && film.lastRender.kind !== "progress"}
      <div class="fb-notice" class:fb-error={film.lastRender.kind === "failed"} role={film.lastRender.kind === "failed" ? "alert" : "status"}>
        <strong>{film.lastRender.kind === "failed" ? "Render failed" : "Render finished"}</strong>
        <span class="fb-mono">{film.lastRender.unit}</span>
        <span>{film.lastRender.message}</span>
      </div>
    {/if}

    {#if film.notice}
      <div class="fb-notice" class:fb-error={film.notice.tone === "error"} role={film.notice.tone === "error" ? "alert" : "status"}>{film.notice.text}</div>
    {/if}

    {#if tree.next.length > 0}
      <section class="fb-next" aria-labelledby="fb-next-title">
        <h3 id="fb-next-title">Between the film and its render</h3>
        <ol>
          {#each tree.next.slice(0, 6) as step (step.unit)}
            <li>
              <StateChip state={step.state} compact />
              <button class="fb-link fb-mono" onclick={() => openUnit(step.unit)}>{step.unit.replace(/\/_/g, "")}</button>
              <span class="fb-todo">{step.todo}</span>
            </li>
          {/each}
        </ol>
        {#if tree.next.length > 6}
          <p class="fb-more">and {tree.next.length - 6} more</p>
        {/if}
      </section>
    {/if}

    <section class="fb-strip" aria-label="Scenes in running order">
      {#each sequences as sequence, s (sequence.id ?? `none-${s}`)}
        <div class="fb-sequence">
          <h3>
            {#if sequence.act}<span class="fb-act">Act {sequence.act}</span>{/if}
            <span>{sequence.title}</span>
            <span class="fb-seq-meta">{sequence.scenes.length} scene{sequence.scenes.length === 1 ? "" : "s"} · {clock(sequence.seconds)}</span>
          </h3>

          {#each sequence.scenes as scene (scene.slug)}
            {@const index = tree.scenes.indexOf(scene)}
            <article class="fb-scene">
              <header class="fb-scene-head">
                <span class="fb-number">{scene.manifest?.number ?? index + 1}</span>
                <div class="fb-scene-title">
                  <button class="fb-link fb-scene-name" onclick={() => library.selectSeries(tree.slug, scene.slug)}>{scene.title}</button>
                  {#if scene.manifest?.heading}<span class="fb-heading">{scene.manifest.heading}</span>{/if}
                </div>
                <span class="fb-length">{clock(scene.status.cut.seconds)}</span>
                <StateChip state={scene.status.state} title={scene.status.reason} />
                <div class="fb-move">
                  <button aria-label="Move {scene.title} earlier" disabled={index === 0} onclick={() => filmUnit && film.move(filmUnit, scene.slug, -1)}>↑</button>
                  <button aria-label="Move {scene.title} later" disabled={index === tree.scenes.length - 1} onclick={() => filmUnit && film.move(filmUnit, scene.slug, 1)}>↓</button>
                </div>
              </header>
              {#if scene.manifest?.summary}
                <p class="fb-summary">{scene.manifest.summary}</p>
              {/if}

              <ul class="fb-shots" aria-label="Shots of {scene.title}">
                {#each scene.shots as shot (shot.slug)}
                  <li>
                    <button class="fb-shot" onclick={() => library.select(tree.slug, scene.slug, shot.slug)} title={shot.status.reason}>
                      <span class="fb-poster" data-tone={RENDER_STATE_TONE[shot.status.state]}>
                        {#if shot.posterUrl}
                          <img src={gatewayUrl(shot.posterUrl)} alt="" loading="lazy" />
                        {:else}
                          <span class="fb-poster-none">{shot.manifest?.source ?? "shot"}</span>
                        {/if}
                        {#if shot.status.cut.seconds > 0}<span class="fb-poster-time">{clock(shot.status.cut.seconds)}</span>{/if}
                      </span>
                      <span class="fb-shot-name">{shot.title}</span>
                      <span class="fb-shot-meta">
                        <StateChip state={shot.status.state} compact />
                        <span class="fb-mono">{shot.slug}</span>
                        {#if shot.manifest?.size}<span>· {shot.manifest.size}</span>{/if}
                      </span>
                    </button>
                  </li>
                {/each}
                {#each scene.missingShots as missing (missing)}
                  <li class="fb-missing" title="scene.yaml names this shot and it is not on disk">✕ {missing}</li>
                {/each}
                <li>
                  {#if adding?.kind === "shot" && adding.scene === scene.slug}
                    <form class="fb-add-form" onsubmit={create}>
                      <!-- svelte-ignore a11y_autofocus -->
                      <input bind:value={draft.title} placeholder="What the shot is" aria-label="Shot title" autofocus required />
                      <input bind:value={draft.slug} oninput={() => (slugTouched = true)} placeholder="slug" aria-label="Shot slug" class="fb-mono" required pattern="[a-z0-9]+(-[a-z0-9]+)*" />
                      <select bind:value={draft.source} aria-label="Where its picture comes from" title={SHOT_SOURCE_DESCRIPTIONS[draft.source]}>
                        {#each SHOT_SOURCES as source (source)}<option value={source}>{source}</option>{/each}
                      </select>
                      <div class="fb-add-actions">
                        <button type="submit" class="fb-btn fb-primary">Add shot</button>
                        <button type="button" class="fb-btn" onclick={() => (adding = null)}>Cancel</button>
                      </div>
                    </form>
                  {:else}
                    <button class="fb-add" onclick={() => startShot(scene)}>+ Shot</button>
                  {/if}
                </li>
              </ul>
            </article>
          {/each}
        </div>
      {/each}

      {#each tree.missingScenes as missing (missing)}
        <p class="fb-missing">✕ {missing} — film.yaml names this scene and it is not on disk</p>
      {/each}

      {#if adding?.kind === "scene"}
        <form class="fb-add-form fb-add-scene" onsubmit={create}>
          <!-- svelte-ignore a11y_autofocus -->
          <input bind:value={draft.title} placeholder="Scene title" aria-label="Scene title" autofocus required />
          <input bind:value={draft.slug} oninput={() => (slugTouched = true)} placeholder="slug" aria-label="Scene slug" class="fb-mono" required pattern="[a-z0-9]+(-[a-z0-9]+)*" />
          <input bind:value={draft.sequence} placeholder="Sequence (optional)" aria-label="Sequence" list="fb-sequences" />
          <datalist id="fb-sequences">
            {#each tree.manifest?.sequences ?? [] as sequence (sequence.id)}<option value={sequence.id}>{sequence.title ?? sequence.id}</option>{/each}
          </datalist>
          <div class="fb-add-actions">
            <button type="submit" class="fb-btn fb-primary">Add scene</button>
            <button type="button" class="fb-btn" onclick={() => (adding = null)}>Cancel</button>
          </div>
        </form>
      {:else}
        <button class="fb-add fb-add-wide" onclick={startScene}>+ Scene</button>
      {/if}
    </section>

    {#if filmUnit}
      <StylePanel project={filmUnit.film} context={{ title: tree.title, idea: tree.manifest?.logline ?? tree.manifest?.synopsis }} />
      <ControlPanel unit={filmUnit} level="film" />
    {/if}
  </div>
{/if}

<style>
  .film-board {
    overflow-y: auto;
    padding: var(--vs-space-5);
    display: flex;
    flex-direction: column;
    gap: var(--vs-space-4);
  }

  .fb-empty {
    margin: auto;
    padding: var(--vs-space-5);
    color: var(--vs-text-tertiary);
    font-size: var(--vs-text-sm);
  }

  .fb-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--vs-space-5);
    flex-wrap: wrap;
  }

  .fb-kicker {
    font-size: var(--vs-text-xs);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--vs-text-tertiary);
  }

  .fb-head h2 {
    margin: 2px 0 0;
    font-size: var(--vs-text-xl);
    font-weight: var(--vs-font-weight-semibold);
    line-height: var(--vs-leading-tight);
  }

  .fb-logline {
    margin: var(--vs-space-2) 0 0;
    max-width: 68ch;
    color: var(--vs-text-secondary);
    font-size: var(--vs-text-base);
    line-height: var(--vs-leading-normal);
  }

  .fb-facts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--vs-space-2) var(--vs-space-5);
    margin: var(--vs-space-3) 0 0;
  }

  .fb-facts div {
    display: flex;
    gap: var(--vs-space-2);
    align-items: baseline;
  }

  .fb-facts dt {
    font-size: var(--vs-text-xs);
    color: var(--vs-text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .fb-facts dd {
    margin: 0;
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-sm);
  }

  .fb-of {
    color: var(--vs-text-tertiary);
  }

  .fb-actions {
    display: flex;
    align-items: center;
    gap: var(--vs-space-2);
    flex-wrap: wrap;
  }

  .fb-btn {
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

  .fb-btn:hover:not(:disabled) {
    background: var(--vs-bg-hover);
  }

  .fb-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .fb-primary {
    background: var(--vs-accent-strong);
    border-color: var(--vs-accent-strong);
    color: var(--vs-accent-text);
    font-weight: var(--vs-font-weight-medium);
  }

  .fb-primary:hover:not(:disabled) {
    background: var(--vs-accent-strong-hover);
  }

  .fb-progress {
    display: flex;
    flex-direction: column;
    gap: var(--vs-space-2);
  }

  .fb-bar {
    display: flex;
    gap: 2px;
    height: 6px;
    border-radius: 3px;
    overflow: hidden;
    background: var(--vs-bg-inset);
  }

  .fb-seg { background: var(--vs-text-disabled); }
  .fb-seg[data-tone="current"] { background: var(--vs-state-current); }
  .fb-seg[data-tone="running"] { background: var(--vs-state-running); }
  .fb-seg[data-tone="attention"] { background: var(--vs-state-attention); }
  .fb-seg[data-tone="blocked"] { background: var(--vs-state-blocked); }
  .fb-seg[data-tone="stale"] { background: var(--vs-state-stale); }

  .fb-legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--vs-space-1) var(--vs-space-4);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .fb-legend li {
    display: inline-flex;
    align-items: center;
    gap: var(--vs-space-1);
  }

  .fb-count {
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-xs);
    color: var(--vs-text-secondary);
  }

  .fb-notice {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--vs-space-3);
    padding: var(--vs-space-2) var(--vs-space-3);
    background: var(--vs-bg-raised);
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-md);
    font-size: var(--vs-text-sm);
    color: var(--vs-text-secondary);
  }

  .fb-running {
    background: var(--vs-state-running-bg);
    color: var(--vs-text-primary);
  }

  .fb-running progress {
    flex: 1;
    min-width: 120px;
    height: 6px;
    accent-color: var(--vs-state-running);
  }

  .fb-error {
    background: var(--vs-state-blocked-bg);
    color: var(--vs-state-blocked);
  }

  .fb-mono {
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-xs);
  }

  .fb-next h3,
  .fb-sequence h3 {
    margin: 0 0 var(--vs-space-2);
    font-size: var(--vs-text-xs);
    font-weight: var(--vs-font-weight-semibold);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--vs-text-tertiary);
  }

  .fb-next ol {
    margin: 0;
    padding: 0;
    list-style: none;
    border-top: 1px solid var(--vs-border-subtle);
  }

  .fb-next li {
    display: grid;
    grid-template-columns: 16px minmax(120px, max-content) 1fr;
    align-items: baseline;
    gap: var(--vs-space-3);
    padding: 6px 0;
    border-bottom: 1px solid var(--vs-border-subtle);
    font-size: var(--vs-text-sm);
  }

  .fb-todo {
    color: var(--vs-text-secondary);
  }

  .fb-more {
    margin: var(--vs-space-2) 0 0;
    font-size: var(--vs-text-xs);
    color: var(--vs-text-tertiary);
  }

  .fb-link {
    padding: 0;
    background: none;
    border: none;
    color: var(--vs-text-primary);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .fb-link:hover {
    color: var(--vs-accent-strong);
    text-decoration: underline;
  }

  .fb-strip {
    display: flex;
    flex-direction: column;
    gap: var(--vs-space-4);
  }

  .fb-sequence h3 {
    display: flex;
    align-items: baseline;
    gap: var(--vs-space-3);
    padding-bottom: var(--vs-space-1);
    border-bottom: 1px solid var(--vs-border);
  }

  .fb-act {
    color: var(--vs-accent-strong);
  }

  .fb-seq-meta {
    margin-left: auto;
    font-family: var(--vs-font-mono);
    font-weight: var(--vs-font-weight-normal);
    letter-spacing: 0;
    text-transform: none;
  }

  .fb-scene {
    padding: var(--vs-space-3) 0;
    border-bottom: 1px solid var(--vs-border-subtle);
  }

  .fb-scene-head {
    display: flex;
    align-items: baseline;
    gap: var(--vs-space-3);
  }

  .fb-number {
    min-width: 2ch;
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-sm);
    color: var(--vs-text-tertiary);
    text-align: right;
  }

  .fb-scene-title {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: var(--vs-space-3);
    flex-wrap: wrap;
  }

  .fb-scene-name {
    font-size: var(--vs-text-md);
    font-weight: var(--vs-font-weight-semibold);
  }

  .fb-heading {
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-xs);
    color: var(--vs-text-tertiary);
  }

  .fb-length {
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-sm);
    color: var(--vs-text-secondary);
  }

  .fb-move {
    display: flex;
    gap: 2px;
  }

  .fb-move button {
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

  .fb-move button:hover:not(:disabled) {
    background: var(--vs-bg-hover);
    color: var(--vs-text-primary);
  }

  .fb-move button:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .fb-summary {
    margin: var(--vs-space-1) 0 0 calc(2ch + var(--vs-space-3));
    max-width: 72ch;
    font-size: var(--vs-text-sm);
    color: var(--vs-text-secondary);
  }

  .fb-shots {
    display: flex;
    flex-wrap: wrap;
    gap: var(--vs-space-3);
    margin: var(--vs-space-3) 0 0 calc(2ch + var(--vs-space-3));
    padding: 0;
    list-style: none;
  }

  .fb-shot {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 152px;
    padding: 0;
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .fb-poster {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    aspect-ratio: 16 / 9;
    background: var(--vs-bg-inset);
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
    overflow: hidden;
  }

  .fb-shot:hover .fb-poster,
  .fb-shot:focus-visible .fb-poster {
    border-color: var(--vs-border-focus);
  }

  .fb-poster img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .fb-poster-none {
    font-size: var(--vs-text-xs);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--vs-text-disabled);
  }

  .fb-poster-time {
    position: absolute;
    right: 4px;
    bottom: 4px;
    padding: 0 4px;
    background: oklch(0% 0 0 / 0.7);
    border-radius: 2px;
    color: oklch(100% 0 0);
    font-family: var(--vs-font-mono);
    font-size: 10px;
  }

  .fb-shot-name {
    font-size: var(--vs-text-sm);
    font-weight: var(--vs-font-weight-medium);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .fb-shot-meta {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: var(--vs-text-xs);
    color: var(--vs-text-tertiary);
    overflow: hidden;
    white-space: nowrap;
  }

  .fb-add {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 152px;
    aspect-ratio: 16 / 9;
    background: none;
    border: 1px dashed var(--vs-border);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-tertiary);
    font: inherit;
    font-size: var(--vs-text-sm);
    cursor: pointer;
  }

  .fb-add:hover {
    border-color: var(--vs-border-focus);
    color: var(--vs-text-primary);
  }

  .fb-add-wide {
    width: 100%;
    aspect-ratio: auto;
    padding: var(--vs-space-3);
  }

  .fb-add-form {
    display: flex;
    flex-direction: column;
    gap: var(--vs-space-1);
    width: 240px;
  }

  .fb-add-scene {
    flex-direction: row;
    flex-wrap: wrap;
    width: auto;
    align-items: center;
    gap: var(--vs-space-2);
  }

  .fb-add-scene input {
    flex: 1;
    min-width: 160px;
  }

  .fb-add-form input,
  .fb-add-form select {
    padding: 5px var(--vs-space-2);
    background: var(--vs-bg-inset);
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-primary);
    font: inherit;
    font-size: var(--vs-text-sm);
  }

  .fb-add-form input:focus,
  .fb-add-form select:focus {
    outline: none;
    border-color: var(--vs-border-focus);
  }

  .fb-add-actions {
    display: flex;
    gap: var(--vs-space-1);
  }

  .fb-missing {
    align-self: center;
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-xs);
    color: var(--vs-state-blocked);
  }
</style>
