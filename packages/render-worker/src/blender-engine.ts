// The engine's side of a Blender job (blender-job.ts):
//
//   blender-paths <key>   ← {"bin","blends":[files/…]}  → {"missing":[files/… | absolute]}
//   blender <key>         ← BlenderJob                   → BlenderAnswer (last stdout line)
//   fetch-blender <key> <attempt>                        → bundle of blender/<attempt>/out/…
//
// The job runs the same @av/blender function a run on the controlling machine
// would, with the request's files where `receive` put them, the machine's own
// Blender, and its GPU lock held with flock(1) while Blender runs. Nothing is
// written outside blender/<attempt>/ but the lock.

import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { holdLock, DEFAULT_LOCK_WAIT_SECONDS, type Exec, type ExecResult } from "@av/machines";
import { ATTEMPT, BLENDER_KINDS, fileSlots, OUT, replacePrefix, type BlenderAnswer, type BlenderJob, type BlenderKind } from "./blender-job.js";
import { sha256File } from "./files.js";
import { checkJobPath, encodeBundle, PROTOCOL_VERSION, RenderWorkerError, type ManifestEntry } from "./protocol.js";

/** Runs one of @av/blender's functions: the real ones by default, a fake in tests. */
export type BlenderRunner = (kind: BlenderKind, request: Record<string, unknown>, options: { blenderPath: string; timeoutMs?: number }) => Promise<Record<string, unknown>>;

/** The files a .blend names that are not where it says, as absolute paths: Blender's own list by default. */
export type BlendPathsLister = (bin: string, blend: string) => Promise<string[]>;

/** "~/x" on the engine: the engine user's home. */
export function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p;
}

/**
 * @av/blender's module for each kind, loaded when a job runs: an engine that
 * only renders video never loads it, and this package is typechecked without it.
 */
const FUNCTIONS: Record<BlenderKind, [string, string]> = {
  "rig-shot": ["@av/blender/rig-shot", "rigShot"],
  "rig-sheet": ["@av/blender/rig-sheet", "rigSheet"],
  "stage-shot": ["@av/blender/stage-shot", "stageShot"],
  render: ["@av/blender", "runBlender"],
};

export const defaultBlenderRunner: BlenderRunner = async (kind, request, options) => {
  const [specifier, name] = FUNCTIONS[kind];
  const module = (await import(specifier)) as Record<string, (request: unknown, options: unknown) => Promise<Record<string, unknown>>>;
  return module[name]!(request, options);
};

const LIST_MISSING = [
  "import bpy, json, os",
  "missing = sorted({p for p in bpy.utils.blend_paths(absolute=True, packed=False) if p and not os.path.exists(p)})",
  "print('BLEND_PATHS ' + json.dumps(missing))",
].join("\n");

export const defaultBlendPathsLister: BlendPathsLister = async (bin, blend) => {
  const run = spawnSync(bin, ["--background", "--factory-startup", "--disable-autoexec", blend, "--python-expr", LIST_MISSING], { encoding: "utf-8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  if (run.error) throw new RenderWorkerError("engine-failed", `${bin} could not run: ${run.error.message}`);
  const line = (run.stdout ?? "").split("\n").find((l) => l.startsWith("BLEND_PATHS "));
  if (!line) throw new RenderWorkerError("engine-failed", `Blender could not read ${path.basename(blend)}: ${(run.stderr ?? "").trim().split("\n").slice(-3).join(" | ")}`);
  return JSON.parse(line.slice("BLEND_PATHS ".length)) as string[];
};

/** A path on the engine as the job names it: files/… when it is in the job's mirror, else as it is. */
function asJobPath(dir: string, absolute: string): string {
  const rel = path.relative(dir, absolute);
  if (!rel.startsWith("..") && !path.isAbsolute(rel) && rel.split(path.sep)[0] === "files") return rel.split(path.sep).join("/");
  return absolute;
}

export async function blendPaths(dir: string, request: { bin?: unknown; blends?: unknown }, lister: BlendPathsLister = defaultBlendPathsLister): Promise<{ missing: string[] }> {
  if (typeof request.bin !== "string" || !Array.isArray(request.blends)) throw new RenderWorkerError("bad-request", "blender-paths takes {bin, blends}");
  const missing = new Set<string>();
  for (const rel of request.blends) {
    if (typeof rel !== "string") throw new RenderWorkerError("bad-request", "a blend is a path under files/");
    const blend = path.join(dir, ...checkJobPath(rel).split("/"));
    if (!existsSync(blend)) throw new RenderWorkerError("missing-file", `${rel} has not been received`);
    for (const p of await lister(expandHome(request.bin), blend)) missing.add(asJobPath(dir, p));
  }
  return { missing: [...missing].sort() };
}

/** flock(1) on this machine: the GPU lock of a job, by the same command a lock over SSH takes. */
const localExec: Exec = (_destination, command, input = {}) => new Promise<ExecResult>((resolve, reject) => {
  const child = spawn("sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"], ...(input.signal ? { signal: input.signal } : {}) });
  let stderr = "";
  child.stderr.setEncoding("utf-8").on("data", (d: string) => { stderr = (stderr + d).slice(-4000); });
  if (input.stdout) child.stdout.pipe(input.stdout as Writable);
  child.on("error", reject);
  child.on("close", (code) => resolve({ code: code ?? 1, stdout: "", stderr }));
  child.stdin.on("error", () => undefined);
  if (input.stdin === undefined) child.stdin.end();
  else if (typeof input.stdin === "string" || Buffer.isBuffer(input.stdin)) child.stdin.end(input.stdin);
  else Readable.from(input.stdin).pipe(child.stdin);
});

