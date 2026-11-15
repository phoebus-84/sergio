/**
 * The cut being edited: a draft of a unit's cut timeline, what is selected in
 * it, where the playhead is, and the way back from every change.
 *
 * A person edits the draft; nothing reaches the library until they save, and
 * a save names the revision the draft was made on, so an edit the agent made
 * meanwhile is never overwritten — the draft is refused and the person is told
 * to take the new cut. Every problem of the draft is known as it is made: the
 * contract's own check runs in the browser.
 */

import {
  clipEnd, cutDuration, emptyCut, validateCutTimeline,
  type CutClip, type CutEffect, type CutMarker, type CutProblem, type CutTimeline, type CutTrack,
} from "@studio/contracts/src/cut-timeline.mjs";
import { filmApi, FilmApiError, gatewayUrl } from "./film-api";
import { unitPath, type CutStatus } from "./film-types";
import type { Unit } from "./film-store.svelte.ts";

export type CutSelection =
  | { kind: "clip"; id: string }
  | { kind: "track"; id: string }
  | { kind: "master" }
  | null;

interface CutView {
  cut: CutTimeline | null;
  exists: boolean;
  hash: string | null;
  status: CutStatus;
  notes?: string[];
}

const HISTORY_LIMIT = 100;

const snapshot = (cut: CutTimeline): string => JSON.stringify(cut);

