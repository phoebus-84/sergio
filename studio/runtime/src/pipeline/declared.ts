// ---------------------------------------------------------------------------
// The pipeline the library declares for an episode (avg-sxk)
// ---------------------------------------------------------------------------
// An episode's pipeline is the `pipeline:` key of a `pipeline.yaml` in the
// episode, else its series, else its channel. The first file that names one
// wins. A file that doesn't parse, or names something that isn't a pipeline
// id, is an error naming the file: guessing past it would run another
// pipeline's stages on the episode.
//
// A film (ADR-0050) is produced at three levels, each by its own pipeline, so
// one key cannot serve all three. A unit's own `pipeline.yaml` names its
// pipeline under `pipeline:`; a level above names the pipeline of the levels
// below it under `scenes:` and `shots:`:
//
//   <film>/pipeline.yaml            pipeline: film-project
//                                   scenes: film-scene
//                                   shots: film-shot-auto     # every shot, unless…
//   <film>/scenes/<s>/pipeline.yaml shots: film-shot          # …its scene says otherwise,
//   …/shots/<shot>/pipeline.yaml    pipeline: film-shot       # or the shot itself does.
//
// That is how one film is automatic in most of its shots and directed by a
// person in one scene.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import path from "node:path";
import { load as loadYaml } from "js-yaml";
import { channelPath, episodePath, seriesPath, unitLevel } from "@studio/contracts/src/layout.mjs";

export interface DeclaredPipeline {
  /** The pipeline id. */
  name: string;
  /** The declaring file, relative to the library root. */
  file: string;
}

export class PipelineDeclarationError extends Error {
  constructor(
    readonly code: "bad-declaration" | "bad-name",
    message: string,
    readonly file: string,
  ) {
    super(message);
    this.name = "PipelineDeclarationError";
  }
}

const PIPELINE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A value as an error names it: briefly, since it may be a whole manifest. */
function brief(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** The pipeline an episode runs when nothing declares one. */
export const DEFAULT_EPISODE_PIPELINE = "narrated-illustrated-video";

/** The pipeline each level of a film runs when nothing declares one. */
export const DEFAULT_FILM_PIPELINES = Object.freeze({
  film: "film-project",
  scene: "film-scene",
  shot: "film-shot",
});

interface Ref { channel: string; series: string; episode: string }

/** The pipeline a unit runs when the library declares none: by what the unit is. */
export function defaultPipeline(libraryRoot: string, ref: Ref): string {
  const level = unitLevel(libraryRoot, ref);
  return level === "episode" ? DEFAULT_EPISODE_PIPELINE : DEFAULT_FILM_PIPELINES[level];
}

/** The pipeline a unit runs: the one the library declares for it, else its level's default. */
export function pipelineOf(libraryRoot: string, ref: Ref): string {
  return declaredPipeline(libraryRoot, ref)?.name ?? defaultPipeline(libraryRoot, ref);
}

/** Where a unit's pipeline may be declared, nearest first, with the key to read in each file. */
function declarations(libraryRoot: string, ref: Ref): { dir: string; key: string }[] {
  const level = unitLevel(libraryRoot, ref);
  const own = episodePath(libraryRoot, ref.channel, ref.series, ref.episode);
  const film = channelPath(libraryRoot, ref.channel);
  if (level === "film") return [{ dir: own, key: "pipeline" }];
  if (level === "scene") return [{ dir: own, key: "pipeline" }, { dir: film, key: "scenes" }];
  if (level === "shot") {
    return [
      { dir: own, key: "pipeline" },
      { dir: seriesPath(libraryRoot, ref.channel, ref.series), key: "shots" },
      { dir: film, key: "shots" },
    ];
  }
  return [
    { dir: own, key: "pipeline" },
    { dir: seriesPath(libraryRoot, ref.channel, ref.series), key: "pipeline" },
    { dir: film, key: "pipeline" },
  ];
}

export function declaredPipeline(
  libraryRoot: string,
  ref: Ref,
): DeclaredPipeline | null {
  for (const { dir, key } of declarations(libraryRoot, ref)) {
    const absolute = path.join(dir, "pipeline.yaml");
    const file = path.relative(libraryRoot, absolute);
    let raw: string;
    try {
      raw = readFileSync(absolute, "utf-8");
    } catch {
      continue;
    }
    // An empty or comment-only file declares nothing (js-yaml 5 refuses an empty document).
    if (!raw.split("\n").some((line) => line.trim() !== "" && !line.trim().startsWith("#"))) continue;
    let doc: unknown;
    try {
      doc = loadYaml(raw);
    } catch (e) {
      throw new PipelineDeclarationError("bad-declaration", `${file} does not parse: ${e instanceof Error ? e.message : String(e)}`, file);
    }
    if (doc === null || doc === undefined) continue;
    if (typeof doc !== "object" || Array.isArray(doc)) {
      throw new PipelineDeclarationError("bad-declaration", `${file} is not a mapping`, file);
    }
    const value = (doc as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    // A pipeline defined inline under the key is a manifest the loader loads
    // from the library too: the episode runs it, by its id.
    const name = typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).id : value;
    if (typeof name !== "string" || !PIPELINE_ID.test(name)) {
      throw new PipelineDeclarationError("bad-name", `${file} declares ${key === "pipeline" ? "pipeline" : `${key}' pipeline`} ${brief(name)}, which is not a pipeline id`, file);
    }
    return { name, file };
  }
  return null;
}
