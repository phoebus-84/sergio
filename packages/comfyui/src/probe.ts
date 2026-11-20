// Whether a server can run a workflow, read before anything is queued: the
// node classes it has (GET /object_info/<class>) and, for each model a
// workflow requires, whether the loader node lists the file among its
// choices. Nothing is run, uploaded or downloaded.

import type { ComfyUiClient, ComfyUiPrompt } from "./client.js";
import { requiredModels, requiredNodes, type DeclaredWorkflow, type ModelRequirement } from "./workflows.js";

/** The choices a COMBO input offers, as /object_info describes it (older ComfyUI: [[…], {}]; newer: ["COMBO", { options: […] }]). */
export function comboOptions(spec: unknown): string[] | null {
  if (!Array.isArray(spec)) return null;
  const options = Array.isArray(spec[0]) ? spec[0] : (spec[1] as { options?: unknown } | undefined)?.options;
  return Array.isArray(options) ? options.filter((x): x is string => typeof x === "string") : null;
}

/** An input's spec in a node's /object_info entry, required or optional. */
export function inputSpec(info: Record<string, unknown> | null | undefined, input: string): unknown {
  const i = info?.input as { required?: Record<string, unknown>; optional?: Record<string, unknown> } | undefined;
  return i?.required?.[input] ?? i?.optional?.[input];
}

export interface ServerInfo {
  /** ComfyUI's version, when it says. */
  version: string | null;
  devices: string[];
}

export async function serverInfo(client: ComfyUiClient, signal?: AbortSignal): Promise<ServerInfo> {
  const stats = await client.systemStats(signal) as { system?: { comfyui_version?: unknown }; devices?: { name?: unknown }[] };
  return {
    version: typeof stats.system?.comfyui_version === "string" ? stats.system.comfyui_version : null,
    devices: (stats.devices ?? []).map((d) => d.name).filter((n): n is string => typeof n === "string"),
  };
}

export type ModelStatus = "present" | "missing" | "unknown";

export interface ModelCheck extends ModelRequirement {
  classType: string;
  /** The file the graph names; null while a placeholder has no value or default. */
  file: string | null;
  /** unknown: the node is missing, the file is not decided yet, or the input is not a list of files. */
  status: ModelStatus;
}

export interface WorkflowProbe {
  /** Every node class is there and no required model is missing. */
  runnable: boolean;
  missingNodes: string[];
  models: ModelCheck[];
}

/** Node info by class, shared by several probes so a server is asked once per class. */
export type NodeInfoCache = Map<string, Promise<Record<string, unknown> | null>>;

/**
 * What the server lacks to run a workflow. Given the filled graph, its
 * optional nodes are as the run will have them and its models are the files
 * the run names; without it, the template's own graph and defaults.
 */
export async function probeWorkflow(
  client: ComfyUiClient, workflow: DeclaredWorkflow,
  options: { prompt?: ComfyUiPrompt; cache?: NodeInfoCache; signal?: AbortSignal } = {},
): Promise<WorkflowProbe> {
  const cache = options.cache ?? new Map();
  const info = (classType: string) => {
    let got = cache.get(classType);
    if (!got) {
      got = client.nodeInfo(classType, options.signal);
      cache.set(classType, got);
    }
    return got;
  };
  const prompt = options.prompt ?? workflow.prompt;
  const classes = requiredNodes(workflow, prompt);
  const infos = new Map(await Promise.all(classes.map(async (c) => [c, await info(c)] as const)));
  const missingNodes = classes.filter((c) => !infos.get(c));
  const models = requiredModels(workflow, prompt).map((m): ModelCheck => {
    const node = infos.get(m.classType);
    const options = node ? comboOptions(inputSpec(node, m.input)) : null;
    const status: ModelStatus = !node || m.file === null || options === null ? "unknown" : options.includes(m.file) ? "present" : "missing";
    return { ...m, status };
  });
  return { runnable: missingNodes.length === 0 && !models.some((m) => m.status === "missing"), missingNodes, models };
}

/** The probe in words: what is missing, and where a missing model goes. */
export function describeProbe(probe: WorkflowProbe): string {
  if (probe.runnable) {
    const unknown = probe.models.filter((m) => m.status === "unknown");
    return unknown.length === 0 ? "runnable" : `runnable; not checked: ${unknown.map((m) => m.file ?? `${m.classType}.${m.input}`).join(", ")}`;
  }
  const parts: string[] = [];
  if (probe.missingNodes.length > 0) parts.push(`missing nodes ${probe.missingNodes.join(", ")}`);
  const missing = probe.models.filter((m) => m.status === "missing");
  if (missing.length > 0) parts.push(`missing models ${missing.map((m) => `${m.file}${m.folder ? ` (models/${m.folder})` : ""}`).join(", ")}`);
  return parts.join("; ");
}
