// ---------------------------------------------------------------------------
// Any ComfyUI workflow the operator has, through the studio's tools (ADR-0055)
// ---------------------------------------------------------------------------
// A workflow is a declared template (@av/comfyui): an API-format graph with
// {{placeholders}}, its inputs, its outputs and the nodes and models it
// requires. Three places hold them, a later one hiding an earlier one of the
// same name:
//
//   built-in                         the ones @av/comfyui ships
//   library/.render/comfyui/workflows/   the operator's, for every channel and
//                                        film on this machine (beside the
//                                        server's comfyui.json)
//   library/<channel or film>/comfyui/workflows/   a channel's or a film's own,
//                                        which travel with its repository
//
// `pva_comfyui_workflows` lists them, with whether the server can run each.
// `pva_comfyui_run` runs one with given inputs in an episode, a channel
// source or a film unit, and writes each output into the workspace with a
// receipt beside it: <file>.comfyui.json. The server is the one speech uses
// (AVG_COMFYUI_URL, or url in the library's .render/comfyui.json). Its GPU is
// the operator's: $0, nothing on the spend ledger, and the time the server
// spent is in the receipt and, for an episode or a film unit, its journal.
//
// Every server names its model files its own way. A workflow takes them as
// `model` inputs with defaults; the library's comfyui.json may give other
// defaults per workflow, for its server, without copying the workflow:
//   "workflowDefaults": { "z-image-turbo": { "vae": "ae.safetensors" } }
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import {
  BUILT_IN, ComfyUiError, createComfyUiClient, describeProbe, isFileInput, listWorkflows, probeWorkflow, requiredModels, runWorkflow, serverInfo,
  withDefaults,
  type DeclaredWorkflow, type InputDeclaration, type NodeInfoCache, type WorkflowEntry, type WorkflowFile, type WorkflowProbe, type WorkflowRun,
} from "@av/comfyui";
import { appendJournalEvent } from "@studio/contracts/src/journal.mjs";
import { comfyUiConfig, COMFYUI_CONFIG_RELATIVE, COMFYUI_URL_ENV } from "./comfyui-speech.js";
import { guardWorkspacePath, workspaceOf, WORKSPACE_PARAMS, type Workspace } from "./workspace-target.js";

export const COMFYUI_WORKFLOW_PROVIDER = "comfyui";
/** Under the library's .render/: the operator's workflows. */
export const LIBRARY_WORKFLOWS_RELATIVE = join(".render", "comfyui", "workflows");
/** Under a channel or a film: its own workflows. */
export const PROJECT_WORKFLOWS_RELATIVE = join("comfyui", "workflows");
export const RECEIPT_SUFFIX = ".comfyui.json";
/** How long a workflow may take, queue included, unless comfyui.json says (workflowTimeoutSeconds). */
export const DEFAULT_RUN_TIMEOUT_SECONDS = 1800;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Where a workflow's outputs go in a workspace, unless the call says: music in music/, as a Strudel render may be. */
export function defaultFolder(workflow: DeclaredWorkflow, role: string): string {
  if (workflow.kind === "music") return "music";
  if (workflow.kind === "speech") return "artifacts/narration";
  if (role === "image") return "assets/images";
  if (role === "video") return "assets/video/comfyui";
  return "assets/audio";
}

const posix = (p: string) => p.split("\\").join("/");

/** The folders a library and a channel or film add to the built-in workflows, in order. */
export function workflowFolders(libraryRoot: string, project?: string): { dir: string; origin: string }[] {
  return [
    { dir: join(libraryRoot, LIBRARY_WORKFLOWS_RELATIVE), origin: "library" },
    ...(project ? [{ dir: join(libraryRoot, project, PROJECT_WORKFLOWS_RELATIVE), origin: project }] : []),
  ];
}

