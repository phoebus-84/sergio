// ---------------------------------------------------------------------------
// A unit's cut on disk: read, checked, written, edited
// ---------------------------------------------------------------------------
// `artifacts/cut.json` is edited by the agent and by a person, sometimes in
// the same hour. Every write goes through here: the document is held to its
// contract, its revision goes up by one, and a writer that names the revision
// it read is refused when someone else wrote in between. The read, the check
// and the write are held together by a lock (cut-lock.ts), so that holds
// between two processes too.
//
// An edit is a list of small operations, applied together or not at all. A
// clip or a track a person locked is left as it is by the agent: that is how
// one shot of an automatic film stays hand-made.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CUT_TIMELINE_PATH, clipEnd, cutDuration, emptyCut, hasCutErrors, validateCutTimeline,
  type CutClip, type CutFormat, type CutMarker, type CutMaster, type CutProblem, type CutTimeline, type CutTrack,
} from "@studio/contracts/src/cut-timeline.mjs";
import type { FilmManifest } from "@studio/contracts/src/film.mjs";
import { writeAtomically } from "./authoring.js";
import { withCutLock, type CutLockOptions } from "./cut-lock.js";
import { FilmError, existingUnitDir, filmUnit, readManifest, unitDir, unitLabel, type UnitRef } from "./units.js";

export type { CutTimeline, CutClip, CutTrack, CutProblem };

export const serialize = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
export const sha256 = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");

export const cutPath = (root: string, ref: UnitRef): string => join(unitDir(root, ref), CUT_TIMELINE_PATH);

export interface StoredCut {
  /** The parsed cut, when the file is there and is JSON. */
  cut: CutTimeline | null;
  exists: boolean;
  /** sha256 of the file's bytes; null when there is none. */
  hash: string | null;
  problems: CutProblem[];
}

/** A unit's cut as it is on disk, with what is wrong with it. Never throws for a bad file. */
export function readCut(root: string, ref: UnitRef): StoredCut {
  const path = cutPath(root, ref);
  if (!existsSync(path)) return { cut: null, exists: false, hash: null, problems: [] };
  const text = readFileSync(path, "utf-8");
  const hash = sha256(text);
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { cut: null, exists: true, hash, problems: [{ code: "json", path: "$", message: `${CUT_TIMELINE_PATH} is not JSON: ${error instanceof Error ? error.message : String(error)}`, severity: "error" }] };
  }
  const problems = validateCutTimeline(doc);
  const usable = doc !== null && typeof doc === "object" && !Array.isArray(doc) && Array.isArray((doc as CutTimeline).tracks);
  return { cut: usable ? (doc as CutTimeline) : null, exists: true, hash, problems };
}

/** The format a film's cuts are made in: its manifest's. */
export function formatOf(root: string, ref: UnitRef): CutFormat {
  const { manifest } = readManifest<FilmManifest>(root, filmUnit(ref.channel));
  const format = manifest?.format;
  if (!format || !Number.isInteger(format.width) || !Number.isInteger(format.height) || !Number.isInteger(format.fps)) {
    throw new FilmError(`${ref.channel}/film.yaml states no usable format`, "bad-manifest");
  }
  return { id: format.id, width: format.width, height: format.height, fps: format.fps };
}

export interface WriteCutOptions extends CutLockOptions {
  /** The revision the writer read. A cut that moved on since is not overwritten. */
  expectedRevision?: number;
}

/** Check and write a cut. The caller holds the cut's lock. */
function storeCut(root: string, ref: UnitRef, cut: CutTimeline, expectedRevision: number | undefined, stillHeld: () => void): CutTimeline {
  const stored = readCut(root, ref);
  const current = stored.cut?.revision ?? 0;
  if (expectedRevision !== undefined && expectedRevision !== current) {
    throw new FilmError(
      `the cut of ${unitLabel(ref)} is at revision ${current}, not ${expectedRevision}: someone changed it since it was read. Read it again and repeat the edit`,
      "revision-conflict",
    );
  }
  const next: CutTimeline = { ...cut, unit: { channel: ref.channel, series: ref.series, episode: ref.episode }, revision: current + 1 };
  const problems = validateCutTimeline(next);
  if (hasCutErrors(problems)) {
    const errors = problems.filter((p) => p.severity === "error");
    throw new FilmError(`the cut of ${unitLabel(ref)} was not written: ${errors.map((p) => `${p.path} ${p.message}`).slice(0, 5).join("; ")}`, "invalid-cut", problems);
  }
  stillHeld();
  writeAtomically(cutPath(root, ref), serialize(next));
  return next;
}

