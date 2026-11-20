<script lang="ts">
  /**
   * A palette, edited: a colour picker and the hex beside it for every colour,
   * its name and what it is for. Colours are added and removed within the
   * bounds the style declares. Nothing is saved here: the panel saves.
   */
  import type { PaletteParams } from "@studio/contracts/src/style.mjs";
  import { inkOn, withColor, withoutColor } from "$lib/style-edit";

  interface Props {
    id: string;
    palette: PaletteParams;
    onchange: (next: PaletteParams) => void;
  }

  let { id, palette, onchange }: Props = $props();

  const HEX = /^#[0-9a-fA-F]{6}$/;

  function set(index: number, patch: { value?: string; name?: string; role?: string | undefined }) {
    onchange({
      ...palette,
      colors: palette.colors.map((c, i) => {
        if (i !== index) return c;
        const { role, ...rest } = { ...c, ...patch };
        // An emptied role is no role: the file keeps no empty field.
        return role ? { ...rest, role } : rest;
      }),
    });
  }

  const canAdd = $derived(typeof palette.max !== "number" || palette.colors.length < palette.max);
  const canRemove = $derived(typeof palette.min !== "number" || palette.colors.length > palette.min);
</script>

<div class="palette">
  {#if palette.description}<p class="pe-note">{palette.description}</p>{/if}
  <ul class="pe-colors">
    {#each palette.colors as color, index (color.id)}
      <li class="pe-color">
        <label class="pe-chip" style="background: {HEX.test(color.value) ? color.value : 'transparent'}; color: {inkOn(color.value)}">
          <input
            type="color"
            value={HEX.test(color.value) ? color.value.toLowerCase() : "#000000"}
            oninput={(event) => set(index, { value: event.currentTarget.value })}
            aria-label="{color.name}: colour"
          />
          <span class="pe-id">{color.id}</span>
        </label>
        <div class="pe-fields">
          <input
            class="pe-hex"
            class:pe-bad={!HEX.test(color.value)}
            value={color.value}
            oninput={(event) => set(index, { value: event.currentTarget.value.trim() })}
            aria-label="{color.name}: hex"
            aria-invalid={!HEX.test(color.value)}
            maxlength="7"
            spellcheck="false"
          />
          <input class="pe-name" value={color.name} oninput={(event) => set(index, { name: event.currentTarget.value })} aria-label="{color.id}: name" maxlength="60" />
          <input
            class="pe-role"
            value={color.role ?? ""}
            placeholder="what it is for"
            oninput={(event) => set(index, { role: event.currentTarget.value || undefined })}
            aria-label="{color.name}: role"
            maxlength="160"
          />
        </div>
        <button class="pe-remove" disabled={!canRemove} onclick={() => onchange(withoutColor(palette, color.id))} aria-label="Remove {color.name}" title={canRemove ? "Remove this colour" : `The style holds at least ${palette.min} colours`}>×</button>
      </li>
    {/each}
  </ul>
  <button class="pe-add" disabled={!canAdd} onclick={() => onchange(withColor(palette))} title={canAdd ? "Add a colour" : `The style allows at most ${palette.max} colours`}>+ Colour</button>
  <p class="pe-note">The brief names these as <code>{`{{${id}.<id>}}`}</code>; a colour removed here that the brief still names will be refused on save.</p>
</div>

<style>
  .palette {
    display: grid;
    gap: var(--vs-space-2);
  }

  .pe-colors {
    display: grid;
    gap: var(--vs-space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .pe-color {
    display: grid;
    grid-template-columns: 72px 1fr auto;
    gap: var(--vs-space-2);
    align-items: center;
  }

  .pe-chip {
    position: relative;
    display: flex;
    align-items: flex-end;
    height: 40px;
    padding: 2px 4px;
    border-radius: var(--vs-radius-sm);
    box-shadow: inset 0 0 0 1px var(--vs-border);
    cursor: pointer;
  }

  .pe-chip input[type="color"] {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    cursor: pointer;
  }

  .pe-chip:focus-within {
    outline: 2px solid var(--vs-border-focus);
    outline-offset: 1px;
  }

  .pe-id {
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-xs);
  }

  .pe-fields {
    display: grid;
    grid-template-columns: 80px 1fr;
    gap: 2px var(--vs-space-1);
    min-width: 0;
  }

  .pe-role {
    grid-column: 1 / -1;
  }

  .pe-fields input {
    min-width: 0;
    padding: 2px 6px;
    background: var(--vs-bg-surface);
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-primary);
    font: inherit;
    font-size: var(--vs-text-xs);
  }

  .pe-hex {
    font-family: var(--vs-font-mono) !important;
  }

  .pe-bad {
    border-color: var(--vs-state-blocked) !important;
  }

  .pe-remove,
  .pe-add {
    padding: 2px var(--vs-space-2);
    background: none;
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-secondary);
    font: inherit;
    font-size: var(--vs-text-xs);
    cursor: pointer;
  }

  .pe-add {
    justify-self: start;
    border-style: dashed;
  }

  button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .pe-note {
    margin: 0;
    font-size: var(--vs-text-xs);
    color: var(--vs-text-tertiary);
  }

  code {
    font-family: var(--vs-font-mono);
  }

  input:focus-visible,
  button:focus-visible {
    outline: 2px solid var(--vs-border-focus);
    outline-offset: 1px;
  }
</style>