/** The library's defaults for its server, by workflow: comfyui.json's workflowDefaults. */
export function workflowDefaults(libraryRoot: string): Record<string, Record<string, unknown>> {
  let config: Record<string, unknown>;
  try {
    config = comfyUiConfig(libraryRoot) as Record<string, unknown>;
  } catch {
    return {}; // the file's own error is reported where the server is needed
  }
  const value = config.workflowDefaults;
  if (value === undefined) return {};
  const where = `${posix(COMFYUI_CONFIG_RELATIVE)}: workflowDefaults`;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} is { "<workflow>": { "<input>": value } }`);
  for (const [name, inputs] of Object.entries(value)) {
    if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) throw new Error(`${where}.${name} is { "<input>": value }`);
  }
  return value as Record<string, Record<string, unknown>>;
}

/** Every workflow the library and the channel or film have, with the library's defaults for its server applied. */
export function comfyUiWorkflows(libraryRoot: string, project?: string): WorkflowEntry[] {
  if (project !== undefined && (!/^[a-z0-9][a-z0-9._-]*$/i.test(project) || project.includes(".."))) throw new Error(`"${project}" is not a slug`);
  const defaults = workflowDefaults(libraryRoot);
  return listWorkflows(workflowFolders(libraryRoot, project)).map((entry) => {
    const own = defaults[entry.name];
    if (!entry.workflow || !own) return entry;
    try {
      return { ...entry, workflow: withDefaults(entry.workflow, own), defaulted: Object.keys(own) };
    } catch (e) {
      const { workflow: _unusable, ...rest } = entry;
      return { ...rest, problems: [...entry.problems, { level: "error" as const, message: `${posix(COMFYUI_CONFIG_RELATIVE)} workflowDefaults: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  });
}

/** Where a workflow's file is, as a receipt names it: relative to the library, or built-in:<name>. */
function whereFrom(libraryRoot: string, entry: WorkflowEntry): string {
  return entry.origin === BUILT_IN ? `${BUILT_IN}:${entry.name}` : posix(relative(libraryRoot, entry.path));
}

const NOT_CONFIGURED = `${COMFYUI_URL_ENV} is not set and the library's ${posix(COMFYUI_CONFIG_RELATIVE)} names no url`;

function serverUrl(libraryRoot: string): { url: string; timeoutSeconds: number; outputPrefix?: string; inputSubfolder?: string } {
  const config = comfyUiConfig(libraryRoot) as ReturnType<typeof comfyUiConfig> & { workflowTimeoutSeconds?: unknown; workflowOutputPrefix?: unknown; workflowInputSubfolder?: unknown };
  if (!config.url) throw new Error(NOT_CONFIGURED);
  const t = config.workflowTimeoutSeconds;
  if (t !== undefined && !(typeof t === "number" && t > 0)) throw new Error(`${posix(COMFYUI_CONFIG_RELATIVE)}: workflowTimeoutSeconds is not a positive number`);
  for (const k of ["workflowOutputPrefix", "workflowInputSubfolder"] as const) {
    if (config[k] !== undefined && typeof config[k] !== "string") throw new Error(`${posix(COMFYUI_CONFIG_RELATIVE)}: ${k} is not a string`);
  }
  return {
    url: config.url,
    timeoutSeconds: (t as number | undefined) ?? DEFAULT_RUN_TIMEOUT_SECONDS,
    ...(typeof config.workflowOutputPrefix === "string" ? { outputPrefix: config.workflowOutputPrefix } : {}),
    ...(typeof config.workflowInputSubfolder === "string" ? { inputSubfolder: config.workflowInputSubfolder } : {}),
  };
}

const unreachable = (e: unknown) => (e instanceof ComfyUiError && e.code === "unreachable" ? new Error(`${e.message}: is the server running, and the operator's tunnel to it open?`) : e);

// ── Describing a workflow ──────────────────────────────────────────────────

function describeInput(name: string, d: InputDeclaration): string {
  const range = d.min !== undefined || d.max !== undefined ? ` [${d.min ?? ""}–${d.max ?? ""}]` : "";
  const value = d.default !== undefined ? ` = ${JSON.stringify(d.default).slice(0, 40)}` : isFileInput(d) ? " (workspace file)" : d.type === "seed" ? " (random unless given)" : "";
  const options = d.type === "choice" && d.options ? ` {${d.options.join(" | ")}}` : "";
  return `${name}: ${d.type}${options}${range}${value}${d.optional ? ", optional" : ""}${d.description ? ` — ${d.description}` : ""}`;
}

