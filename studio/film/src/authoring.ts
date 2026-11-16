// ---------------------------------------------------------------------------
// Making a film, a scene, a shot
// ---------------------------------------------------------------------------
// Creation is idempotent and never overwrites: a file that is there stays as
// it is, and the result says which were made and which were found. Every
// level gets what a production unit needs (journal, artifacts, output) beside
// its own knowledge folders, so the same tools work at each.
//
// A manifest is changed through `updateManifest`, which checks the result
// against the contract before writing it and keeps the file's comments.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { parseDocument, stringify } from "yaml";
import {
  FILM_KNOWLEDGE, SCENE_KNOWLEDGE, SCENES_CONTAINER, SHOTS_CONTAINER, UNIT_DIRECTORIES, WORKSPACE_DIR,
  filmPath, projectKind, scenePath, shotPath,
} from "@studio/contracts/src/layout.mjs";
import {
  DEFAULT_FILM_FORMAT, FILM_API_VERSION, filmFormat, validateManifest,
  type FilmFormat, type FilmManifest, type SceneManifest, type ShotManifest, type ShotSource,
} from "@studio/contracts/src/film.mjs";
import { FilmError, assertSlug, filmUnit, levelOf, manifestName, readManifest, sceneUnit, shotUnit, unitDir, unitLabel, type UnitRef } from "./units.js";

export interface CreateResult {
  level: "film" | "scene" | "shot";
  ref: UnitRef;
  path: string;
  createdFiles: string[];
  existingFiles: string[];
}

const jsonDocument = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function writeNew(root: string, target: string, content: string, result: CreateResult): void {
  mkdirSync(dirname(target), { recursive: true });
  const name = relative(root, target);
  try {
    writeFileSync(target, content, { encoding: "utf-8", flag: "wx" });
    result.createdFiles.push(name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    result.existingFiles.push(name);
  }
}

let temporaries = 0;

/** Write through a temporary file, so no reader ever sees half a document. */
export function writeAtomically(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${(temporaries += 1)}.tmp`;
  writeFileSync(temporary, content, "utf-8");
  renameSync(temporary, target);
}

function text(label: string, value: string | undefined, max: number, required = false): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    if (required) throw new FilmError(`${label} must not be empty`, "bad-input");
    return undefined;
  }
  if (trimmed.length > max) throw new FilmError(`${label} is longer than ${max} characters`, "bad-input");
  return trimmed;
}

/** What every production unit has: the folders the journal, the cut and the renders live in. */
function scaffoldUnit(root: string, dir: string, level: CreateResult["level"], title: string, description: string, result: CreateResult): void {
  const now = new Date().toISOString();
  for (const folder of UNIT_DIRECTORIES) mkdirSync(join(dir, folder), { recursive: true });
  writeNew(root, join(dir, WORKSPACE_DIR, "contract.json"), jsonDocument({
    schema: "video-workspace-contracts/workspace-v1", version: "0.1.0", type: level, createdAt: now, updatedAt: now,
  }), result);
  writeNew(root, join(dir, WORKSPACE_DIR, "metadata.json"), jsonDocument({ title, description, createdAt: now, updatedAt: now }), result);
  writeNew(root, join(dir, "journal", "events.jsonl"), "", result);
  writeNew(root, join(dir, "reviews", "threads.jsonl"), "", result);
  writeNew(root, join(dir, "assets", "manifest.json"), jsonDocument({ apiVersion: "v1alpha1", kind: "AssetManifest", assets: [] }), result);
}

const clean = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0))) as T;

function refuseBadManifest(level: "film" | "scene" | "shot", manifest: unknown): void {
  const problems = validateManifest(level, manifest);
  if (problems.length > 0) {
    throw new FilmError(`the ${level} cannot be described that way: ${problems.map((p) => `${p.path} ${p.message}`).join("; ")}`, "bad-manifest", problems);
  }
}

export interface CreateFilmInput {
  slug: string;
  title: string;
  logline?: string;
  synopsis?: string;
  genre?: string;
  language?: string;
  runtimeTargetSeconds?: number;
  /** A catalog format id (default hd-24), or the film's own format. */
  format?: string | FilmFormat;
}

export function createFilm(root: string, input: CreateFilmInput): CreateResult {
  assertSlug("film", input.slug);
  const dir = filmPath(root, input.slug);
  if (existsSync(dir) && projectKind(root, input.slug) !== "film") {
    throw new FilmError(`${input.slug} is already a channel of this library: a film needs its own name`, "name-taken");
  }
  const title = text("title", input.title, 160, true)!;
  const chosen = typeof input.format === "object" ? input.format : filmFormat(input.format ?? DEFAULT_FILM_FORMAT);
  if (!chosen) throw new FilmError(`there is no film format "${String(input.format)}"`, "bad-format");
  const manifest: FilmManifest = clean({
    apiVersion: FILM_API_VERSION,
    kind: "Film" as const,
    slug: input.slug,
    title,
    logline: text("logline", input.logline, 600),
    synopsis: text("synopsis", input.synopsis, 8000),
    genre: text("genre", input.genre, 120),
    language: input.language,
    runtimeTargetSeconds: input.runtimeTargetSeconds,
    format: structuredClone(chosen) as FilmFormat,
    sequences: [],
    createdAt: new Date().toISOString(),
  });
  refuseBadManifest("film", manifest);

  const ref = filmUnit(input.slug);
  const result: CreateResult = { level: "film", ref, path: dir, createdFiles: [], existingFiles: [] };
  mkdirSync(dir, { recursive: true });
  // The manifest first: it is what makes the directory a film, and every path below depends on that.
  writeNew(root, join(dir, manifestName("film")), stringify(manifest), result);
  for (const folder of [...FILM_KNOWLEDGE, SCENES_CONTAINER]) mkdirSync(join(dir, folder), { recursive: true });
  scaffoldUnit(root, dir, "film", title, manifest.logline ?? "", result);
  writeNew(root, join(dir, "settings.yaml"), [
    `# Settings for the film ${input.slug}. A scene or a shot may carry its own settings.yaml; the nearest wins.`,
    "#",
    "# budget:              # the film's whole purse: every shot's paid calls count against it",
    "#   currency: USD",
    "#   limitMicros: 50000000",
    "# approvalPolicy:",
    "#   mode: guided       # autopilot | guided | manual",
    "",
  ].join("\n"), result);
  writeNew(root, join(dir, "README.md"), `# ${title}\n\n${manifest.logline ?? ""}\n`, result);
  writeNew(root, join(dir, "footage", "catalog.json"), jsonDocument({ apiVersion: FILM_API_VERSION, kind: "FootageCatalog", clips: [] }), result);
  return result;
}

