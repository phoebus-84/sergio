<script lang="ts">
  /**
   * Who decides, at this level and under it.
   *
   * A film runs a pipeline at each of its levels, and each pipeline comes in
   * variants that differ only in where they wait for a person. A level states
   * its own, and may state the one the levels under it run — so a whole film
   * can be automatic, one scene of it guided, one shot of that scene directed
   * step by step. What is not stated here is inherited from the level above.
   */
  import { film, type Unit, type UnitControl } from "$lib/film-store.svelte.ts";
  import type { FilmLevel } from "$lib/film-types";

  interface Props {
    unit: Unit;
    level: FilmLevel;
  }

  let { unit, level }: Props = $props();

  const VARIANTS: Record<FilmLevel, { id: string; label: string; says: string }[]> = {
    film: [
      { id: "film-project", label: "Guided", says: "A person approves the treatment, screenplay, look, breakdown, music, cut and the final review." },
      { id: "film-project-auto", label: "Automatic", says: "Nobody is asked until the final review." },
    ],
    scene: [
      { id: "film-scene", label: "Guided", says: "A person approves the scene's direction and its cut." },
      { id: "film-scene-auto", label: "Automatic", says: "Nobody is asked: the scene is directed, cut and rendered." },
    ],
    shot: [
      { id: "film-shot", label: "Guided", says: "A person chooses the take." },
      { id: "film-shot-auto", label: "Automatic", says: "Nobody is asked: the agent chooses the take." },
      { id: "film-shot-directed", label: "Directed", says: "A person approves the plan, the take and the cut." },
    ],
  };

  /** The declarations a level makes: its own, and those of the levels under it. */
  const ROWS: Record<FilmLevel, { key: string; governs: FilmLevel; label: string }[]> = {
    film: [
      { key: "pipeline", governs: "film", label: "The film itself" },
      { key: "scenes", governs: "scene", label: "Its scenes" },
      { key: "shots", governs: "shot", label: "Its shots" },
    ],
    scene: [
      { key: "pipeline", governs: "scene", label: "This scene" },
      { key: "shots", governs: "shot", label: "Its shots" },
    ],
    shot: [{ key: "pipeline", governs: "shot", label: "This shot" }],
  };

  let control = $state<UnitControl | null>(null);
  let loadedFor = $state("");

  $effect(() => {
    const key = `${unit.film}/${unit.scene}/${unit.shot}`;
    if (key === loadedFor) return;
    loadedFor = key;
    control = null;
    void film.control(unit).then((result) => {
      if (loadedFor === key) control = result;
    });
  });

  async function declare(key: string, value: string) {
    const next = await film.setControl(unit, { [key]: value === "" ? null : value });
    if (next) control = next;
  }

  function labelOf(governs: FilmLevel, id: string | null | undefined): string {
    const known = VARIANTS[governs].find((v) => v.id === id);
    return known ? known.label : (id ?? "");
  }
</script>

<section class="control" aria-labelledby="control-title">
  <h3 id="control-title">Who decides</h3>
  {#if !control}
    <p class="control-note" role="status">Reading…</p>
  {:else}
    <div class="control-rows">
      {#each ROWS[level] as row (row.key)}
        {@const declared = control.declared[row.key] ?? null}
        {@const own = row.key === "pipeline"}
        {@const effective = own ? control.pipeline : (declared ?? control.defaults[row.governs])}
        {@const known = VARIANTS[row.governs].some((v) => v.id === effective)}
        <label class="control-row">
          <span class="control-label">{row.label}</span>
          <select value={declared ?? ""} onchange={(event) => declare(row.key, event.currentTarget.value)}>
            <option value="">
              {own && level !== "film" ? `As the level above says (${labelOf(row.governs, control.pipeline)})` : `Not stated here (${labelOf(row.governs, own ? control.pipeline : control.defaults[row.governs])})`}
            </option>
            {#each VARIANTS[row.governs] as variant (variant.id)}
              <option value={variant.id}>{variant.label}</option>
            {/each}
            {#if declared && !VARIANTS[row.governs].some((v) => v.id === declared)}
              <option value={declared}>{declared}</option>
            {/if}
          </select>
          <span class="control-says">
            {#if known}
              {VARIANTS[row.governs].find((v) => v.id === effective)?.says}
            {:else}
              Runs <code>{effective}</code>, a pipeline of this library.
            {/if}
          </span>
        </label>
      {/each}
    </div>
    <p class="control-note">
      Kept in this level's <code>pipeline.yaml</code>. A clip or a track you lock in a cut is left alone by the agent whatever is chosen here.
    </p>
  {/if}
</section>

<style>
  .control h3 {
    margin: 0 0 var(--vs-space-2);
    font-size: var(--vs-text-xs);
    font-weight: var(--vs-font-weight-semibold);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--vs-text-tertiary);
  }

  .control-rows {
    border-top: 1px solid var(--vs-border-subtle);
  }

  .control-row {
    display: grid;
    grid-template-columns: 140px 260px 1fr;
    align-items: center;
    gap: var(--vs-space-3);
    padding: var(--vs-space-2) 0;
    border-bottom: 1px solid var(--vs-border-subtle);
    font-size: var(--vs-text-sm);
  }

  .control-label {
    font-weight: var(--vs-font-weight-medium);
  }

  .control-row select {
    padding: 4px var(--vs-space-2);
    background: var(--vs-bg-inset);
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-primary);
    font: inherit;
    font-size: var(--vs-text-sm);
  }

  .control-row select:focus {
    outline: none;
    border-color: var(--vs-border-focus);
  }

  .control-says {
    color: var(--vs-text-secondary);
  }

  .control-note {
    margin: var(--vs-space-2) 0 0;
    font-size: var(--vs-text-xs);
    color: var(--vs-text-tertiary);
  }

  code {
    font-family: var(--vs-font-mono);
    font-size: 0.95em;
  }

  @media (max-width: 900px) {
    .control-row {
      grid-template-columns: 1fr;
      gap: var(--vs-space-1);
    }
  }
</style>
