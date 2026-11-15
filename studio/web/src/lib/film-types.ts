/**
 * A film as the gateway serves it (ADR-0050): the tree of its scenes and
 * shots, with each unit's manifest, its cut and where its renders stand.
 *
 * The manifests and the cut are the contracts' own types; what is here is the
 * projection the gateway adds around them.
 */

import type { FilmManifest, ManifestProblem, SceneManifest, ShotManifest } from "@studio/contracts/src/film.mjs";
import type { CutProblem, CutTimeline } from "@studio/contracts/src/cut-timeline.mjs";

export type { FilmManifest, SceneManifest, ShotManifest, ManifestProblem, CutTimeline, CutProblem };

export type FilmLevel = "film" | "scene" | "shot";

export type RenderState = "no-cut" | "invalid-cut" | "blocked" | "not-rendered" | "stale" | "preview" | "current";

export interface UnitRef {
  channel: string;
  series: string;
  episode: string;
}

export interface RenderPointer {
  renderId: string;
  path: string;
  quality: "final" | "preview";
  frames: number;
  durationSeconds: number;
  createdAt: string;
  fresh: boolean;
}

export interface CutStatus {
  state: RenderState;
  reason: string;
  cut: { exists: boolean; revision: number | null; frames: number; seconds: number; clips: number; tracks: number };
  problems: CutProblem[];
  final: RenderPointer | null;
  preview: RenderPointer | null;
  children: { unit: UnitRef; slug: string; renderId: string | null; quality: "final" | "preview" | null; fresh: boolean }[];
}

export interface UnitNode<M> {
  level: FilmLevel;
  ref: UnitRef;
  /** `film/scene/shot`, with `_` for the level itself. */
  key: string;
  slug: string;
  title: string;
  path: string;
  manifest: M | null;
  manifestProblems: ManifestProblem[];
  status: CutStatus;
  render: { path: string; renderId: string; quality: "final" | "preview"; fresh: boolean; durationSeconds: number } | null;
  /** Where the unit's files are served from. */
  url: string | null;
  /** The unit's render to look at, when it has one. */
  renderUrl: string | null;
  /** A still of that render. */
  posterUrl: string | null;
}

export interface ShotNode extends UnitNode<ShotManifest> {
  level: "shot";
}

export interface SceneNode extends UnitNode<SceneManifest> {
  level: "scene";
  sequence: string | null;
  act: string | null;
  shots: ShotNode[];
  missingShots: string[];
}

export interface FilmTree extends UnitNode<FilmManifest> {
  level: "film";
  scenes: SceneNode[];
  missingScenes: string[];
  totals: { scenes: number; shots: number; seconds: number; byState: Record<RenderState, number> };
  next: { unit: string; state: RenderState; todo: string }[];
  rendering: { unit: string; quality: "final" | "preview"; startedAt: string; progress: { unit: string; phase: string; done: number; total: number } | null } | null;
}

export interface FootageClip {
  id: string;
  path: string;
  originalName: string;
  hash: string;
  bytes: number;
  kind: "video" | "audio" | "image";
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audio: { codec: string | null; channels: number | null; sampleRate: number | null } | null;
  origin: "camera" | "recording" | "stock" | "generated" | "other";
  linked: boolean;
  tags: string[];
  notes: string;
  licence?: string;
  scene?: string;
  shot?: string;
  ingestedAt: string;
  segments?: { start: number; end: number }[];
  loudness?: { integrated: number | null; truePeak: number | null; range: number | null };
  url: string | null;
  proxyUrl: string | null;
  sheetUrl: string | null;
}

export type EffectParam =
  | { kind: "number"; min: number; max: number; default: number; step?: number; unit?: string; description: string }
  | { kind: "enum"; values: string[]; default: string; description: string }
  | { kind: "boolean"; default: boolean; description: string }
  | { kind: "color"; default: string; description: string }
  | { kind: "file"; extensions: string[]; description: string };

export interface EffectDefinition {
  type: string;
  domain: "video" | "audio";
  title: string;
  description: string;
  group: string;
  params: Record<string, EffectParam>;
}

/** What each state is called, and what it means for the person looking. */
export const RENDER_STATE_LABELS: Record<RenderState, string> = {
  "no-cut": "No cut",
  "invalid-cut": "Invalid cut",
  blocked: "Blocked",
  "not-rendered": "Ready to render",
  stale: "Stale",
  preview: "Preview only",
  current: "Current",
};

/** The semantic token each state is drawn in: never colour alone, always with its label. */
export const RENDER_STATE_TONE: Record<RenderState, "idle" | "blocked" | "attention" | "stale" | "running" | "current"> = {
  "no-cut": "idle",
  "invalid-cut": "blocked",
  blocked: "blocked",
  "not-rendered": "attention",
  stale: "stale",
  preview: "running",
  current: "current",
};

/** The unit's place in the film, as its routes spell it. */
export function unitPath(unit: { film: string; scene: string; shot: string }): string {
  return `/api/films/${encodeURIComponent(unit.film)}/units/${encodeURIComponent(unit.scene)}/${encodeURIComponent(unit.shot)}`;
}

export function unitKey(unit: { film: string; scene: string; shot: string }): string {
  return `${unit.film}/${unit.scene}/${unit.shot}`;
}
