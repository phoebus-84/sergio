<script lang="ts">
  /**
   * The views this level offers.
   *
   * The set changes with the level rather than staying fixed and greying out —
   * a channel has no "Render", and showing a disabled one would imply a channel
   * could have a deliverable.
   */
  import { studio, type View } from "$lib/studio-store.svelte.ts";
</script>

<div class="view-tabs" role="tablist" aria-label="Workspace views">
  {#each studio.views as view (view.key)}
    <button
      class="view-tab"
      role="tab"
      aria-selected={studio.view === view.key}
      onclick={() => studio.show(view.key as View)}
    >
      {view.label}
    </button>
  {/each}

  <button
    class="view-focus"
    aria-pressed={studio.focus}
    title={studio.focus ? "Bring the library and the inspector back (⌘\\)" : "Put the library and the inspector away, for room to work (⌘\\)"}
    onclick={() => studio.toggleFocus()}
  >
    <span class="view-focus-mark" aria-hidden="true">{studio.focus ? "▣" : "▢"}</span>
    Focus
  </button>
</div>

<style>
  .view-tabs {
    display: flex;
    align-items: stretch;
    padding: 0 var(--vs-space-2);
    background: var(--vs-bg-surface);
    border-bottom: 1px solid var(--vs-border);
    flex-shrink: 0;
    overflow-x: auto;
  }

  .view-tab {
    padding: 9px var(--vs-space-3);
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--vs-text-secondary);
    font: inherit;
    font-size: var(--vs-text-sm);
    cursor: pointer;
    margin-bottom: -1px;
    white-space: nowrap;
  }

  .view-tab:hover {
    color: var(--vs-text-primary);
  }

  .view-focus {
    margin: auto 0 auto auto;
    display: flex;
    align-items: center;
    gap: var(--vs-space-1);
    padding: 3px var(--vs-space-2);
    background: none;
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-secondary);
    font: inherit;
    font-size: var(--vs-text-xs);
    cursor: pointer;
    white-space: nowrap;
  }

  .view-focus:hover {
    background: var(--vs-bg-hover);
    color: var(--vs-text-primary);
  }

  .view-focus[aria-pressed="true"] {
    background: var(--vs-bg-selected);
    border-color: var(--vs-accent);
    color: var(--vs-accent-strong);
  }

  .view-focus:focus-visible {
    outline: 2px solid var(--vs-border-focus);
    outline-offset: 1px;
  }

  .view-tab[aria-selected="true"] {
    color: var(--vs-accent-strong);
    border-bottom-color: var(--vs-accent-strong);
    font-weight: var(--vs-font-weight-semibold);
  }
</style>
