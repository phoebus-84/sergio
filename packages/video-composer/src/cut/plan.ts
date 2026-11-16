// ---------------------------------------------------------------------------
// A cut checked, and divided into the pieces it is rendered in
// ---------------------------------------------------------------------------
// A film is not rendered in one FFmpeg run: two hours of picture would open
// hundreds of files at once and lose everything to one failure. The timeline
// is divided into windows, cut where clips begin and end; each window's
// picture and each track's sound in it is rendered to its own file, kept, and
// used again by the next render if nothing in it changed. Changing one shot
// re-renders the windows it is in.
// ---------------------------------------------------------------------------

import { validateEffect } from "./effects.js";
import type { Cut, CutClip, CutProblem, CutTrack, MediaInfo } from "./types.js";

export const SAMPLE_RATE = 48000;

export const clipEnd = (clip: Pick<CutClip, "at" | "duration">): number => clip.at + clip.duration;

/** A cut's length in frames: where its last clip ends. */
export function cutFrames(cut: Cut): number {
  let end = 0;
  for (const track of cut.tracks) for (const clip of track.clips) end = Math.max(end, clipEnd(clip));
  return end;
}

const isColor = (clip: CutClip): clip is CutClip & { media: { color: string } } => "color" in clip.media;

/** The files a cut reads, each once. */
export function cutFiles(cut: Cut): string[] {
  const files = new Set<string>();
  for (const track of cut.tracks) {
    for (const clip of track.clips) {
      if ("file" in clip.media) {
        files.add(clip.media.file);
        if (clip.media.audioFile) files.add(clip.media.audioFile);
      }
    }
  }
  return [...files];
}

/**
 * Problems of a cut as this package renders it. With `media`, the files are
 * held to what the clips ask of them: a picture clip needs a picture, and a
 * clip that asks for more than its source has is a warning — the last frame
 * holds, the sound ends.
 */
