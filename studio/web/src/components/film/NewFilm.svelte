<script lang="ts">
  /**
   * Start a film: its title, what it is delivered as, and how long it means
   * to run. Everything else — the logline, the screenplay, the look — is
   * written into the film once it exists, by a person or by the agent.
   *
   * The delivery format is asked for here because every cut of the film is
   * made in it: frame size and frame rate are not something to change after
   * the first shot is rendered.
   */
  import { library } from "$lib/library-store.svelte.ts";
  import { filmApi, FilmApiError } from "$lib/film-api";
  import { slugify } from "$lib/film-format";
  import { DEFAULT_FILM_FORMAT, FILM_FORMATS } from "@studio/contracts/src/film.mjs";

  let open = $state(false);
  let title = $state("");
  let slug = $state("");
  let slugTouched = $state(false);
  let format = $state(DEFAULT_FILM_FORMAT);
  let minutes = $state<number | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    if (!slugTouched) slug = slugify(title);
  });

  function cancel() {
    open = false;
    title = "";
    slug = "";
    slugTouched = false;
    minutes = null;
    error = null;
  }

  async function create(event: SubmitEvent) {
    event.preventDefault();
    if (!title.trim() || !slug || busy) return;
    busy = true;
    error = null;
    try {
      await filmApi("/api/films", {
        method: "POST",
        body: { slug, title: title.trim(), format, ...(minutes && minutes > 0 ? { runtimeTargetSeconds: Math.round(minutes * 60) } : {}) },
      });
      const made = slug;
      await library.reload();
      library.selectChannel(made);
      cancel();
    } catch (cause) {
      error = cause instanceof FilmApiError ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

{#if open}
  <form class="new-film" onsubmit={create} aria-label="New film">
    <!-- svelte-ignore a11y_autofocus -->
    <input bind:value={title} placeholder="The film's title" aria-label="Title" required maxlength="160" autofocus />
    <input class="nf-mono" bind:value={slug} oninput={() => (slugTouched = true)} placeholder="its-folder-name" aria-label="Folder name" required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxlength="64" />
    <select bind:value={format} aria-label="Delivery format">
      {#each FILM_FORMATS as option (option.id)}
        <option value={option.id}>{option.title ?? option.id}</option>
      {/each}
    </select>
    <label class="nf-runtime">
      Runs about
      <input type="number" min="0.1" step="0.5" bind:value={minutes} aria-label="Planned running time in minutes" />
      min
    </label>
    {#if error}<p class="nf-error" role="alert">{error}</p>{/if}
    <div class="nf-actions">
      <button type="submit" class="nf-primary" disabled={busy || !title.trim() || !slug}>{busy ? "Creating…" : "Create film"}</button>
      <button type="button" onclick={cancel}>Cancel</button>
    </div>
  </form>
{:else}
  <button class="nf-open" onclick={() => (open = true)}>+ Film</button>
{/if}

<style>
  .nf-open {
    margin: var(--vs-space-1) var(--vs-space-3);
    padding: 2px var(--vs-space-2);
    background: none;
    border: 1px dashed var(--vs-border);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-secondary);
    font: inherit;
    font-size: var(--vs-text-xs);
    cursor: pointer;
  }

  .nf-open:hover {
    border-style: solid;
    color: var(--vs-text-primary);
  }

  .new-film {
    display: flex;
    flex-direction: column;
    gap: var(--vs-space-1);
    margin: var(--vs-space-1) var(--vs-space-2) var(--vs-space-2);
    padding: var(--vs-space-2);
    background: var(--vs-bg-raised);
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-md);
    user-select: text;
  }

  .new-film input,
  .new-film select {
    min-width: 0;
    padding: 3px 6px;
    background: var(--vs-bg-surface);
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-primary);
    font: inherit;
    font-size: var(--vs-text-sm);
  }

  .nf-mono {
    font-family: var(--vs-font-mono) !important;
    font-size: var(--vs-text-xs) !important;
  }

  .nf-runtime {
    display: flex;
    align-items: center;
    gap: var(--vs-space-2);
    font-size: var(--vs-text-xs);
    color: var(--vs-text-secondary);
  }

  .nf-runtime input {
    width: 64px;
  }

  .nf-error {
    margin: 0;
    font-size: var(--vs-text-xs);
    color: var(--vs-state-blocked);
    line-height: var(--vs-leading-normal);
  }

  .nf-actions {
    display: flex;
    gap: var(--vs-space-1);
    margin-top: var(--vs-space-1);
  }

  .nf-actions button {
    padding: 3px var(--vs-space-2);
    background: none;
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-primary);
    font: inherit;
    font-size: var(--vs-text-xs);
    cursor: pointer;
  }

  .nf-actions .nf-primary {
    background: var(--vs-accent-strong);
    border-color: var(--vs-accent-strong);
    color: var(--vs-accent-text);
  }

  .nf-actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  :is(button, input, select):focus-visible {
    outline: 2px solid var(--vs-border-focus);
    outline-offset: 1px;
  }
</style>