/**
 * Write a unit's cut. Refused when it has an error, or when `expectedRevision`
 * is not the revision on disk. The stored revision is the previous one plus one.
 * One writer at a time, on this machine: two that name the same revision
 * cannot both be accepted.
 */
export function writeCut(root: string, ref: UnitRef, cut: CutTimeline, options: WriteCutOptions = {}): CutTimeline {
  existingUnitDir(root, ref);
  return withCutLock(cutPath(root, ref), unitLabel(ref), (stillHeld) => storeCut(root, ref, cut, options.expectedRevision, stillHeld), options);
}

/** The unit's cut, or an empty one in the film's format when it has none yet. */
export function cutOrEmpty(root: string, ref: UnitRef): CutTimeline {
  const stored = readCut(root, ref);
  if (stored.exists && !stored.cut) throw new FilmError(`the cut of ${unitLabel(ref)} cannot be read: ${stored.problems[0]?.message ?? "it is not a cut"}`, "invalid-cut", stored.problems);
  return stored.cut ?? { ...emptyCut(ref, formatOf(root, ref)), revision: 0 };
}

// ── Editing ─────────────────────────────────────────────────────────────────

type Patch<T> = { [K in keyof T]?: T[K] | null };

export type CutOp =
  | { op: "add-track"; track: Omit<CutTrack, "clips"> & { clips?: CutClip[] }; index?: number }
  | { op: "remove-track"; track: string }
  | { op: "set-track"; track: string; set: Patch<Omit<CutTrack, "id" | "kind" | "clips">> }
  | { op: "add-clip"; track: string; clip: Omit<CutClip, "at"> & { at?: number }; after?: string; ripple?: boolean }
  | { op: "set-clip"; clip: string; set: Patch<Omit<CutClip, "id">> }
  | { op: "remove-clip"; clip: string; ripple?: boolean }
  | { op: "move-clip"; clip: string; at?: number; track?: string; after?: string | null; ripple?: boolean }
  | { op: "split-clip"; clip: string; at: number; newId: string }
  | { op: "set-master"; set: Patch<CutMaster> }
  | { op: "set-marker"; marker: CutMarker }
  | { op: "remove-marker"; marker: string };

export type Editor = "agent" | "person";

function applyPatch<T extends object>(target: T, patch: Patch<T>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete (target as Record<string, unknown>)[key];
    else if (value !== undefined) (target as Record<string, unknown>)[key] = value;
  }
}

const sortByStart = (track: CutTrack): void => {
  track.clips.sort((a, b) => a.at - b.at);
};

/**
 * Apply operations to a cut, in order, to a copy. Nothing is written.
 *
 * The agent cannot change, move or remove a clip a person locked, nor a clip
 * of a locked track, nor lock or unlock anything: locking is how a person
 * says "this one is mine".
 */
