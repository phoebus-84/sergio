<script lang="ts">
  /**
   * A structured file — JSON or YAML — as fields, and as its source.
   *
   * Most of what a production keeps is structure: a film's manifest, a shot's
   * plan, a cue sheet, a cut. As text it is braces and indentation, and one
   * misplaced comma is a broken file. As fields it is names with values: a
   * number is typed as a number, a list of similar records is a table, and a
   * change touches the one field it names.
   *
   * The two are the same file. An edit to a field rewrites the text — for
   * YAML, with its comments and key order kept — and the text can always be
   * edited directly, which is also the way out when it does not parse.
   */
  import type { ViewerProps } from "$lib/viewer-registry";
  import { appendItem, dataFormatOf, isRecord, moveItem, parseData, removeField, setField, weigh, type DataPath } from "$lib/structured-data";
  import DataNode from "./DataNode.svelte";

  let { path, contentType, content, readOnly, onEdit }: ViewerProps = $props();

  const format = $derived(dataFormatOf(path, contentType) ?? "json");
  const parsed = $derived(parseData(content, format));

  let mode = $state<"fields" | "source">("fields");

  /* A small file opens fully; a large one opens as its outline. */
  const openDepth = $derived(weigh(parsed.value) <= 120 ? 3 : 1);

  /** What kind of document this says it is, when it says: a contract names itself. */
  const identity = $derived.by(() => {
    const value = parsed.value;
    if (!isRecord(value)) return null;
    const kind = typeof value.kind === "string" ? value.kind : null;
    const version = typeof value.apiVersion === "string" ? value.apiVersion : typeof value.schemaVersion === "string" || typeof value.schemaVersion === "number" ? String(value.schemaVersion) : null;
    return kind || version ? [kind, version].filter(Boolean).join(" · ") : null;
  });

  function apply(change: () => string) {
    if (readOnly) return;
    try {
      onEdit(change());
    } catch { /* the text moved under the form: the next parse shows what it is */ }
  }

  const onset = (at: DataPath, value: unknown) => apply(() => setField(content, format, at, value));
  const onremove = (at: DataPath) => apply(() => removeField(content, format, at));
  const onappend = (at: DataPath, item: unknown) => apply(() => appendItem(content, format, at, item));
  const onmove = (at: DataPath, from: number, to: number) => apply(() => moveItem(content, format, at, from, to));

  function reformat() {
    if (format !== "json" || parsed.error) return;
    onEdit(`${JSON.stringify(parsed.value, null, 2)}\n`);
  }
</script>

<div class="data-viewer">
  <div class="dv-bar">
    <div class="dv-modes" role="tablist" aria-label="How the file is shown">
      <button role="tab" aria-selected={mode === "fields"} onclick={() => (mode = "fields")}>Fields</button>
      <button role="tab" aria-selected={mode === "source"} onclick={() => (mode = "source")}>Source</button>
    </div>
    <span class="dv-kind">{format}</span>
    {#if identity}<span class="dv-identity">{identity}</span>{/if}
    {#if parsed.error}
      <span class="dv-error" role="alert">Does not parse: {parsed.error}</span>
    {/if}
    {#if mode === "source" && format === "json" && !parsed.error && !readOnly}
      <button class="dv-tool" onclick={reformat} title="Rewrite with two-space indentation">Reformat</button>
    {/if}
  </div>

  {#if mode === "source" || parsed.error}
    {#if mode === "fields" && parsed.error}
      <p class="dv-note">The file cannot be shown as fields until it parses. Its source is below: fix it there.</p>
    {/if}
    <textarea
      class="dv-source"
      value={content}
      oninput={(e) => onEdit(e.currentTarget.value)}
      readonly={readOnly}
      spellcheck="false"
      aria-label="File source"
    ></textarea>
  {:else}
    <div class="dv-fields">
      <DataNode value={parsed.value} path={[]} depth={0} {readOnly} {openDepth} {onset} {onremove} {onappend} {onmove} />
    </div>
  {/if}
</div>

<style>
  .data-viewer {
    flex: 1;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--vs-bg-canvas);
  }

  .dv-bar {
    display: flex;
    align-items: center;
    gap: var(--vs-space-3);
    padding: 4px var(--vs-space-3);
    border-bottom: 1px solid var(--vs-border);
    background: var(--vs-bg-surface);
    flex-shrink: 0;
    min-width: 0;
  }

  .dv-modes {
    display: flex;
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
    overflow: hidden;
    flex-shrink: 0;
  }

  .dv-modes button {
    padding: 2px var(--vs-space-3);
    background: none;
    border: none;
    color: var(--vs-text-secondary);
    font: inherit;
    font-size: var(--vs-text-xs);
    cursor: pointer;
  }

  .dv-modes button + button {
    border-left: 1px solid var(--vs-border);
  }

  .dv-modes button[aria-selected="true"] {
    background: var(--vs-bg-selected);
    color: var(--vs-accent-strong);
    font-weight: var(--vs-font-weight-semibold);
  }

  .dv-kind,
  .dv-identity {
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-xs);
    color: var(--vs-text-tertiary);
    white-space: nowrap;
  }

  .dv-identity {
    color: var(--vs-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dv-error {
    min-width: 0;
    font-size: var(--vs-text-xs);
    color: var(--vs-state-blocked);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dv-tool {
    margin-left: auto;
    padding: 2px var(--vs-space-2);
    background: none;
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-secondary);
    font: inherit;
    font-size: var(--vs-text-xs);
    cursor: pointer;
  }

  .dv-note {
    margin: 0;
    padding: var(--vs-space-2) var(--vs-space-3);
    background: var(--vs-state-blocked-bg);
    color: var(--vs-state-blocked);
    font-size: var(--vs-text-xs);
    flex-shrink: 0;
  }

  .dv-fields {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: var(--vs-space-3) var(--vs-space-4) var(--vs-space-6);
    /* A field's value is prose or a number, not a line of code: it reads
       better short than stretched across a wide canvas. */
    max-width: 1100px;
  }

  .dv-source {
    flex: 1;
    min-height: 0;
    padding: var(--vs-space-3);
    background: var(--vs-bg-inset);
    border: none;
    color: var(--vs-text-primary);
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-sm);
    line-height: var(--vs-leading-normal);
    tab-size: 2;
    resize: none;
    outline: none;
    white-space: pre;
  }

  button:focus-visible {
    outline: 2px solid var(--vs-border-focus);
    outline-offset: 1px;
  }
</style>
