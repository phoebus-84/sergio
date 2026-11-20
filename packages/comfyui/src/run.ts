// Run a declared workflow: check the values against its inputs, probe the
// server, upload the files it takes, queue the filled graph, wait, and
// download what each output node saved. No fallback to another workflow or
// another server, and nothing is retried.

import { createHash, randomInt, randomUUID } from "node:crypto";
import type { ComfyUiClient, ComfyUiFile, ComfyUiPrompt } from "./client.js";
import { ComfyUiError } from "./errors.js";
import { describeProbe, probeWorkflow, serverInfo, type NodeInfoCache, type ServerInfo, type WorkflowProbe } from "./probe.js";
import { fillWorkflow, type WorkflowValue } from "./templates.js";
import {
  FILE_EXTENSIONS, isFileInput, OUTPUT_PREFIX, problemOfValue, type DeclaredWorkflow, type OutputRole,
} from "./workflows.js";

export const DEFAULT_WORKFLOW_OUTPUT_PREFIX = "studio-workflows";
export const DEFAULT_WORKFLOW_INPUT_SUBFOLDER = "studio-workflows";
export const DEFAULT_WORKFLOW_TIMEOUT_SECONDS = 1800;
/** A seed the runner picks: any whole number a JSON number holds exactly, kept short. */
const MAX_PICKED_SEED = 2 ** 32 - 1;

/** A file a workflow takes: bytes to upload, or the name of a file already in the server's input folder. */
export type WorkflowFile = { bytes: Uint8Array; filename: string } | { inputName: string };

export interface RunWorkflowOptions {
  client: ComfyUiClient;
  workflow: DeclaredWorkflow;
  /** By input name: a value, or for a file input a WorkflowFile. */
  values?: Record<string, WorkflowValue | WorkflowFile | undefined>;
  /** Folder under the server's output/ the files are saved in. */
  outputPrefix?: string;
  /** Folder under the server's input/ uploaded files go in. */
  inputSubfolder?: string;
  /** How long the graph may take, queue time included. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Tests: what names this request's files instead of a random id. */
  requestId?: string;
  /** Node info shared with other probes. */
  cache?: NodeInfoCache;
}

export interface WorkflowOutput {
  node: string;
  role: OutputRole;
  file: ComfyUiFile;
  bytes: Buffer;
}

export interface UploadedInput {
  /** The name the loader node read. */
  inputName: string;
  /** Of the bytes uploaded; absent for a file already on the server. */
  sha256?: string;
  bytes?: number;
}

export interface WorkflowRun {
  promptId: string;
  /** The graph as queued. */
  prompt: ComfyUiPrompt;
  /** Every value the graph was filled with, file inputs by the name the server read them by, defaults and picked seeds included. */
  values: Record<string, WorkflowValue>;
  /** The seed inputs and their values: the ones picked here are among them. */
  seeds: Record<string, number>;
  uploads: Record<string, UploadedInput>;
  outputs: WorkflowOutput[];
  server: ServerInfo;
  probe: WorkflowProbe;
  /** From queueing to the files in hand. */
  elapsedSeconds: number;
  /** The server's own measure, from its execution_start to its execution_success message; null when it gave no timestamps. */
  executionSeconds: number | null;
}

const isFile = (v: unknown): v is WorkflowFile => !!v && typeof v === "object" && ("bytes" in v || "inputName" in v);

