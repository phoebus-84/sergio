// ---------------------------------------------------------------------------
// Music written as code, in a workspace (ADR-0053)
// ---------------------------------------------------------------------------
// A piece is a file of Strudel code, music/<name>.strudel. It is checked
// without a sound (what plays, in which parts, at what tempo, what is wrong),
// and rendered to a WAV the edit can use: the whole piece or some of its
// cycles, all its parts or a few, with a tail or as a seamless loop, and each
// part alone as a stem. <output>.music.json beside the file names the piece
// and the file by hash, what was asked, the level it was brought to and what
// it measures — so that whoever cannot listen can still tell what was made.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeAudio, encodeWav, findChrome, levelAudio, StrudelError, StrudelRenderer, strudelVersion,
  type AudioAnalysis, type Inspection, type Leveled, type Problem, type Rendering,
} from "@av/strudel";
import { MUSIC_DIR, MUSIC_EXTENSION, MUSIC_RENDER_SUFFIX, validateMusicRender, type MusicRenderRecord, type MusicStem } from "@studio/contracts/src/music-renders.mjs";

export type MusicErrorCode = "bad-request" | "no-such-piece" | "bad-code" | "no-browser" | "render-failed";

export class MusicError extends Error {
  constructor(readonly code: MusicErrorCode, message: string, readonly problems: Problem[] = []) {
    super(message);
    this.name = "MusicError";
  }
}

/** Where a rendered file may go, relative to the workspace. */
export const MUSIC_OUTPUT_DIRS = ["assets/sounds/", "assets/audio/", "assets/music/", "music/", "artifacts/audio/"];
/** Loudness a render is brought to unless the request says otherwise: a known reference for whoever sets its gain in an edit. */
export const MUSIC_LOUDNESS = -16;
export const MUSIC_PEAK = -1;
/** The end of a file is "still sounding" above this level, dBFS. */
const RINGING = -50;

export interface MusicLevel {
  /** Integrated loudness to reach, LUFS (default −16); null keeps the render's own level. */
  loudness?: number | null;
  /** Peak ceiling, dBFS (default −1). */
  peak?: number;
  fadeIn?: number;
  fadeOut?: number;
}

export interface MusicRequest {
  /** The piece, relative to the workspace: music/<name>.strudel. */
  path: string;
  /** Where the file goes, relative to the workspace. Default: assets/sounds/<name>.wav. */
  output?: string;
  /** First cycle (default 0). */
  from?: number;
  /** How many cycles. Give this or `seconds`. */
  cycles?: number;
  /** Instead of `cycles`: as many whole cycles as fit in so many seconds. */
  seconds?: number;
  /** Cycles played before `from` and cut off, so the stretch opens with what they left ringing. */
  lead?: number;
  /** Seconds kept after the last cycle. */
  tail?: number;
  /** Fold the tail over the start: the file repeats without a seam. */
  loop?: boolean;
  only?: string[];
  mute?: string[];
  /** Also render each part alone, at the gain it has in the mix. */
  stems?: boolean;
  seed?: number;
  /** Let the piece fetch samples from the network. */
  network?: boolean;
  level?: MusicLevel;
}

export interface MusicOptions {
  /** A renderer to reuse; without one a browser is opened and closed. */
  renderer?: StrudelRenderer;
  signal?: AbortSignal;
  now?: () => Date;
}

const sha256 = (bytes: Buffer | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Where Remotion keeps the Chrome it downloads in this repository, beside the places @av/strudel looks in by itself. */
function chromeDirs(): string[] {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  return ["packages/remotion-composer", "studio/agent"].map((workspace) => join(root, workspace, "node_modules", ".remotion"));
}

/** Whether this machine can render music, and with which Chrome. */
export function musicReadiness(): { available: boolean; detail: string } {
  try {
    return { available: true, detail: `Strudel ${strudelVersion()}, rendered offline in ${findChrome({ searchDirs: chromeDirs() })}` };
  } catch (error) {
    return { available: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function withRenderer<T>(options: MusicOptions, work: (renderer: StrudelRenderer) => Promise<T>): Promise<T> {
  if (options.renderer) return translate(() => work(options.renderer!));
  return translate(async () => {
    const renderer = await StrudelRenderer.launch({ searchDirs: chromeDirs() });
    try {
      return await work(renderer);
    } finally {
      await renderer.close();
    }
  });
}

async function translate<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof StrudelError)) throw error;
    const code: MusicErrorCode = error.code === "no-browser" ? "no-browser" : error.code === "bad-code" ? "bad-code" : error.code === "bad-options" ? "bad-request" : "render-failed";
    throw new MusicError(code, error.message);
  }
}

