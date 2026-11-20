// A Blender job on an engine (blender-job.ts), seen from the controlling
// machine: the engine brought to this commit, the request's files sent once by
// content, the files a .blend names sent when the engine lacks them, the job
// run there with the machine's Blender and GPU lock, and its output directory
// brought back whole into the caller's outputDir, each file checked against
// the hash the engine reported. The caller gets what the local function
// returns, with its paths here, plus where it ran.

import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PassThrough, type Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { createHash } from "node:crypto";
import { blenderJob, BLENDER_CODE, OUT, prepareBlenderJob, replacePrefix, unmirrorPath, type BlenderAnswer, type BlenderKind } from "./blender-job.js";
import { localGit, renderCommit, syncCode, type Git } from "./code-sync.js";
import { probeEngine, type EngineTarget } from "./hosts.js";
import { checkKey, decodeBundle, lastJsonLine, RenderWorkerError, type ManifestEntry } from "./protocol.js";
import { call, DEFAULT_REPO_ROOT, formatBytes, sendFiles, type EngineSession } from "./remote.js";
import { sshExec, type Exec } from "./ssh.js";

export interface RemoteBlenderOptions {
  /** The engine: the blender machine's ssh destination, clone and cache. */
  target: EngineTarget;
  /** The unit's folder on the engine: <a>/<b>/<c>, plain names. */
  key: string;
  /** The Blender there. */
  bin: string;
  gpuLock?: string;
  lockWaitSeconds?: number;
  /** Files a .blend names may be sent from under these folders only (the episode, film or unit). */
  allowedRoots?: readonly string[];
  repoRoot?: string;
  exec?: Exec;
  git?: Git;
  onLog?: (line: string) => void;
  signal?: AbortSignal;
  /** Tests: the attempt's name. */
  attempt?: string;
  timeoutMs?: number;
}

/** Where a job ran, for its result and its provenance. */
export interface BlenderMachine {
  name: string;
  ssh: string;
  commit: string | null;
  blender: string;
  gpuLock?: string;
  sentFiles: number;
  sentBytes: number;
  /** The engine's folders the result's paths named there. */
  paths: { outputDir: string };
}

