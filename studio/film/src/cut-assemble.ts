// ---------------------------------------------------------------------------
// The first cut of a unit, and keeping it in step with what is under it
// ---------------------------------------------------------------------------
// Assembling is the mechanical part of editing: a shot's cut from its media,
// a scene's from its shots in cutting order, the film's from its scenes in
// running order. It touches the picture track only, and only the clips that
// name a unit: everything a person or the agent added — sound, titles, an
// effect on a clip, a trim on a locked one — stays as it is.
//
// What a lock holds. A locked clip keeps what it shows: its source, its trim,
// its length, its effects and its transitions. It does not keep its place in
// time when what precedes it changes length: the picture track is laid end to
// end, so every clip starts where the one before it ends, and a clip pinned to
// a frame would leave a hole before it or sit on top of its neighbour. A note
// says when a locked clip moved, and from where. To hold a whole track where
// it is, lock the track: it is then not reassembled at all.
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { probeFile } from "@av/video-composer";
import { filmPath } from "@studio/contracts/src/layout.mjs";
import {
  clipEnd, cutDuration, secondsToFrames, sourceKind,
  type CutClip, type CutTimeline, type CutTrack, type CutTransition,
} from "@studio/contracts/src/cut-timeline.mjs";
import { timecode, type ShotManifest } from "@studio/contracts/src/film.mjs";
import { readPointer } from "./cut-render.js";
import { cutOrEmpty, readCut, writeCut } from "./cut-store.js";
import { FilmError, childUnits, existingUnitDir, levelOf, readManifest, unitLabel, type UnitRef } from "./units.js";

const VIDEO = /\.(mp4|mov|mkv|webm|m4v|mxf|avi)$/i;
const IMAGE = /\.(png|jpe?g|webp|tiff?|bmp)$/i;

/** Seconds a still holds when nothing says how long. */
const STILL_SECONDS = 4;
/** Seconds a unit with no cut, no render and no stated length is given, so that the cut above it has a place for it. */
const PLACEHOLDER_SECONDS = 2;

function mediaUnder(dir: string, pattern: RegExp): { file: string; mtimeMs: number }[] {
  const found: { file: string; mtimeMs: number }[] = [];
  const walk = (current: string): void => {
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const path = join(current, name);
      const info = statSync(path);
      if (info.isDirectory()) walk(path);
      else if (pattern.test(name) && !/\.partial\./.test(name)) found.push({ file: path, mtimeMs: info.mtimeMs });
    }
  };
  walk(dir);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export interface AssembleOptions {
  /** Join the picture track's clips with this transition instead of a cut. */
  transition?: CutTransition;
  /**
   * A shot only: the media to cut it from — a path in the shot, or
   * `project:<path>` for a file of the film (footage/…). Default: the newest
   * video under the shot's assets/, or failing that its newest image.
   */
  media?: string;
  /** A shot only: where the clip starts in its source, seconds. */
  in?: number;
  /** A shot only: how long the clip holds, seconds. Default: the shot's durationSeconds, or the media's length. */
  seconds?: number;
  /** A shot only: replace a cut that already has clips. */
  replace?: boolean;
  expectedRevision?: number;
}

export interface AssembleResult {
  cut: CutTimeline;
  /** What was done, one line each. */
  notes: string[];
  frames: number;
  seconds: number;
}

const pictureTrack = (cut: CutTimeline): CutTrack => {
  const track = cut.tracks.find((candidate) => candidate.kind === "video" && (candidate.role ?? "picture") === "picture") ?? cut.tracks.find((candidate) => candidate.kind === "video");
  if (track) return track;
  const made: CutTrack = { id: "v1", kind: "video", name: "Picture", role: "picture", clips: [] };
  cut.tracks.unshift(made);
  return made;
};