export function describeWorkflow(entry: WorkflowEntry, probe?: WorkflowProbe | string, detail = false): string {
  const w = entry.workflow;
  const from = `${entry.origin}${entry.shadows ? `, hides ${entry.shadows.origin}'s` : ""}`;
  if (!w) return `- ${entry.name} (${from}): ❌ unusable — ${entry.problems.filter((p) => p.level === "error").map((p) => p.message).join("; ")}`;
  const server = probe === undefined ? "" : typeof probe === "string" ? `; server: ${probe}` : `; server: ${probe.runnable ? "✅ " : "❌ "}${describeProbe(probe)}`;
  const head = `- ${entry.name} (${w.kind}, ${from}): ${w.description}${server}${w.verifiedOn ? "" : "; never run on a real server yet"}`;
  if (!detail) {
    const inputs = Object.entries(w.inputs).map(([n, d]) => `${n}${d.default !== undefined || d.optional || d.type === "seed" ? "?" : ""}:${d.type}`).join(", ");
    return `${head}\n    inputs ${inputs}; outputs ${Object.values(w.outputs).join(", ")}`;
  }
  const checked = probe && typeof probe !== "string" ? probe.models : [];
  const models = requiredModels(w).map((m) => {
    const files = checked.find((c) => c.node === m.node && c.input === m.input)?.available;
    return `${m.inputName ? `${m.inputName} = ` : ""}${m.file ?? `${m.classType}.${m.input}`}${m.folder ? ` (models/${m.folder})` : ""}${m.source ? ` from ${m.source}` : ""}` +
      `${files ? `; the server's ${m.classType} has ${files.slice(0, 12).join(", ") || "none"}${files.length > 12 ? `, and ${files.length - 12} more` : ""}` : ""}`;
  });
  const defaulted = (entry as WorkflowEntry & { defaulted?: string[] }).defaulted;
  return [
    head,
    "  inputs:",
    ...Object.entries(w.inputs).map(([n, d]) => `    - ${describeInput(n, d)}`),
    `  outputs: ${Object.entries(w.outputs).map(([node, role]) => `node ${node} → ${role}`).join(", ")}`,
    "  models:", ...(models.length > 0 ? models.map((m) => `    - ${m}`) : ["    none declared"]),
    ...(defaulted ? [`  defaults from the library's ${posix(COMFYUI_CONFIG_RELATIVE)}: ${defaulted.join(", ")}`] : []),
    ...(w.requires?.packs?.length ? [`  custom node packs: ${w.requires.packs.join(", ")}`] : []),
    ...(w.verifiedOn ? [`  last run on: ${w.verifiedOn}`] : []),
    ...entry.problems.filter((p) => p.level === "warning").map((p) => `  ⚠️ ${p.message}`),
    `  file: ${entry.path}`,
  ].join("\n");
}

/** Whether the server answers and which workflows it can run, for pva_capability_status. */
export async function comfyUiWorkflowsStatus(libraryRoot: string): Promise<{ available: boolean; detail: string }> {
  let url: string;
  try {
    url = serverUrl(libraryRoot).url;
  } catch (e) {
    return { available: false, detail: e instanceof Error ? e.message : String(e) };
  }
  const entries = comfyUiWorkflows(libraryRoot).filter((e) => e.workflow);
  try {
    const client = createComfyUiClient({ baseUrl: url, requestTimeoutMs: 5_000 });
    const server = await serverInfo(client);
    const cache: NodeInfoCache = new Map();
    const probes = await Promise.all(entries.map(async (e) => [e.name, await probeWorkflow(client, e.workflow!, { cache })] as const));
    const runnable = probes.filter(([, p]) => p.runnable).map(([n]) => n);
    const not = probes.filter(([, p]) => !p.runnable).map(([n, p]) => `${n} (${describeProbe(p)})`);
    return {
      available: runnable.length > 0,
      detail: `ComfyUI ${server.version ?? "?"} at ${url}: pva_comfyui_run, $0; runnable ${runnable.join(", ") || "none"}${not.length > 0 ? `; not runnable: ${not.join("; ")}` : ""}`,
    };
  } catch (e) {
    return { available: false, detail: `${e instanceof Error ? e.message : String(e)}; a server that listens on its own loopback needs the operator's tunnel open` };
  }
}

// ── Generated music, beside Strudel's renders ──────────────────────────────

export interface GeneratedMusic {
  path: string;
  receiptPath: string;
  workflow: string;
  seed: number | null;
  durationSeconds: number | null;
  /** The file is gone, or is not the one the receipt names. */
  missing: boolean;
  createdAt: string;
}

