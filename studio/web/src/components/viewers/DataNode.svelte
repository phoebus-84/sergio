<script lang="ts">
  /**
   * One value of a structured file, drawn for what it is.
   *
   * A plain value is a field to type in. A record is its fields, each on a
   * row. A list of small records is a table, because that is how a person
   * compares them; any other list is its items one after the other, each
   * named by what it calls itself. Anything that holds more opens and closes,
   * so a long file is first an outline.
   */
  import Self from "./DataNode.svelte";
  import { blankLike, isRecord, isScalar, summarize, tableColumns, type DataPath, type Scalar } from "$lib/structured-data";

  interface Props {
    value: unknown;
    path: DataPath;
    depth: number;
    readOnly: boolean;
    /** Branches open on arrival down to this depth. */
    openDepth: number;
    onset: (path: DataPath, value: unknown) => void;
    onremove: (path: DataPath) => void;
    onappend: (path: DataPath, item: unknown) => void;
    onmove: (path: DataPath, from: number, to: number) => void;
  }

  let { value, path, depth, readOnly, openDepth, onset, onremove, onappend, onmove }: Props = $props();

  const columns = $derived(Array.isArray(value) ? tableColumns(value) : null);
  function typed(event: Event, was: Scalar): Scalar {
    const input = event.currentTarget as HTMLInputElement | HTMLTextAreaElement;
    if (typeof was === "boolean") return (input as HTMLInputElement).checked;
    if (typeof was === "number") {
      const number = (input as HTMLInputElement).valueAsNumber;
      return Number.isFinite(number) ? number : was;
    }
    return input.value;
  }

  const long = (text: string) => text.length > 70 || text.includes("\n");
</script>

