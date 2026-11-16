<script lang="ts">
  import { library } from "$lib/library-store.svelte.ts";
  import { studio } from "$lib/studio-store.svelte.ts";
  import type { LibraryTree } from "$lib/library-types";
  import ChannelItem from "./ChannelItem.svelte";
  import NewFilm from "../film/NewFilm.svelte";

  /**
   * Prune the tree to what matches the filter.
   *
   * A branch survives if it matches, or if anything under it does — otherwise
   * filtering for an episode would hide the series it lives in and you would
   * lose the path to it.
   */
  function prune(tree: LibraryTree, query: string): LibraryTree {
    const q = query.trim().toLowerCase();
    if (!q) return tree;

    const hit = (...values: string[]) =>
      values.some((v) => v.toLowerCase().includes(q));

    const channels = tree.channels
      .map((channel) => {
        const channelHit = hit(channel.slug, channel.title);

        const series = channel.series
          .map((s) => {
            const seriesHit = hit(s.slug, s.title);
            const episodes = s.episodes.filter((e) => hit(e.slug, e.title));
            /* A matching series keeps all its episodes; a matching episode
               keeps its series as the way to reach it. */
            if (seriesHit || channelHit) return s;
            if (episodes.length > 0) return { ...s, episodes };
            return null;
          })
          .filter((s): s is NonNullable<typeof s> => s !== null);

        if (channelHit || series.length > 0) return { ...channel, series };
        return null;
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    return { channels };
  }

  const filtered = $derived(prune(library.tree, studio.libraryFilter));
  const filtering = $derived(studio.libraryFilter.trim().length > 0);
</script>

<nav class="library-nav" aria-label="Library">
  {#if library.phase === "loading"}
    <div class="lib-state" role="status">
      <span class="lib-message">Loading library…</span>
    </div>
  {:else if library.phase === "error"}
    <div class="lib-state lib-state-error" role="alert">
      <span class="lib-message">{library.message}</span>
    </div>
  {:else if library.phase === "empty"}
    <div class="lib-state">
      <span class="lib-icon" aria-hidden="true">&#9675;</span>
      <p>The library is empty.</p>
      <p class="lib-hint">Start a film here, or ask the agent for one — or for a channel and its first series.</p>
      {#if library.live}<NewFilm />{/if}
    </div>
  {:else if filtered.channels.length === 0}
    <div class="lib-state" role="status">
      <p>Nothing matches “{studio.libraryFilter}”.</p>
      <p class="lib-hint">The library still has {library.tree.channels.length} channel{library.tree.channels.length === 1 ? "" : "s"}.</p>
    </div>
  {:else}
    <!-- Films and channels are different kinds of work, so they are listed
         apart: a film is one piece, a channel keeps making episodes. -->
    {#each [{ kind: "film", label: "Films" }, { kind: "channel", label: "Channels" }] as section (section.kind)}
      {@const projects = filtered.channels.filter((c) => c.kind === section.kind)}
      <!-- The films' section is always there while the library is the real
           one: it is where a film is started. -->
      {#if projects.length > 0 || (section.kind === "film" && library.live && !filtering)}
        <section class="lib-section" aria-label={section.label}>
          <h2 class="lib-section-title">{section.label}</h2>
          {#each projects as channel (channel.slug)}
            <!-- While filtering, every surviving branch opens: a match you cannot
                 see is not a match. -->
            <ChannelItem {channel} forceExpand={filtering} />
          {/each}
          {#if section.kind === "film" && library.live && !filtering}<NewFilm />{/if}
        </section>
      {/if}
    {/each}
  {/if}
</nav>

<style>
  .library-nav {
    flex: 1;
    overflow-y: auto;
    user-select: none;
  }

  .lib-section + .lib-section {
    margin-top: var(--vs-space-3);
  }

  .lib-section-title {
    margin: 0;
    padding: var(--vs-space-2) var(--vs-space-3) var(--vs-space-1);
    font-size: 10px;
    font-weight: var(--vs-font-weight-semibold);
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--vs-text-tertiary);
  }

  .lib-state {
    padding: var(--vs-space-4);
    text-align: center;
    font-size: var(--vs-text-sm);
    color: var(--vs-text-secondary);
  }

  .lib-state-error {
    color: var(--vs-state-blocked);
    background: var(--vs-state-blocked-bg);
    border-radius: var(--vs-radius-sm);
    margin: var(--vs-space-2);
  }

  .lib-icon {
    font-size: 1.25rem;
    color: var(--vs-text-disabled);
    margin-bottom: var(--vs-space-2);
    display: block;
  }

  .lib-hint {
    font-size: var(--vs-text-xs);
    color: var(--vs-text-tertiary);
    margin-top: var(--vs-space-2);
  }

  .lib-message {
    display: block;
    line-height: var(--vs-leading-normal);
  }
</style>
