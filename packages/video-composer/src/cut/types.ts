// ---------------------------------------------------------------------------
// A cut, as this package renders it
// ---------------------------------------------------------------------------
// Clips of picture and sound on tracks, every source a file on disk or a solid
// colour. Positions and lengths on the timeline are whole frames; positions in
// a source are seconds; gains are dB. Who made the cut, what a clip's file is
// a render of, and where it is kept are the caller's business.
// ---------------------------------------------------------------------------

import type { EffectSpec } from "./effects.js";

export type TransitionType = "dissolve" | "fade" | "wipe-left" | "wipe-right" | "wipe-up" | "wipe-down";

export interface CutTransition {
  type: TransitionType;
  /** Frames. */
  duration: number;
}

export type CutMedia =
  | {
      /** The picture or sound file. */
      file: string;
      /** A sound file to use instead of the one inside `file`: a lossless mix kept beside a render. */
      audioFile?: string;
    }
  | { color: string };

export interface CutClipAudio {
  mute?: boolean;
  gain?: number;
  fadeIn?: number;
  fadeOut?: number;
  effects?: EffectSpec[];
}

export interface CutClip {
  id: string;
  media: CutMedia;
  /** Where the clip starts on the timeline, frames. */
  at: number;
  /** How long it holds, frames. */
  duration: number;
  /** Where it starts in its source, seconds. */
  in?: number;
  speed?: number;
  fit?: "cover" | "contain" | "fill";
  opacity?: number;
  transitionIn?: CutTransition;
  transitionOut?: CutTransition;
  effects?: EffectSpec[];
  /** A picture clip's own sound. */
  audio?: CutClipAudio;
  /** A sound clip's level and fades. */
  gain?: number;
  fadeIn?: number;
  fadeOut?: number;
}

export interface CutDuck {
  /** Tracks whose sound pushes this one down while it plays. */
  under: string[];
  /** dB, negative. */
  gain: number;
  /** Seconds. */
  attack?: number;
  release?: number;
}

export interface CutTrack {
  id: string;
  kind: "video" | "audio";
  muted?: boolean;
  gain?: number;
  duck?: CutDuck;
  effects?: EffectSpec[];
  clips: CutClip[];
}

export interface CutLoudness {
  /** Integrated loudness, LUFS. */
  integrated: number;
  /** True-peak ceiling, dBTP. */
  truePeak: number;
}

export interface Cut {
  width: number;
  height: number;
  fps: number;
  /** Picture tracks are stacked in this order: the first is at the bottom. */
  tracks: CutTrack[];
  master?: {
    video?: EffectSpec[];
    audio?: EffectSpec[];
    loudness?: CutLoudness;
  };
}

export interface CutProblem {
  code: string;
  path: string;
  message: string;
  severity: "error" | "warning";
}

/** What a file is, as far as a cut needs to know. */
export interface MediaInfo {
  file: string;
  kind: "video" | "image" | "audio";
  /** Seconds; null for a still. */
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  audioChannels: number | null;
  sampleRate: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  /** The picture may be transparent: a PNG, a ProRes 4444. */
  hasAlpha: boolean;
  size: number;
  mtimeMs: number;
}

export type RenderQuality = "preview" | "final";

export interface RenderProgress {
  phase: "probe" | "picture" | "sound" | "mix" | "master" | "mux";
  done: number;
  total: number;
  /** What was just finished, for a status line. */
  detail?: string;
}

export interface RenderCutOptions {
  /** The file to write. Its directory is created. */
  output: string;
  /** Where chunks, stems and the mix are kept between renders. */
  workDir: string;
  quality?: RenderQuality;
  /** Render only these frames of the timeline: [from, to). */
  range?: { from: number; to: number };
  /** Resolve a file an effect names (a LUT). Default: as given. */
  resolveFile?: (file: string) => string;
  /** Also write the mix as a 24-bit WAV beside the output (`<output>.mix.wav`), for a cut that nests this render. */
  keepMix?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: RenderProgress) => void;
  ffmpegPath?: string;
  ffprobePath?: string;
  /** Picture chunks rendered at once. Default 1: x264 already uses every core. */
  concurrency?: number;
}

export interface LoudnessReport {
  /** LUFS; null for silence. */
  integrated: number | null;
  truePeak: number | null;
  range: number | null;
}

export interface RenderCutResult {
  output: string;
  /** `<output>.mix.wav`, when kept. */
  mix: string | null;
  quality: RenderQuality;
  width: number;
  height: number;
  fps: number;
  frames: number;
  durationSeconds: number;
  size: number;
  sha256: string;
  hasAudio: boolean;
  loudness: { target: CutLoudness | null; before: LoudnessReport | null; after: LoudnessReport | null; gainDb: number; limited: boolean } | null;
  /** How much was rendered and how much came from the previous render. */
  work: { pictureChunks: number; pictureReused: number; soundChunks: number; soundReused: number };
  /** Every source file the render read, with what it was. */
  inputs: MediaInfo[];
  warnings: CutProblem[];
  elapsedMs: number;
}
