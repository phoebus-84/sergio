// ---------------------------------------------------------------------------
// A film at a glance: every scene and shot in order, and where each stands
// ---------------------------------------------------------------------------
// What the studio's film workspace draws and what the agent reads before it
// decides what to do next: the running order, each unit's manifest and its
// problems, whether it has a cut, whether its renders are still what it would
// render, how long the film runs. Read-only, and tolerant: a unit that cannot
// be read is in the tree with what is wrong with it.
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { join } from "node:path";
import { SCENES_CONTAINER, SHOTS_CONTAINER, filmPath, scenePath } from "@studio/contracts/src/layout.mjs";
import type { FilmManifest, ManifestProblem, SceneManifest, ShotManifest } from "@studio/contracts/src/film.mjs";
import { cutStatus, type CutStatus, type RenderState } from "./cut-render.js";
import {
  FilmError, filmUnit, levelOf, libraryRelative, listScenes, listShots, readManifest, sceneUnit, shotUnit, unitDir, unitKey,
  type FilmLevel, type UnitRef,
} from "./units.js";

export interface UnitNode<M> {
  level: FilmLevel;
  ref: UnitRef;
  /** `film/_/_`: what the gateway's routes and the agent's tools take. */
  key: string;
  slug: string;
  title: string;
  /** The unit's directory, relative to the library. */
  path: string;
  manifest: M | null;
  manifestProblems: ManifestProblem[];
  status: CutStatus;
  /** The unit's render to look at — the final when fresh, else the newest — as a path relative to the library. */
  render: { path: string; renderId: string; quality: "final" | "preview"; fresh: boolean; durationSeconds: number } | null;
}

export interface ShotNode extends UnitNode<ShotManifest> {
  level: "shot";
}

export interface SceneNode extends UnitNode<SceneManifest> {
  level: "scene";
  sequence: string | null;
  act: string | null;
  shots: ShotNode[];
  /** Shots the scene's manifest names that are not on disk. */
  missingShots: string[];
}

export interface FilmTree extends UnitNode<FilmManifest> {
  level: "film";
  scenes: SceneNode[];
  /** Scenes the film's sequences name that are not on disk. */
  missingScenes: string[];
  totals: {
    scenes: number;
    shots: number;
    /** How long the film runs: its own cut's length, or the sum of its scenes' when it has none. */
    seconds: number;
    byState: Record<RenderState, number>;
  };
}

function renderOf(root: string, ref: UnitRef, status: CutStatus): UnitNode<unknown>["render"] {
  const pick = status.final?.fresh ? status.final : status.preview?.fresh ? status.preview : status.final ?? status.preview;
  if (!pick) return null;
  return {
    path: libraryRelative(root, join(unitDir(root, ref), "output", pick.path)),
    renderId: pick.renderId, quality: pick.quality, fresh: pick.fresh, durationSeconds: pick.durationSeconds,
  };
}

function node<M extends { title?: string }>(root: string, ref: UnitRef, slug: string): UnitNode<M> {
  const { manifest, problems } = readManifest<M>(root, ref);
  const status = cutStatus(root, ref);
  return {
    level: levelOf(ref), ref, key: unitKey(ref), slug,
    title: typeof manifest?.title === "string" && manifest.title ? manifest.title : slug,
    path: libraryRelative(root, unitDir(root, ref)),
    manifest, manifestProblems: problems, status, render: renderOf(root, ref, status),
  };
}

/** One scene with its shots. */
export function sceneNode(root: string, film: string, scene: string, placed: { sequence: string | null; act: string | null } = { sequence: null, act: null }): SceneNode {
  if (!existsSync(join(scenePath(root, film, scene)))) throw new FilmError(`there is no scene ${film}/${scene}`, "no-unit");
  const shots = listShots(root, film, scene);
  return {
    ...(node<SceneManifest>(root, sceneUnit(film, scene), scene) as UnitNode<SceneManifest> & { level: "scene" }),
    ...placed,
    shots: shots.order.map((shot) => node<ShotManifest>(root, shotUnit(film, scene, shot), shot) as ShotNode),
    missingShots: shots.missing,
  };
}

/** The whole film. */
export function filmTree(root: string, film: string): FilmTree {
  const ref = filmUnit(film);
  if (!existsSync(filmPath(root, film))) throw new FilmError(`there is no film ${film}`, "no-unit");
  const base = node<FilmManifest>(root, ref, film) as UnitNode<FilmManifest> & { level: "film" };
  const order = listScenes(root, film);
  const scenes = order.scenes.map(({ scene, sequence, act }) => sceneNode(root, film, scene, { sequence, act }));
  const byState = { "no-cut": 0, "invalid-cut": 0, blocked: 0, "not-rendered": 0, stale: 0, preview: 0, current: 0 } as Record<RenderState, number>;
  let shots = 0;
  for (const scene of scenes) {
    byState[scene.status.state] += 1;
    for (const shot of scene.shots) {
      byState[shot.status.state] += 1;
      shots += 1;
    }
  }
  const sceneSeconds = scenes.reduce((sum, scene) => sum + (scene.status.cut.seconds || scene.shots.reduce((s, shot) => s + (shot.status.cut.seconds || shot.manifest?.durationSeconds || 0), 0)), 0);
  return {
    ...base,
    scenes,
    missingScenes: order.missing,
    totals: { scenes: scenes.length, shots, seconds: base.status.cut.seconds || sceneSeconds, byState },
  };
}

/** What a unit should do next, in a sentence: the first thing in the way of the film's final render. */
export function nextSteps(tree: FilmTree, limit = 12): { unit: string; state: RenderState; todo: string }[] {
  const steps: { unit: string; state: RenderState; todo: string }[] = [];
  const consider = (unit: UnitNode<unknown>) => {
    if (unit.status.state === "current") return;
    steps.push({ unit: unit.key, state: unit.status.state, todo: unit.status.reason });
  };
  for (const scene of tree.scenes) {
    for (const shot of scene.shots) consider(shot);
    consider(scene);
  }
  consider(tree);
  return steps.slice(0, limit);
}

export const CONTAINERS = { scenes: SCENES_CONTAINER, shots: SHOTS_CONTAINER } as const;
