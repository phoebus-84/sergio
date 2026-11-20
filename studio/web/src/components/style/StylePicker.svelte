<script lang="ts">
  /**
   * Choose a style template — or none, which is always a choice. Shown as its
   * title, its colours and what it is, so a person picks a look, not an id.
   */
  import type { StyleSummary } from "$lib/style-edit";
  import StyleSwatches from "./StyleSwatches.svelte";

  interface Props {
    styles: StyleSummary[];
    value: string;
    /** What "no style" is called here. */
    noneLabel?: string;
    level?: string;
    onchange?: (id: string) => void;
  }

  let { styles, value = $bindable(""), noneLabel = "No style — make it freely", level, onchange }: Props = $props();

  const usable = $derived(styles.filter((s) => s.problems.length === 0 && (!level || s.levels.includes(level))));
  const chosen = $derived(usable.find((s) => s.id === value) ?? null);
</script>

<div class="picker">
  <select
    bind:value
    aria-label="Style template"
    onchange={() => onchange?.(value)}
  >
    <option value="">{noneLabel}</option>
    {#each usable as style (style.id)}
      <option value={style.id}>{style.title}{style.origin === "builtin" ? "" : ` (${style.origin})`}</option>
    {/each}
  </select>
  {#if chosen}
    <p class="picker-about">
      <StyleSwatches swatches={chosen.swatches} />
      <span>{chosen.summary}</span>
    </p>
  {/if}
</div>

<style>
  .picker {
    display: grid;
    gap: var(--vs-space-1);
    min-width: 0;
  }

  select {
    min-width: 0;
    padding: 3px 6px;
    background: var(--vs-bg-surface);
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-primary);
    font: inherit;
    font-size: var(--vs-text-sm);
  }

  select:focus-visible {
    outline: 2px solid var(--vs-border-focus);
    outline-offset: 1px;
  }

  .picker-about {
    display: flex;
    gap: var(--vs-space-2);
    align-items: flex-start;
    margin: 0;
    font-size: var(--vs-text-xs);
    color: var(--vs-text-secondary);
    line-height: var(--vs-leading-normal);
  }
</style>
