<script lang="ts">
  /**
   * The Music tab (ADR-0053): the pieces of this level — an episode, a film,
   * a scene or a shot — and what was rendered from each. A piece is opened in
   * the Files view, where it is read, edited, played and rendered.
   */
  import { files, apiPrefix } from "$lib/files-store.svelte.ts";
  import { getGatewayClient } from "$lib/gateway.svelte.ts";
  import { studio } from "$lib/studio-store.svelte.ts";
  import type { MusicAnswer } from "$lib/music";
  import MusicRenders from "./MusicRenders.svelte";

  let answer = $state<MusicAnswer | null>(null);
  let error = $state<string | null>(null);
  /** Bumped by Refresh: the agent writes and renders pieces while the tab is open. */
  let asked = $state(0);

  $effect(() => {
    const ref = files.ref;
    void asked;
    error = null;
    if (!ref) { answer = null; return; }
    let live = true;
    getGatewayClient().fetchJSON<MusicAnswer>(`${apiPrefix(ref)}/music`)
      .then((a) => { if (live) answer = a; })
      .catch((err) => { if (live) { answer = null; error = err instanceof Error ? err.message : String(err); } });
    return () => { live = false; };
  });

  function open(path: string) {
    const entry = files.entries.find((e) => e.path === path);
    if (!entry) return;
    studio.openFile(path);
    void files.open(entry);
  }
</script>

{#if error}
  <p class="mt-note" role="alert">{error}</p>
{:else if !answer}
  <p class="mt-note" role="status">Loading…</p>
{:else}
  <div class="mt">
    <div class="mt-bar">
      <span class="mt-ready" class:mt-bad={!answer.readiness.available}>
        {answer.readiness.available ? "Music renders on this machine" : answer.readiness.detail}
      </span>
      <button onclick={() => (asked += 1)}>Refresh</button>
    </div>
    {#if answer.pieces.length === 0}
      <p class="mt-note">No music here yet. A piece is a file of Strudel code, <code>music/&lt;name&gt;.strudel</code>: the agent writes one with the strudel-music skill, or create the file in Files.</p>
    {:else}
      {#each answer.pieces as piece (piece.path)}
        <section class="mt-piece" aria-label={piece.path}>
          <header>
            <h3>{piece.path}</h3>
            <button onclick={() => open(piece.path)}>Open</button>
          </header>
          <MusicRenders renders={piece.renders} />
        </section>
      {/each}
    {/if}
    {#if answer.orphans.length > 0}
      <section class="mt-piece" aria-label="Renders of pieces that are gone">
        <header><h3>Rendered from pieces that are gone</h3></header>
        <MusicRenders renders={answer.orphans} />
      </section>
    {/if}
    {#if answer.invalid.length > 0}
      <p class="mt-note" role="alert">Unreadable render records: {answer.invalid.join(", ")}</p>
    {/if}
  </div>
{/if}

<style>
  .mt { display: flex; flex-direction: column; gap: var(--vs-space-4); padding: var(--vs-space-4); overflow: auto; }
  .mt-note { padding: var(--vs-space-4); margin: 0; color: var(--vs-text-secondary); font-size: var(--vs-text-sm); }
  .mt-bar { display: flex; align-items: center; justify-content: space-between; gap: var(--vs-space-3); }
  .mt-ready { font-size: var(--vs-text-xs); color: var(--vs-text-tertiary); }
  .mt-ready.mt-bad { color: var(--vs-state-blocked); }
  .mt button { border: 1px solid var(--vs-border); border-radius: var(--vs-radius-sm); background: var(--vs-bg-raised); color: var(--vs-text-primary); padding: 2px var(--vs-space-2); cursor: pointer; font-size: var(--vs-text-xs); }
  .mt button:hover { background: var(--vs-bg-hover); }
  .mt button:focus-visible { outline: 2px solid var(--vs-border-focus); outline-offset: 1px; }
  .mt-piece { display: flex; flex-direction: column; gap: var(--vs-space-2); }
  .mt-piece header { display: flex; align-items: center; gap: var(--vs-space-3); }
  .mt-piece h3 { margin: 0; font-family: var(--vs-font-mono); font-size: var(--vs-text-sm); font-weight: 500; color: var(--vs-text-primary); }
  code { font-family: var(--vs-font-mono); }
</style>
