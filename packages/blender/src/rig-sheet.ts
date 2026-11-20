// ---------------------------------------------------------------------------
// A rig, posed and looked at
// ---------------------------------------------------------------------------
// A rig that is right at rest is the usual way an automatic rig is wrong.
// This puts a rigged binary glTF in known poses, renders each from three
// sides on one sheet, plays its clips over six moments each, and measures
// how far every pose pulled the surface out of shape and, for a two-legged
// body, whether a part passed into another: a hand into the head. The work
// is done by
// python/rig-sheet.py inside Blender; nothing here runs code that came with
// the model: a .glb is data.
// ---------------------------------------------------------------------------

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blenderExecutable, probe } from "./index.js";
import { runProcess } from "./process.js";

/** Which way the body faces, in the file's own axes (glTF: y up, +z the front). */
export type RigFacing = "+z" | "-z" | "+x" | "-x";
export const RIG_FACINGS: readonly RigFacing[] = ["+z", "-z", "+x", "-x"];

/** The body's own axes: front (the way it faces), up, side (towards its left). */
export type RigAxis = "front" | "up" | "side";
export const RIG_AXES: readonly RigAxis[] = ["front", "up", "side"];

export interface RigTurn {
  bone: string;
  /** Turned about this axis of the body, through the bone's head. */
  about: RigAxis;
  degrees: number;
}

export interface RigPose {
  name: string;
  turns: RigTurn[];
}

export interface RigSheetRequest {
  /** A rigged binary glTF. */
  rigPath: string;
  /** A new directory: an existing one is never written into. */
  outputDir: string;
  /** Default +z. */
  faces?: RigFacing;
  /** Poses of your own, in place of the ones chosen for the body. */
  poses?: RigPose[];
  /** Clips inside the rig to play, by name. */
  actions?: string[];
  /** Clips kept in files of their own: each holds the body and one motion. */
  clips?: { name: string; path: string }[];
  /** The side of one tile, in pixels. Default 288. */
  tile?: number;
}

export interface RigStrain {
  /** The share of the surface's edges pulled to half as long again, or pressed to two thirds. */
  strained: number;
  /** Edges pulled to three times their length: the surface is torn there. */
  torn: number;
}

/**
 * Two parts of a two-legged body in each other, more than at rest. Its skin is cut up by the bone
 * that moves each point most: head, body, left and right hand (the forearm and all that hangs from
 * it), upper arm, leg. Only parts that are not joined are looked at: a hand and the head, the body
 * or the other hand; one leg and the other.
 */
export interface RigThrough {
  parts: [string, string];
  /** How far one is in the other, in heights of the body, beyond how far it is at rest. */
  depth: number;
}

/** The same over a clip, looked for at 24 moments a second. */
export interface RigClipThrough extends RigThrough {
  /** When it first happens, in seconds from the start of the clip; for how long; when it is deepest. */
  from: number;
  seconds: number;
  at: number;
}

/** Less than this share of the body's height in another part is a brush, not a part passing through. */
export const RIG_THROUGH_FROM = 0.02;

export interface SheetLayout {
  /** The picture, relative to the output directory. */
  sheet: string;
  columns: number;
  rows: number;
  width: number;
  height: number;
}

export interface RigSheetReport {
  rig: {
    bones: number;
    vertices: number;
    edges: number;
    /** Across the shoulders, the height, front to back. */
    size: [number, number, number];
    /** biped: its bones' names were read as a two-legged body's. */
    skeleton: "biped" | "unknown";
    roles: Record<string, string>;
    /** The parts its skin was cut into to see what passes through what; none when it is not a biped's. */
    parts: string[];
  };
  bones: { name: string; parent: string | null; at: [number, number, number] }[];
  /** The rows of the pose sheet, top to bottom. */
  views: string[];
  /** The columns of the pose sheet, left to right; the first is the rest pose. */
  poses: SheetLayout & { list: (RigPose & RigStrain & { through: RigThrough[] })[] };
  clips: (SheetLayout & RigStrain & {
    name: string;
    from: "rig" | "file";
    action: string;
    seconds: number;
    /** How far the body moves over the ground, in heights of the body: 0 is played on the spot. */
    travel: number;
    /** Parts in each other, deepest first. */
    through: RigClipThrough[];
  })[];
  /** The motions the rig holds inside, by name. */
  actionsInside: string[];
  notes: string[];
}

export interface RigSheetResult {
  outputDir: string;
  reportPath: string;
  report: RigSheetReport;
}

