<script lang="ts">
  /**
   * A chain of effects, in the order they are applied.
   *
   * The catalog is the renderer's own: an effect is offered here because the
   * renderer can do it, and its controls are drawn from the parameters it
   * declares — a number as a slider with its range and unit, a choice as a
   * list, a file as a path. An effect switched off stays in the chain with
   * its settings, so a grade can be compared with and without.
   */
  import { film } from "$lib/film-store.svelte.ts";
  import { withEffect } from "$lib/cut-store.svelte.ts";
  import type { CutEffect } from "@studio/contracts/src/cut-timeline.mjs";
  import type { EffectDefinition } from "$lib/film-types";

  interface Props {
    domain: "video" | "audio";
    effects: readonly CutEffect[] | undefined;
    /** The chain changed. `key` joins a slider's run of values into one step back. */
    onchange: (effects: CutEffect[], key?: string) => void;
    disabled?: boolean;
    /** Names the chain in control labels: "clip picture", "track". */
    label: string;
  }

  let { domain, effects, onchange, disabled = false, label }: Props = $props();

  const catalog = $derived(film.effects.filter((effect) => effect.domain === domain));
  const groups = $derived.by(() => {
    const out = new Map<string, EffectDefinition[]>();
    for (const effect of catalog) out.set(effect.group, [...(out.get(effect.group) ?? []), effect]);
    return [...out.entries()];
  });

  const definition = (type: string) => catalog.find((effect) => effect.type === type) ?? null;

  let open = $state<number | null>(null);

  function add(type: string) {
    if (!type) return;
    const chain = [...(effects ?? []), { type }];
    onchange(chain);
    open = chain.length - 1;
  }

  function setParam(index: number, name: string, value: number | string | boolean, joined = false) {
    const effect = effects?.[index];
    if (!effect) return;
    onchange(withEffect(effects, index, { ...effect, params: { ...(effect.params ?? {}), [name]: value } }), joined ? `fx-${label}-${index}-${name}` : undefined);
  }

  function resetParam(index: number, name: string) {
    const effect = effects?.[index];
    if (!effect?.params) return;
    const params = { ...effect.params };
    delete params[name];
    const next: CutEffect = { ...effect };
    if (Object.keys(params).length > 0) next.params = params;
    else delete next.params;
    onchange(withEffect(effects, index, next));
  }

  function toggle(index: number) {
    const effect = effects?.[index];
    if (!effect) return;
    const next: CutEffect = { ...effect };
    if (effect.enabled === false) delete next.enabled;
    else next.enabled = false;
    onchange(withEffect(effects, index, next));
  }

  function move(index: number, by: -1 | 1) {
    const chain = [...(effects ?? [])];
    const to = index + by;
    if (to < 0 || to >= chain.length) return;
    [chain[index], chain[to]] = [chain[to]!, chain[index]!];
    onchange(chain);
    if (open === index) open = to;
  }

  function remove(index: number) {
    onchange(withEffect(effects, index, null));
    open = null;
  }

  function summary(effect: CutEffect): string {
    const params = Object.entries(effect.params ?? {});
    if (params.length === 0) return "defaults";
    return params.map(([name, value]) => `${name} ${typeof value === "number" ? Math.round(value * 100) / 100 : value}`).join(", ");
  }
</script>

