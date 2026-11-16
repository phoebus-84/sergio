// ---------------------------------------------------------------------------
// Looking at media: what a file is, stills and sheets of it, where it cuts
// ---------------------------------------------------------------------------
// Everything a person or an agent needs before placing footage in a cut:
// its streams and length, a still at an instant, a contact sheet to read a
// long take at a glance, the instants its picture changes, a light proxy to
// review it in a browser, and the levels of its sound.
// ---------------------------------------------------------------------------

import { stat, mkdir } from "node:fs/promises";
import * as path from "node:path";
import { runProcess } from "../process-runner.js";
import { fileIdentity } from "./identity.js";
import type { MediaInfo } from "./types.js";

const STILL_CODECS = new Set([
  "png", "mjpeg", "jpeg", "jpegls", "jpeg2000", "jpegxl", "bmp", "gif", "webp", "tiff", "targa", "ppm", "pgm", "pam", "qoi", "avif", "heif",
]);
const STILL_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".avif", ".heic", ".heif"]);
const ALPHA_PIXEL_FORMATS = /^(rgba|bgra|argb|abgr|ya\d|yuva|gbrap|pal8)/;

export interface Tools {
  ffmpegPath?: string;
  ffprobePath?: string;
  signal?: AbortSignal;
}

export class MediaError extends Error {
  constructor(message: string, readonly code: string, readonly file?: string) {
    super(message);
    this.name = "MediaError";
  }
}

const rate = (value: unknown): number | null => {
  const [a, b] = String(value ?? "").split("/").map(Number);
  if (!a || !Number.isFinite(a)) return null;
  const fps = b && Number.isFinite(b) ? a / b : a;
  return Number.isFinite(fps) && fps > 0 ? fps : null;
};

/** What a media file is: its streams, its length, whether it carries sound or transparency. */
export async function probeFile(file: string, tools: Tools = {}): Promise<MediaInfo> {
  let info;
  try {
    info = await stat(file);
  } catch {
    throw new MediaError(`${file} is not there`, "missing-file", file);
  }
  if (!info.isFile()) throw new MediaError(`${file} is not a file`, "missing-file", file);
  const result = await runProcess(tools.ffprobePath ?? "ffprobe", [
    "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file,
  ], tools.signal ? { signal: tools.signal } : {});
  if (result.exitCode !== 0) throw new MediaError(`${file} is not media FFmpeg can read: ${result.stderr.trim().split("\n").pop() ?? ""}`, "unreadable-media", file);
  let raw: { streams?: Record<string, unknown>[]; format?: Record<string, unknown> };
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    throw new MediaError(`${file}: ffprobe's answer cannot be read`, "unreadable-media", file);
  }
  const streams = raw.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video" && (s.disposition as Record<string, number> | undefined)?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === "audio");
  if (!video && !audio) throw new MediaError(`${file} has no picture and no sound`, "unreadable-media", file);

  const duration = Number(raw.format?.duration ?? video?.duration ?? audio?.duration);
  const frames = Number(video?.nb_frames);
  const still = !!video && !audio && (STILL_CODECS.has(String(video.codec_name).toLowerCase()) || STILL_EXTENSIONS.has(path.extname(file).toLowerCase())) &&
    !(Number.isFinite(frames) && frames > 1);
  // A phone's portrait clip is stored on its side with a rotation to apply: FFmpeg turns it, so its size is the turned one.
  const sideData = (video?.side_data_list as Record<string, unknown>[] | undefined) ?? [];
  const rotation = Math.abs(Number(sideData.find((d) => d.rotation !== undefined)?.rotation ?? (video?.tags as Record<string, unknown> | undefined)?.rotate ?? 0));
  const turned = rotation === 90 || rotation === 270;
  const width = video ? Number(video.width) : null;
  const height = video ? Number(video.height) : null;

  return {
    file,
    kind: video ? (still ? "image" : "video") : "audio",
    duration: still || !Number.isFinite(duration) ? null : duration,
    width: turned ? height : width,
    height: turned ? width : height,
    fps: video && !still ? rate(video.avg_frame_rate) ?? rate(video.r_frame_rate) : null,
    hasVideo: !!video,
    hasAudio: !!audio,
    audioChannels: audio ? Number(audio.channels) || null : null,
    sampleRate: audio ? Number(audio.sample_rate) || null : null,
    videoCodec: video ? String(video.codec_name) : null,
    audioCodec: audio ? String(audio.codec_name) : null,
    hasAlpha: !!video && ALPHA_PIXEL_FORMATS.test(String(video.pix_fmt ?? "")),
    size: info.size,
    mtimeMs: Math.round(info.mtimeMs),
    identity: await fileIdentity(file),
  };
}

async function ffmpeg(args: string[], tools: Tools, what: string): Promise<string> {
  const result = await runProcess(tools.ffmpegPath ?? "ffmpeg", ["-hide_banner", "-nostdin", "-y", ...args], tools.signal ? { signal: tools.signal } : {});
  if (result.cancelled) throw new MediaError(`${what} was cancelled`, "cancelled");
  if (result.exitCode !== 0) throw new MediaError(`${what} failed: ${result.stderr.trim().split("\n").slice(-4).join(" | ")}`, "ffmpeg-failed");
  return result.stderr;
}

/** One frame of a picture file as a JPEG or PNG (by the output's extension), `width` pixels wide. */
export async function extractStill(file: string, atSeconds: number, output: string, options: Tools & { width?: number } = {}): Promise<string> {
  await mkdir(path.dirname(output), { recursive: true });
  const scale = options.width ? ["-vf", `scale=${options.width}:-2`] : [];
  await ffmpeg(["-ss", String(Math.max(0, atSeconds)), "-i", file, "-frames:v", "1", ...scale, "-q:v", "3", output], options, `a still of ${path.basename(file)}`);
  return output;
}

