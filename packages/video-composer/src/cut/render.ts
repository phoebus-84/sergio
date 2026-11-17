// ---------------------------------------------------------------------------
// Rendering a cut
// ---------------------------------------------------------------------------
// probe the sources → check the cut against them → render each window's
// picture → render each bus's sound, window by window, and join it into a
// stem → mix the stems → set the mix to its loudness → join the picture and
// lay the mix under it.
//
// Every piece is a file in the work directory named by what made it: the
// FFmpeg arguments and the size and date of each file they read. A piece that
// is already there is not rendered again, so a second render of a cut that
// changed in one place does the work of that place.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { runProcess } from "../process-runner.js";
import { n } from "./effects.js";
import { mixJob, pictureEncoding, pictureJob, soundJob, type Job } from "./graph.js";
import { fileIdentity } from "./identity.js";
import { measureLoudness, probeFile, MediaError, type Tools } from "./media.js";
import { buses, cutFiles, cutFrames, divide, trackEdges, validateCut, SAMPLE_RATE, type Window } from "./plan.js";
import type { Cut, CutProblem, LoudnessReport, MediaInfo, RenderCutOptions, RenderCutResult, RenderProgress } from "./types.js";

export class CutError extends Error {
  constructor(message: string, readonly code: string, readonly problems: CutProblem[] = []) {
    super(message);
    this.name = "CutError";
  }
}

/** Pieces not used for this long are removed from the work directory after a render. */
const KEEP_PIECES_MS = 14 * 24 * 60 * 60 * 1000;

/** Picture windows: about ten seconds, never more than thirty. */
const PICTURE_TARGET_SECONDS = 10;
const PICTURE_MAX_SECONDS = 30;
/** Sound windows are longer: sound is cheap, and a treated clip is better not divided. */
const SOUND_TARGET_SECONDS = 60;
const SOUND_MAX_SECONDS = 180;

const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);

/** The size a cut is rendered at: its own, or at most 960 wide for a preview. */
export function renderSize(cut: Pick<Cut, "width" | "height">, quality: "preview" | "final"): { width: number; height: number } {
  if (quality === "final" || cut.width <= 960) return { width: cut.width, height: cut.height };
  const scale = 960 / cut.width;
  return { width: even(cut.width * scale), height: even(cut.height * scale) };
}

/** Probe every file a cut reads. A file that is missing or unreadable is a problem, not a throw. */
export async function probeCut(cut: Cut, tools: Tools = {}): Promise<{ media: Map<string, MediaInfo>; problems: CutProblem[] }> {
  const media = new Map<string, MediaInfo>();
  const problems: CutProblem[] = [];
  for (const file of cutFiles(cut)) {
    try {
      media.set(file, await probeFile(file, tools));
    } catch (error) {
      if (!(error instanceof MediaError)) throw error;
      problems.push({ code: error.code, path: "$", message: error.message, severity: "error" });
    }
  }
  return { media, problems };
}

