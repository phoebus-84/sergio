// Type declarations for the film, scene and shot manifests (ADR-0050).

export interface ManifestProblem {
  code: string;
  path: string;
  message: string;
}

export interface Loudness {
  integrated: number;
  truePeak: number;
  range?: number;
}

export interface FilmFormat {
  id: string;
  title?: string;
  width: number;
  height: number;
  fps: number;
  aspect?: string;
  loudness?: Loudness;
}

export interface FilmSequence {
  id: string;
  title?: string;
  act?: string;
  summary?: string;
  scenes: string[];
}

export interface FilmManifest {
  apiVersion: "studio.video/v1alpha1";
  kind: "Film";
  slug: string;
  title: string;
  logline?: string;
  synopsis?: string;
  genre?: string;
  language?: string;
  runtimeTargetSeconds?: number;
  format: FilmFormat;
  sequences?: FilmSequence[];
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export type SceneSetting = "int" | "ext" | "int-ext";

export interface SceneManifest {
  apiVersion: "studio.video/v1alpha1";
  kind: "Scene";
  slug: string;
  number?: string;
  title: string;
  heading?: string;
  setting?: SceneSetting;
  location?: string;
  timeOfDay?: string;
  summary?: string;
  characters?: string[];
  durationTargetSeconds?: number;
  shots?: string[];
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export type ShotSource = "footage" | "stock" | "generated" | "animation" | "graphics" | "screen" | "mixed";
export type ShotSize = "extreme-wide" | "wide" | "full" | "medium-wide" | "medium" | "medium-close" | "close" | "extreme-close" | "insert";
export type ShotAngle = "eye-level" | "high" | "low" | "overhead" | "ground" | "dutch" | "over-the-shoulder" | "point-of-view";
export type ShotMovement = "static" | "pan" | "tilt" | "push-in" | "pull-out" | "track" | "crane" | "handheld" | "steadicam" | "zoom" | "orbit" | "aerial";
export type ShotSound = "sync" | "silent" | "generated";

export interface DialogueLine {
  character: string;
  line: string;
  delivery?: string;
  offscreen?: boolean;
}

export interface ShotManifest {
  apiVersion: "studio.video/v1alpha1";
  kind: "Shot";
  slug: string;
  number?: string;
  title: string;
  description?: string;
  source: ShotSource;
  size?: ShotSize;
  angle?: ShotAngle;
  movement?: ShotMovement;
  lens?: string;
  durationSeconds?: number;
  sound?: ShotSound;
  characters?: string[];
  dialogue?: DialogueLine[];
  notes?: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export type FilmLevel = "film" | "scene" | "shot";

export declare const FILM_API_VERSION: "studio.video/v1alpha1";
export declare const FILM_FORMATS: readonly Readonly<FilmFormat>[];
export declare const DEFAULT_FILM_FORMAT: string;
export declare function filmFormat(id: string): Readonly<FilmFormat> | undefined;

export declare const SHOT_SOURCES: readonly ShotSource[];
export declare const SHOT_SIZES: readonly ShotSize[];
export declare const SHOT_ANGLES: readonly ShotAngle[];
export declare const SHOT_MOVEMENTS: readonly ShotMovement[];
export declare const SHOT_SOUNDS: readonly ShotSound[];
export declare const SCENE_SETTINGS: readonly SceneSetting[];
export declare const SHOT_SOURCE_DESCRIPTIONS: Readonly<Record<ShotSource, string>>;

export declare function validateFilm(doc: unknown): ManifestProblem[];
export declare function validateScene(doc: unknown): ManifestProblem[];
export declare function validateShot(doc: unknown): ManifestProblem[];
export declare function validateManifest(level: FilmLevel, doc: unknown): ManifestProblem[];

export declare function compareSlugs(a: string, b: string): number;
export declare function runningOrder(
  declared: readonly string[],
  present: readonly string[],
): { order: string[]; missing: string[]; unlisted: string[] };
export declare function sceneOrder(
  film: Partial<FilmManifest> | null | undefined,
  present: readonly string[],
): { scenes: { scene: string; sequence: string | null; act: string | null }[]; missing: string[]; unlisted: string[] };
export declare function shotOrder(
  scene: Partial<SceneManifest> | null | undefined,
  present: readonly string[],
): { order: string[]; missing: string[]; unlisted: string[] };

export declare function timecode(frames: number, fps: number): string;
export declare function formatRuntime(seconds: number): string;
