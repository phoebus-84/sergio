// ---------------------------------------------------------------------------
// A film's footage: what was shot, recorded or bought, brought in and logged
// ---------------------------------------------------------------------------
// footage/ is where material that was not made in the studio enters a film:
// camera originals, location sound, stock clips, a composer's stems. Bringing
// a file in copies it (or links it, for originals too large to keep twice),
// names it by its content, measures it, and logs it in footage/catalog.json —
// with a contact sheet to read it at a glance, the instants its picture cuts,
// and a light proxy a browser can play. A cut names a clip of it as
// `{ "project": "footage/media/<file>" }`.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { contactSheet, detectSegments, makeProxy, measureLoudness, probeFile, type MediaInfo } from "@av/video-composer";
import { filmPath, projectKind } from "@studio/contracts/src/layout.mjs";
import { writeAtomically } from "./authoring.js";
import { serialize } from "./cut-store.js";
import { FilmError, existingUnitDir, libraryRelative, type UnitRef } from "./units.js";

export const FOOTAGE_DIR = "footage";
export const FOOTAGE_CATALOG = "footage/catalog.json";

export const FOOTAGE_ORIGINS = ["camera", "recording", "stock", "generated", "other"] as const;
export type FootageOrigin = (typeof FOOTAGE_ORIGINS)[number];

export interface FootageClip {
  /** Its name in the catalog: the file's own name and the first of its hash. */
  id: string;
  /** Relative to the film. */
  path: string;
  /** The name it had where it came from. */
  originalName: string;
  hash: string;
  bytes: number;
  kind: MediaInfo["kind"];
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audio: { codec: string | null; channels: number | null; sampleRate: number | null } | null;
  origin: FootageOrigin;
  /** Kept as a link to where it was: the film is not whole without that disk. */
  linked: boolean;
  tags: string[];
  notes: string;
  /** Who made it and under what terms, for material that is not the film's own. */
  licence?: string;
  /** The scene and shot it was shot for, when known. */
  scene?: string;
  shot?: string;
  ingestedAt: string;
  /** Relative to the film: a copy a browser plays. */
  proxy?: string;
  /** Relative to the film: a stamped grid of stills. */
  sheet?: string;
  /** Where its picture cuts, seconds. */
  segments?: { start: number; end: number }[];
  loudness?: { integrated: number | null; truePeak: number | null; range: number | null };
}

interface Catalog {
  apiVersion: "studio.video/v1alpha1";
  kind: "FootageCatalog";
  clips: FootageClip[];
}

const emptyCatalog = (): Catalog => ({ apiVersion: "studio.video/v1alpha1", kind: "FootageCatalog", clips: [] });

function filmDir(root: string, film: string): string {
  if (projectKind(root, film) !== "film") throw new FilmError(`there is no film ${film}`, "no-unit");
  return filmPath(root, film);
}

/** A film's footage log. A catalog that is missing is empty; one that cannot be read is an error, never an empty log. */
export function readFootage(root: string, film: string): FootageClip[] {
  const path = join(filmDir(root, film), FOOTAGE_CATALOG);
  if (!existsSync(path)) return [];
  let catalog: Catalog;
  try {
    catalog = JSON.parse(readFileSync(path, "utf-8")) as Catalog;
  } catch (error) {
    throw new FilmError(`${film}/${FOOTAGE_CATALOG} cannot be read: ${error instanceof Error ? error.message : String(error)}`, "bad-catalog");
  }
  if (!Array.isArray(catalog?.clips)) throw new FilmError(`${film}/${FOOTAGE_CATALOG} has no clips list`, "bad-catalog");
  return catalog.clips;
}

