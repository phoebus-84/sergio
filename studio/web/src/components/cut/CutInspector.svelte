<script lang="ts">
  /**
   * What is selected in the cut, as fields.
   *
   * A clip: where it sits, what part of its source it shows, how it enters and
   * leaves, its picture and sound effects. A track: its level, what it ducks
   * under, the effects on everything it carries. Nothing selected: the cut as
   * a whole — its master chain, its loudness target, its markers.
   *
   * Every field writes the draft at once and joins its run of changes into
   * one step back, so a level dragged from 0 to −12 is undone in one.
   */
  import { cut } from "$lib/cut-store.svelte.ts";
  import { FITS, TRACK_ROLES, TRANSITIONS, clipEnd, sourceKind, type CutClip, type CutEffect, type CutTrack, type CutTransitionType } from "@studio/contracts/src/cut-timeline.mjs";
  import { timecode } from "@studio/contracts/src/film.mjs";
  import EffectStack from "./EffectStack.svelte";

  const draft = $derived(cut.draft);
  const fps = $derived(cut.fps);
  const selected = $derived(cut.selectedClip);
  const track = $derived(cut.selectedTrack);
  const master = $derived(cut.selection?.kind === "master" || cut.selection === null);

  const clip = $derived(selected?.clip ?? null);
  const onPicture = $derived(selected?.track.kind === "video");
  const locked = $derived(!!clip && (clip.locked === true || selected?.track.locked === true));

  /** A number from a field, or null when the field was emptied: null removes the key. */
  function numberOf(event: Event, min = -Infinity, max = Infinity): number | null {
    const value = (event.currentTarget as HTMLInputElement).valueAsNumber;
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : null;
  }

  function setClip(patch: Record<string, unknown>, key?: string) {
    if (clip) cut.setClip(clip.id, patch as Partial<CutClip>, key ? `clip-${clip.id}-${key}` : undefined);
  }

  /** A picture clip's own sound: the keys live under `audio`, which goes when it is empty. */
  function setClipAudio(patch: Record<string, unknown>, key?: string) {
    if (!clip) return;
    const audio = { ...(clip.audio ?? {}) } as Record<string, unknown>;
    for (const [field, value] of Object.entries(patch)) {
      if (value === null || value === undefined || value === false || (Array.isArray(value) && value.length === 0)) delete audio[field];
      else audio[field] = value;
    }
    setClip({ audio: Object.keys(audio).length > 0 ? audio : null }, key);
  }

  function setTransition(edge: "transitionIn" | "transitionOut", type: string, duration?: number | null) {
    if (!clip) return;
    if (!type) return setClip({ [edge]: null });
    const frames = duration ?? clip[edge]?.duration ?? Math.min(clip.duration, Math.round(fps / 2));
    setClip({ [edge]: { type: type as CutTransitionType, duration: Math.max(1, Math.min(clip.duration, Math.round(frames))) } }, `${edge}`);
  }

  function effectsChange(field: "effects", effects: CutEffect[], key?: string) {
    setClip({ [field]: effects.length > 0 ? effects : null }, key);
  }

  function setTrack(patch: Record<string, unknown>, key?: string) {
    if (track) cut.setTrack(track.id, patch as Partial<CutTrack>, key ? `track-${track.id}-${key}` : undefined);
  }

  function toggleDuck(under: string, on: boolean) {
    if (!track) return;
    const current = track.duck?.under ?? [];
    const next = on ? [...current, under] : current.filter((id) => id !== under);
    setTrack({ duck: next.length > 0 ? { gain: -9, ...(track.duck ?? {}), under: next } : null });
  }

  const others = $derived((draft?.tracks ?? []).filter((t) => t.id !== track?.id));
  const roles = $derived(TRACK_ROLES.filter((role) => (track?.kind === "video" ? role === "picture" || role === "overlay" : role !== "picture" && role !== "overlay")));

  const problems = $derived([...cut.problems, ...(cut.deepProblems ?? []).filter((deep) => !cut.problems.some((p) => p.path === deep.path && p.code === deep.code))]);

  /** The problems that point at the selected clip. */
  const clipProblems = $derived.by(() => {
    if (!clip || !draft) return [];
    return problems.filter((problem) => {
      const match = /^\$\.tracks\[(\d+)\]\.clips\[(\d+)\]/.exec(problem.path);
      return match ? draft.tracks[Number(match[1])]?.clips[Number(match[2])]?.id === clip.id : false;
    });
  });

  function goTo(path: string) {
    const match = /^\$\.tracks\[(\d+)\](?:\.clips\[(\d+)\])?/.exec(path);
    if (!match || !draft) return;
    const t = draft.tracks[Number(match[1])];
    const c = match[2] !== undefined ? t?.clips[Number(match[2])] : undefined;
    if (c) {
      cut.selection = { kind: "clip", id: c.id };
      cut.playhead = c.at;
    } else if (t) cut.selection = { kind: "track", id: t.id };
  }

  function sourceText(c: CutClip): string {
    const kind = sourceKind(c.source);
    if (kind === "unit") return c.source.unit!;
    if (kind === "color") return c.source.color!;
    return c.source.path ?? c.source.project ?? "";
  }

  const SOURCE_LABEL = { unit: "render of", path: "file", project: "film file", color: "colour" } as const;