export interface ContactSheet {
  output: string;
  columns: number;
  rows: number;
  /** The instant of each tile, seconds, left to right then down. */
  instants: number[];
}

/**
 * A grid of stills spread evenly over a clip, each stamped with its timecode:
 * a take read at a glance, by a person or by a model that sees images.
 */
export async function contactSheet(
  file: string, output: string,
  options: Tools & { columns?: number; rows?: number; tileWidth?: number; duration?: number } = {},
): Promise<ContactSheet> {
  const columns = options.columns ?? 4;
  const rows = options.rows ?? 3;
  const tiles = columns * rows;
  const duration = options.duration ?? (await probeFile(file, options)).duration;
  if (!duration || duration <= 0) throw new MediaError(`${file} has no length to spread a sheet over`, "no-duration", file);
  const step = duration / tiles;
  const instants = Array.from({ length: tiles }, (_, k) => Math.round((step * (k + 0.5)) * 1000) / 1000);
  const tileWidth = options.tileWidth ?? 480;
  await mkdir(path.dirname(output), { recursive: true });
  // One frame per interval, taken at its middle; the stamp is the frame's own time.
  const filter = [
    `fps=1/${step.toFixed(6)}:start_time=${(-step / 2).toFixed(6)}:round=near`,
    `scale=${tileWidth}:-2`,
    "drawtext=text='%{pts\\:hms}':x=8:y=h-th-8:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=4",
    `tile=${columns}x${rows}:padding=4:margin=4:color=0x111111`,
  ].join(",");
  try {
    await ffmpeg(["-i", file, "-vf", filter, "-frames:v", "1", "-q:v", "3", output], options, `a contact sheet of ${path.basename(file)}`);
  } catch (error) {
    // An FFmpeg built without a font renderer still makes the sheet, unstamped.
    if (!(error instanceof MediaError) || error.code !== "ffmpeg-failed") throw error;
    const plain = filter.split(",").filter((f) => !f.startsWith("drawtext")).join(",");
    await ffmpeg(["-i", file, "-vf", plain, "-frames:v", "1", "-q:v", "3", output], options, `a contact sheet of ${path.basename(file)}`);
  }
  return { output, columns, rows, instants };
}

export interface DetectedSegment {
  /** Seconds. */
  start: number;
  end: number;
}

/**
 * Where a clip's picture changes abruptly — the cuts in an assembled reel, or
 * the takes in one long recording — as the segments between them.
 *
 * @param threshold how different two frames must be, 0 to 1. 0.3 finds hard cuts; lower finds softer changes.
 */
export async function detectSegments(
  file: string, options: Tools & { threshold?: number; minSeconds?: number } = {},
): Promise<DetectedSegment[]> {
  const info = await probeFile(file, options);
  if (info.kind !== "video" || !info.duration) throw new MediaError(`${file} is not a video`, "not-video", file);
  const threshold = options.threshold ?? 0.3;
  const stderr = await ffmpeg(
    ["-i", file, "-an", "-vf", `select='gt(scene,${threshold})',showinfo`, "-f", "null", "-"],
    options, `finding the cuts of ${path.basename(file)}`,
  );
  const minSeconds = options.minSeconds ?? 0.5;
  const cuts: number[] = [];
  for (const match of stderr.matchAll(/pts_time:([0-9.]+)/g)) {
    const at = Number(match[1]);
    const previous = cuts[cuts.length - 1] ?? 0;
    if (at - previous >= minSeconds && info.duration - at >= minSeconds) cuts.push(at);
  }
  const edges = [0, ...cuts, info.duration];
  return edges.slice(0, -1).map((start, k) => ({ start: Math.round(start * 1000) / 1000, end: Math.round(edges[k + 1]! * 1000) / 1000 }));
}

/**
 * A small H.264/AAC copy of a clip a browser can play and scrub: camera
 * originals often are neither. The original is what a final render reads.
 */
export async function makeProxy(file: string, output: string, options: Tools & { height?: number } = {}): Promise<string> {
  await mkdir(path.dirname(output), { recursive: true });
  const info = await probeFile(file, options);
  const args = ["-i", file];
  if (info.hasVideo && info.kind !== "audio") {
    args.push("-vf", `scale=-2:${options.height ?? 540}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p", "-g", "24");
  }
  if (info.hasAudio) args.push("-c:a", "aac", "-b:a", "128k", "-ac", "2");
  else args.push("-an");
  args.push("-movflags", "+faststart", output);
  await ffmpeg(args, options, `a proxy of ${path.basename(file)}`);
  return output;
}

export interface Loudness {
  integrated: number | null;
  truePeak: number | null;
  range: number | null;
  threshold: number | null;
}

const finite = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/** A sound file's loudness (EBU R128): integrated LUFS, true peak dBTP, range LU. Null for silence. */
export async function measureLoudness(file: string, tools: Tools = {}): Promise<Loudness> {
  const stderr = await ffmpeg(
    ["-i", file, "-vn", "-af", "loudnorm=print_format=json", "-f", "null", "-"],
    tools, `measuring ${path.basename(file)}`,
  );
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start < 0 || end < start) return { integrated: null, truePeak: null, range: null, threshold: null };
  try {
    const json = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
    return {
      integrated: finite(json.input_i),
      truePeak: finite(json.input_tp),
      range: finite(json.input_lra),
      threshold: finite(json.input_thresh),
    };
  } catch {
    return { integrated: null, truePeak: null, range: null, threshold: null };
  }
}