const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** The music a workspace generated with ComfyUI: every receipt of a music workflow under music/ or assets/. */
export function listGeneratedMusic(dir: string): GeneratedMusic[] {
  const found: GeneratedMusic[] = [];
  const walk = (folder: string, depth: number) => {
    let entries;
    try { entries = readdirSync(join(dir, folder), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (depth > 0) walk(rel, depth - 1); continue; }
      if (!entry.name.endsWith(RECEIPT_SUFFIX)) continue;
      let receipt: { workflow?: { name?: string; kind?: string }; seeds?: Record<string, number>; output?: { path?: string; sha256?: string; durationSeconds?: number | null }; createdAt?: string };
      try { receipt = JSON.parse(readFileSync(join(dir, rel), "utf-8")); } catch { continue; }
      if (receipt.workflow?.kind !== "music" || typeof receipt.output?.path !== "string") continue;
      const file = join(dir, receipt.output.path);
      const seeds = Object.values(receipt.seeds ?? {});
      found.push({
        path: receipt.output.path, receiptPath: rel, workflow: receipt.workflow.name ?? "?",
        seed: seeds.length === 1 ? seeds[0]! : null, durationSeconds: receipt.output.durationSeconds ?? null,
        missing: !existsSync(file) || sha256(readFileSync(file)) !== receipt.output.sha256, createdAt: receipt.createdAt ?? "",
      });
    }
  };
  for (const top of ["music", "assets"]) walk(top, 4);
  return found.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ── Running one ────────────────────────────────────────────────────────────

/** A file's length as FFprobe reads it; null without FFprobe or for a still picture. */
function mediaSeconds(file: string): number | null {
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { encoding: "utf-8", windowsHide: true, timeout: 30_000 });
  const seconds = Number.parseFloat(probe.stdout ?? "");
  return probe.status === 0 && Number.isFinite(seconds) ? Math.round(seconds * 1000) / 1000 : null;
}

export interface RunRequest {
  libraryRoot: string;
  ws: Workspace;
  workflow: string;
  inputs: Record<string, unknown>;
  name: string;
  folder?: string;
  signal?: AbortSignal;
  /** Tests: what names this request's files on the server. */
  requestId?: string;
}

export interface RunResult {
  entry: WorkflowEntry;
  run: WorkflowRun;
  files: { path: string; receiptPath: string; role: string; bytes: number; durationSeconds: number | null }[];
  receipt: Record<string, unknown>;
}