/** The piece's code, read from inside the workspace once links are followed. */
function readPiece(dir: string, path: string): { code: string; hash: string } {
  if (typeof path !== "string" || isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw new MusicError("bad-request", `${path} is not a path inside the workspace`);
  if (!path.endsWith(MUSIC_EXTENSION)) throw new MusicError("bad-request", `a piece is a ${MUSIC_EXTENSION} file (${MUSIC_DIR}/<name>${MUSIC_EXTENSION}); ${path} is not`);
  const full = resolve(dir, path);
  if (!existsSync(full) || !statSync(full).isFile()) throw new MusicError("no-such-piece", `there is no ${path} in this workspace: write the piece first`);
  if (!realpathSync(full).startsWith(realpathSync(dir) + sep)) throw new MusicError("bad-request", `${path} leads out of this workspace`);
  const bytes = readFileSync(full);
  return { code: bytes.toString("utf-8"), hash: sha256(bytes) };
}

export interface MusicCheckRequest {
  /** The piece, relative to the workspace; or `code` to try something before saving it. */
  path?: string;
  code?: string;
  from?: number;
  /** How many cycles to look at (default 4). */
  cycles?: number;
  /** List up to this many events of each part. */
  events?: number;
  only?: string[];
  mute?: string[];
  network?: boolean;
}

/** Evaluate a piece without making a sound: what plays, in which parts, and what is wrong with it. */
export async function checkMusic(dir: string, request: MusicCheckRequest, options: MusicOptions = {}): Promise<{ inspection: Inspection; source: { path: string; hash: string } | null }> {
  if ((request.path === undefined) === (request.code === undefined)) throw new MusicError("bad-request", "give the piece's path, or code to try, one of them");
  const piece = request.path !== undefined ? readPiece(dir, request.path) : null;
  const from = request.from ?? 0;
  const inspection = await withRenderer(options, (renderer) =>
    renderer.inspect(piece?.code ?? request.code!, {
      from, to: from + (request.cycles ?? 4), events: request.events ?? 0, files: dir,
      ...(request.only ? { only: request.only } : {}), ...(request.mute ? { mute: request.mute } : {}),
      ...(request.network ? { network: true } : {}), ...(options.signal ? { signal: options.signal } : {}),
    }));
  return { inspection, source: piece ? { path: request.path!, hash: piece.hash } : null };
}

function outputPath(request: MusicRequest): string {
  const path = (request.output ?? `assets/sounds/${basename(request.path, MUSIC_EXTENSION)}.wav`).replace(/\\/g, "/");
  if (isAbsolute(path) || path.split("/").includes("..")) throw new MusicError("bad-request", `output: ${path} is not a path inside the workspace`);
  if (!MUSIC_OUTPUT_DIRS.some((d) => path.startsWith(d))) throw new MusicError("bad-request", `output: ${path} must be under one of ${MUSIC_OUTPUT_DIRS.join(", ")}`);
  if (!/^[\w./ -]+\.wav$/.test(path)) throw new MusicError("bad-request", `output: ${path} must be a .wav file named with letters, digits, dots, dashes and underscores`);
  return path;
}

const stemName = (part: string) => part.replace(/^\$/, "part").replace(/[^\w-]/g, "_");

/** What a person should know or listen for, read from the numbers. */
function concernsOf(made: Rendering, leveled: Leveled, analysis: AudioAnalysis, request: MusicRequest, level: Required<Pick<MusicLevel, "loudness" | "peak">>): string[] {
  const out = made.problems.map((p) => p.message);
  if (leveled.held) {
    out.push(`its peaks keep it at ${leveled.loudness} LUFS, under the ${level.loudness} asked: one part hits much harder than the rest plays (crest ${analysis.crest} dB). Lower that part's gain or soften its attack to bring the whole up`);
  }
  const closing = analysis.envelope.rms.at(-1) ?? -99;
  const ending = Math.max(closing, lastLevel(made));
  if (!made.loop && (request.level?.fadeOut ?? 0) === 0 && ending > RINGING) {
    out.push(`it is still sounding where it ends (${Math.round(ending)} dBFS): give it a tail to ring out in, or a fadeOut`);
  }
  if (made.loop && (request.tail ?? 0) === 0 && ending > RINGING) {
    out.push("a loop with no tail cuts off what rings past its last cycle: give tail seconds for it to be folded over the start");
  }
  if (analysis.head > 0.5) out.push(`it starts with ${analysis.head} s of silence`);
  if (analysis.stereo.correlation < 0) out.push(`left and right cancel when summed to mono (correlation ${analysis.stereo.correlation}): narrow the widest part`);
  if (Math.abs(analysis.dc) > 0.01) out.push(`it carries a DC offset (${analysis.dc}): something below hearing is in it — filter the lows of the part that adds it (hpf 20)`);
  const fetched = made.requests.filter((r) => r.outcome === "fetched").length;
  if (fetched > 0) out.push(`the piece took ${fetched} file${fetched === 1 ? "" : "s"} from the network: nobody checked the licence of those samples, and the render depends on them staying there`);
  return out;
}

/** RMS of the file's last 50 ms, dBFS. */
function lastLevel(made: Rendering): number {
  const n = Math.min(made.channels[0].length, Math.round(0.05 * made.sampleRate));
  let sum = 0;
  for (const channel of made.channels) for (let i = channel.length - n; i < channel.length; i++) sum += channel[i]! * channel[i]!;
  return sum > 0 ? 10 * Math.log10(sum / (2 * n)) : -Infinity;
}

export interface MusicRenderResult {
  record: MusicRenderRecord;
  recordPath: string;
}

/**
 * Render a piece into the workspace: the file, <output>.music.json beside it,
 * and with `stems` each part alone as <output>.<part>.wav. Nothing is written
 * when the piece does not evaluate or a sound of it cannot be played.
 */
export async function renderMusic(dir: string, request: MusicRequest, options: MusicOptions = {}): Promise<MusicRenderResult> {
  const piece = readPiece(dir, request.path);
  const output = outputPath(request);
  if ((request.cycles === undefined) === (request.seconds === undefined)) throw new MusicError("bad-request", "say how much to render: cycles, or seconds (one of them)");
  if (request.cycles !== undefined && !(Number.isFinite(request.cycles) && request.cycles > 0)) throw new MusicError("bad-request", "cycles is a number above 0");
  const from = request.from ?? 0;
  const level = { loudness: request.level?.loudness === undefined ? MUSIC_LOUDNESS : request.level.loudness, peak: request.level?.peak ?? MUSIC_PEAK };

  const shared = {
    from, files: dir,
    ...(request.cycles !== undefined ? { to: from + request.cycles } : { seconds: request.seconds! }),
    ...(request.lead !== undefined ? { lead: request.lead } : {}), ...(request.tail !== undefined ? { tail: request.tail } : {}),
    ...(request.loop ? { loop: true } : {}), ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.network ? { network: true } : {}), ...(options.signal ? { signal: options.signal } : {}),
  };
  // A stretch that does not open on an onset, or does not close on silence, would click: 5 ms is enough to stop it.
  const edges = {
    fadeIn: request.level?.fadeIn ?? ((request.lead ?? 0) > 0 && !request.loop ? 0.005 : 0),
    fadeOut: request.level?.fadeOut ?? (request.loop ? 0 : 0.005),
  };

  return withRenderer(options, async (renderer) => {
    const made = await renderer.render(piece.code, { ...shared, ...(request.only ? { only: request.only } : {}), ...(request.mute ? { mute: request.mute } : {}) });
    const errors = made.problems.filter((p) => p.level === "error");
    if (errors.length > 0) throw new MusicError("bad-code", `the piece does not render cleanly: ${errors.map((p) => p.message).join("; ")}`, made.problems);

    const leveled = levelAudio(made.channels, made.sampleRate, { loudness: level.loudness, peak: level.peak, ...edges });
    const analysis = analyzeAudio(leveled.channels, made.sampleRate);
    const concerns = concernsOf(made, leveled, analysis, request, level);

    const files: { path: string; bytes: Buffer }[] = [{ path: output, bytes: encodeWav(leveled.channels, made.sampleRate, "pcm24") }];
    const stems: MusicStem[] = [];
    if (request.stems) {
      const playing = made.parts.filter((p) => p.selected);
      if (playing.length === 0) concerns.push("the piece has no labelled parts, so it has no stems: write each part as `name: pattern`");
      for (const part of playing) {
        const alone = await renderer.render(piece.code, { ...shared, to: made.to, seconds: undefined, only: [part.name] });
        if (alone.problems.some((p) => p.code === "no-events")) {
          concerns.push(`part "${part.name}" plays nothing in this stretch: it has no stem`);
          continue;
        }
        // The mix's gain, so that the stems add up to the mix.
        const stem = levelAudio(alone.channels, alone.sampleRate, { gain: leveled.gain, peak: 0, ...edges });
        const path = `${output.slice(0, -".wav".length)}.${stemName(part.name)}.wav`;
        const bytes = encodeWav(stem.channels, alone.sampleRate, "pcm24");
        files.push({ path, bytes });
        stems.push({ part: part.name, path, hash: sha256(bytes), loudness: stem.loudness, peak: Number.isFinite(stem.peak) ? stem.peak : null });
      }
    }

    const record: MusicRenderRecord = {
      apiVersion: "studio.video/v1alpha1",
      kind: "MusicRender",
      engine: { name: "strudel", version: strudelVersion() },
      source: { path: request.path, hash: piece.hash },
      request: JSON.parse(JSON.stringify(request)) as Record<string, unknown>,
      tempo: { cps: made.cps, cyclesPerMinute: r3(made.cps * 60) },
      range: { from: made.from, to: made.to },
      output: {
        path: output, hash: sha256(files[0]!.bytes), durationSeconds: r3(made.seconds), bodySeconds: r3(made.bodySeconds),
        sampleRate: made.sampleRate, channels: 2, loop: made.loop,
      },
      parts: made.parts,
      level: { gain: leveled.gain, basis: leveled.basis, held: leveled.held, loudness: leveled.loudness, peak: Number.isFinite(leveled.peak) ? leveled.peak : null },
      analysis: JSON.parse(JSON.stringify(analysis)) as Record<string, unknown>,
      inputs: Object.fromEntries(made.requests.filter((r) => r.outcome === "served" && r.path && r.sha256).map((r) => [r.path!, r.sha256!])),
      fetched: made.requests.filter((r) => r.outcome === "fetched" && r.sha256).map((r) => ({ url: r.url, hash: r.sha256!, bytes: r.bytes ?? 0 })),
      stems,
      concerns,
      createdAt: (options.now?.() ?? new Date()).toISOString(),
    };
    const problems = validateMusicRender(record);
    if (problems.length > 0) throw new Error(`the render's record is not valid: ${problems.map((p) => `${p.path} ${p.message}`).join("; ")}`);

    const recordPath = `${output}${MUSIC_RENDER_SUFFIX}`;
    const write = (rel: string, bytes: Buffer | string) => {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(`${full}.tmp`, bytes);
      renameSync(`${full}.tmp`, full);
    };
    for (const file of files) write(file.path, file.bytes);
    write(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    return { record, recordPath };
  });
}

export interface MusicPiece {
  path: string;
  hash: string;
  /** The files rendered from it, newest first. `current` is false when the piece changed since, `missing` when the file is gone or was replaced. */
  renders: { recordPath: string; record: MusicRenderRecord; current: boolean; missing: boolean }[];
}

function walk(dir: string, root: string, keep: (name: string) => boolean, depth = 5): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (entry.name.startsWith(".")) return [];
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return depth > 0 ? walk(full, root, keep, depth - 1) : [];
    return keep(entry.name) ? [full.slice(root.length + 1).split(sep).join("/")] : [];
  });
}

