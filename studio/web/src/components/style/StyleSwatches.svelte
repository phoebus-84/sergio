<script lang="ts">
  /** A style's colours, small: what it looks like before anything is read. */
  interface Props {
    swatches: { name: string; value: string }[];
    size?: number;
  }

  let { swatches, size = 14 }: Props = $props();
</script>

<span class="swatches" role="img" aria-label={swatches.map((s) => `${s.name} ${s.value}`).join(", ")}>
  {#each swatches as swatch (swatch.name + swatch.value)}
    <span class="swatch" style="background: {swatch.value}; width: {size}px; height: {size}px" title="{swatch.name} {swatch.value}"></span>
  {/each}
</span>

<style>
  .swatches {
    display: inline-flex;
    gap: 2px;
    vertical-align: middle;
  }

  .swatch {
    display: inline-block;
    border-radius: 2px;
    box-shadow: inset 0 0 0 1px var(--vs-border-subtle);
  }
</style>
