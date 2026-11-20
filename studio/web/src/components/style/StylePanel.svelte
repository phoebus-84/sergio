<script lang="ts">
  /**
   * A level's style: none, the one it inherits, or its own — and, when it has
   * its own, every value of it to change.
   *
   * A style is optional. With none, the panel says so and offers the
   * templates; nothing else in the studio waits on it. With its own, each
   * parameter file is edited with the control its values ask for (a colour
   * picker for a palette), the brief is shown as it will read, and the cost of
   * saving is said before the button: every unit that read the style becomes
   * stale, with what was made from it.
   */
  import type { StyleParams, PaletteParams, ValuesParams } from "@studio/contracts/src/style.mjs";
  import { FilmApiError } from "$lib/film-api";
  import {
    changedParams, consequence, draftOf, draftProblems, previewBrief, styleApi,
    type LevelStyle, type StyleSummary,
  } from "$lib/style-edit";
  import PaletteEditor from "./PaletteEditor.svelte";
  import ValuesEditor from "./ValuesEditor.svelte";
  import StylePicker from "./StylePicker.svelte";
  import StyleSwatches from "./StyleSwatches.svelte";

  interface Props {
    project: string;
    /** A series or a scene; `_` or nothing for the channel or the film itself. */
    series?: string | null | undefined;
    /** What the level says of itself, for the brief's {{unit.*}} in the preview. */
    context?: { title?: string | undefined; idea?: string | undefined };
  }

  let { project, series = null, context = {} }: Props = $props();

  let data = $state<LevelStyle | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let notice = $state<{ tone: "ok" | "error"; text: string; lines?: string[] } | null>(null);
  let busy = $state(false);

  let draft = $state<Record<string, StyleParams>>({});
  let brief = $state("");
  let showBrief = $state(false);

  let styles = $state<StyleSummary[]>([]);
  let choosing = $state(false);
  let chosen = $state("");
  let keeping = $state(false);
  let keep = $state({ id: "", title: "" });

  const key = $derived(`${project}/${series ?? "_"}`);
  let loadedFor = "";

  async function load() {
    loading = true;
    error = null;
    try {
      data = await styleApi.read(project, series);
      draft = data.own ? draftOf(data.own.params) : {};
      brief = data.own?.brief ?? "";
    } catch (cause) {
      error = cause instanceof FilmApiError ? cause.message : String(cause);
      data = null;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (key === loadedFor) return;
    loadedFor = key;
    notice = null;
    choosing = false;
    keeping = false;
    void load();
  });

  async function openChooser() {
    choosing = true;
    chosen = "";
    if (styles.length === 0) {
      try {
        styles = await styleApi.list(project);
      } catch (cause) {
        error = cause instanceof FilmApiError ? cause.message : String(cause);
      }
    }
  }

  const own = $derived(data?.own ?? null);
  const order = $derived(own?.template?.parameters ?? Object.keys(draft));
  const changed = $derived(own ? changedParams(own.params, draft, order) : []);
  const briefChanged = $derived(own !== null && brief !== (own.brief ?? ""));
  const problems = $derived(draftProblems(draft));
  const preview = $derived(own ? previewBrief(brief, draft, { ...context, level: data?.level }) : null);
  const blocked = $derived(Object.keys(problems).length > 0 || (preview?.problems.length ?? 0) > 0);
  const dirty = $derived(changed.length > 0 || briefChanged);

  function fail(cause: unknown) {
    const e = cause as FilmApiError;
    notice = {
      tone: "error",
      text: e instanceof FilmApiError ? e.message : String(cause),
      lines: e instanceof FilmApiError ? e.problems.map((p) => `${p.path} ${p.message}`) : [],
    };
  }

  async function apply(body: { style?: string; fromParent?: boolean; replace?: boolean }) {
    busy = true;
    notice = null;
    try {
      const result = await styleApi.apply(project, series, body);
      notice = { tone: "ok", text: `Now reads "${result.template.title}". ${result.units.length} unit(s) under it read it from now on.` };
      choosing = false;
      await load();
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }

  async function save() {
    if (!own || !dirty || blocked) return;
    busy = true;
    notice = null;
    const renewed: string[] = [];
    try {
      for (const id of changed) {
        const out = await styleApi.saveParams(project, series, id, draft[id]!);
        renewed.push(...out.renewed.filter((r) => r.affected.length > 0).map((r) => `${r.unit}: ${r.affected.join(", ")}`));
        renewed.push(...out.failed.map((f) => `${f.unit}: not renewed — ${f.message}`));
      }
      if (briefChanged) {
        const out = await styleApi.saveBrief(project, series, brief);
        renewed.push(...out.renewed.filter((r) => r.affected.length > 0).map((r) => `${r.unit}: ${r.affected.join(", ")}`));
      }
      notice = {
        tone: "ok",
        text: renewed.length > 0 ? "Saved. What read the style must be redone:" : "Saved. Nothing had read the style yet.",
        lines: [...new Set(renewed)],
      };
      await load();
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }

  async function keepAsTemplate(event: SubmitEvent) {
    event.preventDefault();
    if (!keep.id) return;
    busy = true;
    try {
      const saved = await styleApi.keep({ project, ...(series && series !== "_" ? { series } : {}), id: keep.id, ...(keep.title ? { title: keep.title } : {}) });
      notice = { tone: "ok", text: `Kept as the template "${saved.id}". It can be named in any request from now on.` };
      keeping = false;
      styles = [];
    } catch (cause) {
      fail(cause);
    } finally {
      busy = false;
    }
  }

  function discard() {
    if (!own) return;
    draft = draftOf(own.params);
    brief = own.brief ?? "";
  }

  const levelName = $derived(data?.level ?? (series && series !== "_" ? "level" : "project"));
</script>

<section class="style-panel" aria-labelledby="style-title-{key}">
  <h3 id="style-title-{key}">Style</h3>

  {#if loading && !data}
    <p class="sp-note" role="status">Reading…</p>
  {:else if error}
    <p class="sp-note sp-error" role="alert">{error}</p>
  {:else if data}
    {#if !own}
      {#if data.inherited}
        <p class="sp-inherit">
          <StyleSwatches swatches={(data.inherited.params.palette?.kind === "palette" ? (data.inherited.params.palette as PaletteParams).colors : []).map((c) => ({ name: c.name, value: c.value }))} />
          Reads <strong>{data.inherited.template?.title ?? "a style"}</strong> from
          <code>{data.inherited.target.series ? `${data.inherited.target.project}/${data.inherited.target.series}` : data.inherited.target.project}</code>.
          Change it there, or give this {levelName} its own copy to change.
        </p>
        <div class="sp-actions">
          <button class="sp-btn" disabled={busy} onclick={() => apply({ fromParent: true })}>Give it its own copy</button>
          <button class="sp-btn" disabled={busy} onclick={openChooser}>Use another style…</button>
        </div>
      {:else}
        <p class="sp-note">
          No style. That is fine: this {levelName} is made however you and the agent decide. A style is a ready-made look and way of
          making it, if you want one.
        </p>
        {#if !choosing}<div class="sp-actions"><button class="sp-btn" onclick={openChooser}>Choose a style…</button></div>{/if}
      {/if}
    {:else}
      <div class="sp-head">
        <p class="sp-line">
          <strong>{own.template?.title ?? own.binding?.template.id}</strong>
          <span class="sp-mono">{own.binding?.template.id} {own.binding?.template.version} · {own.binding?.template.origin}{own.binding?.copiedFrom ? ` · copied from ${own.binding.copiedFrom}` : ""}</span>
        </p>
        <p class="sp-note">{consequence(own.dependents)}</p>
      </div>

      {#each order as id, index (id)}
        {@const doc = draft[id]}
        {#if doc}
          <details class="sp-param" open={index === 0}>
            <summary>
              {doc.title}
              <span class="sp-mono">params/{id}.json</span>
              {#if changed.includes(id)}<span class="sp-changed">changed</span>{/if}
              {#if problems[id]}<span class="sp-bad">does not hold</span>{/if}
            </summary>
            {#if doc.kind === "palette"}
              <PaletteEditor {id} palette={doc as PaletteParams} onchange={(next) => (draft[id] = next)} />
            {:else}
              <ValuesEditor {id} values={doc as ValuesParams} onchange={(next) => (draft[id] = next)} />
            {/if}
            {#if problems[id]}
              <ul class="sp-problems">{#each problems[id]! as p (p.path + p.code)}<li>{p.path} {p.message}</li>{/each}</ul>
            {/if}
          </details>
        {/if}
      {/each}

      <details class="sp-param" bind:open={showBrief}>
        <summary>The brief, as it reads now {#if briefChanged}<span class="sp-changed">changed</span>{/if}</summary>
        <div class="sp-brief">
          <label class="sp-brief-source">
            <span>STYLE.md — values by <code>{"{{placeholder}}"}</code>, never inline</span>
            <textarea bind:value={brief} rows="14" spellcheck="false"></textarea>
          </label>
          <pre class="sp-preview" aria-label="The brief with every value filled in">{preview?.text}</pre>
        </div>
        {#if preview && preview.problems.length > 0}
          <ul class="sp-problems">{#each preview.problems as p (p.path + p.message)}<li>{p.path}: {p.message}</li>{/each}</ul>
        {/if}
      </details>

      <div class="sp-actions">
        <button class="sp-btn sp-primary" disabled={!dirty || blocked || busy} onclick={save} title={blocked ? "Something does not hold: see above" : consequence(own.dependents)}>
          {busy ? "Saving…" : "Save style"}
        </button>
        <button class="sp-btn" disabled={!dirty || busy} onclick={discard}>Discard changes</button>
        <button class="sp-btn" disabled={busy} onclick={openChooser}>Replace…</button>
        <button class="sp-btn" disabled={busy || dirty} onclick={() => (keeping = !keeping)} title={dirty ? "Save first" : "Keep this style as a template of its own"}>Keep as template…</button>
      </div>

      {#if keeping}
        <form class="sp-keep" onsubmit={keepAsTemplate}>
          <input bind:value={keep.title} placeholder="Its name, e.g. Tide riso" aria-label="Template title" maxlength="80" />
          <input bind:value={keep.id} placeholder="its-id" aria-label="Template id" pattern="[a-z0-9]+(-[a-z0-9]+)*" maxlength="64" required class="sp-mono" />
          <button type="submit" class="sp-btn sp-primary" disabled={busy || !keep.id}>Keep</button>
        </form>
      {/if}
    {/if}

    {#if choosing}
      <div class="sp-choose">
        <StylePicker {styles} bind:value={chosen} level={data.level} noneLabel="Choose a template…" />
        <div class="sp-actions">
          <button class="sp-btn sp-primary" disabled={!chosen || busy} onclick={() => apply({ style: chosen, replace: own !== null })}>
            {own ? "Replace the style" : "Apply"}
          </button>
          <button class="sp-btn" onclick={() => (choosing = false)}>Cancel</button>
        </div>
        {#if own}<p class="sp-note">The style it has is set aside in <code>.style-history/</code>, not deleted. {consequence(own.dependents)}</p>{/if}
      </div>
    {/if}

    {#if notice}
      <div class="sp-notice" class:sp-error={notice.tone === "error"} role={notice.tone === "error" ? "alert" : "status"}>
        {notice.text}
        {#if notice.lines && notice.lines.length > 0}
          <ul>{#each notice.lines as line (line)}<li class="sp-mono">{line}</li>{/each}</ul>
        {/if}
      </div>
    {/if}
  {/if}
</section>

<style>
  .style-panel {
    display: grid;
    gap: var(--vs-space-2);
  }

  .style-panel h3 {
    margin: 0;
    font-size: var(--vs-text-xs);
    font-weight: var(--vs-font-weight-semibold);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--vs-text-tertiary);
  }

  .sp-head {
    display: grid;
    gap: 2px;
  }

  .sp-line {
    display: flex;
    flex-wrap: wrap;
    gap: var(--vs-space-2);
    align-items: baseline;
    margin: 0;
    font-size: var(--vs-text-sm);
  }

  .sp-inherit {
    margin: 0;
    font-size: var(--vs-text-sm);
    line-height: var(--vs-leading-normal);
  }

  .sp-note {
    margin: 0;
    font-size: var(--vs-text-xs);
    color: var(--vs-text-secondary);
    line-height: var(--vs-leading-normal);
  }

  .sp-mono,
  code {
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-xs);
    color: var(--vs-text-tertiary);
  }

  .sp-param {
    border-top: 1px solid var(--vs-border-subtle);
    padding: var(--vs-space-2) 0;
  }

  .sp-param summary {
    display: flex;
    gap: var(--vs-space-2);
    align-items: baseline;
    margin-bottom: var(--vs-space-2);
    font-size: var(--vs-text-sm);
    font-weight: var(--vs-font-weight-medium);
    cursor: pointer;
  }

  .sp-changed {
    font-size: var(--vs-text-xs);
    color: var(--vs-state-stale);
  }

  .sp-bad {
    font-size: var(--vs-text-xs);
    color: var(--vs-state-blocked);
  }

  .sp-problems {
    margin: var(--vs-space-1) 0 0;
    padding-left: var(--vs-space-4);
    font-size: var(--vs-text-xs);
    color: var(--vs-state-blocked);
  }

  .sp-brief {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--vs-space-3);
  }

  .sp-brief-source {
    display: grid;
    gap: var(--vs-space-1);
    font-size: var(--vs-text-xs);
    color: var(--vs-text-secondary);
  }

  .sp-brief textarea {
    min-height: 220px;
    padding: var(--vs-space-2);
    background: var(--vs-bg-inset);
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-primary);
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-xs);
    resize: vertical;
  }

  .sp-preview {
    margin: 0;
    max-height: 360px;
    overflow: auto;
    padding: var(--vs-space-2);
    background: var(--vs-bg-raised);
    border: 1px solid var(--vs-border-subtle);
    border-radius: var(--vs-radius-sm);
    font-family: var(--vs-font-sans);
    font-size: var(--vs-text-xs);
    line-height: var(--vs-leading-normal);
    white-space: pre-wrap;
  }

  .sp-actions,
  .sp-keep {
    display: flex;
    flex-wrap: wrap;
    gap: var(--vs-space-1);
  }

  .sp-keep input {
    padding: 2px 6px;
    background: var(--vs-bg-surface);
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-primary);
    font: inherit;
    font-size: var(--vs-text-sm);
  }

  .sp-choose {
    display: grid;
    gap: var(--vs-space-2);
    padding: var(--vs-space-2);
    background: var(--vs-bg-raised);
    border: 1px solid var(--vs-border-subtle);
    border-radius: var(--vs-radius-md);
  }

  .sp-btn {
    padding: 3px var(--vs-space-2);
    background: none;
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-primary);
    font: inherit;
    font-size: var(--vs-text-xs);
    cursor: pointer;
  }

  .sp-primary {
    background: var(--vs-accent-strong);
    border-color: var(--vs-accent-strong);
    color: var(--vs-accent-text);
  }

  .sp-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .sp-notice {
    padding: var(--vs-space-2);
    background: var(--vs-state-current-bg);
    border-radius: var(--vs-radius-sm);
    font-size: var(--vs-text-xs);
  }

  .sp-notice ul {
    margin: var(--vs-space-1) 0 0;
    padding-left: var(--vs-space-4);
  }

  .sp-error {
    color: var(--vs-state-blocked);
  }

  .sp-notice.sp-error {
    background: var(--vs-state-blocked-bg);
  }

  :is(button, input, textarea, summary):focus-visible {
    outline: 2px solid var(--vs-border-focus);
    outline-offset: 1px;
  }

  @media (max-width: 1100px) {
    .sp-brief {
      grid-template-columns: 1fr;
    }
  }
</style>
