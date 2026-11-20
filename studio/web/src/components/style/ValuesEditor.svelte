<script lang="ts">
  /**
   * A style's named values, each with the control its type asks for: a slider
   * and a number for a number, a menu for a choice, a switch, a colour picker,
   * a font with the families offered, a line or a paragraph of text.
   */
  import { fieldValueProblem, type ParamField, type ValuesParams } from "@studio/contracts/src/style.mjs";

  interface Props {
    id: string;
    values: ValuesParams;
    onchange: (next: ValuesParams) => void;
  }

  let { id, values, onchange }: Props = $props();

  const HEX = /^#[0-9a-fA-F]{6}$/;

  function set(index: number, value: ParamField["value"]) {
    onchange({ ...values, fields: values.fields.map((f, i) => (i === index ? { ...f, value } : f)) });
  }

  const asNumber = (raw: string): number | string => (raw.trim() === "" || Number.isNaN(Number(raw)) ? raw : Number(raw));
</script>

<div class="values">
  {#if values.description}<p class="ve-note">{values.description}</p>{/if}
  {#each values.fields as field, index (field.id)}
    {@const problem = fieldValueProblem(field, field.value)}
    {@const control = `ve-${id}-${field.id}`}
    <div class="ve-field">
      <label class="ve-label" for={control}>
        {field.label}
        <code>{`{{${id}.${field.id}}}`}</code>
      </label>
      <div class="ve-control">
        {#if field.type === "number"}
          {#if typeof field.min === "number" && typeof field.max === "number"}
            <input
              type="range"
              min={field.min}
              max={field.max}
              step={field.step ?? "any"}
              value={typeof field.value === "number" ? field.value : field.min}
              oninput={(event) => set(index, Number(event.currentTarget.value))}
              aria-label="{field.label}, slider"
            />
          {/if}
          <input
            id={control}
            class="ve-number"
            type="number"
            min={field.min}
            max={field.max}
            step={field.step ?? "any"}
            value={field.value}
            oninput={(event) => set(index, asNumber(event.currentTarget.value))}
            aria-invalid={problem !== null}
          />
          {#if field.unit}<span class="ve-unit">{field.unit}</span>{/if}
        {:else if field.type === "enum"}
          <select id={control} value={field.value} onchange={(event) => set(index, event.currentTarget.value)}>
            {#each field.options ?? [] as option (option)}<option value={option}>{option}</option>{/each}
          </select>
        {:else if field.type === "boolean"}
          <input id={control} type="checkbox" checked={field.value === true} onchange={(event) => set(index, event.currentTarget.checked)} />
          <span class="ve-unit">{field.value === true ? "yes" : "no"}</span>
        {:else if field.type === "color"}
          <input
            type="color"
            value={typeof field.value === "string" && HEX.test(field.value) ? field.value.toLowerCase() : "#000000"}
            oninput={(event) => set(index, event.currentTarget.value)}
            aria-label="{field.label}, colour picker"
          />
          <input id={control} class="ve-hex" value={field.value} oninput={(event) => set(index, event.currentTarget.value.trim())} maxlength="7" aria-invalid={problem !== null} />
        {:else if field.type === "font"}
          <input id={control} list="{control}-families" value={field.value} oninput={(event) => set(index, event.currentTarget.value)} aria-invalid={problem !== null} />
          <datalist id="{control}-families">
            {#each field.options ?? [] as option (option)}<option value={option}></option>{/each}
          </datalist>
          <span class="ve-sample" style="font-family: {String(field.value)}, sans-serif">Aa</span>
        {:else if field.multiline}
          <textarea id={control} rows="2" value={String(field.value)} oninput={(event) => set(index, event.currentTarget.value)}></textarea>
        {:else}
          <input id={control} value={String(field.value)} oninput={(event) => set(index, event.currentTarget.value)} />
        {/if}
      </div>
      {#if field.description}<p class="ve-note">{field.description}</p>{/if}
      {#if problem}<p class="ve-problem" role="alert">{field.label} {problem}</p>{/if}
    </div>
  {/each}
</div>

<style>
  .values {
    display: grid;
    gap: var(--vs-space-2);
  }

  .ve-field {
    display: grid;
    grid-template-columns: 180px 1fr;
    gap: 2px var(--vs-space-3);
    align-items: center;
    font-size: var(--vs-text-sm);
  }

  .ve-label {
    display: grid;
    font-weight: var(--vs-font-weight-medium);
  }

  .ve-label code {
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-xs);
    font-weight: var(--vs-font-weight-normal);
    color: var(--vs-text-tertiary);
  }

  .ve-control {
    display: flex;
    gap: var(--vs-space-2);
    align-items: center;
    min-width: 0;
  }

  .ve-control input:not([type="range"]):not([type="checkbox"]):not([type="color"]),
  .ve-control select,
  .ve-control textarea {
    flex: 1;
    min-width: 0;
    padding: 2px 6px;
    background: var(--vs-bg-surface);
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-primary);
    font: inherit;
    font-size: var(--vs-text-sm);
  }

  .ve-control input[type="range"] {
    flex: 1;
    min-width: 80px;
  }

  .ve-control .ve-number {
    flex: 0 0 80px;
  }

  .ve-control .ve-hex {
    flex: 0 0 90px;
    font-family: var(--vs-font-mono);
  }

  .ve-control input[aria-invalid="true"] {
    border-color: var(--vs-state-blocked);
  }

  .ve-control textarea {
    resize: vertical;
  }

  .ve-unit {
    font-size: var(--vs-text-xs);
    color: var(--vs-text-secondary);
  }

  .ve-sample {
    font-size: var(--vs-text-md);
  }

  .ve-note,
  .ve-problem {
    grid-column: 2;
    margin: 0;
    font-size: var(--vs-text-xs);
    color: var(--vs-text-tertiary);
  }

  .ve-problem {
    color: var(--vs-state-blocked);
  }

  .values > .ve-note {
    grid-column: auto;
  }

  :is(input, select, textarea):focus-visible {
    outline: 2px solid var(--vs-border-focus);
    outline-offset: 1px;
  }

  @media (max-width: 900px) {
    .ve-field {
      grid-template-columns: 1fr;
    }

    .ve-note,
    .ve-problem {
      grid-column: 1;
    }
  }
</style>