/** Brings the engine to this commit and checks it answers. */
async function openBlenderEngine(options: RemoteBlenderOptions): Promise<EngineSession> {
  const exec = options.exec ?? sshExec();
  const log = options.onLog ?? (() => undefined);
  const target = options.target;
  const probe = await probeEngine(exec, target);
  if (!probe.ok) {
    if (!probe.reachable) throw new RenderWorkerError("no-engine", `${target.name} (${target.destination}) did not answer over SSH: ${probe.reason}`);
  }
  const git = options.git ?? localGit(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const sha = await renderCommit(git, BLENDER_CODE);
  const version = probe.ok ? probe.version : null;
  const synced = version?.synced === sha && version.commit === sha ? sha : null;
  await syncCode({ git, exec, target, sha, synced, onLog: log, ...(options.signal ? { signal: options.signal } : {}) });
  return { target, exec, key: checkKey(options.key), sha, log, ...(options.signal ? { signal: options.signal } : {}) };
}

function inside(file: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const rel = path.relative(path.resolve(root), file);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
}

/** Sends what the job's .blend files name and the engine lacks, until nothing is missing. */
async function sendBlendReferences(engine: EngineSession, bin: string, blends: string[], roots: readonly string[]): Promise<{ sentFiles: number; sentBytes: number }> {
  let sentFiles = 0;
  let sentBytes = 0;
  if (blends.length === 0) return { sentFiles, sentBytes };
  const tried = new Set<string>();
  for (let round = 0; round < 4; round++) {
    const { missing } = lastJsonLine<{ missing: string[] }>((await call(engine.exec, engine.target, ["blender-paths", engine.key], {
      stdin: JSON.stringify({ bin, blends }), ...(engine.signal ? { signal: engine.signal } : {}),
    }, "blender-paths")).stdout);
    if (missing.length === 0) return { sentFiles, sentBytes };
    const sendable: { local: string; rel: string }[] = [];
    const lacking: string[] = [];
    for (const name of missing) {
      if (!name.startsWith("files/")) { lacking.push(name); continue; }
      const local = unmirrorPath(name);
      if (tried.has(name) || !existsSync(local) || !statSync(local).isFile() || !inside(local, roots)) lacking.push(local);
      else sendable.push({ local, rel: name });
    }
    if (lacking.length > 0) {
      throw new RenderWorkerError("missing-file", `the .blend names file(s) that cannot be sent to ${engine.target.name}: ${lacking.slice(0, 8).join(", ")}${lacking.length > 8 ? ", …" : ""}. Keep them in the episode or film beside the .blend, named relative to it (File › External Data › Make Paths Relative), or render here.`);
    }
    for (const s of sendable) tried.add(s.rel);
    const files = await Promise.all(sendable.map(async (s) => ({ local: s.local, entry: { path: s.rel, size: statSync(s.local).size, hash: await sha256(s.local) } })));
    const sent = await sendFiles(engine, files);
    sentFiles += sent.sentFiles;
    sentBytes += sent.sentBytes;
  }
  throw new RenderWorkerError("missing-file", "the .blend still names missing files after they were sent");
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return `sha256:${hash.digest("hex")}`;
}

/** Brings the attempt's output into `outputDir`, each file checked against what the engine reported. */
async function fetchOutput(engine: EngineSession, attempt: string, outputDir: string, expected: readonly ManifestEntry[]): Promise<void> {
  const wanted = new Map(expected.map((e) => [e.path, e]));
  const received = new Set<string>();
  const stream = new PassThrough();
  let sink: { out: Writable; hash: ReturnType<typeof createHash>; part: string; file: string } | null = null;
  const decoding = decodeBundle(stream, {
    start(entry) {
      const want = wanted.get(entry.path);
      if (!want || want.hash !== entry.hash || want.size !== entry.size) throw new RenderWorkerError("transfer-failed", `${entry.path} is not a file the job reported`);
      const file = path.join(outputDir, ...entry.path.split("/").slice(1));
      mkdirSync(path.dirname(file), { recursive: true });
      sink = { out: createWriteStream(`${file}.partial`), hash: createHash("sha256"), part: `${file}.partial`, file };
    },
    async data(chunk) {
      sink!.hash.update(chunk);
      if (!sink!.out.write(chunk)) await new Promise((r) => sink!.out.once("drain", r));
    },
    async end(entry) {
      const s = sink!;
      sink = null;
      s.out.end();
      await finished(s.out);
      const hash = `sha256:${s.hash.digest("hex")}`;
      if (hash !== entry.hash) {
        rmSync(s.part, { force: true });
        throw new RenderWorkerError("transfer-failed", `${entry.path} came back as ${hash}, the engine wrote ${entry.hash}`);
      }
      renameSync(s.part, s.file);
      received.add(entry.path);
    },
  }, OUT);
  decoding.catch(() => stream.resume());
  const [fetched, decoded] = await Promise.allSettled([
    call(engine.exec, engine.target, ["fetch-blender", engine.key, attempt], { stdout: stream, ...(engine.signal ? { signal: engine.signal } : {}) }, "fetch-blender"),
    decoding,
  ]);
  // A file that came back wrong is the failure; the engine's broken pipe that follows is not.
  if (decoded.status === "rejected") {
    const s = sink as { out: Writable; part: string } | null;
    if (s) { s.out.destroy(); rmSync(s.part, { force: true }); }
    throw decoded.reason;
  }
  if (fetched.status === "rejected") throw fetched.reason;
  const absent = expected.filter((e) => !received.has(e.path)).map((e) => e.path);
  if (absent.length > 0) throw new RenderWorkerError("transfer-failed", `${absent.length} file(s) did not come back: ${absent.slice(0, 5).join(", ")}`);
}

/**
 * runBlender's manifest names the engine's folders and its copy of the .blend:
 * they become this machine's, and the engine's are kept under machine.paths.
 */
function localizeManifest(outputDir: string, engineOutputDir: string, origins: Map<string, string>, engineDir: string, machine: BlenderMachine): void {
  const file = path.join(outputDir, "manifest.json");
  if (!existsSync(file)) return;
  let manifest = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
  const enginePaths: Record<string, unknown> = { outputDir: engineOutputDir };
  for (const key of ["inputBlend", "inputScript"] as const) {
    const value = manifest[key];
    if (typeof value !== "string") continue;
    enginePaths[key] = value;
    const rel = path.posix.relative(engineDir.split(path.sep).join("/"), value.split(path.sep).join("/"));
    const origin = origins.get(rel);
    if (origin) manifest[key] = origin;
  }
  manifest = replacePrefix(manifest, engineOutputDir, outputDir);
  manifest.machine = { ...machine, paths: enginePaths };
  writeFileSync(`${file}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/** Runs `kind` with `request` on the engine; its result as the local function would return it, plus `machine`. */
export async function runBlenderRemote<T extends object>(kind: BlenderKind, request: object & { outputDir: string }, options: RemoteBlenderOptions): Promise<T & { machine: BlenderMachine }> {
  const outputDir = path.resolve(request.outputDir);
  if (existsSync(outputDir)) throw new RenderWorkerError("bad-request", `${outputDir} exists: an attempt is never written over`);
  const prepared = await prepareBlenderJob(kind, request);
  const engine = await openBlenderEngine(options);
  const log = engine.log;
  log(`Blender on ${engine.target.name} (${engine.target.destination})`);
  const sent = await sendFiles(engine, prepared.files);
  const roots = options.allowedRoots ?? [...new Set([...prepared.origins.values()].map((o) => path.dirname(o)))];
  const referenced = await sendBlendReferences(engine, options.bin, prepared.blends, roots);
  const sentFiles = sent.sentFiles + referenced.sentFiles;
  const sentBytes = sent.sentBytes + referenced.sentBytes;
  if (sentFiles > 0) log(`sent ${sentFiles} file(s), ${formatBytes(sentBytes)}`);

  const attempt = options.attempt ?? `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const job = blenderJob(prepared, kind, {
    bin: options.bin, attempt,
    ...(options.gpuLock ? { gpuLock: options.gpuLock } : {}),
    ...(options.lockWaitSeconds !== undefined ? { lockWaitSeconds: options.lockWaitSeconds } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  const ran = await call(engine.exec, engine.target, ["blender", engine.key], {
    stdin: JSON.stringify(job),
    onStderrLine: (line) => { if (line.trim()) log(line); },
    ...(engine.signal ? { signal: engine.signal } : {}),
  }, "blender");
  const answer = lastJsonLine<BlenderAnswer>(ran.stdout);

  mkdirSync(path.dirname(outputDir), { recursive: true });
  mkdirSync(outputDir); // exclusive, as a local attempt
  try {
    await fetchOutput(engine, attempt, outputDir, answer.files);
  } catch (e) {
    rmSync(outputDir, { recursive: true, force: true });
    throw e;
  }
  const machine: BlenderMachine = {
    name: engine.target.name, ssh: engine.target.destination, commit: answer.engine.commit ?? engine.sha, blender: answer.engine.blender,
    ...(options.gpuLock ? { gpuLock: options.gpuLock } : {}), sentFiles, sentBytes, paths: { outputDir: answer.outputDir },
  };
  if (kind === "render") {
    const engineDir = path.posix.dirname(path.posix.dirname(path.posix.dirname(answer.outputDir.split(path.sep).join("/"))));
    localizeManifest(outputDir, answer.outputDir, prepared.origins, engineDir, machine);
  }
  const result = replacePrefix(answer.result, OUT, outputDir) as T;
  return { ...result, machine };
}

