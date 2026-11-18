// ---------------------------------------------------------------------------
// A motion, read out of a file
// ---------------------------------------------------------------------------
// python/clip-sample.py plays a clip held in a .glb or an .fbx inside Blender
// and writes, for every frame and every bone, how far the bone has turned
// from its rest pose — in the world, in glTF's axes — and where it is. That
// is what carrying a clip from one skeleton to another needs, and nothing
// about the body the clip came with.
// ---------------------------------------------------------------------------

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blenderExecutable, probe } from "./index.js";
import { runProcess } from "./process.js";

export type Quat = [number, number, number, number];
export type Point = [number, number, number];

export interface ClipSample {
  /** The clip that was read, and every motion the file holds. */
  action: string;
  actions: string[];
  fps: number;
  seconds: number;
  /** One per frame, from 0. */
  times: number[];
  /** The skeleton at rest: where each bone starts, in the world (y up). */
  bones: { name: string; parent: string | null; rest: Point }[];
  /** For each bone, a turn a frame: from its rest pose, in the world; x y z w. */
  rotations: Record<string, Quat[]>;
  /** For each bone, where it starts in each frame. */
  positions: Record<string, Point[]>;
}

export interface ClipSampleRequest {
  /** A .glb or an .fbx that holds a skeleton and at least one motion. */
  path: string;
  /** A new directory. */
  outputDir: string;
  /** The clip to read, by name. Default: the longest. */
  action?: string;
  /** Frames are skipped evenly beyond this many. Default 720. */
  maxFrames?: number;
}

/** Play a clip in Blender and return what every bone did. */
export async function sampleClip(
  request: ClipSampleRequest,
  options: { blenderPath?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ClipSample> {
  if (!/\.(glb|fbx)$/i.test(request.path)) throw new Error("a clip is read from a .glb or an .fbx");
  const maxFrames = request.maxFrames ?? 720;
  if (!Number.isInteger(maxFrames) || maxFrames < 2 || maxFrames > 7200) throw new Error("maxFrames is a whole number from 2 to 7200");
  options.signal?.throwIfAborted();
  const path = resolve(request.path);
  const found = await stat(path).catch(() => null);
  if (!found?.isFile() || found.size === 0) throw new Error(`Missing or empty file: ${path}`);
  const executable = options.blenderPath ?? blenderExecutable();
  const health = probe(executable);
  if (!health.available) throw new Error(health.detail);

  const outputDir = resolve(request.outputDir);
  await mkdir(dirname(outputDir), { recursive: true });
  await mkdir(outputDir);
  const configPath = join(outputDir, "request.json");
  await writeFile(configPath, JSON.stringify({ path, outputDir, maxFrames, ...(request.action ? { action: request.action } : {}) }, null, 2));
  const worker = fileURLToPath(new URL("../python/clip-sample.py", import.meta.url));
  const logPath = join(outputDir, "blender.log");
  try {
    await runProcess(executable, [
      "--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1", "--python", worker, "--", configPath,
    ], { cwd: outputDir, logPath, timeoutMs: options.timeoutMs ?? 600_000, signal: options.signal });
  } catch (error) {
    const log = await readFile(logPath, "utf8").catch(() => "");
    const said = [...log.matchAll(/^RuntimeError: (.+)$/gm)].at(-1)?.[1];
    if (said) throw new Error(said, { cause: error });
    throw error;
  }
  return JSON.parse(await readFile(join(outputDir, "clip.json"), "utf8")) as ClipSample;
}
