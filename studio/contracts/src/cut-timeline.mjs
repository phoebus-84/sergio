// ---------------------------------------------------------------------------
// The cut timeline (ADR-0050)
// ---------------------------------------------------------------------------
// `artifacts/cut.json` is how a production unit is cut: clips of picture and
// sound on tracks, trimmed, retimed, joined by transitions, treated by
// effects, mixed and mastered. It is the editable counterpart of the edit
// timeline (ADR-0034), which a series compiler derives from a spec and nobody
// edits by hand: a cut is written by the agent and corrected by a person, clip
// by clip, in the studio or in the file.
//
// A film is cut at three levels with the same document. A shot's cut places
// its takes; a scene's places its shots (`source.unit`), with the scene's
// dialogue, effects and ambience; the film's places its scenes, with its
// music. A unit reference resolves to that unit's current render, so each
// level is rendered from the one below it and re-rendered only when that
// changed.
//
// This module reads no file and runs in the browser. Effect names and their
// parameters belong to the renderer's catalog (@av/video-composer), which is
// where they are checked.
// ---------------------------------------------------------------------------

import schema from "../schemas/v1alpha1/cut-timeline.schema.json" with { type: "json" };
import { check } from "./schema-lite.mjs";

export const CUT_API_VERSION = "studio.video/v1alpha1";
export const CUT_KIND = "CutTimeline";

/** Where a unit's cut lives, relative to the unit. */
export const CUT_TIMELINE_PATH = "artifacts/cut.json";

/** The record of a unit's current render of its cut: what was rendered, from what. */
export const CUT_RENDER_PATH = "artifacts/cut-render.json";

export const TRACK_KINDS = Object.freeze(["video", "audio"]);
export const TRACK_ROLES = Object.freeze([...schema.$defs.Track.properties.role.enum]);
export const TRANSITIONS = Object.freeze([...schema.$defs.Transition.properties.type.enum]);
export const FITS = Object.freeze([...schema.$defs.Clip.properties.fit.enum]);
export const SOURCE_KINDS = Object.freeze(["unit", "path", "project", "color"]);

/** The kind of a clip's source: the one key it carries. */
export function sourceKind(source) {
  if (!source || typeof source !== "object") return null;
  const kinds = SOURCE_KINDS.filter((kind) => source[kind] !== undefined);
  return kinds.length === 1 ? kinds[0] : null;
}

/** The frame after a clip's last. */
export function clipEnd(clip) {
  return clip.at + clip.duration;
}

/** A cut's length in frames: where its last clip ends. Zero for a cut with no clip. */
export function cutDuration(cut) {
  let end = 0;
  for (const track of cut?.tracks ?? []) {
    for (const clip of track.clips ?? []) end = Math.max(end, clipEnd(clip));
  }
  return end;
}

/** A cut's length in seconds. */
export function cutSeconds(cut) {
  return cutDuration(cut) / (cut?.format?.fps || 1);
}

/** Every clip of a cut, with the track it is on. */
export function allClips(cut) {
  return (cut?.tracks ?? []).flatMap((track) => (track.clips ?? []).map((clip) => ({ track, clip })));
}

/** The child units a cut is made of, in the order they first appear. */
export function unitSources(cut) {
  const seen = [];
  for (const { clip } of allClips(cut)) {
    const unit = clip.source?.unit;
    if (typeof unit === "string" && !seen.includes(unit)) seen.push(unit);
  }
  return seen;
}

/**
 * Problems of a cut, as `{code, path, message, severity}`; none of severity
 * "error" when it can be rendered.
 *
 * Beyond its shape:
 * - track ids are unique, and clip ids are unique in the whole cut, so a
 *   review comment or an edit names one clip;
 * - a clip has exactly one source; a colour is picture, never sound;
 * - on a picture track, clips are in order and overlap only by the incoming
 *   clip's transition — that overlap is the dissolve;
 * - a transition or a fade is no longer than its clip;
 * - a duck names tracks of this cut, and not its own.
 */
