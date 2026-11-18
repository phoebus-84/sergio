// ---------------------------------------------------------------------------
// A rigged character, filmed
// ---------------------------------------------------------------------------
// The step from a character to a picture that moves. python/rig-shot.py
// lights the body on a plain ground and renders it playing the one clip the
// file holds, from a camera asked for in the words a shot is described in;
// the frames are joined here into an H.264 file with no sound.
//
// No script comes with a request, so nothing here runs code a caller wrote.
// ---------------------------------------------------------------------------

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { joinFrames, nonempty } from "./frames.js";
import { blenderExecutable, probe } from "./index.js";
import { runProcess } from "./process.js";
import { RIG_FACINGS, type RigFacing } from "./rig-sheet.js";

export const SHOT_CAMERAS = ["front", "three-quarter", "side", "back"] as const;
export type ShotCamera = (typeof SHOT_CAMERAS)[number];
/** full: the whole body. medium: from the waist up. close: head and shoulders. */
export const SHOT_FRAMINGS = ["full", "medium", "close"] as const;
export type ShotFraming = (typeof SHOT_FRAMINGS)[number];

export interface RigShotRequest {
  /** A rigged binary glTF: the rig, to film it standing; or one of its clips, to film it moving. */
  path: string;
  /** A new directory. */
  outputDir: string;
  /** Which way the body faces in its file. Default +z. */
  faces?: RigFacing;
  camera?: ShotCamera;
  framing?: ShotFraming;
  /** The camera keeps the body in frame as it travels. Default true. */
  follow?: boolean;
  /** How long. Default: the clip once (times `loops`), or two seconds for a body that stands. */
  seconds?: number;
  /** How many times the clip is played, when `seconds` is not given. Default 1. */
  loops?: number;
  width?: number;
  height?: number;
  fps?: number;
  /** What is behind the body, as #rrggbb. Default a light grey. */
  background?: string;
  /** A round floor under the body that takes its shadow. Default true. */
  ground?: boolean;
  /** Render samples: more is smoother and slower. Default 16. */
  samples?: number;
}

export interface RigShotReport {
  frames: number;
  fps: number;
  seconds: number;
  width: number;
  height: number;
  /** The clip that was played, or null for a body that stood. */
  action: string | null;
  clipSeconds: number;
  camera: ShotCamera;
  framing: ShotFraming;
  follow: boolean;
  /** How far the body goes over the ground, in its own heights. */
  travel: number;
  body: { tall: number; wide: number };
  engine: string;
  blender: string;
}

export interface RigShotResult {
  outputDir: string;
  mediaPath: string;
  report: RigShotReport;
}

export const RIG_SHOT_LIMITS = { seconds: 60, frames: 1800, loops: 20, side: [64, 3840] as const, fps: [6, 60] as const, samples: [1, 256] as const };
export const RIG_SHOT_DEFAULTS = { camera: "three-quarter" as ShotCamera, framing: "full" as ShotFraming, width: 1280, height: 720, fps: 24, background: "#d9dadc", samples: 16 };