/** Check what is given against the declaration, and fill in defaults and seeds. Files are checked, not uploaded. */
export function resolveValues(workflow: DeclaredWorkflow, given: RunWorkflowOptions["values"] = {}): {
  values: Record<string, WorkflowValue>; files: Record<string, WorkflowFile>; seeds: Record<string, number>;
} {
  const unknown = Object.keys(given).filter((k) => given[k] !== undefined && !(k in workflow.inputs));
  if (unknown.length > 0) {
    throw new ComfyUiError("bad-request", `the workflow takes no ${unknown.join(", ")}; it takes ${Object.keys(workflow.inputs).join(", ") || "nothing"}`);
  }
  const values: Record<string, WorkflowValue> = {};
  const files: Record<string, WorkflowFile> = {};
  const seeds: Record<string, number> = {};
  const problems: string[] = [];
  for (const [name, d] of Object.entries(workflow.inputs)) {
    const v = given[name];
    if (isFileInput(d)) {
      if (v === undefined) { if (!d.optional) problems.push(`${name}: a ${d.type} file is needed`); continue; }
      if (!isFile(v)) { problems.push(`${name}: a ${d.type} file, not a value`); continue; }
      if ("inputName" in v) {
        if (v.inputName.trim() === "" || v.inputName.includes("..")) problems.push(`${name}: "${v.inputName}" is not a file of the server's input folder`);
      } else {
        const extension = /\.([A-Za-z0-9]+)$/.exec(v.filename)?.[1]?.toLowerCase() ?? "";
        if (!FILE_EXTENSIONS[d.type].includes(extension)) problems.push(`${name}: ${v.filename || "the file"} is not a ${d.type} file (${FILE_EXTENSIONS[d.type].join(", ")})`);
        else if (v.bytes.length === 0) problems.push(`${name}: the file is empty`);
      }
      files[name] = v;
      continue;
    }
    if (isFile(v)) { problems.push(`${name}: a ${d.type}, not a file`); continue; }
    let value: WorkflowValue | undefined = v ?? d.default;
    if (value === undefined && d.type === "seed") {
      value = randomInt(0, Math.min(MAX_PICKED_SEED, d.max ?? MAX_PICKED_SEED) - (d.min ?? 0) + 1) + (d.min ?? 0);
    }
    if (value === undefined) { if (!d.optional) problems.push(`${name}: a value is needed (${d.type})`); continue; }
    const wrong = problemOfValue(d, value);
    if (wrong) { problems.push(`${name}: ${wrong}`); continue; }
    if (d.type === "seed") seeds[name] = value as number;
    values[name] = value;
  }
  if (problems.length > 0) throw new ComfyUiError("bad-request", problems.join("; "));
  return { values, files, seeds };
}

/** Seconds between the server's execution_start and execution_success messages, when both carry a timestamp (ms). */
export function executionSecondsOf(messages: unknown[] | undefined): number | null {
  const at = (kind: string) => {
    const m = (messages ?? []).find((x) => Array.isArray(x) && x[0] === kind) as [string, { timestamp?: unknown }] | undefined;
    return typeof m?.[1]?.timestamp === "number" ? m[1].timestamp : null;
  };
  const start = at("execution_start");
  const end = at("execution_success");
  return start !== null && end !== null && end >= start ? Math.round(end - start) / 1000 : null;
}

/** Every file an output node saved, whatever the key it lists them under (images, gifs, audio, video…). */
export function savedFiles(output: Record<string, unknown> | undefined): ComfyUiFile[] {
  return Object.values(output ?? {}).flatMap((list) => Array.isArray(list) ? list : []).flatMap((f) => {
    const file = f as Partial<ComfyUiFile> | null;
    if (!file || typeof file.filename !== "string" || file.filename === "") return [];
    return [{ filename: file.filename, subfolder: typeof file.subfolder === "string" ? file.subfolder : "", type: typeof file.type === "string" ? file.type : "output" }];
  });
}

const folder = (value: string | undefined, fallback: string, what: string) => {
  const f = (value ?? fallback).replace(/^\/+|\/+$/g, "");
  if (f === "" || f.split("/").includes("..")) throw new ComfyUiError("bad-request", `"${value}" is not a folder under the server's ${what}`);
  return f;
};

