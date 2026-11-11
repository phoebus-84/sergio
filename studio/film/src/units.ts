// ---------------------------------------------------------------------------
// A film's units: the film, its scenes, their shots
// ---------------------------------------------------------------------------
// Each level of a film is a production unit — a directory with a manifest, a
// cut, a journal and renders — addressed with the three positions every tool
// of the studio takes: `channel` is the film, `series` the scene, `episode`
// the shot, and `_` the level itself (ADR-0050). This module names the units,
// reads their manifests and lists them in running order. It writes nothing.
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  SELF, FILM_MANIFEST, SCENE_MANIFEST, SHOT_MANIFEST, SCENES_CONTAINER, SHOTS_CONTAINER,
  episodePath, filmPath, projectKind, scenePath,
} from "@studio/contracts/src/layout.mjs";
import {
  sceneOrder, shotOrder, validateManifest,
  type FilmLevel, type FilmManifest, type ManifestProblem, type SceneManifest, type ShotManifest,
} from "@studio/contracts/src/film.mjs";

export { SELF };
export type { FilmLevel };

/** A unit, by the three positions the studio's tools take. */
export interface UnitRef {
  channel: string;
  series: string;
  episode: string;
}

export class FilmError extends Error {
  constructor(message: string, readonly code: string, readonly problems: { code: string; path: string; message: string }[] = []) {
    super(message);
    this.name = "FilmError";
  }
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function assertSlug(label: string, value: string): void {
  if (typeof value !== "string" || value.length > 64 || !SLUG.test(value)) {
    throw new FilmError(`${label} "${value}" must be lowercase letters, digits and single hyphens, at most 64 characters`, "bad-slug");
  }
}

export const filmUnit = (film: string): UnitRef => ({ channel: film, series: SELF, episode: SELF });
export const sceneUnit = (film: string, scene: string): UnitRef => ({ channel: film, series: scene, episode: SELF });
export const shotUnit = (film: string, scene: string, shot: string): UnitRef => ({ channel: film, series: scene, episode: shot });

/** The level a film's reference names. */
export function levelOf(ref: UnitRef): FilmLevel {
  if (ref.series === SELF) return "film";
  return ref.episode === SELF ? "scene" : "shot";
}

/** `film`, `film/scene` or `film/scene/shot`: how a person names the unit. */
export function unitLabel(ref: UnitRef): string {
  const level = levelOf(ref);
  if (level === "film") return ref.channel;
  return level === "scene" ? `${ref.channel}/${ref.series}` : `${ref.channel}/${ref.series}/${ref.episode}`;
}

/** `film/_/_`: the unit as the gateway, the journal and a session key spell it. */
export const unitKey = (ref: UnitRef): string => `${ref.channel}/${ref.series}/${ref.episode}`;

/** A reference from what a tool was given: the film, and optionally its scene and shot. */
export function unitOf(film: string, scene?: string | null, shot?: string | null): UnitRef {
  assertSlug("film", film);
  const sceneSlug = scene && scene !== SELF ? scene : null;
  const shotSlug = shot && shot !== SELF ? shot : null;
  if (shotSlug && !sceneSlug) throw new FilmError("a shot is inside a scene: name the scene too", "bad-unit");
  if (sceneSlug) assertSlug("scene", sceneSlug);
  if (shotSlug) assertSlug("shot", shotSlug);
  return { channel: film, series: sceneSlug ?? SELF, episode: shotSlug ?? SELF };
}

/** The unit's directory. Throws when the project is not a film. */
export function unitDir(root: string, ref: UnitRef): string {
  if (projectKind(root, ref.channel) !== "film") {
    throw new FilmError(`${ref.channel} is not a film: there is no ${ref.channel}/${FILM_MANIFEST}`, "not-a-film");
  }
  return episodePath(root, ref.channel, ref.series, ref.episode);
}

/** The unit's directory, which must exist. */
export function existingUnitDir(root: string, ref: UnitRef): string {
  const dir = unitDir(root, ref);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new FilmError(`there is no ${levelOf(ref)} ${unitLabel(ref)}`, "no-unit");
  }
  return dir;
}

