/**
 * TypeScript bindings generated from cut-timeline.schema.json
 * Schema: https://schemas.studio.video/v1alpha1/cut-timeline.schema.json
 * Auto-generated — do not edit directly.
 */

export type LocalId = string;

export type Slug = string;

export type Frame = number;

export type FrameCount = number;

export type RelativePath = string;

export interface UnitRef {
  channel: string;
  series: string;
  episode: string;
}

export interface Format {
  id?: Slug;
  width: number;
  height: number;
  fps: 24 | 25 | 30 | 48 | 50 | 60;
}

export interface Source {
  unit?: Slug;
  path?: RelativePath;
  project?: RelativePath;
  color?: string;
}

export interface Effect {
  "type": string;
  params?: Record<string, number | string | boolean>;
  enabled?: boolean;
}

export interface Transition {
  "type": "dissolve" | "fade" | "wipe-left" | "wipe-right" | "wipe-up" | "wipe-down";
  duration: FrameCount;
}

export interface ClipAudio {
  mute?: boolean;
  gain?: number;
  fadeIn?: Frame;
  fadeOut?: Frame;
  effects?: Effect[];
}

export interface Clip {
  id: LocalId;
  label?: string;
  source: Source;
  at: Frame;
  duration: FrameCount;
  /** Where the clip starts in its source, seconds. */
  in?: number;
  speed?: number;
  fit?: "cover" | "contain" | "fill";
  opacity?: number;
  transitionIn?: Transition;
  transitionOut?: Transition;
  effects?: Effect[];
  audio?: ClipAudio;
  gain?: number;
  fadeIn?: Frame;
  fadeOut?: Frame;
  /** A person fixed this clip: the agent leaves it as it is. */
  locked?: boolean;
  note?: string;
}

export interface Duck {
  under: LocalId[];
  gain: number;
  attack?: number;
  release?: number;
}

export interface Track {
  id: LocalId;
  kind: "video" | "audio";
  name?: string;
  role?: "picture" | "overlay" | "dialogue" | "music" | "effects" | "ambience";
  muted?: boolean;
  locked?: boolean;
  gain?: number;
  duck?: Duck;
  effects?: Effect[];
  clips: Clip[];
}

export interface Marker {
  id: LocalId;
  at: Frame;
  label?: string;
  note?: string;
}

export interface Master {
  video?: Effect[];
  audio?: Effect[];
  loudness?: {
    integrated: number;
    truePeak: number;
    range?: number;
  };
}

export interface CutTimeline {
  apiVersion: "studio.video/v1alpha1";
  kind: "CutTimeline";
  unit: UnitRef;
  revision: number;
  format: Format;
  tracks: Track[];
  markers?: Marker[];
  master?: Master;
  metadata?: Record<string, unknown>;
}