export async function runWorkflow(o: RunWorkflowOptions): Promise<WorkflowRun> {
  const { values, files, seeds } = resolveValues(o.workflow, o.values);
  const prefix = folder(o.outputPrefix, DEFAULT_WORKFLOW_OUTPUT_PREFIX, "output");
  const subfolder = folder(o.inputSubfolder, DEFAULT_WORKFLOW_INPUT_SUBFOLDER, "input");
  // Unique per request: an output node always writes, even when the server's cache already holds the graph.
  const id = o.requestId ?? `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const reserved: Record<string, WorkflowValue> = { [OUTPUT_PREFIX]: `${prefix}/${id}` };
  const usesPrefix = JSON.stringify(o.workflow.prompt).includes(`"{{${OUTPUT_PREFIX}}}"`);
  const fill = (fileValues: Record<string, string>) => fillWorkflow(o.workflow, { ...values, ...fileValues, ...(usesPrefix ? reserved : {}) });

  // Before anything leaves this machine: does the server have the nodes and the models?
  const server = await serverInfo(o.client, o.signal);
  const probe = await probeWorkflow(o.client, o.workflow, {
    prompt: fill(Object.fromEntries(Object.keys(files).map((k) => [k, `probe-${k}`]))),
    ...(o.cache ? { cache: o.cache } : {}), ...(o.signal ? { signal: o.signal } : {}),
  });
  if (!probe.runnable) {
    const code = probe.missingNodes.length > 0 ? "missing-node" : probe.models.some((m) => m.status === "missing") ? "missing-model" : "bad-request";
    throw new ComfyUiError(code, `the server cannot run this workflow: ${describeProbe(probe)}`);
  }

  const uploads: Record<string, UploadedInput> = {};
  for (const [name, file] of Object.entries(files)) {
    if ("inputName" in file) {
      uploads[name] = { inputName: file.inputName };
      continue;
    }
    // Named by content: the same file is one file on the server however often it is used, and no local name leaves this machine.
    const sha256 = createHash("sha256").update(file.bytes).digest("hex");
    const extension = /\.([A-Za-z0-9]+)$/.exec(file.filename)![1]!.toLowerCase();
    const inputName = await o.client.uploadInput({ bytes: file.bytes, filename: `${sha256.slice(0, 32)}.${extension}`, subfolder }, o.signal);
    uploads[name] = { inputName, sha256, bytes: file.bytes.length };
  }
  const prompt = fill(Object.fromEntries(Object.entries(uploads).map(([k, u]) => [k, u.inputName])));

  const started = Date.now();
  const promptId = await o.client.queuePrompt(prompt, o.signal);
  let finished: Awaited<ReturnType<ComfyUiClient["waitForPrompt"]>>;
  try {
    finished = await o.client.waitForPrompt(promptId, { timeoutMs: o.timeoutMs ?? DEFAULT_WORKFLOW_TIMEOUT_SECONDS * 1000, ...(o.signal ? { signal: o.signal } : {}) });
  } catch (e) {
    // Given up on: out of the queue if it has not started. A graph already
    // running is left to finish: interrupting stops whatever the server runs.
    if (e instanceof ComfyUiError && (e.code === "aborted" || e.code === "timeout")) await o.client.dequeue(promptId).catch(() => undefined);
    throw e;
  }

  const outputs: WorkflowOutput[] = [];
  for (const [node, role] of Object.entries(o.workflow.outputs)) {
    if (!prompt[node]) continue; // an optional output left out
    const saved = savedFiles(finished.outputs[node]);
    if (saved.length === 0) throw new ComfyUiError("no-output", `the graph finished without the ${role} node ${node} (${prompt[node]!.class_type}) should have saved`);
    for (const file of saved) {
      const bytes = await o.client.download(file, o.signal);
      if (bytes.length === 0) throw new ComfyUiError("no-output", `${file.filename} is empty`);
      outputs.push({ node, role, file, bytes });
    }
  }
  return {
    promptId, prompt,
    values: { ...values, ...Object.fromEntries(Object.entries(uploads).map(([k, u]) => [k, u.inputName])) },
    seeds, uploads, outputs, server, probe,
    elapsedSeconds: (Date.now() - started) / 1000,
    executionSeconds: executionSecondsOf(finished.messages),
  };
}