</script>

{#if !draft}
  <p class="in-empty">No cut is open.</p>
{:else if clip && selected}
  <div class="inspector" aria-label="Clip {clip.id}">
    <header class="in-head">
      <span class="in-kind">{onPicture ? "Picture clip" : "Sound clip"}</span>
      <code class="in-id">{clip.id}</code>
    </header>

    {#each clipProblems as problem (problem.path + problem.code)}
      <p class="in-problem" data-severity={problem.severity} role={problem.severity === "error" ? "alert" : "note"}>{problem.message}</p>
    {/each}

    <fieldset class="in-group" disabled={locked}>
      <legend class="sr-only">Clip</legend>
      <label class="in-field in-wide">
        <span>Label</span>
        <input type="text" value={clip.label ?? ""} placeholder={sourceText(clip).split("/").pop()} oninput={(e) => setClip({ label: e.currentTarget.value || null }, "label")} />
      </label>
      <div class="in-field in-wide">
        <span>{SOURCE_LABEL[sourceKind(clip.source) ?? "path"]}</span>
        {#if sourceKind(clip.source) === "color"}
          <input type="color" aria-label="Colour" value={clip.source.color} onchange={(e) => setClip({ source: { color: e.currentTarget.value } })} />
        {:else}
          <code class="in-source" title={sourceText(clip)}>{sourceText(clip)}</code>
        {/if}
      </div>

      <label class="in-field">
        <span>Starts at</span>
        <input type="number" min="0" step="1" value={clip.at} onchange={(e) => { const v = numberOf(e, 0); if (v !== null) cut.moveClip(clip.id, v); }} />
        <small>{timecode(clip.at, fps)}</small>
      </label>
      <label class="in-field">
        <span>Length</span>
        <input type="number" min="1" step="1" value={clip.duration} onchange={(e) => { const v = numberOf(e, 1); if (v !== null) setClip({ duration: Math.round(v) }); }} />
        <small>{(clip.duration / fps).toFixed(2)} s · ends {timecode(clipEnd(clip), fps)}</small>
      </label>
      {#if sourceKind(clip.source) !== "color"}
        <label class="in-field">
          <span>Source from</span>
          <input type="number" min="0" step="0.01" value={clip.in ?? 0} onchange={(e) => { const v = numberOf(e, 0); setClip({ in: v ? Math.round(v * 1000) / 1000 : null }); }} />
          <small>seconds into the source</small>
        </label>
        <label class="in-field">
          <span>Speed</span>
          <input type="number" min="0.1" max="10" step="0.05" value={clip.speed ?? 1} onchange={(e) => { const v = numberOf(e, 0.1, 10); setClip({ speed: v && v !== 1 ? v : null }); }} />
          <small>× · uses {((clip.duration / fps) * (clip.speed ?? 1)).toFixed(2)} s of source</small>
        </label>
      {/if}
    </fieldset>

    {#if onPicture}
      <fieldset class="in-group" disabled={locked}>
        <legend>Picture</legend>
        <label class="in-field">
          <span>Fit</span>
          <select value={clip.fit ?? "cover"} onchange={(e) => setClip({ fit: e.currentTarget.value === "cover" ? null : e.currentTarget.value })}>
            {#each FITS as fit (fit)}<option value={fit}>{fit}</option>{/each}
          </select>
        </label>
        <label class="in-field">
          <span>Opacity</span>
          <input type="range" min="0" max="1" step="0.01" value={clip.opacity ?? 1} oninput={(e) => { const v = numberOf(e, 0, 1); setClip({ opacity: v !== null && v < 1 ? v : null }, "opacity"); }} />
          <small>{Math.round((clip.opacity ?? 1) * 100)}%</small>
        </label>
        {#each [["transitionIn", "Enters with"], ["transitionOut", "Leaves with"]] as const as [edge, title] (edge)}
          <div class="in-field in-wide in-pair">
            <span>{title}</span>
            <select aria-label={title} value={clip[edge]?.type ?? ""} onchange={(e) => setTransition(edge, e.currentTarget.value)}>
              <option value="">a cut</option>
              {#each TRANSITIONS as type (type)}<option value={type}>{type}</option>{/each}
            </select>
            {#if clip[edge]}
              <input type="number" min="1" max={clip.duration} step="1" aria-label="{title}: frames" value={clip[edge]!.duration} onchange={(e) => { const v = numberOf(e, 1, clip.duration); if (v !== null) setTransition(edge, clip[edge]!.type, v); }} />
              <small>frames</small>
            {/if}
          </div>
        {/each}
        <div class="in-stack">
          <span class="in-stack-title">Picture effects</span>
          <EffectStack domain="video" label="clip picture" effects={clip.effects} disabled={locked} onchange={(effects, key) => effectsChange("effects", effects, key)} />
        </div>
      </fieldset>

      {#if sourceKind(clip.source) !== "color"}
        <fieldset class="in-group" disabled={locked}>
          <legend>Its sound</legend>
          <label class="in-check">
            <input type="checkbox" checked={clip.audio?.mute === true} onchange={(e) => setClipAudio({ mute: e.currentTarget.checked })} />
            Silent: the picture without its sound
          </label>
          <label class="in-field">
            <span>Level</span>
            <input type="number" min="-60" max="24" step="0.5" value={clip.audio?.gain ?? 0} onchange={(e) => { const v = numberOf(e, -60, 24); setClipAudio({ gain: v || null }); }} />
            <small>dB</small>
          </label>
          <label class="in-field">
            <span>Fade in</span>
            <input type="number" min="0" max={clip.duration} step="1" value={clip.audio?.fadeIn ?? 0} onchange={(e) => { const v = numberOf(e, 0, clip.duration); setClipAudio({ fadeIn: v || null }); }} />
            <small>frames</small>
          </label>
          <label class="in-field">
            <span>Fade out</span>
            <input type="number" min="0" max={clip.duration} step="1" value={clip.audio?.fadeOut ?? 0} onchange={(e) => { const v = numberOf(e, 0, clip.duration); setClipAudio({ fadeOut: v || null }); }} />
            <small>frames</small>
          </label>
          <div class="in-stack">
            <span class="in-stack-title">Sound effects</span>
            <EffectStack domain="audio" label="clip sound" effects={clip.audio?.effects} disabled={locked} onchange={(effects, key) => setClipAudio({ effects }, key)} />
          </div>
        </fieldset>
      {/if}
    {:else}
      <fieldset class="in-group" disabled={locked}>
        <legend>Sound</legend>
        <label class="in-field">
          <span>Level</span>
          <input type="number" min="-60" max="24" step="0.5" value={clip.gain ?? 0} onchange={(e) => { const v = numberOf(e, -60, 24); setClip({ gain: v || null }); }} />
          <small>dB</small>
        </label>
        <label class="in-field">
          <span>Fade in</span>
          <input type="number" min="0" max={clip.duration} step="1" value={clip.fadeIn ?? 0} onchange={(e) => { const v = numberOf(e, 0, clip.duration); setClip({ fadeIn: v || null }); }} />
          <small>frames</small>
        </label>
        <label class="in-field">
          <span>Fade out</span>
          <input type="number" min="0" max={clip.duration} step="1" value={clip.fadeOut ?? 0} onchange={(e) => { const v = numberOf(e, 0, clip.duration); setClip({ fadeOut: v || null }); }} />
          <small>frames</small>
        </label>
        <div class="in-stack">
          <span class="in-stack-title">Effects</span>
          <EffectStack domain="audio" label="clip" effects={clip.effects} disabled={locked} onchange={(effects, key) => effectsChange("effects", effects, key)} />
        </div>
      </fieldset>
    {/if}

    <fieldset class="in-group">
      <legend>Notes and lock</legend>
      <label class="in-field in-wide in-top">
        <span>Note</span>
        <textarea rows="2" value={clip.note ?? ""} placeholder="Why this take, what to fix" oninput={(e) => setClip({ note: e.currentTarget.value || null }, "note")}></textarea>
      </label>
      <label class="in-check">
        <input type="checkbox" checked={clip.locked === true} disabled={selected.track.locked === true} onchange={(e) => setClip({ locked: e.currentTarget.checked || null })} />
        Locked: the agent and assembly leave this clip as it is
      </label>
      {#if selected.track.locked}<p class="in-hint">Its track is locked, which locks every clip on it.</p>{/if}
      <div class="in-actions">
        <button disabled={locked} onclick={() => cut.removeClip(clip.id)}>Remove</button>
        <button disabled={locked} onclick={() => cut.removeClip(clip.id, true)} title="Remove it and close the gap it leaves">Remove and close gap</button>
      </div>
    </fieldset>
  </div>
{:else if track}
  <div class="inspector" aria-label="Track {track.id}">
    <header class="in-head">
      <span class="in-kind">{track.kind === "video" ? "Picture track" : "Sound track"}</span>
      <code class="in-id">{track.id}</code>
    </header>

    <fieldset class="in-group">
      <legend class="sr-only">Track</legend>
      <label class="in-field in-wide">
        <span>Name</span>
        <input type="text" value={track.name ?? ""} placeholder={track.id} oninput={(e) => setTrack({ name: e.currentTarget.value || null }, "name")} />
      </label>
      <label class="in-field">
        <span>Carries</span>
        <select value={track.role ?? ""} onchange={(e) => setTrack({ role: e.currentTarget.value || null })}>
          <option value="">unspecified</option>
          {#each roles as role (role)}<option value={role}>{role}</option>{/each}
        </select>
      </label>
      <label class="in-field">
        <span>Level</span>
        <input type="number" min="-60" max="24" step="0.5" value={track.gain ?? 0} onchange={(e) => { const v = numberOf(e, -60, 24); setTrack({ gain: v || null }); }} />
        <small>dB{track.kind === "video" ? " · its clips' sound" : ""}</small>
      </label>
      <label class="in-check">
        <input type="checkbox" checked={track.muted === true} onchange={(e) => setTrack({ muted: e.currentTarget.checked || null })} />
        Muted: left out of the render
      </label>
      <label class="in-check">
        <input type="checkbox" checked={track.locked === true} onchange={(e) => setTrack({ locked: e.currentTarget.checked || null })} />
        Locked: the agent and assembly leave this track as it is
      </label>
    </fieldset>

    {#if track.kind === "audio"}
      <fieldset class="in-group">
        <legend>Ducks under</legend>
        <p class="in-hint">This track drops while the chosen ones sound: music under dialogue.</p>
        {#each others as other (other.id)}
          <label class="in-check">
            <input type="checkbox" checked={track.duck?.under.includes(other.id) ?? false} onchange={(e) => toggleDuck(other.id, e.currentTarget.checked)} />
            {other.name ?? other.id} <code>{other.id}</code>
          </label>
        {/each}
        {#if track.duck}
          <label class="in-field">
            <span>Drops by</span>
            <input type="number" min="-40" max="-1" step="0.5" value={track.duck.gain} onchange={(e) => { const v = numberOf(e, -40, -1); if (v !== null) setTrack({ duck: { ...track.duck, gain: v } }); }} />
            <small>dB</small>
          </label>
          <label class="in-field">
            <span>Falls in</span>
            <input type="number" min="0.01" max="5" step="0.01" value={track.duck.attack ?? 0.2} onchange={(e) => { const v = numberOf(e, 0.01, 5); if (v !== null) setTrack({ duck: { ...track.duck, attack: v } }); }} />
            <small>s</small>
          </label>
          <label class="in-field">
            <span>Returns in</span>
            <input type="number" min="0.01" max="10" step="0.01" value={track.duck.release ?? 0.6} onchange={(e) => { const v = numberOf(e, 0.01, 10); if (v !== null) setTrack({ duck: { ...track.duck, release: v } }); }} />
            <small>s</small>
          </label>
        {/if}
      </fieldset>
    {/if}

    <fieldset class="in-group">
      <legend>Effects on the whole track</legend>
      <EffectStack domain={track.kind} label="track" effects={track.effects} onchange={(effects, key) => setTrack({ effects: effects.length > 0 ? effects : null }, key)} />
    </fieldset>

    <div class="in-actions">
      <button disabled={draft.tracks.length <= 1} onclick={() => cut.removeTrack(track.id)} title="Remove the track and its {track.clips.length} clip{track.clips.length === 1 ? '' : 's'}">Remove track</button>
    </div>
  </div>
{:else if master}
  <div class="inspector" aria-label="The whole cut">
    <header class="in-head">
      <span class="in-kind">The whole cut</span>
      <code class="in-id">{draft.format.width}×{draft.format.height} · {draft.format.fps} fps</code>
    </header>

    {#if problems.length > 0}
      <fieldset class="in-group">
        <legend>To look at ({problems.length})</legend>
        <ul class="in-problems">
          {#each problems as problem (problem.path + problem.code)}
            <li data-severity={problem.severity}>
              <button onclick={() => goTo(problem.path)} title="Select what this is about">
                <span class="in-sev">{problem.severity === "error" ? "Stops a render" : "Warning"}</span>
                {problem.message}
              </button>
            </li>
          {/each}
        </ul>
      </fieldset>
    {/if}

    <fieldset class="in-group">
      <legend>Finishing: picture</legend>
      <p class="in-hint">Applied to the composed frame, after every clip: a grade over the whole cut.</p>
      <EffectStack domain="video" label="master picture" effects={draft.master?.video} onchange={(effects, key) => cut.setMaster({ video: effects }, key ? `master-${key}` : undefined)} />
    </fieldset>

    <fieldset class="in-group">
      <legend>Finishing: sound</legend>
      <EffectStack domain="audio" label="master sound" effects={draft.master?.audio} onchange={(effects, key) => cut.setMaster({ audio: effects }, key ? `master-${key}` : undefined)} />
      <label class="in-check">
        <input
          type="checkbox"
          checked={!!draft.master?.loudness}
          onchange={(e) => cut.setMaster({ loudness: e.currentTarget.checked ? { integrated: -16, truePeak: -1.5 } : null } as Record<string, unknown>)}
        />
        Bring the mix to a loudness target
      </label>
      {#if draft.master?.loudness}
        {@const loudness = draft.master.loudness}
        <label class="in-field">
          <span>Integrated</span>
          <input type="number" min="-40" max="-5" step="0.5" value={loudness.integrated} onchange={(e) => { const v = numberOf(e, -40, -5); if (v !== null) cut.setMaster({ loudness: { ...loudness, integrated: v } }); }} />
          <small>LUFS · −16 online, −23 broadcast, −27 cinema</small>
        </label>
        <label class="in-field">
          <span>True peak</span>
          <input type="number" min="-9" max="0" step="0.1" value={loudness.truePeak} onchange={(e) => { const v = numberOf(e, -9, 0); if (v !== null) cut.setMaster({ loudness: { ...loudness, truePeak: v } }); }} />
          <small>dBTP</small>
        </label>
      {/if}
    </fieldset>

    <fieldset class="in-group">
      <legend>Markers</legend>
      {#each draft.markers ?? [] as marker (marker.id)}
        <div class="in-marker">
          <button class="in-marker-at" onclick={() => (cut.playhead = marker.at)} title="Go to the marker">{timecode(marker.at, fps)}</button>
          <input type="text" aria-label="Marker label" value={marker.label ?? ""} onchange={(e) => cut.setMarker({ ...marker, label: e.currentTarget.value })} />
          <button class="in-x" aria-label="Remove marker {marker.label ?? ''}" onclick={() => cut.removeMarker(marker.id)}>×</button>
        </div>
      {:else}
        <p class="in-hint">None. A marker names an instant: a beat, a note for the mix, where a scene turns.</p>
      {/each}
    </fieldset>
  </div>
{/if}

<style>
  .inspector {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
    padding-bottom: var(--vs-space-4);
  }

  .in-empty {
    margin: 0;
    padding: var(--vs-space-4);
    font-size: var(--vs-text-sm);
    color: var(--vs-text-tertiary);
  }

  .in-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--vs-space-2);
    padding: var(--vs-space-2) var(--vs-space-3);
    border-bottom: 1px solid var(--vs-border);
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--vs-bg-surface);
  }

  .in-kind {
    font-size: var(--vs-text-sm);
    font-weight: var(--vs-font-weight-semibold);
  }

  .in-id {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-xs);
    color: var(--vs-text-tertiary);
  }

  .in-group {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--vs-space-2) var(--vs-space-3);
    margin: 0;
    padding: var(--vs-space-3);
    border: none;
    border-bottom: 1px solid var(--vs-border-subtle);
    min-width: 0;
  }

  .in-group > legend {
    float: left;
    grid-column: 1 / -1;
    width: 100%;
    padding: 0;
    margin-bottom: var(--vs-space-1);
    font-size: var(--vs-text-xs);
    font-weight: var(--vs-font-weight-semibold);
    color: var(--vs-text-secondary);
  }

  .in-group > :global(*) {
    grid-column: 1 / -1;
  }

  .in-group > .in-field:not(.in-wide) {
    grid-column: auto;
  }

  .in-group:disabled {
    opacity: 0.6;
  }

  .in-field {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
    min-width: 0;
    font-size: var(--vs-text-xs);
  }

  .in-field > span {
    color: var(--vs-text-secondary);
  }

  .in-field small {
    font-size: 10px;
    color: var(--vs-text-tertiary);
    font-variant-numeric: tabular-nums;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .in-pair {
    grid-template-columns: 76px minmax(0, 1fr) 56px auto;
    align-items: center;
    gap: var(--vs-space-1);
  }

  .in-top textarea {
    resize: vertical;
    min-height: 40px;
  }

  input[type="text"],
  input[type="number"],
  select,
  textarea {
    min-width: 0;
    width: 100%;
    box-sizing: border-box;
    padding: 3px 6px;
    background: var(--vs-bg-canvas);
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-primary);
    font: inherit;
    font-size: var(--vs-text-sm);
  }

  input[type="number"] {
    font-family: var(--vs-font-mono);
    font-variant-numeric: tabular-nums;
  }

  input[type="range"] {
    width: 100%;
    accent-color: var(--vs-accent);
  }

  input[type="color"] {
    width: 44px;
    height: 24px;
    padding: 0;
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
    background: none;
  }

  .in-source {
    padding: 3px 0;
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-xs);
    color: var(--vs-text-primary);
    overflow-wrap: anywhere;
  }

  .in-check {
    display: flex;
    align-items: baseline;
    gap: var(--vs-space-2);
    font-size: var(--vs-text-xs);
    color: var(--vs-text-primary);
    line-height: var(--vs-leading-normal);
  }

  .in-check input {
    accent-color: var(--vs-accent);
    margin: 0;
    transform: translateY(2px);
  }

  .in-check code {
    font-family: var(--vs-font-mono);
    color: var(--vs-text-tertiary);
  }

  .in-hint {
    margin: 0;
    font-size: var(--vs-text-xs);
    color: var(--vs-text-tertiary);
    line-height: var(--vs-leading-normal);
  }

  .in-stack {
    display: flex;
    flex-direction: column;
    gap: var(--vs-space-1);
  }

  .in-stack-title {
    font-size: var(--vs-text-xs);
    color: var(--vs-text-secondary);
  }

  .in-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--vs-space-2);
    padding: 0;
  }

  .inspector > .in-actions {
    padding: var(--vs-space-3);
  }

  .in-actions button {
    padding: 3px var(--vs-space-2);
    background: none;
    border: 1px solid var(--vs-border);
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-secondary);
    font: inherit;
    font-size: var(--vs-text-xs);
    cursor: pointer;
  }

  .in-actions button:hover:not(:disabled) {
    border-color: var(--vs-state-blocked);
    color: var(--vs-state-blocked);
  }

  .in-actions button:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .in-problem {
    margin: 0;
    padding: var(--vs-space-2) var(--vs-space-3);
    border-bottom: 1px solid var(--vs-border-subtle);
    font-size: var(--vs-text-xs);
    line-height: var(--vs-leading-normal);
    color: var(--vs-state-attention);
    background: var(--vs-state-attention-bg);
  }

  .in-problem[data-severity="error"] {
    color: var(--vs-state-blocked);
    background: var(--vs-state-blocked-bg);
  }

  .in-problems {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .in-problems button {
    width: 100%;
    padding: 4px 6px;
    background: var(--vs-state-attention-bg);
    border: none;
    border-radius: var(--vs-radius-sm);
    color: var(--vs-text-primary);
    font: inherit;
    font-size: var(--vs-text-xs);
    line-height: var(--vs-leading-normal);
    text-align: left;
    cursor: pointer;
  }

  .in-problems li[data-severity="error"] button {
    background: var(--vs-state-blocked-bg);
  }

  .in-sev {
    display: block;
    font-weight: var(--vs-font-weight-semibold);
    color: var(--vs-state-attention);
  }

  .in-problems li[data-severity="error"] .in-sev {
    color: var(--vs-state-blocked);
  }

  .in-marker {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--vs-space-1);
  }

  .in-marker-at {
    padding: 2px 4px;
    background: none;
    border: none;
    color: var(--vs-accent-strong);
    font-family: var(--vs-font-mono);
    font-size: var(--vs-text-xs);
    cursor: pointer;
  }

  .in-x {
    width: 22px;
    height: 22px;
    padding: 0;
    background: none;
    border: none;
    color: var(--vs-text-tertiary);
    cursor: pointer;
  }

  :is(button, input, select, textarea):focus-visible {
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
