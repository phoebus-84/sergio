// Type declarations for the cut timeline (ADR-0050).

export interface CutUnitRef {
  channel: string;
  series: string;
  episode: string;
}

export interface CutFormat {
  id?: string;
  width: number;
  height: number;
  fps: number;
}

/** Exactly one of its keys. */
export interface CutSource {
  /** A child unit's current render: a shot of this scene, a scene of this film. */
  unit?: string;
  /** A file of this unit. */
  path?: string;
  /** A file of the project: footage/, music/. */
  project?: string;
  /** A solid colour, #rrggbb. */
  color?: string;
}

export type CutSourceKind = "unit" | "path" | "project" | "color";

export interface CutEffect {
  type: string;
  params?: Record<string, number | string | boolean>;
  enabled?: boolean;
}

export type CutTransitionType = "dissolve" | "fade" | "wipe-left" | "wipe-right" | "wipe-up" | "wipe-down";

export interface CutTransition {
  type: CutTransitionType;
  /** Frames. */
  duration: number;
}

export interface CutClipAudio {
  mute?: boolean;
  /** dB. */
  gain?: number;
  /** Frames. */
  fadeIn?: number;
  fadeOut?: number;
  effects?: CutEffect[];
}

export interface CutClip {
  id: string;
  label?: string;
  source: CutSource;
  /** Where it starts on the timeline, frames. */
  at: number;
  /** How long it holds on the timeline, frames. */
  duration: number;
  /** Where it starts in its source, seconds. */
  in?: number;
  speed?: number;
  fit?: "cover" | "contain" | "fill";
  opacity?: number;
  transitionIn?: CutTransition;
  transitionOut?: CutTransition;
  effects?: CutEffect[];
  /** A picture clip's own sound. */
  audio?: CutClipAudio;
  /** A sound clip's level, dB. */
  gain?: number;
  /** A sound clip's fades, frames. */
  fadeIn?: number;
  fadeOut?: number;
  locked?: boolean;
  note?: string;
}

export interface CutDuck {
  under: string[];
  /** dB, negative. */
  gain: number;
  /** Seconds. */
  attack?: number;
  release?: number;
}

export type CutTrackRole = "picture" | "overlay" | "dialogue" | "music" | "effects" | "ambience";

export interface CutTrack {
  id: string;
  kind: "video" | "audio";
  name?: string;
  role?: CutTrackRole;
  muted?: boolean;
  locked?: boolean;
  gain?: number;
  duck?: CutDuck;
  effects?: CutEffect[];
  clips: CutClip[];
}

export interface CutMarker {
  id: string;
  at: number;
  label?: string;
  note?: string;
}

export interface CutMaster {
  video?: CutEffect[];
  audio?: CutEffect[];
  loudness?: { integrated: number; truePeak: number; range?: number };
}

export interface CutTimeline {
  apiVersion: "studio.video/v1alpha1";
  kind: "CutTimeline";
  unit: CutUnitRef;
  revision: number;
  format: CutFormat;
  tracks: CutTrack[];
  markers?: CutMarker[];
  master?: CutMaster;
  metadata?: Record<string, unknown>;
}

export interface CutProblem {
  code: string;
  path: string;
  message: string;
  severity: "error" | "warning";
}

export declare const CUT_API_VERSION: "studio.video/v1alpha1";
export declare const CUT_KIND: "CutTimeline";
export declare const CUT_TIMELINE_PATH: "artifacts/cut.json";
export declare const CUT_RENDER_PATH: "artifacts/cut-render.json";
export declare const TRACK_KINDS: readonly ("video" | "audio")[];
export declare const TRACK_ROLES: readonly CutTrackRole[];
export declare const TRANSITIONS: readonly CutTransitionType[];
export declare const FITS: readonly ("cover" | "contain" | "fill")[];
export declare const SOURCE_KINDS: readonly CutSourceKind[];

export declare function sourceKind(source: CutSource | null | undefined): CutSourceKind | null;
export declare function clipEnd(clip: Pick<CutClip, "at" | "duration">): number;
export declare function cutDuration(cut: Pick<CutTimeline, "tracks"> | null | undefined): number;
export declare function cutSeconds(cut: Pick<CutTimeline, "tracks" | "format"> | null | undefined): number;
export declare function allClips(cut: Pick<CutTimeline, "tracks"> | null | undefined): { track: CutTrack; clip: CutClip }[];
export declare function unitSources(cut: Pick<CutTimeline, "tracks"> | null | undefined): string[];
export declare function validateCutTimeline(doc: unknown): CutProblem[];
export declare function hasCutErrors(problems: readonly CutProblem[]): boolean;
export declare function emptyCut(unit: CutUnitRef, format: CutFormat): CutTimeline;
export declare function sequenceClips(
  items: readonly { id: string; source: CutSource; duration: number; label?: string; in?: number }[],
  options?: { transition?: CutTransition },
): CutClip[];
export declare function secondsToFrames(seconds: number, fps: number): number;
