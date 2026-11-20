// A Blender job: one of @av/blender's functions, run on an engine with the
// operator's Blender there (ADR-0056). The request is the function's own,
// with every file it reads mirrored under the job's files/ (protocol.ts) and
// named there, so the engine reads the same bytes; the output directory is
// the engine's to choose, and comes back whole.
//
//   rig-shot     rigShot(request)        request.path
//   rig-sheet    rigSheet(request)       request.rigPath, request.clips[].path
//   stage-shot   stageShot(request)      request.set, players[].path, players[].does[].clip
//   render       runBlender(request)     request.blendPath (preview or animation of a saved .blend)
//
// A .blend may name files outside itself (textures, libraries). Those are
// found on the engine, by its Blender, and sent before the job runs
// (`blender-paths`), when they are on this machine.

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { sha256FileCached } from "./files.js";
import { mirrorPath, PROTOCOL_VERSION, RenderWorkerError, type ManifestEntry } from "./protocol.js";
import type { JobFile } from "./files.js";

export const BLENDER_KINDS = ["rig-shot", "rig-sheet", "stage-shot", "render"] as const;
export type BlenderKind = (typeof BLENDER_KINDS)[number];

/** What changes a Blender job's result or how the engine runs it: changes here must be committed first. */
export const BLENDER_CODE = ["packages/blender", "packages/render-worker", "packages/machines", "package.json", "bun.lock"];

/** The token a result's paths in the engine's output directory are written with, in an answer. */
export const OUT = "out";

export interface BlenderJob {
  version: number;
  kind: BlenderKind;
  /** The function's request, its files named under files/ and without outputDir. */
  request: Record<string, unknown>;
  /** The Blender to run, as the machines file names it ("~/" is the engine user's home). */
  bin: string;
  /** A path on the engine to hold with flock(1) while Blender runs. */
  gpuLock?: string;
  /** How long to wait for that lock. */
  lockWaitSeconds?: number;
  /** A new name: the job's output goes under blender/<attempt>/out. */
  attempt: string;
  timeoutMs?: number;
}

/** What `blender` answers: the function's result with its paths under `out/`, and every file it wrote. */
export interface BlenderAnswer {
  result: Record<string, unknown>;
  files: ManifestEntry[];
  /** Where the engine wrote, for the record. */
  outputDir: string;
  engine: { commit: string | null; blender: string };
}

export const ATTEMPT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

type Slot = { get: () => unknown; set: (value: string) => void; what: string };

/** The places in a request that name a file the job reads. */
export function fileSlots(kind: BlenderKind, request: Record<string, any>): Slot[] {
  const slot = (holder: Record<string, any>, key: string, what: string): Slot[] =>
    holder && holder[key] !== undefined ? [{ get: () => holder[key], set: (v) => { holder[key] = v; }, what }] : [];
  switch (kind) {
    case "rig-shot":
      return slot(request, "path", "the body");
    case "rig-sheet":
      return [
        ...slot(request, "rigPath", "the rig"),
        ...((request.clips ?? []) as Record<string, any>[]).flatMap((clip, i) => slot(clip, "path", `clip ${i + 1}`)),
      ];
    case "stage-shot":
      return [
        ...slot(request, "set", "the set"),
        ...((request.players ?? []) as Record<string, any>[]).flatMap((player) => [
          ...slot(player, "path", `${player.name}'s body`),
          ...((player.does ?? []) as Record<string, any>[]).flatMap((act, i) => slot(act, "clip", `${player.name}'s act ${i + 1}`)),
        ]),
      ];
    case "render":
      return slot(request, "blendPath", "the .blend");
  }
}

/** The .blend files of a request, which may name other files: a set, a scene. */
export function blendSlots(kind: BlenderKind, request: Record<string, any>): Slot[] {
  return fileSlots(kind, request).filter((s) => typeof s.get() === "string" && /\.blend$/i.test(s.get() as string));
}

export interface PreparedBlenderJob {
  /** The request as the engine reads it: files under files/, no outputDir. */
  request: Record<string, unknown>;
  files: JobFile[];
  /** The mirrored .blend files, to ask the engine what they name. */
  blends: string[];
  /** The local path each mirrored one came from. */
  origins: Map<string, string>;
}

/** Checks a kind and a request, mirrors the files it reads, and hashes each one. */
export async function prepareBlenderJob(kind: BlenderKind, request: object): Promise<PreparedBlenderJob> {
  if (!BLENDER_KINDS.includes(kind)) throw new RenderWorkerError("bad-request", `a Blender job is one of ${BLENDER_KINDS.join(", ")}`);
  const copy = structuredClone(request) as Record<string, unknown>;
  delete copy.outputDir;
  if (kind === "render") {
    if (copy.mode === "create" || copy.scriptPath !== undefined) throw new RenderWorkerError("bad-request", "on another machine a .blend is rendered; a scene is created here");
  }
  const files: JobFile[] = [];
  const origins = new Map<string, string>();
  const seen = new Map<string, string>();
  for (const s of fileSlots(kind, copy)) {
    const value = s.get();
    if (typeof value !== "string" || value === "") throw new RenderWorkerError("bad-request", `${s.what} is not a path`);
    const local = path.resolve(value);
    if (!existsSync(local) || !statSync(local).isFile()) throw new RenderWorkerError("missing-file", `${s.what}: ${local} is not a file`);
    const rel = mirrorPath(local);
    s.set(rel);
    if (seen.has(rel)) continue;
    seen.set(rel, local);
    origins.set(rel, local);
    files.push({ local, entry: { path: rel, size: statSync(local).size, hash: await sha256FileCached(local) } });
  }
  return { request: copy, files, blends: blendSlots(kind, copy).map((s) => s.get() as string), origins };
}

/** The local path a mirrored path came from: the reverse of mirrorPath. */
export function unmirrorPath(rel: string, platform: NodeJS.Platform = process.platform): string {
  const parts = rel.split("/");
  if (parts[0] !== "files" || parts.length < 2) throw new RenderWorkerError("bad-path", `"${rel}" is not under files/`);
  const rest = parts.slice(1);
  if (platform === "win32") {
    if (rest[0] === "unc") return `\\\\${rest.slice(1).join("\\")}`;
    return `${rest[0]}:\\${rest.slice(1).join("\\")}`;
  }
  return `/${rest.join("/")}`;
}

/** Every string in `value` that starts with `from`, starting with `to` instead. */
export function replacePrefix<T>(value: T, from: string, to: string): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v === from || v.startsWith(`${from}/`) || v.startsWith(`${from}${path.sep}`) ? `${to}${v.slice(from.length)}` : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

export function blenderJob(prepared: PreparedBlenderJob, kind: BlenderKind, options: Omit<BlenderJob, "version" | "kind" | "request">): BlenderJob {
  if (!ATTEMPT.test(options.attempt)) throw new RenderWorkerError("bad-request", `"${options.attempt}" is not an attempt name`);
  return { version: PROTOCOL_VERSION, kind, request: prepared.request, ...options };
}