export function validateCut(cut: Cut, media?: ReadonlyMap<string, MediaInfo>): CutProblem[] {
  const problems: CutProblem[] = [];
  const add = (severity: CutProblem["severity"], code: string, path: string, message: string) => problems.push({ code, path, message, severity });
  const integer = (value: number) => Number.isInteger(value);

  if (!integer(cut.width) || !integer(cut.height) || cut.width < 16 || cut.height < 16 || cut.width % 2 || cut.height % 2) {
    add("error", "bad-size", "$.width", `the picture must be an even number of pixels each way, at least 16: ${cut.width}x${cut.height}`);
  }
  if (!integer(cut.fps) || cut.fps < 1 || cut.fps > 120 || SAMPLE_RATE % cut.fps !== 0) {
    add("error", "bad-rate", "$.fps", `${cut.fps} fps does not divide ${SAMPLE_RATE} samples: sound and picture would drift`);
  }

  const trackIds = new Set<string>();
  const clipIds = new Set<string>();
  cut.tracks.forEach((track, t) => {
    const base = `$.tracks[${t}]`;
    if (trackIds.has(track.id)) add("error", "duplicate-track", `${base}.id`, `track "${track.id}" is declared twice`);
    trackIds.add(track.id);
    (track.effects ?? []).forEach((effect, e) => {
      for (const p of validateEffect(track.kind, effect, `${base}.effects[${e}]`)) add("error", p.code, p.path, p.message);
    });
    track.clips.forEach((clip, c) => {
      const at = `${base}.clips[${c}]`;
      if (clipIds.has(clip.id)) add("error", "duplicate-clip", `${at}.id`, `clip "${clip.id}" is declared twice`);
      clipIds.add(clip.id);
      if (!integer(clip.at) || clip.at < 0) add("error", "bad-clip", `${at}.at`, "a clip starts on a whole frame, zero or later");
      if (!integer(clip.duration) || clip.duration < 1) add("error", "bad-clip", `${at}.duration`, "a clip holds for at least one whole frame");
      if (clip.in !== undefined && (!(clip.in >= 0) || !Number.isFinite(clip.in))) add("error", "bad-clip", `${at}.in`, "a clip starts at zero or later in its source");
      if (clip.speed !== undefined && !(clip.speed >= 0.1 && clip.speed <= 10)) add("error", "bad-clip", `${at}.speed`, "a clip's speed is between 0.1 and 10");
      if (clip.opacity !== undefined && !(clip.opacity >= 0 && clip.opacity <= 1)) add("error", "bad-clip", `${at}.opacity`, "opacity is between 0 and 1");
      if (isColor(clip)) {
        if (track.kind === "audio") add("error", "clip-source", `${at}.media`, "a colour is not a sound");
        if (!/^#[0-9A-Fa-f]{6}$/.test(clip.media.color)) add("error", "clip-source", `${at}.media.color`, "a colour is written #rrggbb");
      }
      for (const key of ["transitionIn", "transitionOut"] as const) {
        const transition = clip[key];
        if (!transition) continue;
        if (track.kind === "audio") add("error", "clip-transition", `${at}.${key}`, "a sound clip fades; transitions are for picture");
        else if (!integer(transition.duration) || transition.duration < 1 || transition.duration > clip.duration) {
          add("error", "clip-transition", `${at}.${key}.duration`, `a ${transition.duration}-frame transition does not fit a ${clip.duration}-frame clip`);
        }
      }
      const picture = track.kind === "video";
      (clip.effects ?? []).forEach((effect, e) => {
        for (const p of validateEffect(track.kind, effect, `${at}.effects[${e}]`)) add("error", p.code, p.path, p.message);
      });
      (picture ? clip.audio?.effects ?? [] : []).forEach((effect, e) => {
        for (const p of validateEffect("audio", effect, `${at}.audio.effects[${e}]`)) add("error", p.code, p.path, p.message);
      });
      const fadeIn = (picture ? clip.audio?.fadeIn : clip.fadeIn) ?? 0;
      const fadeOut = (picture ? clip.audio?.fadeOut : clip.fadeOut) ?? 0;
      if (fadeIn < 0 || fadeOut < 0 || fadeIn + fadeOut > clip.duration) add("error", "clip-fade", at, `fades of ${fadeIn} + ${fadeOut} frames do not fit a ${clip.duration}-frame clip`);

      const info = "file" in clip.media ? media?.get(clip.media.file) : undefined;
      if (info) {
        if (picture && !info.hasVideo) add("error", "clip-media", `${at}.media.file`, `${info.file} has no picture`);
        if (!picture && !info.hasAudio) add("error", "clip-media", `${at}.media.file`, `${info.file} has no sound`);
        if (info.duration !== null && cut.fps > 0) {
          const needs = (clip.in ?? 0) + (clip.duration / cut.fps) * (clip.speed ?? 1);
          // Half a frame of grace: a source measured in seconds rarely ends on a frame.
          if (needs > info.duration + 0.5 / cut.fps) {
            add("warning", "clip-past-source", at, `clip "${clip.id}" asks for ${needs.toFixed(2)} s of a ${info.duration.toFixed(2)} s source: ` +
              (picture ? "its last frame holds for the rest" : "it is silent for the rest"));
          }
        }
      }
    });
    if (track.kind === "video") {
      for (let c = 1; c < track.clips.length; c++) {
        const previous = track.clips[c - 1]!;
        const clip = track.clips[c]!;
        if (clip.at < previous.at) add("error", "clip-order", `${base}.clips[${c}].at`, `clip "${clip.id}" starts before "${previous.id}": a picture track's clips are in order`);
        else if (clipEnd(previous) - clip.at > (clip.transitionIn?.duration ?? 0)) {
          add("error", "clip-overlap", `${base}.clips[${c}].at`, `clip "${clip.id}" overlaps "${previous.id}" by more than its transition`);
        }
      }
    }
  });
  cut.tracks.forEach((track, t) => {
    for (const under of track.duck?.under ?? []) {
      if (!trackIds.has(under) || under === track.id) add("error", "duck-unknown", `$.tracks[${t}].duck.under`, `"${track.id}" cannot duck under "${under}"`);
    }
  });
  (cut.master?.video ?? []).forEach((effect, e) => {
    for (const p of validateEffect("video", effect, `$.master.video[${e}]`)) add("error", p.code, p.path, p.message);
  });
  (cut.master?.audio ?? []).forEach((effect, e) => {
    for (const p of validateEffect("audio", effect, `$.master.audio[${e}]`)) add("error", p.code, p.path, p.message);
  });
  if (cutFrames(cut) === 0) add("error", "empty-cut", "$.tracks", "the cut has no clip");
  return problems;
}

export type Window = readonly [from: number, to: number];

/**
 * [from, to) divided into windows that begin and end where clips do, each
 * about `target` frames and none longer than `max`: a long clip is divided
 * inside itself rather than rendered in one run.
 */
export function divide(edges: readonly number[], from: number, to: number, target: number, max: number): Window[] {
  const inside = [...new Set(edges)].filter((edge) => edge > from && edge < to).sort((a, b) => a - b);
  const windows: Window[] = [];
  let start = from;
  while (start < to) {
    let end = inside.find((edge) => edge >= start + target) ?? to;
    if (end - start > max) end = start + max;
    windows.push([start, end]);
    start = end;
  }
  return windows;
}

/** Where a track's clips begin and end, with the ends of their transitions: good places to divide. */
export function trackEdges(tracks: readonly CutTrack[]): number[] {
  const edges: number[] = [];
  for (const track of tracks) {
    for (const clip of track.clips) {
      edges.push(clip.at, clipEnd(clip));
    }
  }
  return edges;
}

/** The clips of a track that play in a window, in order. */
export function clipsIn(track: CutTrack, [from, to]: Window): CutClip[] {
  return track.clips.filter((clip) => clip.at < to && clipEnd(clip) > from);
}

/**
 * The sound of a cut is mixed from buses: each sound track is one, and each
 * picture track's clips' own sound is another, under the picture track's id.
 */
export interface Bus {
  id: string;
  track: CutTrack;
  /** The clips that sound: muted ones and files with no sound are left out. */
  clips: CutClip[];
}

export function buses(cut: Cut, media: ReadonlyMap<string, MediaInfo>): Bus[] {
  const out: Bus[] = [];
  for (const track of cut.tracks) {
    if (track.muted) continue;
    const clips = track.clips.filter((clip) => {
      if (!("file" in clip.media)) return false;
      if (track.kind === "video" && clip.audio?.mute) return false;
      return media.get(clip.media.audioFile ?? clip.media.file)?.hasAudio === true;
    });
    if (clips.length > 0) out.push({ id: track.id, track, clips });
  }
  return out;
}