{#snippet scalar(item: Scalar, at: DataPath, label: string)}
  {#if typeof item === "boolean"}
    <input type="checkbox" aria-label={label} checked={item} disabled={readOnly} onchange={(e) => onset(at, typed(e, item))} />
  {:else if typeof item === "number"}
    <input class="dn-input dn-number" type="number" step="any" aria-label={label} value={item} readonly={readOnly} onchange={(e) => onset(at, typed(e, item))} />
  {:else if item === null}
    <input class="dn-input dn-null" type="text" aria-label={label} value="" placeholder="empty" readonly={readOnly} onchange={(e) => e.currentTarget.value !== "" && onset(at, e.currentTarget.value)} />
  {:else if long(item)}
    <textarea class="dn-input dn-text" aria-label={label} rows={Math.min(12, Math.max(2, item.split("\n").length, Math.ceil(item.length / 80)))} value={item} readonly={readOnly} onchange={(e) => onset(at, e.currentTarget.value)}></textarea>
  {:else}
    <input class="dn-input" type="text" aria-label={label} value={item} readonly={readOnly} onchange={(e) => onset(at, e.currentTarget.value)} />
  {/if}
{/snippet}

{#if isScalar(value)}
  {@render scalar(value, path, String(path[path.length - 1] ?? "value"))}
{:else if Array.isArray(value) && columns}
  <div class="dn-table-wrap">
    <table class="dn-table">
      <thead>
        <tr>
          <th class="dn-index">#</th>
          {#each columns as column (column)}<th>{column}</th>{/each}
          {#if !readOnly}<th><span class="sr-only">Row actions</span></th>{/if}
        </tr>
      </thead>
      <tbody>
        {#each value as row, index (index)}
          <tr>
            <td class="dn-index">{index + 1}</td>
            {#each columns as column (column)}
              {@const cell = (row as Record<string, Scalar | undefined>)[column]}
              <td>
                {#if cell === undefined}
                  <input class="dn-input dn-null" type="text" aria-label="{column}, row {index + 1}" value="" placeholder="—" readonly={readOnly} onchange={(e) => e.currentTarget.value !== "" && onset([...path, index, column], e.currentTarget.value)} />
                {:else}
                  {@render scalar(cell, [...path, index, column], `${column}, row ${index + 1}`)}
                {/if}
              </td>
            {/each}
            {#if !readOnly}
              <td class="dn-row-actions">
                <button aria-label="Move row {index + 1} up" disabled={index === 0} onclick={() => onmove(path, index, index - 1)}>↑</button>
                <button aria-label="Move row {index + 1} down" disabled={index === value.length - 1} onclick={() => onmove(path, index, index + 1)}>↓</button>
                <button aria-label="Remove row {index + 1}" onclick={() => onremove([...path, index])}>×</button>
              </td>
            {/if}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if !readOnly}
    <button class="dn-add" onclick={() => onappend(path, blankLike(value[value.length - 1]))}>+ Row</button>
  {/if}
{:else if Array.isArray(value)}
  <ol class="dn-list">
    {#each value as item, index (index)}
      <li class="dn-item">
        {#if isScalar(item)}
          <span class="dn-n">{index + 1}</span>
          <div class="dn-value">{@render scalar(item, [...path, index], `item ${index + 1}`)}</div>
        {:else}
          <details class="dn-branch" open={depth < openDepth}>
            <summary><span class="dn-n">{index + 1}</span><span class="dn-summary">{summarize(item)}</span></summary>
            <div class="dn-body">
              <Self value={item} path={[...path, index]} depth={depth + 1} {readOnly} {openDepth} {onset} {onremove} {onappend} {onmove} />
            </div>
          </details>
        {/if}
        {#if !readOnly}
          <span class="dn-row-actions">
            <button aria-label="Move item {index + 1} up" disabled={index === 0} onclick={() => onmove(path, index, index - 1)}>↑</button>
            <button aria-label="Move item {index + 1} down" disabled={index === value.length - 1} onclick={() => onmove(path, index, index + 1)}>↓</button>
            <button aria-label="Remove item {index + 1}" onclick={() => onremove([...path, index])}>×</button>
          </span>
        {/if}
      </li>
    {:else}
      <li class="dn-empty">An empty list.</li>
    {/each}
  </ol>
  {#if !readOnly}
    <button class="dn-add" onclick={() => onappend(path, value.length > 0 ? blankLike(value[value.length - 1]) : "")}>+ Item</button>
  {/if}
{:else if isRecord(value)}
  <div class="dn-fields">
    {#each Object.entries(value) as [key, field] (key)}
      {#if isScalar(field)}
        <div class="dn-field">
          <span class="dn-key" title={key}>{key}</span>
          <div class="dn-value">{@render scalar(field, [...path, key], key)}</div>
        </div>
      {:else}
        <details class="dn-branch dn-field-branch" open={depth < openDepth}>
          <summary>
            <span class="dn-key" title={key}>{key}</span>
            <span class="dn-summary">{Array.isArray(field) ? `${field.length} item${field.length === 1 ? "" : "s"}` : summarize(field)}</span>
          </summary>
          <div class="dn-body">
            <Self value={field} path={[...path, key]} depth={depth + 1} {readOnly} {openDepth} {onset} {onremove} {onappend} {onmove} />
          </div>
        </details>
      {/if}
    {:else}
      <p class="dn-empty">No fields.</p>
    {/each}
  </div>
{/if}

<style>
  .dn-fields {
    display: flex;
    flex-direction: column;
  }

  .dn-field {
    display: grid;
    grid-template-columns: minmax(96px, 200px) minmax(0, 1fr);
    align-items: baseline;
    gap: var(--vs-space-3);
    padding: 1px 0;
    border-bottom: 1px solid var(--vs-border-subtle);
  }

  .dn-key {
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-xs);
    color: var(--vs-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dn-value {
    min-width: 0;
  }

  .dn-input {
    width: 100%;
    box-sizing: border-box;
    padding: 2px 6px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-primary);
    font: inherit;
    font-size: var(--vs-text-sm);
    line-height: 1.4;
  }

  .dn-input:hover:not([readonly]) {
    border-color: var(--vs-border);
  }

  .dn-input:focus {
    background: var(--vs-bg-surface);
    border-color: var(--vs-border-focus);
    outline: none;
  }

  .dn-number {
    max-width: 160px;
    font-family: var(--vs-font-mono);
    font-variant-numeric: tabular-nums;
  }

  .dn-text {
    resize: vertical;
    display: block;
  }

  .dn-null::placeholder {
    color: var(--vs-text-disabled);
    font-style: italic;
  }

  input[type="checkbox"] {
    accent-color: var(--vs-accent);
    margin: 4px 6px;
  }

  .dn-branch > summary {
    display: flex;
    align-items: baseline;
    gap: var(--vs-space-3);
    padding: 4px 0;
    cursor: pointer;
    list-style: none;
    border-bottom: 1px solid var(--vs-border-subtle);
  }

  .dn-branch > summary::-webkit-details-marker {
    display: none;
  }

  .dn-branch > summary::before {
    content: "▸";
    width: 10px;
    flex-shrink: 0;
    color: var(--vs-text-tertiary);
    font-size: 10px;
  }

  .dn-branch[open] > summary::before {
    content: "▾";
  }

  .dn-branch > summary:hover {
    background: var(--vs-bg-hover);
  }

  .dn-field-branch > summary .dn-key {
    color: var(--vs-text-primary);
    font-weight: var(--vs-font-weight-semibold);
  }

  .dn-summary {
    min-width: 0;
    font-size: var(--vs-text-xs);
    color: var(--vs-text-tertiary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Depth is shown by one rule down the left of what a branch holds, not by a
     box around it: nested boxes would turn a deep file into a set of frames. */
  .dn-body {
    margin-left: 4px;
    padding-left: var(--vs-space-3);
    border-left: 1px solid var(--vs-border);
  }

  .dn-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .dn-item {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: baseline;
    gap: var(--vs-space-2);
  }

  .dn-item > .dn-branch {
    grid-column: 1 / 3;
    min-width: 0;
  }

  .dn-n,
  .dn-index {
    min-width: 2ch;
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-xs);
    color: var(--vs-text-tertiary);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .dn-row-actions {
    display: flex;
    gap: 1px;
    white-space: nowrap;
    opacity: 0.35;
  }

  .dn-item:hover > .dn-row-actions,
  .dn-item:focus-within > .dn-row-actions,
  tr:hover .dn-row-actions,
  tr:focus-within .dn-row-actions {
    opacity: 1;
  }

  .dn-row-actions button {
    width: 20px;
    height: 20px;
    padding: 0;
    background: none;
    border: none;
    border-radius: 2px;
    color: var(--vs-text-secondary);
    font: inherit;
    font-size: var(--vs-text-xs);
    cursor: pointer;
  }

  .dn-row-actions button:hover:not(:disabled) {
    background: var(--vs-bg-hover);
    color: var(--vs-text-primary);
  }

  .dn-row-actions button:disabled {
    color: var(--vs-text-disabled);
    cursor: default;
  }

  .dn-add {
    margin: var(--vs-space-1) 0 var(--vs-space-2);
    padding: 1px var(--vs-space-2);
    background: none;
    border: 1px dashed var(--vs-border);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-secondary);
    font: inherit;
    font-size: var(--vs-text-xs);
    cursor: pointer;
  }

  .dn-add:hover {
    border-style: solid;
    color: var(--vs-text-primary);
  }

  .dn-empty {
    margin: 0;
    padding: 4px 0;
    font-size: var(--vs-text-xs);
    color: var(--vs-text-tertiary);
  }

  .dn-table-wrap {
    overflow-x: auto;
    margin: var(--vs-space-1) 0;
  }

  .dn-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--vs-text-sm);
  }

  .dn-table th {
    padding: 3px 6px;
    border-bottom: 1px solid var(--vs-border);
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-xs);
    font-weight: var(--vs-font-weight-medium);
    color: var(--vs-text-secondary);
    text-align: left;
    white-space: nowrap;
  }

  .dn-table td {
    padding: 0;
    border-bottom: 1px solid var(--vs-border-subtle);
    vertical-align: baseline;
  }

  .dn-table td.dn-index,
  .dn-table th.dn-index {
    padding: 3px 6px;
    width: 1%;
  }

  .dn-table .dn-row-actions {
    padding: 0 2px;
    width: 1%;
  }

  .dn-table .dn-number {
    max-width: none;
    min-width: 7ch;
  }

  .dn-table .dn-input {
    min-width: 8ch;
  }

  :is(button, summary):focus-visible {
    outline: 2px solid var(--vs-border-focus);
    outline-offset: 1px;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