export async function runComfyUiWorkflow(r: RunRequest): Promise<RunResult> {
  if (!NAME.test(r.name)) throw new Error(`name "${r.name}": letters, digits, _ and -, as a scene id or a take's name`);
  const entry = comfyUiWorkflows(r.libraryRoot, r.ws.channel).find((e) => e.name === r.workflow);
  if (!entry) throw new Error(`there is no workflow "${r.workflow}": pva_comfyui_workflows lists them`);
  if (!entry.workflow) throw new Error(`${entry.path} is not a usable workflow: ${entry.problems.filter((p) => p.level === "error").map((p) => p.message).join("; ")}`);
  const workflow = entry.workflow;

  // Every file it takes is a file of this workspace; a value is a value.
  const values: Record<string, WorkflowFile | string | number | boolean> = {};
  const files: Record<string, { path: string; sha256: string }> = {};
  for (const [key, value] of Object.entries(r.inputs)) {
    const d = workflow.inputs[key];
    if (d && isFileInput(d)) {
      if (typeof value !== "string") throw new Error(`${key}: the workspace-relative path of a ${d.type} file`);
      const guard = await guardWorkspacePath(r.libraryRoot, r.ws, value);
      if (!guard.allowed) throw new Error(`${key}: ${guard.reason ?? "rejected"}`);
      const absolute = join(r.ws.dir, value);
      if (!existsSync(absolute)) throw new Error(`${key}: there is no ${value} in ${r.ws.label}`);
      const bytes = readFileSync(absolute);
      // Only the extension leaves this machine: the upload is named by its content's hash.
      values[key] = { bytes, filename: `input${extname(value).toLowerCase()}` };
      files[key] = { path: posix(value), sha256: sha256(bytes) };
    } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      values[key] = value;
    } else if (value !== undefined && value !== null) {
      throw new Error(`${key}: a string, a number or true/false`);
    }
  }

  // Where each output goes, decided before the GPU is used: generated media are never overwritten (ADR-0021).
  const folders = new Map(Object.entries(workflow.outputs).map(([node, role]) => [node, posix(r.folder ?? defaultFolder(workflow, role)).replace(/\/+$/, "")]));
  for (const folder of new Set(folders.values())) {
    const guard = await guardWorkspacePath(r.libraryRoot, r.ws, `${folder}/${r.name}.x`);
    if (!guard.allowed) throw new Error(`folder ${folder}: ${guard.reason ?? "rejected"}`);
    const ours = (f: string) => f.startsWith(`${r.name}.`) || new RegExp(`^${r.name}-\\d+\\.`).test(f);
    const present = existsSync(join(r.ws.dir, folder)) ? readdirSync(join(r.ws.dir, folder)).filter(ours) : [];
    // A file half-written by a run that crashed is no take: it goes, rather than block the name.
    for (const stale of present.filter((f) => f.endsWith(".tmp"))) rmSync(join(r.ws.dir, folder, stale), { force: true });
    const taken = present.find((f) => !f.endsWith(".tmp"));
    if (taken) throw new Error(`${folder}/${taken} already exists: generated media are not overwritten, pick another name`);
  }

  const server = serverUrl(r.libraryRoot);
  let run: WorkflowRun;
  try {
    run = await runWorkflow({
      client: createComfyUiClient({ baseUrl: server.url }),
      workflow,
      values,
      timeoutMs: server.timeoutSeconds * 1000,
      ...(server.outputPrefix ? { outputPrefix: server.outputPrefix } : {}),
      ...(server.inputSubfolder ? { inputSubfolder: server.inputSubfolder } : {}),
      ...(r.signal ? { signal: r.signal } : {}),
      ...(r.requestId ? { requestId: r.requestId } : {}),
    });
  } catch (e) {
    throw unreachable(e);
  }
  r.signal?.throwIfAborted();

  const written: RunResult["files"] = [];
  const planned = run.outputs.map((output, index) => {
    const extension = extname(output.file.filename).toLowerCase() || (output.role === "image" ? ".png" : output.role === "video" ? ".mp4" : ".flac");
    const path = `${folders.get(output.node)}/${r.name}${index === 0 ? "" : `-${index + 1}`}${extension}`;
    return { output, path };
  });
  const createdAt = new Date().toISOString();
  const common = {
    provider: COMFYUI_WORKFLOW_PROVIDER,
    workflow: {
      name: entry.name, kind: workflow.kind, origin: entry.origin, file: whereFrom(r.libraryRoot, entry), sha256: entry.sha256,
      graphSha256: sha256(JSON.stringify(run.prompt)), verifiedOn: workflow.verifiedOn ?? null,
    },
    promptId: run.promptId,
    // The server's version and devices; its address is configuration, never recorded.
    server: run.server,
    inputs: Object.fromEntries(Object.entries(run.values).filter(([k]) => !(k in files))),
    ...((entry as WorkflowEntry & { defaulted?: string[] }).defaulted ? { libraryDefaults: (entry as WorkflowEntry & { defaulted?: string[] }).defaulted } : {}),
    files: Object.fromEntries(Object.entries(files).map(([k, f]) => [k, { ...f, uploadedAs: run.uploads[k]?.inputName }])),
    seeds: run.seeds,
    models: run.probe.models.map((m) => ({ node: m.node, classType: m.classType, input: m.input, file: m.file, ...(m.folder ? { folder: m.folder } : {}) })),
    // ComfyUI does not report checkpoint hashes or resolved node versions: the models are the names the loaders were given.
    runtimeVerified: false,
    cost: { amount: 0, currency: "USD" },
    gpu: { executionSeconds: run.executionSeconds, elapsedSeconds: Math.round(run.elapsedSeconds * 100) / 100 },
    outputs: planned.map((p) => p.path),
    createdAt,
  };
  let receipt: Record<string, unknown> = common;
  for (const { output, path } of planned) {
    const absolute = join(r.ws.dir, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(`${absolute}.tmp`, output.bytes, { flag: "wx" });
    renameSync(`${absolute}.tmp`, absolute);
    const durationSeconds = output.role === "image" ? null : mediaSeconds(absolute);
    receipt = {
      ...common,
      output: {
        node: output.node, role: output.role, path, sha256: sha256(output.bytes), bytes: output.bytes.length,
        ...(output.role === "image" ? {} : { durationSeconds }),
        serverFile: `${output.file.subfolder ? `${output.file.subfolder}/` : ""}${output.file.filename}`,
      },
    };
    const receiptPath = `${path}${RECEIPT_SUFFIX}`;
    writeFileSync(join(r.ws.dir, receiptPath), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    written.push({ path, receiptPath, role: output.role, bytes: output.bytes.length, durationSeconds });
  }

  // The GPU's time, in the unit's journal: what a run cost when money is $0.
  if (r.ws.kind === "episode") {
    await appendJournalEvent(r.ws.dir, {
      type: "artifact-written", actor: "pi",
      episode: { channel: r.ws.channel, series: r.ws.series, episode: r.ws.episode },
      data: {
        provider: COMFYUI_WORKFLOW_PROVIDER, workflow: entry.name, paths: written.map((f) => f.path), promptId: run.promptId,
        gpuSeconds: run.executionSeconds, elapsedSeconds: common.gpu.elapsedSeconds, cost: { amount: 0, currency: "USD" },
      },
    }).catch(() => null);
  }
  return { entry, run, files: written, receipt };
}

/** What the agent does with what a run made, by kind and workspace. */
export function nextStep(kind: string, ws: Workspace, files: RunResult["files"]): string {
  const first = files[0]?.path ?? "";
  const film = ws.kind === "episode" && (ws.series === "_" || ws.episode === "_" || existsSync(join(ws.dir, "shot.yaml")));
  switch (kind) {
    case "speech": return "a narration take: pva_register_take, then pva_align_take and pva_verify_take";
    case "music": return `music: place ${first} on the cut's music track (pva_edit_cut: an audio track with role music; set its gain and duck it under dialogue), or name it in a spec as any sound; pva_music lists it`;
    case "video": return `a take: place it in the unit's cut (pva_edit_cut, source path ${first})${film ? "" : ", or in an episode's spec as its clip"}`;
    default: return film
      ? `a still for this unit: place it in the cut (pva_edit_cut, source path ${first}) or animate it (pva_comfyui_run with a video workflow, image: ${first})`
      : `an episode's picture is assets/images/<sceneId>.<ext>, as pva_generate_image writes it: name the run after the scene${first.startsWith("assets/images/") ? "" : ", in the folder assets/images"}`;
  }
}

// ── The tools ──────────────────────────────────────────────────────────────

export function registerComfyUiWorkflowTools(pi: ExtensionAPI): void {
  const libraryRoot = () => process.env.AVG_LIBRARY_ROOT || join(process.cwd(), "library");

  pi.registerTool({
    name: "pva_comfyui_workflows",
    label: "ComfyUI Workflows",
    description:
      "List the ComfyUI workflows the studio can run on the operator's server (free, their GPU): the built-in ones (text to image, image edit, " +
      `video, music), the operator's in the library's ${posix(LIBRARY_WORKFLOWS_RELATIVE)}/, and a channel's or film's own in ` +
      `<channel>/${posix(PROJECT_WORKFLOWS_RELATIVE)}/ (a later one hides an earlier one of the same name). For each: what it makes, its ` +
      "inputs (types, defaults, which are files of the workspace), its outputs, the models it requires, and whether the server has the nodes and models " +
      "to run it, read from /object_info without running anything. Give `workflow` for one in full. Run one with pva_comfyui_run.",
    parameters: Type.Object({
      channel: Type.Optional(Type.String({ description: "A channel's or a film's slug: also its own workflows" })),
      workflow: Type.Optional(Type.String({ description: "Only this one, in full" })),
      probe: Type.Optional(Type.Boolean({ description: "Ask the server whether it can run each (default true when a server is configured)" })),
    }),
    async execute(_id, params, signal) {
      const root = libraryRoot();
      let entries = comfyUiWorkflows(root, params.channel);
      if (params.workflow !== undefined) {
        entries = entries.filter((e) => e.name === params.workflow);
        if (entries.length === 0) throw new Error(`there is no workflow "${params.workflow}"${params.channel ? "" : " (a channel's own are listed with channel)"}`);
      }
      const lines: string[] = [];
      const probes = new Map<string, WorkflowProbe | string>();
      let server: string;
      if (params.probe === false) server = "server not asked";
      else {
        try {
          const { url } = serverUrl(root);
          const client = createComfyUiClient({ baseUrl: url, requestTimeoutMs: 10_000 });
          const info = await serverInfo(client, signal);
          server = `ComfyUI ${info.version ?? "?"}${info.devices.length > 0 ? ` (${info.devices.join(", ")})` : ""}`;
          const cache: NodeInfoCache = new Map();
          await Promise.all(entries.filter((e) => e.workflow).map(async (e) => {
            probes.set(e.name, await probeWorkflow(client, e.workflow!, { cache, ...(signal ? { signal } : {}) }).catch((err: unknown) => `not probed: ${err instanceof Error ? err.message : String(err)}`));
          }));
        } catch (e) {
          server = `not asked: ${(unreachable(e) as Error).message ?? String(e)}`;
        }
      }
      lines.push(`ComfyUI workflows — server: ${server}`);
      for (const entry of entries) lines.push(describeWorkflow(entry, probes.get(entry.name), params.workflow !== undefined));
      if (entries.length === 0) lines.push("none");
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          workflows: entries.map((e) => ({
            name: e.name, origin: e.origin, path: e.path, sha256: e.sha256, kind: e.workflow?.kind ?? null, inputs: e.workflow?.inputs ?? null,
            outputs: e.workflow?.outputs ?? null, problems: e.problems, ...(e.shadows ? { shadows: e.shadows } : {}),
            server: probes.get(e.name) ?? null,
          })),
        } as Record<string, unknown>,
      };
    },
  });

  pi.registerTool({
    name: "pva_comfyui_run",
    label: "Run ComfyUI Workflow",
    description:
      "Run a ComfyUI workflow (see pva_comfyui_workflows) on the operator's server, free, in an episode, a channel source or a film unit " +
      "(channel: the film, series: the scene or _, episode: the shot or _). `inputs` are the workflow's: values, and for an image, audio or " +
      "video input the workspace-relative path of a file, uploaded under its content's hash. The server is probed first: a missing node or " +
      "model is reported before anything runs. Each output is written as <folder>/<name>.<ext> (more than one: <name>-2…), by default images in " +
      "assets/images/, video in assets/video/comfyui/, music in music/, speech in artifacts/narration/, other audio in assets/audio/; never over " +
      `an existing file. Beside each, <file>${RECEIPT_SUFFIX}: the workflow and graph by hash, every value, the input files by hash, the seeds, ` +
      "the models named, the server's version, and the GPU time (also in an episode's or film unit's journal). Model files are inputs too, defaulted " +
      "by the workflow or the library's comfyui.json (workflowDefaults): pva_comfyui_workflows shows the files the server has. " +
      "Seeds not given are picked and recorded: give the same seed to make the same take again.",
    parameters: Type.Object({
      ...WORKSPACE_PARAMS,
      workflow: Type.String({ description: "The workflow's name" }),
      name: Type.String({ description: "The output's base name: a scene id for an episode's picture, a take's name for a shot (letters, digits, _ -)" }),
      inputs: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]), { description: "The workflow's inputs by name; files as workspace-relative paths" })),
      folder: Type.Optional(Type.String({ description: "Workspace-relative folder for the outputs, instead of the default for their kind" })),
    }),
    async execute(_id, params, signal) {
      const root = libraryRoot();
      const ws = workspaceOf(root, params);
      const made = await runComfyUiWorkflow({
        libraryRoot: root, ws, workflow: params.workflow, inputs: params.inputs ?? {}, name: params.name,
        ...(params.folder !== undefined ? { folder: params.folder } : {}), ...(signal ? { signal } : {}),
      });
      const seeds = Object.entries(made.run.seeds).map(([k, v]) => `${k} ${v}`).join(", ");
      const time = made.run.executionSeconds !== null ? `${made.run.executionSeconds.toFixed(1)} s on the server` : `${made.run.elapsedSeconds.toFixed(1)} s`;
      const lines = [
        `✅ ${made.entry.name} on ComfyUI ${made.run.server.version ?? "?"}${seeds ? `, ${seeds}` : ""}, ${time}, $0 → ${made.files.length} file${made.files.length === 1 ? "" : "s"} in ${ws.label}:`,
        ...made.files.map((f) => `  - ${f.path} (${f.role}, ${(f.bytes / 1024).toFixed(0)} KB${f.durationSeconds !== null ? `, ${f.durationSeconds} s` : ""}) + ${basename(f.receiptPath)}`),
        `next: ${nextStep(made.entry.workflow!.kind, ws, made.files)}`,
        ...(made.entry.workflow!.verifiedOn ? [] : ["⚠️ this workflow had never run on a real server before: look at what it made before using it"]),
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { files: made.files, receipt: made.receipt } as Record<string, unknown> };
    },
  });
}
