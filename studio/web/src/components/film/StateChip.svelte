<script lang="ts">
  /**
   * Where a unit stands, as a mark and a word. The mark's shape differs with
   * the state as well as its colour, so the state reads without colour.
   */
  import { RENDER_STATE_LABELS, RENDER_STATE_TONE, type RenderState } from "$lib/film-types";

  interface Props {
    state: RenderState;
    /** Only the mark: for a dense list where the word is in a title. */
    compact?: boolean;
    title?: string;
  }

  let { state, compact = false, title }: Props = $props();

  const MARKS: Record<RenderState, string> = {
    "no-cut": "○",
    "invalid-cut": "✕",
    blocked: "◼",
    "not-rendered": "◇",
    stale: "↻",
    preview: "◐",
    current: "●",
  };
</script>

<span class="state-chip" class:compact data-tone={RENDER_STATE_TONE[state]} title={title ?? RENDER_STATE_LABELS[state]}>
  <span class="mark" aria-hidden="true">{MARKS[state]}</span>
  {#if compact}
    <span class="sr-only">{RENDER_STATE_LABELS[state]}</span>
  {:else}
    <span class="word">{RENDER_STATE_LABELS[state]}</span>
  {/if}
</span>

<style>
  .state-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: var(--vs-text-xs);
    font-weight: var(--vs-font-weight-medium);
    white-space: nowrap;
    color: var(--vs-text-tertiary);
  }

  .mark {
    font-size: 0.8em;
    line-height: 1;
  }

  .state-chip[data-tone="current"] { color: var(--vs-state-current); }
  .state-chip[data-tone="running"] { color: var(--vs-state-running); }
  .state-chip[data-tone="attention"] { color: var(--vs-state-attention); }
  .state-chip[data-tone="blocked"] { color: var(--vs-state-blocked); }
  .state-chip[data-tone="stale"] { color: var(--vs-state-stale); }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