export interface BlenderJobContext {
  run?: BlenderRunner;
  commit: string | null;
  /** The Blender's own word on its version, for the answer. */
  blenderVersion?: (bin: string) => string;
  /** Lines for the controlling machine. */
  log: (line: string) => void;
  /** The lock's runner: flock on this machine by default. */
  lockExec?: Exec;
}

function checkBlenderJob(job: BlenderJob): BlenderJob {
  if (job?.version !== PROTOCOL_VERSION) throw new RenderWorkerError("bad-request", `the job is protocol ${String(job?.version)}, this engine speaks ${PROTOCOL_VERSION}`);
  if (!BLENDER_KINDS.includes(job.kind)) throw new RenderWorkerError("bad-request", `a Blender job is one of ${BLENDER_KINDS.join(", ")}`);
  if (typeof job.bin !== "string" || job.bin === "") throw new RenderWorkerError("bad-request", "the job names no Blender");
  if (typeof job.attempt !== "string" || !ATTEMPT.test(job.attempt)) throw new RenderWorkerError("bad-request", "the job's attempt is not a name");
  if (!job.request || typeof job.request !== "object") throw new RenderWorkerError("bad-request", "the job has no request");
  return job;
}

function blenderVersionOf(bin: string): string {
  const run = spawnSync(bin, ["--version"], { encoding: "utf-8", timeout: 20_000 });
  return (run.stdout ?? "").split("\n")[0]?.trim() || "unknown";
}

/** Every file under `root`, as bundle entries named `<prefix>/<relative path>`. */
async function filesUnder(root: string, prefix: string): Promise<{ entry: ManifestEntry; file: string }[]> {
  const found: { entry: ManifestEntry; file: string }[] = [];
  const walk = async (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) await walk(file);
      else if (e.isFile()) {
        const rel = [prefix, ...path.relative(root, file).split(path.sep)].join("/");
        found.push({ file, entry: { path: rel, size: statSync(file).size, hash: await sha256File(file) } });
      }
    }
  };
  await walk(root);
  return found.sort((a, b) => a.entry.path.localeCompare(b.entry.path));
}

/** Runs a Blender job in the episode's folder `dir`. */
export async function runBlenderJob(dir: string, raw: BlenderJob, ctx: BlenderJobContext): Promise<BlenderAnswer> {
  const job = checkBlenderJob(raw);
  const request = structuredClone(job.request) as Record<string, unknown>;
  for (const s of fileSlots(job.kind, request)) {
    const rel = s.get();
    if (typeof rel !== "string") throw new RenderWorkerError("bad-request", `${s.what} is not a path`);
    const file = path.join(dir, ...checkJobPath(rel).split("/"));
    if (!existsSync(file)) throw new RenderWorkerError("missing-file", `${s.what} (${rel}) has not been received`);
    s.set(file);
  }
  const attemptDir = path.join(dir, "blender", job.attempt);
  if (existsSync(attemptDir)) throw new RenderWorkerError("bad-request", `the attempt ${job.attempt} exists already`);
  mkdirSync(attemptDir, { recursive: true });
  const outputDir = path.join(attemptDir, OUT);
  request.outputDir = outputDir;
  const bin = expandHome(job.bin);

  const work = async () => {
    ctx.log(`running Blender (${job.kind}) with ${job.bin}`);
    return (ctx.run ?? defaultBlenderRunner)(job.kind, request, { blenderPath: bin, ...(job.timeoutMs ? { timeoutMs: job.timeoutMs } : {}) });
  };
  let result: Record<string, unknown>;
  if (job.gpuLock) {
    const lockPath = expandHome(job.gpuLock);
    const lock = await holdLock(ctx.lockExec ?? localExec, "", lockPath, {
      waitSeconds: job.lockWaitSeconds ?? DEFAULT_LOCK_WAIT_SECONDS,
      onWaiting: () => ctx.log(`waiting for the GPU lock ${job.gpuLock}`),
    });
    try {
      result = await work();
    } finally {
      await lock.release();
    }
  } else {
    result = await work();
  }
  const files = existsSync(outputDir) ? await filesUnder(outputDir, OUT) : [];
  return {
    result: replacePrefix(result, outputDir, OUT),
    files: files.map((f) => f.entry),
    outputDir,
    engine: { commit: ctx.commit, blender: (ctx.blenderVersion ?? blenderVersionOf)(bin) },
  };
}

/** The attempt's output, as a bundle whose paths start with out/. */
export async function sendBlenderOutput(dir: string, attempt: string | undefined, stdout: Writable): Promise<void> {
  if (!attempt || !ATTEMPT.test(attempt)) throw new RenderWorkerError("bad-request", "fetch-blender takes an attempt name");
  const outputDir = path.join(dir, "blender", attempt, OUT);
  if (!existsSync(outputDir)) throw new RenderWorkerError("missing-file", `the attempt ${attempt} has no output here`);
  const files = await filesUnder(outputDir, OUT);
  await pipeline(encodeBundle(files.map((f) => ({ entry: f.entry, read: () => createReadStream(f.file) }))), stdout, { end: false });
}
