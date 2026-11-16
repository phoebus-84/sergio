/**
 * TypeScript bindings generated from film.schema.json
 * Schema: https://schemas.studio.video/v1alpha1/film.schema.json
 * Auto-generated — do not edit directly.
 */

export type ResourceVersion = "studio.video/v1alpha1";

export type Slug = string;

export type Number = string;

export interface Loudness {
  /** Integrated loudness, LUFS. */
  integrated: number;
  /** True peak, dBTP. */
  truePeak: number;
  /** Loudness range, LU. */
  range?: number;
}

export interface FilmFormat {
  id: Slug;
  title?: string;
  width: number;
  height: number;
  fps: 24 | 25 | 30 | 48 | 50 | 60;
  aspect?: string;
  loudness?: Loudness;
}

export interface Sequence {
  id: Slug;
  title?: string;
  act?: string;
  summary?: string;
  scenes: Slug[];
}

export interface Film {
  apiVersion: ResourceVersion;
  kind: "Film";
  slug: Slug;
  title: string;
  logline?: string;
  synopsis?: string;
  genre?: string;
  language?: string;
  runtimeTargetSeconds?: number;
  format: FilmFormat;
  sequences?: Sequence[];
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface Scene {
  apiVersion: ResourceVersion;
  kind: "Scene";
  slug: Slug;
  number?: Number;
  title: string;
  /** The slugline: INT. KITCHEN - DAWN. */
  heading?: string;
  setting?: "int" | "ext" | "int-ext";
  /** A location of the film's locations/, by name. */
  location?: string;
  timeOfDay?: string;
  summary?: string;
  characters?: string[];
  durationTargetSeconds?: number;
  /** The shots in cutting order. Shots on disk it does not name follow, by slug. */
  shots?: Slug[];
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface DialogueLine {
  character: string;
  line: string;
  /** How it is said: the parenthetical. */
  delivery?: string;
  offscreen?: boolean;
}

export interface Shot {
  apiVersion: ResourceVersion;
  kind: "Shot";
  slug: Slug;
  number?: Number;
  title: string;
  /** What the shot shows and what happens in it. */
  description?: string;
  /** Where its picture comes from: footage shot for the film, stock or archive, an AI model, 3D or 2D animation, programmed graphics, a screen or terminal recording, or several of them. */
  source: "footage" | "stock" | "generated" | "animation" | "graphics" | "screen" | "mixed";
  size?: "extreme-wide" | "wide" | "full" | "medium-wide" | "medium" | "medium-close" | "close" | "extreme-close" | "insert";
  angle?: "eye-level" | "high" | "low" | "overhead" | "ground" | "dutch" | "over-the-shoulder" | "point-of-view";
  movement?: "static" | "pan" | "tilt" | "push-in" | "pull-out" | "track" | "crane" | "handheld" | "steadicam" | "zoom" | "orbit" | "aerial";
  lens?: string;
  /** How long the shot is meant to hold in the cut. */
  durationSeconds?: number;
  /** Sound recorded with the picture, none, or made afterwards. */
  sound?: "sync" | "silent" | "generated";
  characters?: string[];
  dialogue?: DialogueLine[];
  notes?: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}