export const RIG_SHEET_LIMITS = { poses: 12, turns: 16, clips: 8, tile: [128, 512] as const, clipFrames: 6 };

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/** Refuse a request before Blender is started. */
export function checkRigSheetRequest(request: RigSheetRequest): void {
  if (!/\.glb$/i.test(request.rigPath)) throw new Error("the rig must be a binary glTF (.glb): convert an FBX first");
  if (request.faces !== undefined && !RIG_FACINGS.includes(request.faces)) throw new Error(`faces is one of ${RIG_FACINGS.join(", ")}`);
  const tile = request.tile ?? 288;
  if (!Number.isInteger(tile) || tile < RIG_SHEET_LIMITS.tile[0] || tile > RIG_SHEET_LIMITS.tile[1] || tile % 2) {
    throw new Error(`tile is an even number of pixels from ${RIG_SHEET_LIMITS.tile[0]} to ${RIG_SHEET_LIMITS.tile[1]}`);
  }
  const poses = request.poses ?? [];
  if (poses.length > RIG_SHEET_LIMITS.poses) throw new Error(`at most ${RIG_SHEET_LIMITS.poses} poses a sheet`);
  for (const pose of poses) {
    if (!NAME.test(pose.name ?? "")) throw new Error(`a pose's name is letters, digits, spaces, dots, dashes: ${JSON.stringify(pose.name)}`);
    if (!Array.isArray(pose.turns) || pose.turns.length === 0 || pose.turns.length > RIG_SHEET_LIMITS.turns) {
      throw new Error(`pose ${pose.name}: one to ${RIG_SHEET_LIMITS.turns} turns`);
    }
    for (const turn of pose.turns) {
      if (typeof turn.bone !== "string" || !turn.bone) throw new Error(`pose ${pose.name}: every turn names a bone`);
      if (!RIG_AXES.includes(turn.about)) throw new Error(`pose ${pose.name}: about is one of ${RIG_AXES.join(", ")}`);
      if (typeof turn.degrees !== "number" || !Number.isFinite(turn.degrees) || Math.abs(turn.degrees) > 360) throw new Error(`pose ${pose.name}: degrees is a number from -360 to 360`);
    }
  }
  const clips = request.clips ?? [], actions = request.actions ?? [];
  if (clips.length + actions.length > RIG_SHEET_LIMITS.clips) throw new Error(`at most ${RIG_SHEET_LIMITS.clips} clips a run`);
  const names = new Set<string>();
  for (const name of [...actions, ...clips.map((clip) => clip.name)]) {
    if (typeof name !== "string" || !name) throw new Error("every clip has a name");
    const key = name.replace(/[^A-Za-z0-9._-]+/g, "-").toLowerCase();
    if (names.has(key)) throw new Error(`two clips would be written to one sheet: ${name}`);
    names.add(key);
  }
  for (const clip of clips) if (!/\.glb$/i.test(clip.path)) throw new Error(`clip ${clip.name}: a clip is a binary glTF (.glb)`);
}

async function nonempty(file: string): Promise<void> {
  const found = await stat(file).catch(() => null);
  if (!found?.isFile() || found.size === 0) throw new Error(`Missing or empty output: ${file}`);
}

/** Pose a rig and render its sheets. The output directory holds poses.png, clip.<name>.png, sheet.json and the tiles. */
export async function rigSheet(
  request: RigSheetRequest,
  options: { blenderPath?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RigSheetResult> {
  checkRigSheetRequest(request);
  options.signal?.throwIfAborted();
  const rigPath = resolve(request.rigPath);
  await nonempty(rigPath);
  const clips = (request.clips ?? []).map((clip) => ({ name: clip.name, path: resolve(clip.path) }));
  for (const clip of clips) await nonempty(clip.path);
  const executable = options.blenderPath ?? blenderExecutable();
  const health = probe(executable);
  if (!health.available) throw new Error(health.detail);

  const outputDir = resolve(request.outputDir);
  await mkdir(dirname(outputDir), { recursive: true });
  await mkdir(outputDir); // exclusive: an attempt is never written over
  await mkdir(join(outputDir, "tiles"));
  const configPath = join(outputDir, "request.json");
  await writeFile(configPath, JSON.stringify({
    rigPath, outputDir, faces: request.faces ?? "+z", tile: request.tile ?? 288, clipFrames: RIG_SHEET_LIMITS.clipFrames,
    poses: request.poses ?? [], actions: request.actions ?? [], clips,
  }, null, 2));
  const worker = fileURLToPath(new URL("../python/rig-sheet.py", import.meta.url));
  const logPath = join(outputDir, "blender.log");
  try {
    await runProcess(executable, [
      "--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1", "--python", worker, "--", configPath,
    ], { cwd: outputDir, logPath, timeoutMs: options.timeoutMs ?? 600_000, signal: options.signal });
  } catch (error) {
    // The script says what was wrong in its last RuntimeError; the log has the rest.
    const log = await readFile(logPath, "utf8").catch(() => "");
    const said = [...log.matchAll(/^RuntimeError: (.+)$/gm)].at(-1)?.[1];
    if (said) throw new Error(said, { cause: error });
    throw error;
  }
  const reportPath = join(outputDir, "sheet.json");
  const report = JSON.parse(await readFile(reportPath, "utf8")) as RigSheetReport;
  await nonempty(join(outputDir, report.poses.sheet));
  for (const clip of report.clips) await nonempty(join(outputDir, clip.sheet));
  return { outputDir, reportPath, report };
}