export function validateCutTimeline(doc) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return [{ code: "type", path: "$", message: "a cut must be a mapping", severity: "error" }];
  }
  const problems = check(schema, schema.$defs.CutTimeline, doc).map((problem) => ({ ...problem, severity: "error" }));
  if (problems.length > 0) return problems;
  const add = (code, path, message, severity = "error") => problems.push({ code, path, message, severity });

  const trackIds = new Set();
  const clipIds = new Map();
  doc.tracks.forEach((track, t) => {
    const base = `$.tracks[${t}]`;
    if (trackIds.has(track.id)) add("duplicate-track", `${base}.id`, `track "${track.id}" is declared twice`);
    trackIds.add(track.id);
    if (track.kind === "audio" && track.role && ["picture", "overlay"].includes(track.role)) {
      add("track-role", `${base}.role`, `"${track.role}" is a picture role; a sound track is dialogue, music, effects or ambience`);
    }
    if (track.kind === "video" && track.role && !["picture", "overlay"].includes(track.role)) {
      add("track-role", `${base}.role`, `"${track.role}" is a sound role; a picture track is picture or overlay`);
    }
    if (track.kind === "video" && track.duck) add("track-duck", `${base}.duck`, "a picture track's sound is ducked by putting it on a sound track");

    track.clips.forEach((clip, c) => {
      const at = `${base}.clips[${c}]`;
      if (clipIds.has(clip.id)) add("duplicate-clip", `${at}.id`, `clip "${clip.id}" is also ${clipIds.get(clip.id)}`);
      else clipIds.set(clip.id, at);

      const kind = sourceKind(clip.source);
      if (!kind) add("clip-source", `${at}.source`, "a clip has exactly one source: unit, path, project or color");
      if (kind === "color" && track.kind === "audio") add("clip-source", `${at}.source`, "a colour is not a sound");

      for (const key of ["transitionIn", "transitionOut"]) {
        if (!clip[key]) continue;
        if (track.kind === "audio") add("clip-transition", `${at}.${key}`, "a sound clip fades (fadeIn, fadeOut); transitions are for picture");
        else if (clip[key].duration > clip.duration) add("clip-transition", `${at}.${key}.duration`, `a ${clip[key].duration}-frame transition does not fit a ${clip.duration}-frame clip`);
      }
      const fades = track.kind === "audio" ? clip : (clip.audio ?? {});
      const fadePath = track.kind === "audio" ? at : `${at}.audio`;
      if ((fades.fadeIn ?? 0) + (fades.fadeOut ?? 0) > clip.duration) {
        add("clip-fade", fadePath, `fades of ${fades.fadeIn ?? 0} + ${fades.fadeOut ?? 0} frames do not fit a ${clip.duration}-frame clip`);
      }
      if (track.kind === "audio") {
        for (const key of ["fit", "opacity", "audio"]) {
          if (clip[key] !== undefined) add("clip-field", `${at}.${key}`, `"${key}" is for picture clips`);
        }
      } else {
        for (const key of ["gain", "fadeIn", "fadeOut"]) {
          if (clip[key] !== undefined) add("clip-field", `${at}.${key}`, `a picture clip's sound is set under "audio" (audio.${key})`);
        }
      }
    });

    if (track.kind === "video") {
      for (let c = 1; c < track.clips.length; c++) {
        const previous = track.clips[c - 1];
        const clip = track.clips[c];
        const at = `${base}.clips[${c}]`;
        if (clip.at < previous.at) {
          add("clip-order", `${at}.at`, `clip "${clip.id}" starts before "${previous.id}": a picture track's clips are in order`);
          continue;
        }
        const overlap = clipEnd(previous) - clip.at;
        const allowed = clip.transitionIn?.duration ?? 0;
        if (overlap > allowed) {
          add("clip-overlap", `${at}.at`, `clip "${clip.id}" overlaps "${previous.id}" by ${overlap} frame(s)` +
            (allowed > 0 ? `, more than its ${allowed}-frame transition` : ": give it a transitionIn that long, or move it"));
        }
      }
    }
  });

  doc.tracks.forEach((track, t) => {
    for (const [u, under] of (track.duck?.under ?? []).entries()) {
      const path = `$.tracks[${t}].duck.under[${u}]`;
      if (!trackIds.has(under)) add("duck-unknown", path, `there is no track "${under}"`);
      else if (under === track.id) add("duck-self", path, "a track cannot duck under itself");
    }
  });

  const markerIds = new Set();
  (doc.markers ?? []).forEach((marker, m) => {
    if (markerIds.has(marker.id)) add("duplicate-marker", `$.markers[${m}].id`, `marker "${marker.id}" is declared twice`);
    markerIds.add(marker.id);
  });

  if (cutDuration(doc) === 0) add("empty-cut", "$.tracks", "the cut has no clip", "warning");
  return problems;
}

/** Whether a cut's problems stop a render. */
export function hasCutErrors(problems) {
  return problems.some((problem) => problem.severity === "error");
}

/** A cut with one empty picture track and one empty sound track. */
export function emptyCut(unit, format) {
  return {
    apiVersion: CUT_API_VERSION,
    kind: CUT_KIND,
    unit: { channel: unit.channel, series: unit.series, episode: unit.episode },
    revision: 1,
    format: { ...(format.id ? { id: format.id } : {}), width: format.width, height: format.height, fps: format.fps },
    tracks: [
      { id: "v1", kind: "video", name: "Picture", role: "picture", clips: [] },
      { id: "a1", kind: "audio", name: "Sound", role: "effects", clips: [] },
    ],
  };
}

/**
 * Sources laid end to end on one track: each starts where the previous ends,
 * or `transition` frames before it, dissolving in.
 *
 * @param {{id: string, source: object, duration: number, label?: string, in?: number}[]} items
 * @param {{transition?: {type: string, duration: number}}} [options]
 */
export function sequenceClips(items, options = {}) {
  const clips = [];
  let at = 0;
  for (const [index, item] of items.entries()) {
    const overlap = index > 0 && options.transition ? Math.min(options.transition.duration, item.duration, items[index - 1].duration) : 0;
    const start = Math.max(0, at - overlap);
    clips.push({
      id: item.id,
      ...(item.label ? { label: item.label } : {}),
      source: item.source,
      at: start,
      duration: item.duration,
      ...(item.in ? { in: item.in } : {}),
      ...(overlap > 0 ? { transitionIn: { type: options.transition.type, duration: overlap } } : {}),
    });
    at = start + item.duration;
  }
  return clips;
}

/** Seconds as frames at a rate, never less than one frame. */
export function secondsToFrames(seconds, fps) {
  return Math.max(1, Math.round(seconds * fps));
}