function writeFootage(root: string, film: string, clips: FootageClip[]): void {
  writeAtomically(join(filmDir(root, film), FOOTAGE_CATALOG), serialize({ ...emptyCatalog(), clips }));
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

const slugOf = (name: string): string =>
  name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "clip";

export interface IngestOptions {
  origin?: FootageOrigin;
  /** Link to the file where it is instead of copying it: for originals too large to keep twice. */
  link?: boolean;
  tags?: string[];
  notes?: string;
  licence?: string;
  scene?: string;
  shot?: string;
  /** Make a contact sheet, find the cuts, make a proxy, measure the sound. Default: all, for picture; the level, for sound. */
  sheet?: boolean;
  segments?: boolean;
  proxy?: boolean;
  signal?: AbortSignal;
}

export interface IngestResult {
  clip: FootageClip;
  /** False when the same bytes were already in the catalog: nothing was copied. */
  added: boolean;
  warnings: string[];
}

/**
 * Bring one file into a film's footage. The file is identified by its bytes:
 * bringing the same one in twice finds the first.
 */
export async function ingestFootage(root: string, film: string, file: string, options: IngestOptions = {}): Promise<IngestResult> {
  const dir = filmDir(root, film);
  const source = resolve(file);
  if (!isAbsolute(file)) throw new FilmError(`name the file by its full path: "${file}" is relative`, "bad-input");
  let info;
  try {
    info = statSync(source);
  } catch {
    throw new FilmError(`${source} is not there`, "missing-file");
  }
  if (!info.isFile()) throw new FilmError(`${source} is not a file`, "missing-file");
  const media = await probeFile(source, options.signal ? { signal: options.signal } : {});
  const hash = await hashFile(source);
  const clips = readFootage(root, film);
  const known = clips.find((clip) => clip.hash === `sha256:${hash}`);
  if (known) return { clip: known, added: false, warnings: [`the same file is already in the film's footage as ${known.id}`] };

  const extension = extname(source).toLowerCase();
  const id = `${slugOf(basename(source, extname(source)))}-${hash.slice(0, 8)}`;
  const relative = `${FOOTAGE_DIR}/media/${id}${extension}`;
  const target = join(dir, relative);
  mkdirSync(join(dir, FOOTAGE_DIR, "media"), { recursive: true });
  if (options.link) symlinkSync(source, target);
  else copyFileSync(source, target);

  const warnings: string[] = [];
  const tools = options.signal ? { signal: options.signal } : {};
  const clip: FootageClip = {
    id,
    path: relative,
    originalName: basename(source),
    hash: `sha256:${hash}`,
    bytes: info.size,
    kind: media.kind,
    durationSeconds: media.duration,
    width: media.width,
    height: media.height,
    fps: media.fps === null ? null : Math.round(media.fps * 1000) / 1000,
    videoCodec: media.videoCodec,
    audio: media.hasAudio ? { codec: media.audioCodec, channels: media.audioChannels, sampleRate: media.sampleRate } : null,
    origin: options.origin ?? "camera",
    linked: options.link === true,
    tags: [...new Set(options.tags ?? [])],
    notes: options.notes?.trim() ?? "",
    ...(options.licence ? { licence: options.licence.trim() } : {}),
    ...(options.scene ? { scene: options.scene } : {}),
    ...(options.shot ? { shot: options.shot } : {}),
    ingestedAt: new Date().toISOString(),
  };
  // What follows helps reading the clip; a failure of it is said, and the clip is still in.
  const attempt = async (what: string, work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      warnings.push(`${what} could not be made: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  if (media.kind === "video") {
    if (options.sheet !== false) {
      await attempt("its contact sheet", async () => {
        const sheet = `${FOOTAGE_DIR}/sheets/${id}.jpg`;
        await contactSheet(target, join(dir, sheet), { ...tools, ...(media.duration ? { duration: media.duration } : {}) });
        clip.sheet = sheet;
      });
    }
    if (options.segments !== false) {
      await attempt("its segments", async () => {
        clip.segments = await detectSegments(target, tools);
      });
    }
    if (options.proxy !== false) {
      await attempt("its proxy", async () => {
        const proxy = `${FOOTAGE_DIR}/proxies/${id}.mp4`;
        await makeProxy(target, join(dir, proxy), tools);
        clip.proxy = proxy;
      });
    }
  }
  if (media.hasAudio) {
    await attempt("its loudness", async () => {
      const level = await measureLoudness(target, tools);
      clip.loudness = { integrated: level.integrated, truePeak: level.truePeak, range: level.range };
    });
  }
  // Read again: the measurements take a while, and another ingest may have written meanwhile.
  writeFootage(root, film, [...readFootage(root, film).filter((other) => other.id !== id), clip]);
  return { clip, added: true, warnings };
}

/** Change what the log says about a clip: its tags, notes, licence, origin, the scene and shot it is for. */
export function annotateFootage(
  root: string, film: string, id: string,
  change: Partial<Pick<FootageClip, "tags" | "notes" | "licence" | "origin" | "scene" | "shot">>,
): FootageClip {
  const clips = readFootage(root, film);
  const clip = clips.find((candidate) => candidate.id === id);
  if (!clip) throw new FilmError(`there is no footage "${id}" in ${film}`, "no-footage");
  if (change.origin && !FOOTAGE_ORIGINS.includes(change.origin)) throw new FilmError(`"${change.origin}" is not an origin`, "bad-input");
  Object.assign(clip, Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined)));
  writeFootage(root, film, clips);
  return clip;
}

/** The clips of a film's footage that match: every word of the query is in its name, tags, notes, scene or shot. */
export function searchFootage(root: string, film: string, query = "", filter: { kind?: MediaInfo["kind"]; origin?: FootageOrigin; scene?: string } = {}): FootageClip[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return readFootage(root, film).filter((clip) => {
    if (filter.kind && clip.kind !== filter.kind) return false;
    if (filter.origin && clip.origin !== filter.origin) return false;
    if (filter.scene && clip.scene !== filter.scene) return false;
    const text = [clip.id, clip.originalName, clip.notes, clip.scene ?? "", clip.shot ?? "", clip.origin, ...clip.tags].join(" ").toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export interface Inspection {
  /** Relative to the library. */
  file: string;
  media: MediaInfo;
  sheet: string | null;
  sheetInstants: number[];
  segments: { start: number; end: number }[] | null;
  loudness: { integrated: number | null; truePeak: number | null; range: number | null } | null;
}

/**
 * Look at a media file of a unit before using it: what it is, a contact sheet
 * of it under artifacts/inspect/, where it cuts, how loud it is.
 */
export async function inspectMedia(
  root: string, ref: UnitRef, path: string, options: { sheet?: boolean; segments?: boolean; columns?: number; rows?: number } = {},
): Promise<Inspection> {
  const dir = existingUnitDir(root, ref);
  const file = path.startsWith("project:") ? join(filmDir(root, ref.channel), path.slice("project:".length)) : join(dir, path);
  if (!file.startsWith(filmDir(root, ref.channel))) throw new FilmError(`${path} is outside the film`, "bad-input");
  const media = await probeFile(file);
  const inspection: Inspection = { file: libraryRelative(root, file), media: { ...media, file: libraryRelative(root, file) }, sheet: null, sheetInstants: [], segments: null, loudness: null };
  if (media.kind === "video") {
    if (options.sheet !== false) {
      const name = `${slugOf(basename(file, extname(file)))}.sheet.jpg`;
      const sheet = await contactSheet(file, join(dir, "artifacts", "inspect", name), {
        ...(media.duration ? { duration: media.duration } : {}),
        ...(options.columns ? { columns: options.columns } : {}),
        ...(options.rows ? { rows: options.rows } : {}),
      });
      inspection.sheet = libraryRelative(root, sheet.output);
      inspection.sheetInstants = sheet.instants;
    }
    if (options.segments) inspection.segments = await detectSegments(file);
  }
  if (media.hasAudio) {
    const level = await measureLoudness(file);
    inspection.loudness = { integrated: level.integrated, truePeak: level.truePeak, range: level.range };
  }
  return inspection;
}
