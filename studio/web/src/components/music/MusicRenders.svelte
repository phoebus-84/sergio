<script lang="ts">
  /**
   * What was rendered from a piece: each file to hear, its level and spectrum
   * as numbers and bars, what its record says to listen for, and whether the
   * piece has changed since. The numbers are the ones the agent mixes by.
   */
  import { files } from "$lib/files-store.svelte.ts";
  import { bandsOf, inLevel, levelLine, shapeLine, type MusicRenderEntry } from "$lib/music";

  let { renders, within = "" }: { renders: MusicRenderEntry[]; within?: string } = $props();

  const src = (path: string) => files.mediaUrl(inLevel(within, path));
</script>

{#if renders.length === 0}
  <p class="mr-none">Not rendered yet.</p>
{:else}
  <ul class="mr" aria-label="Renders">
    {#each renders as render (render.recordPath)}
      {@const record = render.record}
      <li class="mr-item">
        <div class="mr-head">
          <span class="mr-path">{record.output.path}</span>
          {#if render.missing}
            <span class="mr-flag mr-bad">file missing or replaced</span>
          {:else if !render.current}
            <span class="mr-flag mr-stale">stale: the piece changed since</span>
          {:else}
            <span class="mr-flag mr-ok">current</span>
          {/if}
        </div>
        <p class="mr-line">{shapeLine(record)}</p>
        <p class="mr-line">{levelLine(record)}</p>
        {#if !render.missing}
          <audio controls preload="none" src={src(record.output.path)} aria-label="Play {record.output.path}"></audio>
        {/if}
        <dl class="mr-bands" aria-label="Spectrum by band, as a share of the energy">
          {#each bandsOf(record) as band (band.name)}
            <div class="mr-band">
              <dt>{band.label}</dt>
              <dd>
                <span class="mr-bar" aria-hidden="true"><span style:width="{band.fill * 100}%"></span></span>
                <span class="mr-db">{band.db === null ? "–" : band.db.toFixed(0)} dB</span>
              </dd>
            </div>
          {/each}
        </dl>
        {#if record.stems.length > 0 && !render.missing}
          <ul class="mr-stems" aria-label="Stems">
            {#each record.stems as stem (stem.path)}
              <li>
                <span class="mr-stem">{stem.part}</span>
                <span class="mr-db">{stem.loudness === null ? "–" : stem.loudness.toFixed(1)} LUFS</span>
                <audio controls preload="none" src={src(stem.path)} aria-label="Play the {stem.part} stem"></audio>
              </li>
            {/each}
          </ul>
        {/if}
        {#if record.concerns.length > 0}
          <ul class="mr-concerns" aria-label="What to listen for">
            {#each record.concerns as concern, i (i)}
              <li>{concern}</li>
            {/each}
          </ul>
        {/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .mr { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--vs-space-3); }
  .mr-none { margin: 0; color: var(--vs-text-tertiary); font-size: var(--vs-text-sm); }
  .mr-item { display: flex; flex-direction: column; gap: var(--vs-space-2); padding: var(--vs-space-3); border: 1px solid var(--vs-border-subtle); border-radius: var(--vs-radius-md); background: var(--vs-bg-surface); }
  .mr-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--vs-space-2); }
  .mr-path, .mr-stem { font-family: var(--vs-font-mono); font-size: var(--vs-text-sm); color: var(--vs-text-primary); }
  .mr-flag { font-size: var(--vs-text-xs); padding: 0 var(--vs-space-2); border-radius: var(--vs-radius-sm); }
  .mr-ok { color: var(--vs-state-current); background: var(--vs-state-current-bg); }
  .mr-stale { color: var(--vs-state-attention); background: var(--vs-state-attention-bg); }
  .mr-bad { color: var(--vs-state-blocked); background: var(--vs-state-blocked-bg); }
  .mr-line { margin: 0; font-size: var(--vs-text-xs); color: var(--vs-text-secondary); }
  audio { width: 100%; max-width: 520px; height: 32px; }
  .mr-bands { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: var(--vs-space-2); margin: 0; max-width: 520px; }
  .mr-band { display: flex; flex-direction: column; gap: 2px; }
  .mr-band dt { font-size: var(--vs-text-xs); color: var(--vs-text-tertiary); }
  .mr-band dd { margin: 0; display: flex; flex-direction: column; gap: 2px; }
  .mr-bar { display: block; height: 6px; border-radius: var(--vs-radius-sm); background: var(--vs-bg-inset); overflow: hidden; }
  .mr-bar span { display: block; height: 100%; background: var(--vs-text-secondary); }
  .mr-db { font-family: var(--vs-font-mono); font-size: var(--vs-text-xs); color: var(--vs-text-secondary); }
  .mr-stems { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--vs-space-1); }
  .mr-stems li { display: grid; grid-template-columns: minmax(80px, 140px) 90px minmax(0, 1fr); align-items: center; gap: var(--vs-space-2); }
  .mr-concerns { margin: 0; padding-left: var(--vs-space-4); font-size: var(--vs-text-xs); color: var(--vs-state-attention); }
</style>