/** How long a unit is, in frames of the film: its render, else its cut, else what its manifest says. */
function unitFrames(root: string, unit: UnitRef, fps: number): { frames: number; from: string } {
  const pointer = readPointer(root, unit, "final") ?? readPointer(root, unit, "preview");
  if (pointer && pointer.frames > 0) return { frames: pointer.frames, from: "its render" };
  const stored = readCut(root, unit);
  const frames = stored.cut ? cutDuration(stored.cut) : 0;
  if (frames > 0) return { frames, from: "its cut" };
  if (levelOf(unit) === "shot") {
    const seconds = readManifest<ShotManifest>(root, unit).manifest?.durationSeconds;
    if (typeof seconds === "number" && seconds > 0) return { frames: secondsToFrames(seconds, fps), from: "its planned length" };
  }
  return { frames: secondsToFrames(PLACEHOLDER_SECONDS, fps), from: "a placeholder: it has no cut yet" };
}

async function assembleShot(root: string, ref: UnitRef, options: AssembleOptions): Promise<AssembleResult> {
  const dir = existingUnitDir(root, ref);
  const cut = cutOrEmpty(root, ref);
  const track = pictureTrack(cut);
  if (track.clips.length > 0 && !options.replace) {
    throw new FilmError(`the shot ${unitLabel(ref)} already has a cut with ${track.clips.length} clip(s): edit it, or assemble again with replace`, "cut-exists");
  }
  if (track.clips.some((clip) => clip.locked)) throw new FilmError(`the shot ${unitLabel(ref)} has a clip a person locked: it is not replaced`, "locked");

  let source: CutClip["source"];
  let file: string;
  if (options.media) {
    if (options.media.startsWith("project:")) {
      const path = options.media.slice("project:".length);
      source = { project: path };
      file = join(filmPath(root, ref.channel), path);
    } else {
      source = { path: options.media };
      file = join(dir, options.media);
    }
    if (!existsSync(file)) throw new FilmError(`${options.media} is not there`, "missing-file");
  } else {
    const candidate = mediaUnder(join(dir, "assets"), VIDEO)[0] ?? mediaUnder(join(dir, "assets"), IMAGE)[0];
    if (!candidate) {
      throw new FilmError(`the shot ${unitLabel(ref)} has no picture under assets/ yet: make or import its media, or name a file of the film (media: "project:footage/…")`, "no-media");
    }
    file = candidate.file;
    source = { path: relative(dir, file).split("\\").join("/") };
  }
  const info = await probeFile(file);
  if (!info.hasVideo) throw new FilmError(`${file} has no picture`, "no-media");
  const fps = cut.format.fps;
  const start = options.in ?? 0;
  const planned = options.seconds ?? readManifest<ShotManifest>(root, ref).manifest?.durationSeconds;
  const available = info.duration === null ? null : Math.max(0, info.duration - start);
  const seconds = planned ?? available ?? STILL_SECONDS;
  const notes: string[] = [];
  if (available !== null && seconds > available + 0.5 / fps) {
    notes.push(`the shot asks for ${seconds.toFixed(2)} s and its media has ${available.toFixed(2)} s from ${start} s: the last frame holds for the rest`);
  }
  track.clips = [{ id: "take", source, at: 0, duration: secondsToFrames(seconds, fps), ...(start > 0 ? { in: start } : {}) }];
  const written = writeCut(root, ref, cut, { expectedRevision: options.expectedRevision ?? cut.revision });
  notes.unshift(`cut from ${"path" in source ? source.path : `the film's ${source.project}`}: ${seconds.toFixed(2)} s${start > 0 ? ` from ${start} s` : ""}`);
  return { cut: written, notes, frames: cutDuration(written), seconds: cutDuration(written) / fps };
}

/**
 * Assemble a unit's cut.
 *
 * A shot: one clip of its media. A scene or the film: its units in order on
 * the picture track. Units already in the cut keep their clip — its effects,
 * its trim, its sound — and take their unit's present length, unless the clip
 * is locked; new units are added in place; a clip whose unit is gone is
 * removed, unless it is locked. Clips that name no unit stay after the unit
 * clip they followed. A locked clip is given no transition and keeps its
 * length; it starts where the clip before it now ends, and a note says so
 * when that moved it.
 */
export async function assembleCut(root: string, ref: UnitRef, options: AssembleOptions = {}): Promise<AssembleResult> {
  if (levelOf(ref) === "shot") return assembleShot(root, ref, options);
  existingUnitDir(root, ref);
  const cut = cutOrEmpty(root, ref);
  const fps = cut.format.fps;
  const track = pictureTrack(cut);
  if (track.locked) throw new FilmError(`the picture track of ${unitLabel(ref)} is locked by a person: it is not reassembled`, "locked");
  const order = childUnits(root, ref).map((unit) => ({ unit, slug: levelOf(ref) === "film" ? unit.series : unit.episode }));
  const what = levelOf(ref) === "film" ? "scene" : "shot";
  if (order.length === 0) throw new FilmError(`${unitLabel(ref)} has no ${what} to assemble`, "no-units");
  const notes: string[] = [];

  // Groups: a unit's clip with the clips that follow it and name no unit.
  const head: CutClip[] = [];
  const groups = new Map<string, CutClip[]>();
  let open: CutClip[] = head;
  for (const clip of [...track.clips].sort((a, b) => a.at - b.at)) {
    const slug = sourceKind(clip.source) === "unit" ? clip.source.unit! : null;
    if (slug && !groups.has(slug)) {
      open = [clip];
      groups.set(slug, open);
    } else {
      open.push(clip);
    }
  }
  const present = new Set(order.map((entry) => entry.slug));
  const kept: CutClip[][] = [head];
  for (const { unit, slug } of order) {
    const length = unitFrames(root, unit, fps);
    const group = groups.get(slug);
    if (group) {
      const clip = group[0]!;
      if (!clip.locked && clip.duration !== length.frames && (clip.in ?? 0) === 0 && (clip.speed ?? 1) === 1) {
        notes.push(`${slug}: ${clip.duration} → ${length.frames} frames (${length.from})`);
        clip.duration = length.frames;
      }
      kept.push(group);
    } else {
      notes.push(`${slug}: added, ${length.frames} frames (${length.from})`);
      kept.push([{ id: uniqueId(cut, slug), source: { unit: slug }, at: 0, duration: length.frames }]);
    }
  }
  for (const [slug, group] of groups) {
    if (present.has(slug)) continue;
    if (group[0]!.locked) {
      notes.push(`${slug}: there is no such ${what} any more, but its clip is locked: kept at the end`);
      kept.push(group);
    } else {
      notes.push(`${slug}: removed (there is no such ${what} any more)`);
      // What followed it and names no unit stays, after the group before.
      kept[kept.length - 1]!.push(...group.slice(1));
    }
  }

  // Laid end to end: each clip starts where the previous ends, or its transition before.
  const laid: CutClip[] = [];
  let at = 0;
  for (const clip of kept.flat()) {
    const previous = laid[laid.length - 1];
    if (options.transition && previous && !clip.locked && sourceKind(clip.source) === "unit") {
      clip.transitionIn = { type: options.transition.type, duration: Math.min(options.transition.duration, clip.duration, previous.duration) };
    }
    const overlap = previous ? Math.min(clip.transitionIn?.duration ?? 0, previous.duration) : 0;
    if (!previous && clip.transitionIn?.type === "dissolve") delete clip.transitionIn;
    const start = Math.max(0, at - overlap);
    if (clip.locked && clip.at !== start) {
      notes.push(`${clip.id}: locked, kept as it is; it now starts at ${timecode(start, fps)}, not ${timecode(clip.at, fps)}, because what precedes it changed length`);
    }
    clip.at = start;
    at = clipEnd(clip);
    laid.push(clip);
  }
  track.clips = laid;
  const written = writeCut(root, ref, cut, { expectedRevision: options.expectedRevision ?? cut.revision });
  if (notes.length === 0) notes.push(`already in step with its ${order.length} ${what}${order.length === 1 ? "" : "s"}`);
  return { cut: written, notes, frames: cutDuration(written), seconds: cutDuration(written) / fps };
}

function uniqueId(cut: CutTimeline, wanted: string): string {
  const taken = new Set(cut.tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
  if (!taken.has(wanted)) return wanted;
  for (let k = 2; ; k++) if (!taken.has(`${wanted}-${k}`)) return `${wanted}-${k}`;
}