/** The request with its defaults, refused before Blender is started when it cannot be made. */
export function shotSettings(request: RigShotRequest) {
  if (!/\.glb$/i.test(request.path)) throw new Error("a character is filmed from a binary glTF (.glb)");
  const settings = {
    faces: request.faces ?? "+z", camera: request.camera ?? RIG_SHOT_DEFAULTS.camera, framing: request.framing ?? RIG_SHOT_DEFAULTS.framing,
    follow: request.follow ?? true, loops: request.loops ?? 1,
    width: request.width ?? RIG_SHOT_DEFAULTS.width, height: request.height ?? RIG_SHOT_DEFAULTS.height, fps: request.fps ?? RIG_SHOT_DEFAULTS.fps,
    background: request.background ?? RIG_SHOT_DEFAULTS.background, ground: request.ground ?? true, samples: request.samples ?? RIG_SHOT_DEFAULTS.samples,
    ...(request.seconds !== undefined ? { seconds: request.seconds } : {}),
  };
  if (!RIG_FACINGS.includes(settings.faces)) throw new Error(`faces is one of ${RIG_FACINGS.join(", ")}`);
  if (!SHOT_CAMERAS.includes(settings.camera)) throw new Error(`camera is one of ${SHOT_CAMERAS.join(", ")}`);
  if (!SHOT_FRAMINGS.includes(settings.framing)) throw new Error(`framing is one of ${SHOT_FRAMINGS.join(", ")}`);
  for (const [name, value] of [["width", settings.width], ["height", settings.height]] as const) {
    if (!Number.isInteger(value) || value < RIG_SHOT_LIMITS.side[0] || value > RIG_SHOT_LIMITS.side[1] || value % 2) {
      throw new Error(`${name} is an even number of pixels from ${RIG_SHOT_LIMITS.side[0]} to ${RIG_SHOT_LIMITS.side[1]}`);
    }
  }
  if (!Number.isInteger(settings.fps) || settings.fps < RIG_SHOT_LIMITS.fps[0] || settings.fps > RIG_SHOT_LIMITS.fps[1]) throw new Error(`fps is a whole number from ${RIG_SHOT_LIMITS.fps[0]} to ${RIG_SHOT_LIMITS.fps[1]}`);
  if (!Number.isInteger(settings.loops) || settings.loops < 1 || settings.loops > RIG_SHOT_LIMITS.loops) throw new Error(`loops is a whole number from 1 to ${RIG_SHOT_LIMITS.loops}`);
  if (settings.seconds !== undefined && (!(settings.seconds > 0) || settings.seconds > RIG_SHOT_LIMITS.seconds)) throw new Error(`seconds is more than 0 and at most ${RIG_SHOT_LIMITS.seconds}`);
  if (!Number.isInteger(settings.samples) || settings.samples < RIG_SHOT_LIMITS.samples[0] || settings.samples > RIG_SHOT_LIMITS.samples[1]) throw new Error(`samples is a whole number from ${RIG_SHOT_LIMITS.samples[0]} to ${RIG_SHOT_LIMITS.samples[1]}`);
  if (!/^#[0-9a-f]{6}$/i.test(settings.background)) throw new Error("background is a colour as #rrggbb");
  return settings;
}

/** Film a rigged character. The output directory holds shot.mp4, shot.json and the frames. */
export async function rigShot(
  request: RigShotRequest,
  options: { blenderPath?: string; ffmpegPath?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RigShotResult> {
  const settings = shotSettings(request);
  options.signal?.throwIfAborted();
  const path = resolve(request.path);
  await nonempty(path);
  const executable = options.blenderPath ?? blenderExecutable();
  const health = probe(executable);
  if (!health.available) throw new Error(health.detail);
  const timeoutMs = options.timeoutMs ?? 1_800_000;

  const outputDir = resolve(request.outputDir);
  await mkdir(dirname(outputDir), { recursive: true });
  await mkdir(outputDir);
  const configPath = join(outputDir, "request.json");
  await writeFile(configPath, JSON.stringify({ path, outputDir, ...settings, maxFrames: RIG_SHOT_LIMITS.frames }, null, 2));
  const worker = fileURLToPath(new URL("../python/rig-shot.py", import.meta.url));
  const logPath = join(outputDir, "blender.log");
  try {
    await runProcess(executable, [
      "--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1", "--python", worker, "--", configPath,
    ], { cwd: outputDir, logPath, timeoutMs, signal: options.signal });
  } catch (error) {
    const log = await readFile(logPath, "utf8").catch(() => "");
    const said = [...log.matchAll(/^RuntimeError: (.+)$/gm)].at(-1)?.[1];
    if (said) throw new Error(said, { cause: error });
    throw error;
  }
  const report = JSON.parse(await readFile(join(outputDir, "shot.json"), "utf8")) as RigShotReport;
  const mediaPath = await joinFrames(outputDir, report, { ffmpegPath: options.ffmpegPath, timeoutMs, signal: options.signal });
  return { outputDir, mediaPath, report };
}
