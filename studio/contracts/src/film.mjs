// ---------------------------------------------------------------------------
// Films, scenes and shots (ADR-0050)
// ---------------------------------------------------------------------------
// A film is the other kind of project a library holds: one self-contained
// work, short or feature length, where a channel is a publication that keeps
// making episodes. It is produced at three levels, each a directory with its
// own manifest, knowledge, cut and renders:
//
//   film.yaml   what the film is, its delivery format, its running order
//   scene.yaml  one scene: its heading, who is in it, its shots in order
//   shot.yaml   one shot: what it shows, how it is framed, where it comes from
//
// This module is the manifests' contract and reads no file: it is imported by
// the browser, which edits them as forms, as well as by the tools that write
// them. Paths are `layout.mjs`'s.
// ---------------------------------------------------------------------------

import schema from "../schemas/v1alpha1/film.schema.json" with { type: "json" };
import catalog from "./film-formats.json" with { type: "json" };
import { check } from "./schema-lite.mjs";

export const FILM_API_VERSION = "studio.video/v1alpha1";

const deepFreeze = (value) => {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
};

/** Every delivery format a film can choose by id. A film may also carry its own values. */
export const FILM_FORMATS = deepFreeze(structuredClone(catalog));

/** The catalog format with this id, or undefined. */
export function filmFormat(id) {
  return FILM_FORMATS.find((format) => format.id === id);
}

/** The format a new film gets when none is asked for. */
export const DEFAULT_FILM_FORMAT = "hd-24";

const enumOf = (def, property) => Object.freeze([...schema.$defs[def].properties[property].enum]);

/** Where a shot's picture comes from. */
export const SHOT_SOURCES = enumOf("Shot", "source");
export const SHOT_SIZES = enumOf("Shot", "size");
export const SHOT_ANGLES = enumOf("Shot", "angle");
export const SHOT_MOVEMENTS = enumOf("Shot", "movement");
export const SHOT_SOUNDS = enumOf("Shot", "sound");
export const SCENE_SETTINGS = enumOf("Scene", "setting");

/** What each source means, for a person choosing one and for the agent producing it. */
export const SHOT_SOURCE_DESCRIPTIONS = Object.freeze({
  footage: "Footage shot for the film, ingested into footage/",
  stock: "Stock or archive media with a licence anyone can verify",
  generated: "Made by an image or video model",
  animation: "2D or 3D animation: Blender, rigged vectors",
  graphics: "Programmed graphics: titles, diagrams, motion graphics",
  screen: "A screen or terminal recording",
  mixed: "Several of these, composited in the shot's cut",
});

const KINDS = Object.freeze({ Film: "film", Scene: "scene", Shot: "shot" });

function validate(def, doc) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return [{ code: "type", path: "$", message: `a ${KINDS[def]} manifest must be a mapping` }];
  }
  return check(schema, schema.$defs[def], doc);
}

/**
 * Problems of a parsed film.yaml, as `{code, path, message}`; none when it is a Film.
 *
 * Beyond its shape: a scene belongs to one sequence, sequence ids are unique,
 * and a format that names a catalog id carries that format's size and rate —
 * a film that says `hd-24` and 25 fps would render at one and be described as
 * the other.
 */
export function validateFilm(doc) {
  const problems = validate("Film", doc);
  if (problems.length > 0) return problems;
  const add = (code, path, message) => problems.push({ code, path, message });

  const ids = new Set();
  const placed = new Map();
  (doc.sequences ?? []).forEach((sequence, s) => {
    if (ids.has(sequence.id)) add("duplicate-sequence", `$.sequences[${s}].id`, `sequence "${sequence.id}" is declared twice`);
    ids.add(sequence.id);
    sequence.scenes.forEach((scene, i) => {
      if (placed.has(scene)) add("scene-placed-twice", `$.sequences[${s}].scenes[${i}]`, `scene "${scene}" is already in sequence "${placed.get(scene)}"`);
      else placed.set(scene, sequence.id);
    });
  });

  const known = filmFormat(doc.format.id);
  if (known) {
    for (const key of ["width", "height", "fps"]) {
      if (doc.format[key] !== known[key]) {
        add("format-mismatch", `$.format.${key}`, `format "${known.id}" has ${key} ${known[key]}, not ${doc.format[key]}: change the value, or give the format the film's own id`);
      }
    }
  }
  return problems;
}

/** Problems of a parsed scene.yaml; none when it is a Scene. */
export function validateScene(doc) {
  return validate("Scene", doc);
}

/** Problems of a parsed shot.yaml; none when it is a Shot. */
export function validateShot(doc) {
  return validate("Shot", doc);
}

/** The validator of a manifest, by the level it describes. */
export function validateManifest(level, doc) {
  if (level === "film") return validateFilm(doc);
  if (level === "scene") return validateScene(doc);
  if (level === "shot") return validateShot(doc);
  throw new RangeError(`"${level}" is not a film level`);
}

// ── Running order ───────────────────────────────────────────────────────────

/** Slugs sort as a script numbers them: 2 before 10, 10 before 10a. */
export function compareSlugs(a, b) {
  return a.localeCompare(b, "en", { numeric: true });
}

/**
 * The order a list of names is cut in: the ones `declared` names, in its
 * order, then the rest by slug. A declared name that is not on disk is left
 * out and reported, never invented.
 *
 * @param {readonly string[]} declared the order a manifest states
 * @param {readonly string[]} present the names that exist on disk
 * @returns {{order: string[], missing: string[], unlisted: string[]}}
 */
export function runningOrder(declared, present) {
  const have = new Set(present);
  const listed = new Set(declared);
  const order = declared.filter((name) => have.has(name));
  const unlisted = present.filter((name) => !listed.has(name)).sort(compareSlugs);
  return { order: [...order, ...unlisted], missing: declared.filter((name) => !have.has(name)), unlisted };
}

/**
 * A film's scenes in running order, each with the sequence it is in.
 *
 * @param {object|null} film a parsed film.yaml (or null, when it cannot be read)
 * @param {readonly string[]} present the scene directories on disk
 * @returns {{scenes: {scene: string, sequence: string|null, act: string|null}[], missing: string[], unlisted: string[]}}
 */
export function sceneOrder(film, present) {
  const sequences = Array.isArray(film?.sequences) ? film.sequences : [];
  const declared = sequences.flatMap((sequence) => (Array.isArray(sequence.scenes) ? sequence.scenes : []));
  const where = new Map();
  for (const sequence of sequences) {
    for (const scene of Array.isArray(sequence.scenes) ? sequence.scenes : []) {
      if (!where.has(scene)) where.set(scene, sequence);
    }
  }
  const { order, missing, unlisted } = runningOrder([...new Set(declared)], present);
  return {
    scenes: order.map((scene) => ({ scene, sequence: where.get(scene)?.id ?? null, act: where.get(scene)?.act ?? null })),
    missing,
    unlisted,
  };
}

/** A scene's shots in cutting order. */
export function shotOrder(scene, present) {
  return runningOrder(Array.isArray(scene?.shots) ? scene.shots : [], present);
}

// ── Timecode ────────────────────────────────────────────────────────────────

/** `HH:MM:SS:FF` for a frame count at an integer rate. */
export function timecode(frames, fps) {
  const total = Math.max(0, Math.round(frames));
  const ff = total % fps;
  const seconds = Math.floor(total / fps);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}:${pad(ff)}`;
}

/** A duration a person reads: 1h 32m, 4m 05s, 12.5s. */
export function formatRuntime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "–";
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`;
  const whole = Math.round(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor(whole / 60) % 60;
  const s = whole % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s).padStart(2, "0")}s`;
}