/** The workspace's pieces and what was rendered from each. */
export function listMusic(dir: string): { pieces: MusicPiece[]; orphans: MusicPiece["renders"]; invalid: string[] } {
  const invalid: string[] = [];
  const renders: MusicPiece["renders"] = [];
  const sources = new Map(walk(join(dir, MUSIC_DIR), dir, (name) => name.endsWith(MUSIC_EXTENSION)).sort().map((path) => [path, sha256(readFileSync(join(dir, path)))]));
  const records = ["assets", MUSIC_DIR, "artifacts"].flatMap((top) => walk(join(dir, top), dir, (name) => name.endsWith(MUSIC_RENDER_SUFFIX)));
  for (const recordPath of records) {
    let record: MusicRenderRecord;
    try {
      record = JSON.parse(readFileSync(join(dir, recordPath), "utf-8")) as MusicRenderRecord;
    } catch {
      invalid.push(recordPath);
      continue;
    }
    if (validateMusicRender(record).length > 0) {
      invalid.push(recordPath);
      continue;
    }
    const file = join(dir, record.output.path);
    renders.push({
      recordPath, record,
      current: sources.get(record.source.path) === record.source.hash,
      missing: !existsSync(file) || sha256(readFileSync(file)) !== record.output.hash,
    });
  }
  renders.sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt));
  const pieces = [...sources].map(([path, hash]) => ({ path, hash, renders: renders.filter((r) => r.record.source.path === path) }));
  return { pieces, orphans: renders.filter((r) => !sources.has(r.record.source.path)), invalid: invalid.sort() };
}