export function applyCutOps(cut: CutTimeline, ops: readonly CutOp[], editor: Editor = "person"): CutTimeline {
  const next = structuredClone(cut);
  const refuse = (index: number, message: string): never => {
    throw new FilmError(`operation ${index + 1} (${ops[index]!.op}): ${message}`, "bad-edit");
  };
  const trackOf = (index: number, id: string): CutTrack => next.tracks.find((track) => track.id === id) ?? refuse(index, `there is no track "${id}"`);
  const find = (index: number, id: string): { track: CutTrack; clip: CutClip; position: number } => {
    for (const track of next.tracks) {
      const position = track.clips.findIndex((clip) => clip.id === id);
      if (position >= 0) return { track, clip: track.clips[position]!, position };
    }
    return refuse(index, `there is no clip "${id}"`);
  };
  const guard = (index: number, track: CutTrack, clip?: CutClip): void => {
    if (editor !== "agent") return;
    if (track.locked) refuse(index, `track "${track.id}" is locked by a person`);
    if (clip?.locked) refuse(index, `clip "${clip.id}" is locked by a person`);
  };
  const guardLock = (index: number, patch: { locked?: unknown }): void => {
    if (editor === "agent" && patch.locked !== undefined) refuse(index, "only a person locks or unlocks");
  };
  /** Shift every clip of a track that starts at or after a frame. */
  const shift = (track: CutTrack, from: number, by: number, except?: CutClip): void => {
    for (const clip of track.clips) if (clip !== except && clip.at >= from) clip.at = Math.max(0, clip.at + by);
  };

  ops.forEach((operation, index) => {
    switch (operation.op) {
      case "add-track": {
        if (next.tracks.some((track) => track.id === operation.track.id)) refuse(index, `track "${operation.track.id}" already exists`);
        guardLock(index, operation.track);
        const track: CutTrack = { ...operation.track, clips: operation.track.clips ?? [] };
        next.tracks.splice(operation.index ?? next.tracks.length, 0, track);
        break;
      }
      case "remove-track": {
        const track = trackOf(index, operation.track);
        guard(index, track);
        if (editor === "agent" && track.clips.some((clip) => clip.locked)) refuse(index, `track "${track.id}" has a clip locked by a person`);
        if (next.tracks.length === 1) refuse(index, "a cut keeps at least one track");
        next.tracks = next.tracks.filter((candidate) => candidate !== track);
        for (const other of next.tracks) {
          if (!other.duck) continue;
          other.duck.under = other.duck.under.filter((id) => id !== track.id);
          if (other.duck.under.length === 0) delete other.duck;
        }
        break;
      }
      case "set-track": {
        const track = trackOf(index, operation.track);
        guard(index, track);
        guardLock(index, operation.set);
        applyPatch(track, operation.set);
        break;
      }
      case "add-clip": {
        const track = trackOf(index, operation.track);
        guard(index, track);
        guardLock(index, operation.clip);
        if (next.tracks.some((t) => t.clips.some((clip) => clip.id === operation.clip.id))) refuse(index, `clip "${operation.clip.id}" already exists`);
        let at = operation.clip.at;
        if (operation.after !== undefined) {
          const anchor = track.clips.find((clip) => clip.id === operation.after) ?? refuse(index, `track "${track.id}" has no clip "${operation.after}"`);
          at = clipEnd(anchor) - (operation.clip.transitionIn?.duration ?? 0);
        }
        if (at === undefined) {
          const last = track.clips.reduce((end, clip) => Math.max(end, clipEnd(clip)), 0);
          at = Math.max(0, last - (track.clips.length > 0 ? operation.clip.transitionIn?.duration ?? 0 : 0));
        }
        const clip: CutClip = { ...operation.clip, at };
        if (operation.ripple) shift(track, at + (clip.transitionIn?.duration ?? 0), clip.duration - (clip.transitionIn?.duration ?? 0));
        track.clips.push(clip);
        sortByStart(track);
        break;
      }
      case "set-clip": {
        const { track, clip } = find(index, operation.clip);
        guard(index, track, clip);
        guardLock(index, operation.set);
        applyPatch(clip, operation.set);
        sortByStart(track);
        break;
      }
      case "remove-clip": {
        const { track, clip } = find(index, operation.clip);
        guard(index, track, clip);
        track.clips = track.clips.filter((candidate) => candidate !== clip);
        if (operation.ripple) shift(track, clip.at, -clip.duration);
        break;
      }
      case "move-clip": {
        const found = find(index, operation.clip);
        guard(index, found.track, found.clip);
        const target = operation.track ? trackOf(index, operation.track) : found.track;
        guard(index, target);
        if (target.kind !== found.track.kind) refuse(index, `a ${found.track.kind === "video" ? "picture" : "sound"} clip stays on a ${found.track.kind === "video" ? "picture" : "sound"} track`);
        const clip = found.clip;
        found.track.clips = found.track.clips.filter((candidate) => candidate !== clip);
        if (operation.ripple) shift(found.track, clip.at, -clip.duration);
        let at = operation.at ?? clip.at;
        if (operation.after === null) at = 0;
        else if (operation.after !== undefined) {
          const anchor = target.clips.find((candidate) => candidate.id === operation.after) ?? refuse(index, `track "${target.id}" has no clip "${operation.after}"`);
          at = clipEnd(anchor) - (clip.transitionIn?.duration ?? 0);
        }
        if (operation.ripple) shift(target, at, clip.duration);
        clip.at = Math.max(0, at);
        target.clips.push(clip);
        sortByStart(target);
        break;
      }
      case "split-clip": {
        const { track, clip } = find(index, operation.clip);
        guard(index, track, clip);
        if (!(operation.at > clip.at && operation.at < clipEnd(clip))) refuse(index, `frame ${operation.at} is not inside clip "${clip.id}" (${clip.at}–${clipEnd(clip)})`);
        if (next.tracks.some((t) => t.clips.some((candidate) => candidate.id === operation.newId))) refuse(index, `clip "${operation.newId}" already exists`);
        const first = operation.at - clip.at;
        const second: CutClip = { ...structuredClone(clip), id: operation.newId, at: operation.at, duration: clip.duration - first };
        // The second half starts where the first stops in the source, at the clip's speed.
        second.in = Math.round(((clip.in ?? 0) + (first / next.format.fps) * (clip.speed ?? 1)) * 1e6) / 1e6;
        delete second.transitionIn;
        if (track.kind === "audio") delete second.fadeIn;
        else if (second.audio) delete second.audio.fadeIn;
        clip.duration = first;
        delete clip.transitionOut;
        if (track.kind === "audio") delete clip.fadeOut;
        else if (clip.audio) delete clip.audio.fadeOut;
        track.clips.push(second);
        sortByStart(track);
        break;
      }
      case "set-master": {
        const master = { ...(next.master ?? {}) };
        applyPatch(master, operation.set);
        if (Object.keys(master).length === 0) delete next.master;
        else next.master = master;
        break;
      }
      case "set-marker": {
        const markers = (next.markers ?? []).filter((marker) => marker.id !== operation.marker.id);
        markers.push(operation.marker);
        next.markers = markers.sort((a, b) => a.at - b.at);
        break;
      }
      case "remove-marker": {
        next.markers = (next.markers ?? []).filter((marker) => marker.id !== operation.marker);
        if (next.markers.length === 0) delete next.markers;
        break;
      }
      default:
        refuse(index, "is not an operation on a cut");
    }
  });
  return next;
}

