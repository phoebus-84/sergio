// ---------------------------------------------------------------------------
// Where a style lives, and which units read it
// ---------------------------------------------------------------------------
// A style is applied to a level that holds others: a channel or a film (the
// project), a series of a channel or a scene of a film. It lives in that
// level's style/ folder. A production unit — an episode, a shot, a scene's or
// a film's own unit — reads the nearest style above it: its scene's or its
// series', else its project's. Nothing has to have one.
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  EPISODES_CONTAINER, FILM_MANIFEST, SCENE_MANIFEST, SCENES_CONTAINER, SELF, SERIES_CONTAINER, SHOT_MANIFEST, SHOTS_CONTAINER,
  WORKSPACE_DIR, channelPath, episodePath, projectKind, seriesPath,
} from "@studio/contracts/src/layout.mjs";
import { STYLE_DIR, STYLE_MANIFEST, type StyleLevel } from "@studio/contracts/src/style.mjs";

export class StyleError extends Error {
  constructor(message: string, readonly code: string, readonly problems: { code: string; path: string; message: string }[] = []) {
    super(message);
    this.name = "StyleError";
  }
}

/** A level a style can be applied to: a project (channel or film), or one of its series or scenes. */
export interface StyleTarget {
  project: string;
  series?: string;
}

/** A production unit, addressed as everywhere in the studio: `_` for a level's own unit. */
export interface UnitRef {
  channel: string;
  series: string;
  episode: string;
}

export type UnitLevel = "episode" | "film" | "scene" | "shot";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function assertSlug(label: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 64 || !SLUG.test(value)) {
    throw new StyleError(`${label} "${String(value)}" must be lowercase letters, digits and single hyphens, at most 64 characters`, "bad-slug");
  }
}

export function assertTarget(target: StyleTarget): void {
  assertSlug("the channel or film", target.project);
  if (target.series !== undefined && target.series !== SELF) assertSlug("the series or scene", target.series);
}

/** `_` and an absent series both mean the project itself. */
export const normalTarget = (target: StyleTarget): StyleTarget =>
  target.series && target.series !== SELF ? { project: target.project, series: target.series } : { project: target.project };

export const targetLabel = (target: StyleTarget): string => (target.series ? `${target.project}/${target.series}` : target.project);

export const sameTarget = (a: StyleTarget, b: StyleTarget): boolean => a.project === b.project && (a.series ?? null) === (b.series ?? null);

/** Which kind of level a target is: a channel, a series, a film or a scene. */
export function targetLevel(root: string, target: StyleTarget): StyleLevel {
  const film = projectKind(root, target.project) === "film";
  if (target.series) return film ? "scene" : "series";
  return film ? "film" : "channel";
}

/** The target's own folder. Throws when it is not in the library. */
export function targetDir(root: string, target: StyleTarget): string {
  assertTarget(target);
  const t = normalTarget(target);
  const dir = t.series ? seriesPath(root, t.project, t.series) : channelPath(root, t.project);
  if (!existsSync(dir)) {
    throw new StyleError(`there is no ${t.series ? "series or scene" : "channel or film"} ${targetLabel(t)} in the library`, "no-target");
  }
  return dir;
}

/** Where the target's style is, whether or not it has one. */
export const styleDirOf = (root: string, target: StyleTarget): string => join(targetDir(root, target), STYLE_DIR);

/** Whether the target has a style applied. */
export function hasStyle(root: string, target: StyleTarget): boolean {
  try {
    return existsSync(join(styleDirOf(root, target), STYLE_MANIFEST));
  } catch {
    return false;
  }
}

/** The level above a target that may carry a style: a scene's film, a series' channel; none for a project. */
export const parentTarget = (target: StyleTarget): StyleTarget | null => (target.series ? { project: target.project } : null);

export function unitLevel(root: string, ref: UnitRef): UnitLevel {
  if (projectKind(root, ref.channel) !== "film") return "episode";
  if (ref.series === SELF) return "film";
  if (ref.episode === SELF) return "scene";
  return "shot";
}

export const unitLabel = (ref: UnitRef): string => `${ref.channel}/${ref.series}/${ref.episode}`;

export const unitDirOf = (root: string, ref: UnitRef): string => episodePath(root, ref.channel, ref.series, ref.episode);

