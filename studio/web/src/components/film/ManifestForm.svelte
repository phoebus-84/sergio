<script lang="ts">
  /**
   * A unit's manifest as a form: film.yaml, scene.yaml or shot.yaml edited by
   * what its fields mean instead of as text.
   *
   * The form is drawn from a description of the fields, and the choices of a
   * field are the contract's own lists — so a new size or a new source appears
   * here when the contract gains it. Saving sends only what changed; the
   * gateway writes the file only when the result holds, and what it refuses is
   * shown beside the field it names.
   */
  import { film, type Unit } from "$lib/film-store.svelte.ts";
  import type { FilmLevel, ManifestProblem } from "$lib/film-types";
  import {
    SCENE_SETTINGS, SHOT_ANGLES, SHOT_MOVEMENTS, SHOT_SIZES, SHOT_SOUNDS, SHOT_SOURCES, SHOT_SOURCE_DESCRIPTIONS, validateManifest,
  } from "@studio/contracts/src/film.mjs";

  interface Props {
    unit: Unit;
    level: FilmLevel;
    manifest: Record<string, unknown> | null;
    problems: ManifestProblem[];
  }

  let { unit, level, manifest, problems }: Props = $props();

  type Field =
    | { key: string; label: string; kind: "text" | "textarea" | "number"; help?: string; wide?: boolean; step?: number; unit?: string; mono?: boolean }
    | { key: string; label: string; kind: "select"; options: readonly string[]; help?: string; describe?: Record<string, string> }
    | { key: string; label: string; kind: "list"; help?: string; wide?: boolean }
    | { key: string; label: string; kind: "dialogue"; help?: string; wide: true }
    | { key: string; label: string; kind: "format"; help?: string };

  const FIELDS: Record<FilmLevel, Field[]> = {
    film: [
      { key: "title", label: "Title", kind: "text" },
      { key: "genre", label: "Genre", kind: "text" },
      { key: "logline", label: "Logline", kind: "textarea", wide: true, help: "The film in one or two sentences." },
      { key: "synopsis", label: "Synopsis", kind: "textarea", wide: true },
      { key: "format", label: "Format", kind: "format", help: "What the film is delivered as. Every cut of the film is made in it." },
      { key: "runtimeTargetSeconds", label: "Planned length", kind: "number", unit: "s", step: 1 },
      { key: "language", label: "Language", kind: "text", help: "A language tag: en, it, pt-BR.", mono: true },
    ],
    scene: [
      { key: "title", label: "Title", kind: "text" },
      { key: "number", label: "Number", kind: "text", help: "As the script numbers it: 12, 12A.", mono: true },
      { key: "heading", label: "Heading", kind: "text", wide: true, help: "The slugline: INT. KITCHEN - DAWN.", mono: true },
      { key: "setting", label: "Setting", kind: "select", options: SCENE_SETTINGS },
      { key: "location", label: "Location", kind: "text", help: "A location of the film's locations/." },
      { key: "timeOfDay", label: "Time of day", kind: "text" },
      { key: "durationTargetSeconds", label: "Planned length", kind: "number", unit: "s", step: 0.5 },
      { key: "summary", label: "What happens", kind: "textarea", wide: true, help: "What happens, and what the scene is for." },
      { key: "characters", label: "Characters", kind: "list", wide: true, help: "One per line." },
    ],
    shot: [
      { key: "title", label: "Title", kind: "text" },
      { key: "number", label: "Number", kind: "text", mono: true },
      { key: "source", label: "Picture from", kind: "select", options: SHOT_SOURCES, describe: SHOT_SOURCE_DESCRIPTIONS },
      { key: "durationSeconds", label: "Planned length", kind: "number", unit: "s", step: 0.1 },
      { key: "description", label: "What it shows", kind: "textarea", wide: true, help: "What the shot shows and what happens in it." },
      { key: "size", label: "Size", kind: "select", options: SHOT_SIZES },
      { key: "angle", label: "Angle", kind: "select", options: SHOT_ANGLES },
      { key: "movement", label: "Movement", kind: "select", options: SHOT_MOVEMENTS },
      { key: "lens", label: "Lens", kind: "text", mono: true },
      { key: "sound", label: "Sound", kind: "select", options: SHOT_SOUNDS, describe: { sync: "Recorded with the picture", silent: "None", generated: "Made afterwards" } },
      { key: "characters", label: "Characters", kind: "list", help: "One per line." },
      { key: "dialogue", label: "Dialogue", kind: "dialogue", wide: true, help: "The lines said in the shot, in order." },
      { key: "notes", label: "Notes", kind: "textarea", wide: true },
    ],
  };

  type Line = { character: string; line: string; delivery?: string; offscreen?: boolean };

  /* The form's own copy. It is taken again from the manifest whenever the unit
     changes or the manifest on disk does and the form has no edits of its own. */
  let values = $state<Record<string, unknown>>({});
  let takenFrom = $state("");

  const saved = $derived(JSON.stringify(manifest ?? {}));
  const unitKey = $derived(`${unit.film}/${unit.scene}/${unit.shot}`);

  $effect(() => {
    const source = `${unitKey}|${saved}`;
    if (source === takenFrom) return;
    if (takenFrom.startsWith(`${unitKey}|`) && dirty) return;
    takenFrom = source;
    values = $state.snapshot(manifest ?? {}) as typeof values;
  });

  /** A value as the manifest stores it: an emptied field is absent, not an empty string. */
  function normal(value: unknown): unknown {
    if (value === "" || value === null || value === undefined) return undefined;
    if (Array.isArray(value)) {
      const kept = value.filter((item) => (typeof item === "string" ? item.trim() !== "" : item && String((item as Line).line ?? "").trim() !== ""));
      return kept.length > 0 ? kept : undefined;
    }
    if (typeof value === "number" && Number.isNaN(value)) return undefined;
    return value;
  }

  const changes = $derived.by(() => {
    const set: Record<string, unknown> = {};
    for (const field of FIELDS[level]) {
      const now = normal(values[field.key]);
      const before = normal(manifest?.[field.key]);
      if (JSON.stringify(now) !== JSON.stringify(before)) set[field.key] = now === undefined ? null : now;
    }
    return set;
  });

  const dirty = $derived(Object.keys(changes).length > 0);

  /** The manifest as it would be saved, checked as the gateway will check it. */
  const draftProblems = $derived.by(() => {
    if (!manifest) return [];
    const next: Record<string, unknown> = { ...manifest };
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    return validateManifest(level, next);
  });

  const shown = $derived(dirty ? draftProblems : problems);

  function problemFor(key: string): string | null {
    const found = shown.find((p) => p.path === `$.${key}` || p.path.startsWith(`$.${key}.`) || p.path.startsWith(`$.${key}[`));
    return found ? found.message : null;
  }

  const otherProblems = $derived(shown.filter((p) => !FIELDS[level].some((f) => p.path === `$.${f.key}` || p.path.startsWith(`$.${f.key}.`) || p.path.startsWith(`$.${f.key}[`))));

  let saving = $state(false);

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!dirty || draftProblems.length > 0) return;
    saving = true;
    const done = await film.saveManifest(unit, { set: changes });
    saving = false;
    if (done) takenFrom = "";
  }

  function revert() {
    values = $state.snapshot(manifest ?? {}) as typeof values;
  }

  const list = (key: string): string => (Array.isArray(values[key]) ? (values[key] as string[]).join("\n") : "");
  const setList = (key: string, text: string) => {
    values[key] = text.split("\n").map((line) => line.trim()).filter((line, index, all) => line !== "" || index === all.length - 1);
  };

  const lines = (key: string): Line[] => (Array.isArray(values[key]) ? (values[key] as Line[]) : []);
  function addLine(key: string) {
    values[key] = [...lines(key), { character: lines(key).at(-1)?.character ?? "", line: "" }];
  }
  function removeLine(key: string, index: number) {
    values[key] = lines(key).filter((_, i) => i !== index);
  }

  const format = $derived(values.format as { id?: string; width?: number; height?: number; fps?: number } | undefined);
  const formatIsCatalog = $derived(film.formats.some((f) => f.id === format?.id));
  function chooseFormat(id: string) {
    const chosen = film.formats.find((f) => f.id === id);
    if (chosen) values.format = structuredClone($state.snapshot(chosen));
  }