export interface EditCutResult {
  cut: CutTimeline;
  /** Warnings of the cut as written. */
  problems: CutProblem[];
  frames: number;
}

/**
 * Edit a unit's cut and write it: the operations hold together, or nothing
 * changes. The cut is read, edited and written under its lock, so an edit
 * that names no revision is applied to the cut as it then is, after any
 * other writer's, and never on top of it.
 */
export function editCut(
  root: string, ref: UnitRef, ops: readonly CutOp[], options: WriteCutOptions & { editor?: Editor } = {},
): EditCutResult {
  existingUnitDir(root, ref);
  const written = withCutLock(cutPath(root, ref), unitLabel(ref), (stillHeld) => {
    const current = cutOrEmpty(root, ref);
    if (options.expectedRevision !== undefined && options.expectedRevision !== current.revision) {
      throw new FilmError(
        `the cut of ${unitLabel(ref)} is at revision ${current.revision}, not ${options.expectedRevision}: someone changed it since it was read. Read it again and repeat the edit`,
        "revision-conflict",
      );
    }
    const edited = applyCutOps(current, ops, options.editor ?? "person");
    return storeCut(root, ref, edited, current.revision, stillHeld);
  }, options);
  return { cut: written, problems: validateCutTimeline(written), frames: cutDuration(written) };
}