const MANIFEST_NAME: Record<FilmLevel, string> = { film: FILM_MANIFEST, scene: SCENE_MANIFEST, shot: SHOT_MANIFEST };

export const manifestName = (level: FilmLevel): string => MANIFEST_NAME[level];

export interface ReadManifest<T> {
  /** The parsed document, when the file parses to a mapping; whatever is wrong with it is in `problems`. */
  manifest: T | null;
  problems: ManifestProblem[];
  path: string;
}

/** A unit's manifest as it is on disk, with what is wrong with it. Never throws for a bad file. */
export function readManifest<T = FilmManifest | SceneManifest | ShotManifest>(root: string, ref: UnitRef): ReadManifest<T> {
  const level = levelOf(ref);
  const path = join(unitDir(root, ref), MANIFEST_NAME[level]);
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return { manifest: null, problems: [{ code: "missing", path: "$", message: `${MANIFEST_NAME[level]} is not there` }], path };
  }
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (error) {
    return { manifest: null, problems: [{ code: "yaml", path: "$", message: `does not parse: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` }], path };
  }
  const problems = validateManifest(level, doc);
  const usable = doc !== null && typeof doc === "object" && !Array.isArray(doc);
  return { manifest: usable ? (doc as T) : null, problems, path };
}

const isUnitDirectory = (dir: string, name: string): boolean => {
  if (name.startsWith(".") || name.startsWith("_")) return false;
  try {
    return statSync(join(dir, name)).isDirectory();
  } catch {
    return false;
  }
};

const directoriesOf = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((name) => isUnitDirectory(dir, name));
  } catch {
    return [];
  }
};

/** The films of a library, by slug. */
export function listFilms(root: string): string[] {
  return directoriesOf(root).filter((name) => projectKind(root, name) === "film").sort();
}

export interface OrderedScene {
  scene: string;
  sequence: string | null;
  act: string | null;
}

/** A film's scenes in running order, with the names its manifest declares that are not on disk. */
export function listScenes(root: string, film: string): { scenes: OrderedScene[]; missing: string[]; unlisted: string[] } {
  const present = directoriesOf(join(filmPath(root, film), SCENES_CONTAINER));
  return sceneOrder(readManifest<FilmManifest>(root, filmUnit(film)).manifest, present);
}

/** A scene's shots in cutting order. */
export function listShots(root: string, film: string, scene: string): { order: string[]; missing: string[]; unlisted: string[] } {
  const present = directoriesOf(join(scenePath(root, film, scene), SHOTS_CONTAINER));
  return shotOrder(readManifest<SceneManifest>(root, sceneUnit(film, scene)).manifest, present);
}

/** The units a unit is cut from, in order: a film's scenes, a scene's shots; none for a shot. */
export function childUnits(root: string, ref: UnitRef): UnitRef[] {
  const level = levelOf(ref);
  if (level === "film") return listScenes(root, ref.channel).scenes.map(({ scene }) => sceneUnit(ref.channel, scene));
  if (level === "scene") return listShots(root, ref.channel, ref.series).order.map((shot) => shotUnit(ref.channel, ref.series, shot));
  return [];
}

/** The child a cut's `source.unit` names: a shot of this scene, a scene of this film. */
export function childUnit(ref: UnitRef, slug: string): UnitRef {
  const level = levelOf(ref);
  if (level === "film") return sceneUnit(ref.channel, slug);
  if (level === "scene") return shotUnit(ref.channel, ref.series, slug);
  throw new FilmError(`a shot is cut from files, not from units: "${slug}" names none`, "bad-unit");
}

/** A path of the library relative to its root, with forward slashes: what a report or a URL carries. */
export function libraryRelative(root: string, path: string): string {
  return relative(root, path).split("\\").join("/");
}