</script>

<form class="manifest-form" onsubmit={save}>
  {#if !manifest}
    <p class="mf-problem" role="alert">
      This {level}'s manifest cannot be read: {problems[0]?.message ?? "it is missing"}. Open it under Files to repair it.
    </p>
  {:else}
    <div class="mf-grid">
      {#each FIELDS[level] as field (field.key)}
        {@const problem = problemFor(field.key)}
        <div class="mf-field" class:wide={"wide" in field && field.wide} class:invalid={problem !== null}>
          <label for="mf-{field.key}">{field.label}</label>

          {#if field.kind === "text"}
            <input id="mf-{field.key}" type="text" class:mono={field.mono} value={(values[field.key] as string) ?? ""} oninput={(e) => (values[field.key] = e.currentTarget.value)} />
          {:else if field.kind === "number"}
            <div class="mf-number">
              <input id="mf-{field.key}" type="number" min="0" step={field.step ?? 1} value={(values[field.key] as number) ?? ""} oninput={(e) => (values[field.key] = e.currentTarget.value === "" ? undefined : e.currentTarget.valueAsNumber)} />
              {#if field.unit}<span>{field.unit}</span>{/if}
            </div>
          {:else if field.kind === "textarea"}
            <textarea id="mf-{field.key}" rows={field.key === "synopsis" || field.key === "description" || field.key === "summary" ? 4 : 2} value={(values[field.key] as string) ?? ""} oninput={(e) => (values[field.key] = e.currentTarget.value)}></textarea>
          {:else if field.kind === "select"}
            <select id="mf-{field.key}" value={(values[field.key] as string) ?? ""} onchange={(e) => (values[field.key] = e.currentTarget.value || undefined)}>
              {#if field.key !== "source"}<option value="">—</option>{/if}
              {#each field.options as option (option)}<option value={option}>{option}</option>{/each}
            </select>
            {#if field.describe && values[field.key]}
              <p class="mf-help">{field.describe[values[field.key] as string]}</p>
            {/if}
          {:else if field.kind === "list"}
            <textarea id="mf-{field.key}" rows="2" value={list(field.key)} oninput={(e) => setList(field.key, e.currentTarget.value)}></textarea>
          {:else if field.kind === "format"}
            <select id="mf-{field.key}" value={formatIsCatalog ? format?.id : "__own"} onchange={(e) => chooseFormat(e.currentTarget.value)}>
              {#each film.formats as option (option.id)}<option value={option.id}>{option.title ?? option.id}</option>{/each}
              {#if !formatIsCatalog}<option value="__own">{format?.id ?? "its own"} — the film's own</option>{/if}
            </select>
            {#if format}<p class="mf-help mono">{format.width}×{format.height} · {format.fps} fps</p>{/if}
          {:else if field.kind === "dialogue"}
            <div class="mf-lines" id="mf-{field.key}">
              {#each lines(field.key) as line, index (index)}
                <div class="mf-line">
                  <input type="text" aria-label="Who says it" placeholder="who" value={line.character} oninput={(e) => (line.character = e.currentTarget.value)} />
                  <input type="text" aria-label="The line" placeholder="the line" value={line.line} oninput={(e) => (line.line = e.currentTarget.value)} />
                  <input type="text" aria-label="How it is said" placeholder="how it is said" value={line.delivery ?? ""} oninput={(e) => { if (e.currentTarget.value) line.delivery = e.currentTarget.value; else delete line.delivery; }} />
                  <label class="mf-check" title="Heard, not seen"><input type="checkbox" checked={line.offscreen === true} onchange={(e) => { if (e.currentTarget.checked) line.offscreen = true; else delete line.offscreen; }} /> off</label>
                  <button type="button" aria-label="Remove this line" onclick={() => removeLine(field.key, index)}>×</button>
                </div>
              {/each}
              <button type="button" class="mf-add" onclick={() => addLine(field.key)}>+ Line</button>
            </div>
          {/if}

          {#if problem}
            <p class="mf-problem" role="alert">{problem}</p>
          {:else if field.help && field.kind !== "select"}
            <p class="mf-help">{field.help}</p>
          {/if}
        </div>
      {/each}
    </div>

    {#each otherProblems as problem (problem.path + problem.code)}
      <p class="mf-problem" role="alert"><span class="mono">{problem.path}</span> {problem.message}</p>
    {/each}

    <div class="mf-actions">
      <button type="submit" class="mf-save" disabled={!dirty || saving || draftProblems.length > 0}>{saving ? "Saving…" : "Save"}</button>
      <button type="button" disabled={!dirty || saving} onclick={revert}>Revert</button>
      <span class="mf-state" role="status">
        {#if dirty}{Object.keys(changes).length} field{Object.keys(changes).length === 1 ? "" : "s"} changed{:else}Saved in the {level}'s manifest{/if}
      </span>
    </div>
  {/if}
</form>

<style>
  .mf-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
    gap: var(--vs-space-3) var(--vs-space-4);
  }

  .mf-field {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .mf-field.wide {
    grid-column: 1 / -1;
  }

  .mf-field > label {
    font-size: var(--vs-text-xs);
    font-weight: var(--vs-font-weight-medium);
    color: var(--vs-text-secondary);
  }

  input[type="text"],
  input[type="number"],
  textarea,
  select {
    width: 100%;
    padding: 5px var(--vs-space-2);
    background: var(--vs-bg-inset);
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-primary);
    font: inherit;
    font-size: var(--vs-text-sm);
    line-height: var(--vs-leading-normal);
  }

  textarea {
    resize: vertical;
  }

  input:focus,
  textarea:focus,
  select:focus {
    outline: none;
    border-color: var(--vs-border-focus);
  }

  .invalid input,
  .invalid textarea,
  .invalid select {
    border-color: var(--vs-state-blocked);
  }

  .mono {
    font-family: var(--vs-font-mono);
  }

  .mf-number {
    display: flex;
    align-items: center;
    gap: var(--vs-space-2);
  }

  .mf-number span {
    font-size: var(--vs-text-xs);
    color: var(--vs-text-tertiary);
  }

  .mf-help {
    margin: 0;
    font-size: var(--vs-text-xs);
    color: var(--vs-text-tertiary);
  }

  .mf-problem {
    margin: 0;
    font-size: var(--vs-text-xs);
    color: var(--vs-state-blocked);
  }

  .mf-lines {
    display: flex;
    flex-direction: column;
    gap: var(--vs-space-1);
  }

  .mf-line {
    display: grid;
    grid-template-columns: minmax(80px, 0.6fr) minmax(160px, 2fr) minmax(100px, 1fr) auto auto;
    gap: var(--vs-space-1);
    align-items: center;
  }

  .mf-check {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--vs-text-xs);
    color: var(--vs-text-secondary);
  }

  .mf-line button,
  .mf-add,
  .mf-actions button {
    padding: 4px var(--vs-space-2);
    background: none;
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-secondary);
    font: inherit;
    font-size: var(--vs-text-sm);
    cursor: pointer;
  }

  .mf-add {
    align-self: flex-start;
  }

  .mf-line button:hover,
  .mf-add:hover,
  .mf-actions button:hover:not(:disabled) {
    background: var(--vs-bg-hover);
    color: var(--vs-text-primary);
  }

  .mf-actions {
    display: flex;
    align-items: center;
    gap: var(--vs-space-2);
    margin-top: var(--vs-space-3);
  }

  .mf-actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .mf-actions .mf-save:not(:disabled) {
    background: var(--vs-accent-strong);
    border-color: var(--vs-accent-strong);
    color: var(--vs-accent-text);
  }

  .mf-state {
    font-size: var(--vs-text-xs);
    color: var(--vs-text-tertiary);
  }
</style>