class CutStore {
  unit = $state<Unit | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);

  /** The cut as the library has it. */
  saved = $state<CutTimeline | null>(null);
  status = $state<CutStatus | null>(null);
  /** The cut as it is being edited. */
  draft = $state<CutTimeline | null>(null);

  selection = $state<CutSelection>(null);
  /** Frames. */
  playhead = $state(0);
  /** Pixels per frame. */
  zoom = $state(4);

  /** What the last request said: a save refused, an assembly's notes. */
  notice = $state<{ tone: "error" | "info"; text: string } | null>(null);
  /** Problems a deep check found: files and effects, which the browser cannot see. */
  deepProblems = $state<CutProblem[] | null>(null);
  saving = $state(false);

  /** The composed frame at the playhead, when one was asked for. */
  frame = $state<{ url: string; frame: number; revision: number } | null>(null);
  frameLoading = $state(false);

  #requests = 0;
  #past: string[] = [];
  #future: string[] = [];
  historyDepth = $state({ past: 0, future: 0 });

  get dirty(): boolean {
    if (!this.draft) return false;
    return this.saved === null ? cutDuration(this.draft) > 0 || this.draft.tracks.length !== 2 : snapshot(this.draft) !== snapshot(this.saved);
  }

  get problems(): CutProblem[] {
    return this.draft ? validateCutTimeline(this.draft) : [];
  }

  get frames(): number {
    return this.draft ? cutDuration(this.draft) : 0;
  }

  get fps(): number {
    return this.draft?.format.fps ?? 24;
  }

  get selectedClip(): { track: CutTrack; clip: CutClip } | null {
    const selection = this.selection;
    if (selection?.kind !== "clip" || !this.draft) return null;
    for (const track of this.draft.tracks) {
      const clip = track.clips.find((c) => c.id === selection.id);
      if (clip) return { track, clip };
    }
    return null;
  }

  get selectedTrack(): CutTrack | null {
    const selection = this.selection;
    if (selection?.kind !== "track" || !this.draft) return null;
    return this.draft.tracks.find((t) => t.id === selection.id) ?? null;
  }

  // ── Loading and saving ────────────────────────────────────────────────

  async load(unit: Unit, format?: { id?: string; width: number; height: number; fps: number }): Promise<void> {
    const same = this.unit && this.unit.film === unit.film && this.unit.scene === unit.scene && this.unit.shot === unit.shot;
    this.unit = unit;
    if (!same) {
      this.draft = null;
      this.saved = null;
      this.status = null;
      this.selection = null;
      this.playhead = 0;
      this.frame = null;
      this.deepProblems = null;
      this.notice = null;
      this.#past = [];
      this.#future = [];
      this.#depth();
    }
    this.loading = !same;
    // Only the last request speaks: an answer for a unit the person has left is dropped.
    const request = ++this.#requests;
    try {
      const view = await filmApi<CutView>(`${unitPath(unit)}/cut`);
      if (request !== this.#requests) return;
      this.#take(view, format, same === true);
      this.error = null;
    } catch (error) {
      if (request === this.#requests) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (request === this.#requests) this.loading = false;
    }
  }

  /** Take the library's cut. A draft with changes of its own is kept: the person decides what to do with it. */
  #take(view: CutView, format: { id?: string; width: number; height: number; fps: number } | undefined, keepDraft: boolean): void {
    const hadChanges = keepDraft && this.dirty;
    this.saved = view.cut;
    this.status = view.status;
    if (hadChanges) {
      if (view.cut && this.draft && view.cut.revision !== this.draft.revision) {
        this.notice = { tone: "error", text: `The cut was changed elsewhere (revision ${view.cut.revision}) while you were editing revision ${this.draft.revision}. Discard your changes to take it, or save to be told what conflicts.` };
      }
      return;
    }
    if (view.cut) this.draft = structuredClone(view.cut);
    else if (format && this.unit) {
      this.draft = { ...emptyCut({ channel: this.unit.film, series: this.unit.scene, episode: this.unit.shot }, format), revision: 0 };
    } else this.draft = null;
  }

  async save(): Promise<boolean> {
    const unit = this.unit;
    const draft = this.draft;
    if (!unit || !draft) return false;
    this.saving = true;
    try {
      const view = await filmApi<CutView>(`${unitPath(unit)}/cut`, { method: "PUT", body: { cut: draft, expectedRevision: this.saved?.revision ?? 0 } });
      this.saved = view.cut;
      this.status = view.status;
      this.draft = view.cut ? structuredClone(view.cut) : null;
      this.notice = { tone: "info", text: `Saved as revision ${view.cut?.revision ?? "?"}.` };
      this.deepProblems = null;
      return true;
    } catch (error) {
      const located = error instanceof FilmApiError ? error.problems.slice(0, 3).map((p) => `${p.path} ${p.message}`).join("; ") : "";
      this.notice = { tone: "error", text: `${error instanceof Error ? error.message : String(error)}${located ? ` — ${located}` : ""}` };
      return false;
    } finally {
      this.saving = false;
    }
  }

  discard(): void {
    this.draft = this.saved ? ($state.snapshot(this.saved) as CutTimeline) : this.draft && this.unit
      ? { ...emptyCut({ channel: this.unit.film, series: this.unit.scene, episode: this.unit.shot }, this.draft.format), revision: 0 }
      : null;
    this.#past = [];
    this.#future = [];
    this.#depth();
    this.notice = null;
    this.selection = null;
  }

  /** Make the unit's cut from what is under it, or bring it in step. Refused while the draft has unsaved changes. */
  async assemble(options: Record<string, unknown> = {}): Promise<boolean> {
    const unit = this.unit;
    if (!unit) return false;
    if (this.dirty) {
      this.notice = { tone: "error", text: "Save or discard your changes first: assembling rewrites the picture track from the library's cut." };
      return false;
    }
    try {
      const view = await filmApi<CutView>(`${unitPath(unit)}/cut/assemble`, { method: "POST", body: options });
      this.saved = view.cut;
      this.status = view.status;
      this.draft = view.cut ? structuredClone(view.cut) : null;
      this.notice = { tone: "info", text: (view.notes ?? []).join(" · ") || "Assembled." };
      return true;
    } catch (error) {
      this.notice = { tone: "error", text: error instanceof Error ? error.message : String(error) };
      return false;
    }
  }

  /** Ask the gateway what a render would refuse or warn about: the files and effects the browser cannot check. */
  async check(): Promise<void> {
    const unit = this.unit;
    if (!unit) return;
    try {
      const { problems } = await filmApi<{ problems: CutProblem[] }>(`${unitPath(unit)}/cut/check`);
      this.deepProblems = problems;
      this.notice = problems.length === 0
        ? { tone: "info", text: "Checked: nothing stands in the way of a render." }
        : { tone: problems.some((p) => p.severity === "error") ? "error" : "info", text: `Checked: ${problems.length} thing${problems.length === 1 ? "" : "s"} to look at.` };
    } catch (error) {
      this.notice = { tone: "error", text: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The frame the saved cut shows at the playhead, composed by the renderer with every effect. */
  async showFrame(): Promise<void> {
    const unit = this.unit;
    if (!unit || !this.saved || this.frameLoading) return;
    this.frameLoading = true;
    try {
      const at = Math.min(this.playhead, Math.max(0, cutDuration(this.saved) - 1));
      const result = await filmApi<{ url: string; frame: number }>(`${unitPath(unit)}/cut/frame`, { method: "POST", body: { frame: at, width: 960 } });
      this.frame = { url: `${gatewayUrl(result.url)}?t=${Date.now()}`, frame: result.frame, revision: this.saved.revision };
    } catch (error) {
      this.notice = { tone: "error", text: error instanceof Error ? error.message : String(error) };
    } finally {
      this.frameLoading = false;
    }
  }

  // ── Changing the draft ────────────────────────────────────────────────

  #depth(): void {
    this.historyDepth = { past: this.#past.length, future: this.#future.length };
  }

  /**
   * Change the draft. `key` joins a run of small changes — a drag, a slider —
   * into one step back: a change with the key of the one before it does not
   * add a step.
   */
  mutate(change: (cut: CutTimeline) => void, key?: string): void {
    if (!this.draft) return;
    const before = snapshot(this.draft);
    change(this.draft);
    if (snapshot(this.draft) === before) return;
    if (!key || key !== this.#lastKey) {
      this.#past.push(before);
      if (this.#past.length > HISTORY_LIMIT) this.#past.shift();
    }
    this.#lastKey = key ?? null;
    this.#future = [];
    this.#depth();
  }

  #lastKey: string | null = null;

  /** End a run of joined changes: the next one is its own step. */
  commit(): void {
    this.#lastKey = null;
  }

  undo(): void {
    const previous = this.#past.pop();
    if (!previous || !this.draft) return;
    this.#future.push(snapshot(this.draft));
    this.draft = JSON.parse(previous) as CutTimeline;
    this.#lastKey = null;
    this.#depth();
  }

  redo(): void {
    const next = this.#future.pop();
    if (!next || !this.draft) return;
    this.#past.push(snapshot(this.draft));
    this.draft = JSON.parse(next) as CutTimeline;
    this.#lastKey = null;
    this.#depth();
  }

  #find(cut: CutTimeline, id: string): { track: CutTrack; clip: CutClip } | null {
    for (const track of cut.tracks) {
      const clip = track.clips.find((c) => c.id === id);
      if (clip) return { track, clip };
    }
    return null;
  }

  /** Whether a clip may be changed here: a locked clip, or one on a locked track, is unlocked first. */
  editable(id: string): boolean {
    const found = this.draft ? this.#find(this.draft, id) : null;
    return !!found && !found.clip.locked && !found.track.locked;
  }

  setClip(id: string, patch: Partial<CutClip> & Record<string, unknown>, key?: string): void {
    this.mutate((cut) => {
      const found = this.#find(cut, id);
      if (!found) return;
      for (const [field, value] of Object.entries(patch)) {
        if (value === null || value === undefined || (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0)) {
          delete (found.clip as unknown as Record<string, unknown>)[field];
        } else (found.clip as unknown as Record<string, unknown>)[field] = value;
      }
      found.track.clips.sort((a, b) => a.at - b.at);
    }, key);
  }

  /** Move a clip to a frame, and to another track of its kind when one is named. */
  moveClip(id: string, at: number, trackId?: string, key?: string): void {
    this.mutate((cut) => {
      const found = this.#find(cut, id);
      if (!found) return;
      const target = trackId ? cut.tracks.find((t) => t.id === trackId) : found.track;
      if (target && target !== found.track && target.kind === found.track.kind && !target.locked) {
        found.track.clips = found.track.clips.filter((c) => c !== found.clip);
        target.clips.push(found.clip);
        target.clips.sort((a, b) => a.at - b.at);
      }
      found.clip.at = Math.max(0, Math.round(at));
      (target ?? found.track).clips.sort((a, b) => a.at - b.at);
    }, key);
  }

  /** Move one edge of a clip. The start edge moves the clip's start in its source with it, at its speed. */
  trimClip(id: string, edge: "start" | "end", frame: number, key?: string): void {
    this.mutate((cut) => {
      const found = this.#find(cut, id);
      if (!found) return;
      const clip = found.clip;
      const fps = cut.format.fps;
      if (edge === "end") {
        clip.duration = Math.max(1, Math.round(frame) - clip.at);
        return;
      }
      const end = clipEnd(clip);
      const start = Math.min(end - 1, Math.max(0, Math.round(frame)));
      const delta = start - clip.at;
      const source = (clip.in ?? 0) + (delta / fps) * (clip.speed ?? 1);
      // A clip cannot start before its source does: the edge stops there.
      const allowed = source < 0 ? start - Math.round((source * fps) / (clip.speed ?? 1)) : start;
      const moved = allowed - clip.at;
      clip.in = Math.max(0, Math.round(((clip.in ?? 0) + (moved / fps) * (clip.speed ?? 1)) * 1000) / 1000);
      if (clip.in === 0) delete clip.in;
      clip.at = allowed;
      clip.duration = end - allowed;
    }, key);
  }

  removeClip(id: string, ripple = false): void {
    this.mutate((cut) => {
      const found = this.#find(cut, id);
      if (!found) return;
      found.track.clips = found.track.clips.filter((c) => c !== found.clip);
      if (ripple) for (const clip of found.track.clips) if (clip.at >= found.clip.at) clip.at = Math.max(0, clip.at - found.clip.duration);
    });
    if (this.selection?.kind === "clip" && this.selection.id === id) this.selection = null;
  }

  /** Cut the selected clip in two at the playhead. */
  splitAtPlayhead(): void {
    const selected = this.selectedClip;
    if (!selected || !(this.playhead > selected.clip.at && this.playhead < clipEnd(selected.clip))) return;
    const id = selected.clip.id;
    const at = this.playhead;
    this.mutate((cut) => {
      const found = this.#find(cut, id);
      if (!found) return;
      const { clip, track } = found;
      const taken = new Set(cut.tracks.flatMap((t) => t.clips.map((c) => c.id)));
      let newId = `${id}-b`;
      for (let k = 2; taken.has(newId); k++) newId = `${id}-b${k}`;
      const first = at - clip.at;
      const second: CutClip = { ...structuredClone($state.snapshot(clip) as CutClip), id: newId, at, duration: clip.duration - first };
      second.in = Math.round(((clip.in ?? 0) + (first / cut.format.fps) * (clip.speed ?? 1)) * 1000) / 1000;
      delete second.transitionIn;
      if (track.kind === "audio") delete second.fadeIn;
      else if (second.audio) delete second.audio.fadeIn;
      clip.duration = first;
      delete clip.transitionOut;
      if (track.kind === "audio") delete clip.fadeOut;
      else if (clip.audio) delete clip.audio.fadeOut;
      track.clips.push(second);
      track.clips.sort((a, b) => a.at - b.at);
    });
  }

  setTrack(id: string, patch: Partial<CutTrack> & Record<string, unknown>, key?: string): void {
    this.mutate((cut) => {
      const track = cut.tracks.find((t) => t.id === id);
      if (!track) return;
      for (const [field, value] of Object.entries(patch)) {
        if (value === null || value === undefined) delete (track as unknown as Record<string, unknown>)[field];
        else (track as unknown as Record<string, unknown>)[field] = value;
      }
    }, key);
  }

  addTrack(kind: "video" | "audio", role?: CutTrack["role"]): void {
    this.mutate((cut) => {
      const prefix = kind === "video" ? "v" : "a";
      let n = cut.tracks.filter((t) => t.kind === kind).length + 1;
      while (cut.tracks.some((t) => t.id === `${prefix}${n}`)) n += 1;
      const names: Record<string, string> = { overlay: "Overlay", dialogue: "Dialogue", music: "Music", effects: "Effects", ambience: "Ambience", picture: "Picture" };
      const track: CutTrack = { id: `${prefix}${n}`, kind, name: role ? names[role]! : kind === "video" ? "Picture" : "Sound", ...(role ? { role } : {}), clips: [] };
      // Picture tracks stack upwards; a new one goes on top of the others, sound after the sound.
      const last = cut.tracks.map((t) => t.kind).lastIndexOf(kind);
      cut.tracks.splice(last >= 0 ? last + 1 : cut.tracks.length, 0, track);
      this.selection = { kind: "track", id: track.id };
    });
  }

  removeTrack(id: string): void {
    this.mutate((cut) => {
      if (cut.tracks.length <= 1) return;
      cut.tracks = cut.tracks.filter((t) => t.id !== id);
      for (const track of cut.tracks) {
        if (!track.duck) continue;
        track.duck.under = track.duck.under.filter((u) => u !== id);
        if (track.duck.under.length === 0) delete track.duck;
      }
    });
    if (this.selection?.kind === "track" && this.selection.id === id) this.selection = null;
  }

  /** Put a new clip on a track at the playhead (or at the track's end when something is in the way). */
  addClip(trackId: string, source: CutClip["source"], frames: number, label?: string): void {
    this.mutate((cut) => {
      const track = cut.tracks.find((t) => t.id === trackId);
      if (!track) return;
      const taken = new Set(cut.tracks.flatMap((t) => t.clips.map((c) => c.id)));
      const base = (source.unit ?? source.path?.split("/").pop()?.replace(/\.[^.]+$/, "") ?? source.project?.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "clip")
        .toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "clip";
      let id = base;
      for (let k = 2; taken.has(id); k++) id = `${base}-${k}`;
      const duration = Math.max(1, Math.round(frames));
      let at = this.playhead;
      if (track.kind === "video" && track.clips.some((c) => c.at < at + duration && clipEnd(c) > at)) {
        at = track.clips.reduce((end, c) => Math.max(end, clipEnd(c)), 0);
      }
      track.clips.push({ id, ...(label ? { label } : {}), source, at, duration });
      track.clips.sort((a, b) => a.at - b.at);
      this.selection = { kind: "clip", id };
    });
  }

  setMaster(patch: Partial<NonNullable<CutTimeline["master"]>> & Record<string, unknown>, key?: string): void {
    this.mutate((cut) => {
      const master = { ...(cut.master ?? {}) } as Record<string, unknown>;
      for (const [field, value] of Object.entries(patch)) {
        if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) delete master[field];
        else master[field] = value;
      }
      if (Object.keys(master).length === 0) delete cut.master;
      else cut.master = master as NonNullable<CutTimeline["master"]>;
    }, key);
  }

  setMarker(marker: CutMarker): void {
    this.mutate((cut) => {
      cut.markers = [...(cut.markers ?? []).filter((m) => m.id !== marker.id), marker].sort((a, b) => a.at - b.at);
    });
  }

  removeMarker(id: string): void {
    this.mutate((cut) => {
      cut.markers = (cut.markers ?? []).filter((m) => m.id !== id);
      if (cut.markers.length === 0) delete cut.markers;
    });
  }

  /** The frames a dragged edge snaps to: every clip's edges, the markers, the playhead and zero. */
  snapPoints(excludeClip?: string): number[] {
    const points = new Set<number>([0, this.playhead]);
    for (const track of this.draft?.tracks ?? []) {
      for (const clip of track.clips) {
        if (clip.id === excludeClip) continue;
        points.add(clip.at);
        points.add(clipEnd(clip));
      }
    }
    for (const marker of this.draft?.markers ?? []) points.add(marker.at);
    return [...points];
  }

  /** `frame` moved to the nearest snap point within `pixels` of it, or left where it is. */
  snap(frame: number, pixels = 8, excludeClip?: string): number {
    const reach = pixels / this.zoom;
    let best = frame;
    let distance = reach;
    for (const point of this.snapPoints(excludeClip)) {
      const d = Math.abs(point - frame);
      if (d <= distance) {
        best = point;
        distance = d;
      }
    }
    return Math.round(best);
  }
}

export const cut = new CutStore();

/** A list of effects with one changed, as a new list: what a form hands back to the store. */
export function withEffect(effects: readonly CutEffect[] | undefined, index: number, change: CutEffect | null): CutEffect[] {
  const next = [...(effects ?? [])];
  if (change === null) next.splice(index, 1);
  else if (index >= next.length) next.push(change);
  else next[index] = change;
  return next;
}