/** The targets whose style a unit would read, nearest first. */
export function candidateTargets(ref: UnitRef): StyleTarget[] {
  return ref.series === SELF ? [{ project: ref.channel }] : [{ project: ref.channel, series: ref.series }, { project: ref.channel }];
}

/** The style a unit reads: the nearest target above it that has one, or null. */
export function nearestStyledTarget(root: string, ref: UnitRef): StyleTarget | null {
  return candidateTargets(ref).find((target) => hasStyle(root, target)) ?? null;
}

/** The style a target's units read when the target itself has none: the level above's, if any. */
export function inheritedTarget(root: string, target: StyleTarget): StyleTarget | null {
  const parent = parentTarget(normalTarget(target));
  return parent && hasStyle(root, parent) ? parent : null;
}

const contentDirs = (dir: string): string[] => {
  try {
    return readdirSync(dir)
      .filter((name) => !name.startsWith(".") && !name.startsWith("_"))
      .filter((name) => {
        try {
          return statSync(join(dir, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
};

/** Every production unit under a target, the target's own unit included when it has one. */
export function unitsUnder(root: string, target: StyleTarget): UnitRef[] {
  const t = normalTarget(target);
  const project = channelPath(root, t.project);
  if (projectKind(root, t.project) === "film") {
    const scenes = t.series ? [t.series] : contentDirs(join(project, SCENES_CONTAINER));
    const units: UnitRef[] = t.series ? [] : [{ channel: t.project, series: SELF, episode: SELF }];
    for (const scene of scenes) {
      const sceneDir = join(project, SCENES_CONTAINER, scene);
      if (!existsSync(join(sceneDir, SCENE_MANIFEST))) continue;
      units.push({ channel: t.project, series: scene, episode: SELF });
      for (const shot of contentDirs(join(sceneDir, SHOTS_CONTAINER))) {
        if (existsSync(join(sceneDir, SHOTS_CONTAINER, shot, SHOT_MANIFEST))) units.push({ channel: t.project, series: scene, episode: shot });
      }
    }
    return units;
  }
  const series = t.series ? [t.series] : contentDirs(join(project, SERIES_CONTAINER));
  return series.flatMap((s) => contentDirs(join(project, SERIES_CONTAINER, s, EPISODES_CONTAINER)).map((episode) => ({ channel: t.project, series: s, episode })));
}

const readYaml = (file: string): Record<string, unknown> | null => {
  try {
    const doc = parseYaml(readFileSync(file, "utf-8"));
    return doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const readJson = (file: string): Record<string, unknown> | null => {
  try {
    const doc = JSON.parse(readFileSync(file, "utf-8"));
    return doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** What a unit says of itself, for a brief's {{unit.*}}: its title and what it is about. */
export function unitContext(root: string, ref: UnitRef): { title?: string; idea?: string; level: string } {
  const level = unitLevel(root, ref);
  const dir = unitDirOf(root, ref);
  const meta = readJson(join(dir, WORKSPACE_DIR, "metadata.json"));
  if (level === "film") {
    const film = readYaml(join(dir, FILM_MANIFEST));
    return { level, title: str(film?.title) ?? str(meta?.title), idea: str(film?.logline) ?? str(film?.synopsis) ?? str(meta?.description) };
  }
  if (level === "scene") {
    const scene = readYaml(join(dir, SCENE_MANIFEST));
    return { level, title: str(scene?.title) ?? str(meta?.title), idea: str(scene?.summary) ?? str(meta?.description) };
  }
  if (level === "shot") {
    const shot = readYaml(join(dir, SHOT_MANIFEST));
    return { level, title: str(shot?.title) ?? str(meta?.title), idea: str(shot?.description) ?? str(meta?.description) };
  }
  return { level, title: str(meta?.title), idea: str(meta?.description) };
}

/** What a target says of itself, for a brief read at the level the style is applied to. */
export function targetContext(root: string, target: StyleTarget): { title?: string; idea?: string; level: string } {
  const t = normalTarget(target);
  const level = targetLevel(root, t);
  if (level === "film") return unitContext(root, { channel: t.project, series: SELF, episode: SELF });
  if (level === "scene") return unitContext(root, { channel: t.project, series: t.series!, episode: SELF });
  const dir = targetDir(root, t);
  const meta = readJson(join(dir, WORKSPACE_DIR, "metadata.json")) ?? readJson(join(dir, level === "channel" ? "channel.json" : "series.json"));
  return { level, title: str(meta?.title), idea: str(meta?.description) };
}