<div class="fx">
  {#if (effects ?? []).length === 0}
    <p class="fx-none">None.</p>
  {:else}
    <ol class="fx-chain">
      {#each effects ?? [] as effect, index (index)}
        {@const def = definition(effect.type)}
        <li class="fx-item" class:off={effect.enabled === false} class:unknown={!def}>
          <div class="fx-row">
            <input
              type="checkbox"
              checked={effect.enabled !== false}
              {disabled}
              aria-label="{def?.title ?? effect.type} on the {label}: applied"
              title="Applied. Clear to compare without it."
              onchange={() => toggle(index)}
            />
            <button class="fx-name" aria-expanded={open === index} onclick={() => (open = open === index ? null : index)}>
              <span class="fx-title">{def?.title ?? effect.type}</span>
              <span class="fx-summary">{def ? summary(effect) : "the renderer does not know this effect"}</span>
            </button>
            <button class="fx-icon" {disabled} aria-label="Apply {def?.title ?? effect.type} earlier" title="Earlier in the chain" onclick={() => move(index, -1)}>↑</button>
            <button class="fx-icon" {disabled} aria-label="Apply {def?.title ?? effect.type} later" title="Later in the chain" onclick={() => move(index, 1)}>↓</button>
            <button class="fx-icon" {disabled} aria-label="Remove {def?.title ?? effect.type}" title="Remove" onclick={() => remove(index)}>×</button>
          </div>

          {#if open === index && def}
            <div class="fx-params">
              <p class="fx-about">{def.description}</p>
              {#each Object.entries(def.params) as [name, param] (name)}
                {@const value = effect.params?.[name]}
                {@const id = `fx-${label.replace(/\W+/g, "-")}-${index}-${name}`}
                <div class="fx-param">
                  <label for={id} title={param.description}>{name}</label>
                  {#if param.kind === "number"}
                    <input
                      {id}
                      type="range"
                      min={param.min}
                      max={param.max}
                      step={param.step ?? (param.max - param.min <= 4 ? 0.01 : param.max - param.min <= 40 ? 0.1 : 1)}
                      value={typeof value === "number" ? value : param.default}
                      {disabled}
                      oninput={(e) => setParam(index, name, e.currentTarget.valueAsNumber, true)}
                    />
                    <input
                      class="fx-number"
                      type="number"
                      min={param.min}
                      max={param.max}
                      step="any"
                      aria-label="{name}, as a number"
                      value={typeof value === "number" ? value : param.default}
                      {disabled}
                      onchange={(e) => Number.isFinite(e.currentTarget.valueAsNumber) && setParam(index, name, Math.min(param.max, Math.max(param.min, e.currentTarget.valueAsNumber)))}
                    />
                    <span class="fx-unit">{param.unit ?? ""}</span>
                  {:else if param.kind === "enum"}
                    <select {id} {disabled} value={typeof value === "string" ? value : param.default} onchange={(e) => setParam(index, name, e.currentTarget.value)}>
                      {#each param.values as option (option)}<option value={option}>{option}</option>{/each}
                    </select>
                  {:else if param.kind === "boolean"}
                    <input {id} type="checkbox" {disabled} checked={typeof value === "boolean" ? value : param.default} onchange={(e) => setParam(index, name, e.currentTarget.checked)} />
                  {:else if param.kind === "color"}
                    <input {id} type="color" {disabled} value={typeof value === "string" ? value : param.default} onchange={(e) => setParam(index, name, e.currentTarget.value)} />
                  {:else}
                    <input
                      {id}
                      class="fx-file"
                      type="text"
                      spellcheck="false"
                      placeholder={param.extensions.map((ext) => `.${ext.replace(/^\./, "")}`).join(" ")}
                      {disabled}
                      value={typeof value === "string" ? value : ""}
                      onchange={(e) => (e.currentTarget.value.trim() ? setParam(index, name, e.currentTarget.value.trim()) : resetParam(index, name))}
                    />
                  {/if}
                  {#if value !== undefined && param.kind !== "file"}
                    <button class="fx-reset" {disabled} title="Back to the default" aria-label="Reset {name}" onclick={() => resetParam(index, name)}>reset</button>
                  {/if}
                </div>
              {:else}
                <p class="fx-about">Nothing to set.</p>
              {/each}
            </div>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}

  <select class="fx-add" aria-label="Add an effect to the {label}" disabled={disabled || catalog.length === 0} onchange={(e) => { add(e.currentTarget.value); e.currentTarget.value = ""; }}>
    <option value="">{catalog.length === 0 ? "The effect catalog is not loaded" : "Add an effect…"}</option>
    {#each groups as [group, items] (group)}
      <optgroup label={group}>
        {#each items as item (item.type)}<option value={item.type} title={item.description}>{item.title}</option>{/each}
      </optgroup>
    {/each}
  </select>
</div>

<style>
  .fx {
    display: flex;
    flex-direction: column;
    gap: var(--vs-space-1);
  }

  .fx-none {
    margin: 0;
    font-size: var(--vs-text-xs);
    color: var(--vs-text-tertiary);
  }

  .fx-chain {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
  }

  .fx-item + .fx-item {
    border-top: 1px solid var(--vs-border-subtle);
  }

  .fx-item.off .fx-name {
    color: var(--vs-text-tertiary);
    text-decoration: line-through;
  }

  .fx-item.unknown .fx-summary {
    color: var(--vs-state-blocked);
  }

  .fx-row {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 2px 2px 2px var(--vs-space-2);
  }

  .fx-row input[type="checkbox"] {
    accent-color: var(--vs-accent);
    margin: 0 var(--vs-space-1) 0 0;
  }

  .fx-name {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: baseline;
    gap: var(--vs-space-2);
    padding: 4px 0;
    background: none;
    border: none;
    color: var(--vs-text-primary);
    font: inherit;
    font-size: var(--vs-text-sm);
    text-align: left;
    cursor: pointer;
  }

  .fx-title {
    flex-shrink: 0;
  }

  .fx-summary {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--vs-font-mono);
    font-size: 10px;
    color: var(--vs-text-tertiary);
    text-decoration: none;
  }

  .fx-icon {
    width: 22px;
    height: 22px;
    padding: 0;
    background: none;
    border: none;
    border-radius: 2px;
    color: var(--vs-text-tertiary);
    font: inherit;
    font-size: var(--vs-text-sm);
    cursor: pointer;
  }

  .fx-icon:hover:not(:disabled) {
    background: var(--vs-bg-hover);
    color: var(--vs-text-primary);
  }

  .fx-params {
    padding: var(--vs-space-1) var(--vs-space-2) var(--vs-space-2);
    background: var(--vs-bg-inset);
    border-top: 1px solid var(--vs-border-subtle);
  }

  .fx-about {
    margin: 0 0 var(--vs-space-1);
    font-size: var(--vs-text-xs);
    color: var(--vs-text-secondary);
    line-height: var(--vs-leading-normal);
  }

  .fx-param {
    display: grid;
    grid-template-columns: 76px minmax(0, 1fr) auto auto auto;
    align-items: center;
    gap: var(--vs-space-1);
    min-height: 24px;
  }

  .fx-param label {
    font-size: var(--vs-text-xs);
    color: var(--vs-text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .fx-param input[type="range"] {
    min-width: 0;
    accent-color: var(--vs-accent);
  }

  .fx-number {
    width: 58px;
  }

  .fx-number,
  .fx-file,
  .fx-param select,
  .fx-add {
    padding: 2px 4px;
    background: var(--vs-bg-surface);
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-primary);
    font: inherit;
    font-size: var(--vs-text-xs);
  }

  .fx-number,
  .fx-file {
    font-family: var(--vs-font-mono);
  }

  .fx-file {
    grid-column: 2 / -1;
    min-width: 0;
  }

  .fx-unit {
    min-width: 14px;
    font-size: 10px;
    color: var(--vs-text-tertiary);
  }

  .fx-reset {
    padding: 0 2px;
    background: none;
    border: none;
    color: var(--vs-text-tertiary);
    font: inherit;
    font-size: 10px;
    text-decoration: underline;
    cursor: pointer;
  }

  .fx-add {
    align-self: flex-start;
    max-width: 100%;
    color: var(--vs-text-secondary);
    cursor: pointer;
  }

  button:focus-visible,
  select:focus-visible,
  input:focus-visible {
    outline: 2px solid var(--vs-border-focus);
    outline-offset: 1px;
  }
</style>