/** Every problem of a cut, its files included: what `renderCut` would refuse or warn about. */
export async function checkCut(cut: Cut, tools: Tools = {}): Promise<CutProblem[]> {
  const structural = validateCut(cut);
  if (structural.some((p) => p.severity === "error")) return structural;
  const { media, problems } = await probeCut(cut, tools);
  return [...problems, ...validateCut(cut, media)];
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

const exists = async (file: string): Promise<boolean> => {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
};

interface Runner {
  ffmpeg: string;
  signal: AbortSignal | undefined;
  pieces: string;
  used: Set<string>;
}

async function run(runner: Runner, args: string[], what: string): Promise<string> {
  if (runner.signal?.aborted) throw new CutError(`${what} was cancelled`, "cancelled");
  const result = await runProcess(runner.ffmpeg, ["-hide_banner", "-nostdin", "-y", ...args], runner.signal ? { signal: runner.signal } : {});
  if (result.cancelled || runner.signal?.aborted) throw new CutError(`${what} was cancelled`, "cancelled");
  if (result.exitCode !== 0) {
    throw new CutError(`${what} failed (ffmpeg exit ${result.exitCode}): ${result.stderr.trim().split("\n").slice(-8).join(" | ")}`, "ffmpeg-failed");
  }
  return result.stderr;
}

/**
 * A piece of the render, made once: the file named by the job's arguments and
 * the state of the files it reads. Returns the file and whether it was there.
 */
async function piece(
  runner: Runner, job: Job, encoding: string[], extension: string, media: ReadonlyMap<string, { identity: string }>, what: string,
): Promise<{ file: string; reused: boolean }> {
  const states = await Promise.all([...new Set(job.files)].sort().map(async (file) => {
    // A piece is named by what made it: its name is its state, and its date moves each time it is used again.
    if (path.dirname(file) === runner.pieces) return [path.basename(file)];
    return [file, media.get(file)?.identity ?? await fileIdentity(file)];
  }));
  const key = createHash("sha256").update(JSON.stringify([job.args, encoding, states])).digest("hex").slice(0, 32);
  const file = path.join(runner.pieces, `${key}${extension}`);
  runner.used.add(path.basename(file));
  if (await exists(file)) {
    const now = new Date();
    await utimes(file, now, now).catch(() => undefined);
    return { file, reused: true };
  }
  // Written beside its name and moved into it: a render that stops halfway leaves no piece that looks whole.
  const partial = path.join(runner.pieces, `${key}.partial${extension}`);
  try {
    await run(runner, [...job.args, ...encoding, partial], what);
    await rename(partial, file);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return { file, reused: false };
}

const concatList = (files: readonly string[]): string =>
  files.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join("\n") + "\n";

async function removeStale(pieces: string, used: ReadonlySet<string>): Promise<void> {
  const now = Date.now();
  for (const name of await readdir(pieces).catch(() => [] as string[])) {
    if (used.has(name)) continue;
    const file = path.join(pieces, name);
    try {
      const info = await stat(file);
      if (info.isFile() && now - info.mtimeMs > KEEP_PIECES_MS) await rm(file, { force: true });
    } catch { /* gone already */ }
  }
}

const report = (loudness: { integrated: number | null; truePeak: number | null; range: number | null }): LoudnessReport =>
  ({ integrated: loudness.integrated, truePeak: loudness.truePeak, range: loudness.range });

/**
 * Render a cut to an H.264/AAC MP4.
 *
 * Refuses, before rendering anything, a cut with an error or a source that is
 * missing or unreadable (`CutError`, with every problem). Warnings come back
 * in the result.
 */
export async function renderCut(cut: Cut, options: RenderCutOptions): Promise<RenderCutResult> {
  const started = Date.now();
  const quality = options.quality ?? "final";
  const tools: Tools = {
    ...(options.ffmpegPath ? { ffmpegPath: options.ffmpegPath } : {}),
    ...(options.ffprobePath ? { ffprobePath: options.ffprobePath } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const progress = (p: RenderProgress) => options.onProgress?.(p);

  const structural = validateCut(cut);
  if (structural.some((p) => p.severity === "error")) throw new CutError(`the cut cannot be rendered: ${structural.find((p) => p.severity === "error")!.message}`, "invalid-cut", structural);

  progress({ phase: "probe", done: 0, total: 1 });
  const probed = await probeCut(cut, tools);
  const problems = [...probed.problems, ...validateCut(cut, probed.media)];
  const errors = problems.filter((p) => p.severity === "error");
  if (errors.length > 0) throw new CutError(`the cut cannot be rendered: ${errors[0]!.message}${errors.length > 1 ? ` (and ${errors.length - 1} more)` : ""}`, "invalid-cut", problems);
  const media = probed.media;
  progress({ phase: "probe", done: 1, total: 1 });

  const total = cutFrames(cut);
  const from = Math.max(0, options.range?.from ?? 0);
  const to = Math.min(total, options.range?.to ?? total);
  if (!(to > from)) throw new CutError(`there is nothing to render between frames ${from} and ${to}`, "empty-range");
  const fps = cut.fps;
  const size = renderSize(cut, quality);
  const resolveFile = options.resolveFile ?? ((file: string) => file);

  const pieces = path.join(options.workDir, "pieces");
  const scratch = path.join(options.workDir, "scratch");
  await mkdir(pieces, { recursive: true });
  await mkdir(scratch, { recursive: true });
  await mkdir(path.dirname(options.output), { recursive: true });
  const runner: Runner = { ffmpeg: options.ffmpegPath ?? "ffmpeg", signal: options.signal, pieces, used: new Set() };
  const work = { pictureChunks: 0, pictureReused: 0, soundChunks: 0, soundReused: 0 };

  // ── Picture ────────────────────────────────────────────────────────────
  const pictureTracks = cut.tracks.filter((track) => track.kind === "video");
  const pictureWindows = divide(trackEdges(pictureTracks), from, to, PICTURE_TARGET_SECONDS * fps, PICTURE_MAX_SECONDS * fps);
  const encoding = pictureEncoding(quality, fps);
  const chunks: string[] = new Array(pictureWindows.length);
  let done = 0;
  progress({ phase: "picture", done, total: pictureWindows.length });
  const renderChunk = async (index: number) => {
    const window = pictureWindows[index]!;
    // The job names an effect's own file (a LUT) among what it reads: a changed look is a changed chunk.
    const job = pictureJob(cut, window, media, { ...size, resolveFile });
    const { file, reused } = await piece(runner, job, encoding, ".mp4", media, `the picture of frames ${window[0]}–${window[1]}`);
    chunks[index] = file;
    work.pictureChunks += 1;
    if (reused) work.pictureReused += 1;
    done += 1;
    progress({ phase: "picture", done, total: pictureWindows.length, detail: `frames ${window[0]}–${window[1]}${reused ? " (kept)" : ""}` });
  };
  const lanes = Math.max(1, Math.min(options.concurrency ?? 1, pictureWindows.length));
  let nextChunk = 0;
  await Promise.all(Array.from({ length: lanes }, async () => {
    while (nextChunk < pictureWindows.length) await renderChunk(nextChunk++);
  }));

  // ── Sound ──────────────────────────────────────────────────────────────
  const all = buses(cut, media);
  const stems: { bus: (typeof all)[number]; file: string }[] = [];
  const soundWindows = new Map<string, Window[]>();
  let soundTotal = 0;
  for (const bus of all) {
    const windows = divide(trackEdges([{ ...bus.track, clips: bus.clips }]), from, to, SOUND_TARGET_SECONDS * fps, SOUND_MAX_SECONDS * fps);
    soundWindows.set(bus.id, windows);
    soundTotal += windows.length;
  }
  let soundDone = 0;
  progress({ phase: "sound", done: 0, total: soundTotal });
  for (const bus of all) {
    const parts: string[] = [];
    for (const window of soundWindows.get(bus.id)!) {
      const { file, reused } = await piece(runner, soundJob(cut, bus, window, all), [], ".wav", media, `the sound of "${bus.id}", frames ${window[0]}–${window[1]}`);
      parts.push(file);
      work.soundChunks += 1;
      if (reused) work.soundReused += 1;
      soundDone += 1;
      progress({ phase: "sound", done: soundDone, total: soundTotal, detail: `${bus.id} ${window[0]}–${window[1]}${reused ? " (kept)" : ""}` });
    }
    if (parts.length === 1) {
      stems.push({ bus, file: parts[0]! });
    } else {
      const list = path.join(scratch, `stem-${createHash("sha256").update(bus.id).digest("hex").slice(0, 12)}.txt`);
      await writeFile(list, concatList(parts));
      const joined = await piece(
        runner, { args: ["-f", "concat", "-safe", "0", "-i", list], files: parts }, ["-c:a", "copy", "-rf64", "auto"], ".wav", new Map(), `the stem of "${bus.id}"`,
      );
      stems.push({ bus, file: joined.file });
    }
  }

  // ── Mix and master ─────────────────────────────────────────────────────
  let mixFile: string | null = null;
  let loudness: RenderCutResult["loudness"] = null;
  if (stems.length > 0) {
    progress({ phase: "mix", done: 0, total: 1 });
    const premix = await piece(runner, mixJob(cut, stems), ["-rf64", "auto"], ".wav", new Map(), "the mix");
    progress({ phase: "mix", done: 1, total: 1 });

    progress({ phase: "master", done: 0, total: 1 });
    const target = cut.master?.loudness ?? null;
    const before = await measureLoudness(premix.file, tools);
    let gainDb = 0;
    let limited = false;
    const filters: string[] = [];
    if (target && before.integrated !== null) {
      gainDb = Math.round((target.integrated - before.integrated) * 100) / 100;
      filters.push(`volume=${n(gainDb)}dB`);
      // A static gain keeps the mix's dynamics. Only what would pass the ceiling is held back.
      if (before.truePeak !== null && before.truePeak + gainDb > target.truePeak) {
        limited = true;
        filters.push(`alimiter=limit=${n(Math.pow(10, target.truePeak / 20))}:level=disabled:attack=5:release=80`, `aresample=${SAMPLE_RATE}`);
      }
    }
    const mastered = await piece(
      runner, { args: ["-i", premix.file, ...(filters.length > 0 ? ["-af", filters.join(",")] : [])], files: [premix.file] },
      ["-c:a", "pcm_s24le", "-ar", String(SAMPLE_RATE), "-ac", "2", "-rf64", "auto"], ".wav", new Map(), "the master",
    );
    mixFile = mastered.file;
    const after = filters.length > 0 ? await measureLoudness(mixFile, tools) : before;
    loudness = { target, before: report(before), after: report(after), gainDb, limited };
    progress({ phase: "master", done: 1, total: 1 });
  }

  // ── Join ───────────────────────────────────────────────────────────────
  progress({ phase: "mux", done: 0, total: 1 });
  const list = path.join(scratch, "picture.txt");
  await writeFile(list, concatList(chunks));
  const partial = `${options.output}.partial.mp4`;
  const muxArgs = ["-f", "concat", "-safe", "0", "-i", list];
  if (mixFile) muxArgs.push("-i", mixFile, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", quality === "preview" ? "128k" : "256k");
  else muxArgs.push("-map", "0:v:0", "-c:v", "copy", "-an");
  muxArgs.push("-movflags", "+faststart", partial);
  try {
    await run(runner, muxArgs, "joining the render");
    await rename(partial, options.output);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  let keptMix: string | null = null;
  if (mixFile && options.keepMix) {
    keptMix = options.output.replace(/\.[^./]+$/, "") + ".mix.wav";
    await run(runner, ["-i", mixFile, "-c:a", "copy", "-rf64", "auto", keptMix], "keeping the mix");
  }
  progress({ phase: "mux", done: 1, total: 1 });

  await removeStale(pieces, runner.used);
  const info = await stat(options.output);
  return {
    output: options.output,
    mix: keptMix,
    quality,
    width: size.width,
    height: size.height,
    fps,
    frames: to - from,
    durationSeconds: (to - from) / fps,
    size: info.size,
    sha256: await sha256(options.output),
    hasAudio: mixFile !== null,
    loudness,
    work,
    inputs: [...media.values()],
    warnings: problems.filter((p) => p.severity === "warning"),
    elapsedMs: Date.now() - started,
  };
}

/**
 * One frame of a cut, as a PNG or JPEG: what the timeline shows at an instant,
 * with every effect, without rendering anything else.
 */
export async function renderCutFrame(
  cut: Cut, frame: number, output: string,
  options: { width?: number; resolveFile?: (file: string) => string } & Tools = {},
): Promise<string> {
  const structural = validateCut(cut);
  if (structural.some((p) => p.severity === "error")) throw new CutError(`the cut cannot be rendered: ${structural.find((p) => p.severity === "error")!.message}`, "invalid-cut", structural);
  const { media, problems } = await probeCut(cut, options);
  if (problems.length > 0) throw new CutError(`the cut cannot be rendered: ${problems[0]!.message}`, "invalid-cut", problems);
  const total = cutFrames(cut);
  const at = Math.max(0, Math.min(total - 1, Math.round(frame)));
  const width = even(Math.min(options.width ?? cut.width, cut.width));
  const height = even((cut.height * width) / cut.width);
  const job = pictureJob(cut, [at, at + 1], media, { width, height, resolveFile: options.resolveFile ?? ((file) => file) });
  await mkdir(path.dirname(output), { recursive: true });
  const runner: Runner = { ffmpeg: options.ffmpegPath ?? "ffmpeg", signal: options.signal, pieces: "", used: new Set() };
  await run(runner, [...job.args, "-q:v", "3", output], `frame ${at}`);
  return output;
}