export interface CreateSceneInput {
  film: string;
  slug: string;
  title: string;
  number?: string;
  heading?: string;
  setting?: SceneManifest["setting"];
  location?: string;
  timeOfDay?: string;
  summary?: string;
  characters?: string[];
  durationTargetSeconds?: number;
  /** The sequence of the film the scene joins, at its end; created when the film has none by that id. */
  sequence?: string;
  sequenceTitle?: string;
  act?: string;
}

export function createScene(root: string, input: CreateSceneInput): CreateResult {
  assertSlug("film", input.film);
  assertSlug("scene", input.slug);
  if (projectKind(root, input.film) !== "film") throw new FilmError(`there is no film ${input.film}`, "no-unit");
  const title = text("title", input.title, 160, true)!;
  const manifest: SceneManifest = clean({
    apiVersion: FILM_API_VERSION,
    kind: "Scene" as const,
    slug: input.slug,
    number: input.number,
    title,
    heading: text("heading", input.heading, 200),
    setting: input.setting,
    location: text("location", input.location, 120),
    timeOfDay: text("timeOfDay", input.timeOfDay, 60),
    summary: text("summary", input.summary, 4000),
    characters: input.characters,
    durationTargetSeconds: input.durationTargetSeconds,
    shots: [],
    createdAt: new Date().toISOString(),
  });
  refuseBadManifest("scene", manifest);

  const dir = scenePath(root, input.film, input.slug);
  const ref = sceneUnit(input.film, input.slug);
  const result: CreateResult = { level: "scene", ref, path: dir, createdFiles: [], existingFiles: [] };
  mkdirSync(dir, { recursive: true });
  writeNew(root, join(dir, manifestName("scene")), stringify(manifest), result);
  for (const folder of [...SCENE_KNOWLEDGE, SHOTS_CONTAINER]) mkdirSync(join(dir, folder), { recursive: true });
  scaffoldUnit(root, dir, "scene", title, manifest.summary ?? "", result);

  if (input.sequence) {
    assertSlug("sequence", input.sequence);
    updateManifest<FilmManifest>(root, filmUnit(input.film), (film) => {
      const sequences = (Array.isArray(film.sequences) ? film.sequences : []) as NonNullable<FilmManifest["sequences"]>;
      if (sequences.some((sequence) => sequence.scenes?.includes(input.slug))) return film;
      let sequence = sequences.find((candidate) => candidate.id === input.sequence);
      if (!sequence) {
        sequence = { ...clean({ id: input.sequence!, title: text("sequenceTitle", input.sequenceTitle, 160), act: text("act", input.act, 80) }), scenes: [] };
        sequences.push(sequence);
      }
      sequence.scenes.push(input.slug);
      return { ...film, sequences };
    });
  }
  return result;
}

export interface CreateShotInput {
  film: string;
  scene: string;
  slug: string;
  title: string;
  source: ShotSource;
  number?: string;
  description?: string;
  size?: ShotManifest["size"];
  angle?: ShotManifest["angle"];
  movement?: ShotManifest["movement"];
  lens?: string;
  durationSeconds?: number;
  sound?: ShotManifest["sound"];
  characters?: string[];
  dialogue?: ShotManifest["dialogue"];
  notes?: string;
}

export function createShot(root: string, input: CreateShotInput): CreateResult {
  assertSlug("film", input.film);
  assertSlug("scene", input.scene);
  assertSlug("shot", input.slug);
  const sceneDir = scenePath(root, input.film, input.scene);
  if (projectKind(root, input.film) !== "film" || !existsSync(join(sceneDir, manifestName("scene")))) {
    throw new FilmError(`there is no scene ${input.film}/${input.scene}`, "no-unit");
  }
  const title = text("title", input.title, 160, true)!;
  const manifest: ShotManifest = clean({
    apiVersion: FILM_API_VERSION,
    kind: "Shot" as const,
    slug: input.slug,
    number: input.number,
    title,
    description: text("description", input.description, 4000),
    source: input.source,
    size: input.size,
    angle: input.angle,
    movement: input.movement,
    lens: text("lens", input.lens, 60),
    durationSeconds: input.durationSeconds,
    sound: input.sound,
    characters: input.characters,
    dialogue: input.dialogue,
    notes: text("notes", input.notes, 4000),
    createdAt: new Date().toISOString(),
  });
  refuseBadManifest("shot", manifest);

  const dir = shotPath(root, input.film, input.scene, input.slug);
  const ref = shotUnit(input.film, input.scene, input.slug);
  const result: CreateResult = { level: "shot", ref, path: dir, createdFiles: [], existingFiles: [] };
  mkdirSync(dir, { recursive: true });
  writeNew(root, join(dir, manifestName("shot")), stringify(manifest), result);
  for (const folder of ["assets/video", "assets/images", "assets/audio"]) mkdirSync(join(dir, folder), { recursive: true });
  scaffoldUnit(root, dir, "shot", title, manifest.description ?? "", result);
  return result;
}

/**
 * Change a unit's manifest: `change` gets the parsed document and returns the
 * new one, which must hold under the contract or nothing is written. The
 * file's comments and key order are kept where the change leaves them alone.
 */
export function updateManifest<T extends FilmManifest | SceneManifest | ShotManifest>(
  root: string, ref: UnitRef, change: (manifest: T) => T,
): T {
  const level = levelOf(ref);
  const path = join(unitDir(root, ref), manifestName(level));
  let source: string;
  try {
    source = readFileSync(path, "utf-8");
  } catch {
    throw new FilmError(`${unitLabel(ref)} has no ${manifestName(level)}`, "no-unit");
  }
  const document = parseDocument(source);
  if (document.errors.length > 0) throw new FilmError(`${manifestName(level)} of ${unitLabel(ref)} does not parse: ${document.errors[0]!.message.split("\n")[0]}`, "bad-manifest");
  const current = document.toJS() as T;
  const next = change(structuredClone(current));
  const problems = validateManifest(level, next);
  if (problems.length > 0) {
    throw new FilmError(`${unitLabel(ref)}: the change does not hold: ${problems.map((p) => `${p.path} ${p.message}`).join("; ")}`, "bad-manifest", problems);
  }
  const keys = new Set([...Object.keys(current ?? {}), ...Object.keys(next)]);
  for (const key of keys) {
    const value = (next as unknown as Record<string, unknown>)[key];
    if (value === undefined) document.delete(key);
    else if (JSON.stringify(value) !== JSON.stringify((current as unknown as Record<string, unknown>)?.[key])) document.set(key, value);
  }
  writeAtomically(path, document.toString());
  return next;
}

/** The order a film's scenes or a scene's shots are cut in, as its manifest should state it. */
export function setOrder(root: string, ref: UnitRef, order: string[]): void {
  for (const name of order) assertSlug("unit", name);
  if (new Set(order).size !== order.length) throw new FilmError("the order names a unit twice", "bad-input");
  const level = levelOf(ref);
  if (level === "scene") {
    updateManifest<SceneManifest>(root, ref, (scene) => ({ ...scene, shots: order }));
    return;
  }
  if (level !== "film") throw new FilmError("a shot has nothing to order", "bad-unit");
  updateManifest<FilmManifest>(root, ref, (film) => {
    // Scenes keep the sequence they are in; the order moves them inside it and moves the sequences themselves.
    const sequences = Array.isArray(film.sequences) ? film.sequences : [];
    const where = new Map<string, string>();
    for (const sequence of sequences) for (const scene of sequence.scenes) where.set(scene, sequence.id);
    const rebuilt = new Map<string, NonNullable<FilmManifest["sequences"]>[number]>();
    for (const scene of order) {
      const id = where.get(scene);
      if (!id) continue;
      if (!rebuilt.has(id)) rebuilt.set(id, { ...sequences.find((s) => s.id === id)!, scenes: [] });
      rebuilt.get(id)!.scenes.push(scene);
    }
    const loose = order.filter((scene) => !where.has(scene));
    const next = [...rebuilt.values(), ...sequences.filter((s) => !rebuilt.has(s.id)).map((s) => ({ ...s, scenes: s.scenes.filter((scene) => !order.includes(scene)) }))];
    if (loose.length > 0) {
      const rest = next.find((s) => s.id === "unsequenced");
      if (rest) rest.scenes.push(...loose.filter((scene) => !rest.scenes.includes(scene)));
      else next.push({ id: "unsequenced", title: "Unsequenced", scenes: loose });
    }
    return { ...film, sequences: next };
  });
}

export { readManifest };
