// Declared workflows: a template that says what it takes and what it makes,
// so that a caller who has never seen the graph can run it.
//
//   {
//     "description": "Text to image with Z-Image Turbo.",
//     "kind": "image",                         image | image-edit | video | speech | music | audio | other
//     "inputs": {                              one per placeholder, but outputPrefix
//       "prompt": { "type": "text" },
//       "width":  { "type": "integer", "default": 1024, "min": 256, "max": 2048 },
//       "seed":   { "type": "seed" },          absent: a random one, returned
//       "vae":    { "type": "model", "default": "ae.safetensors" },   a file a loader reads
//       "image":  { "type": "image" },         a file: uploaded, its input name filled in
//       "start":  { "type": "image", "optional": true }   leaves its optionalNodes out when absent
//     },
//     "outputs": { "9": "image" },             node id → image | video | audio
//     "requires": {
//       "nodes": ["SaveImage"],                classes beyond the graph's own (they are read from it)
//       "packs": ["ComfyUI-VideoHelperSuite"], where custom classes come from, for a person
//       "models": [{ "node": "17", "input": "vae_name", "folder": "vae" }]   its value: {{vae}}
//     },
//     "verifiedOn": "ComfyUI 0.3.75, 2026-11-20", when and where it last ran; absent: never on a real server
//     "prompt": { … API format, with {{name}} placeholders … },
//     "optionalNodes": { "start": "56" }
//   }
//
// `{{outputPrefix}}` is the runner's: every output node's filename_prefix
// should be it, so that each run writes files of its own. A model is the
// value a loader node's input holds. Every server names its files its own
// way, so a model is best a `model` input with a default — a caller, or the
// library's defaults, can then name another file without copying the
// template — and the probe checks the server lists the file it gets.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ComfyUiPrompt } from "./client.js";
import { PLACEHOLDER, placeholdersOf, type GraphTemplate, type WorkflowValue } from "./templates.js";

export const WORKFLOW_KINDS = ["image", "image-edit", "video", "speech", "music", "audio", "other"] as const;
export type WorkflowKind = typeof WORKFLOW_KINDS[number];
export const OUTPUT_ROLES = ["image", "video", "audio"] as const;
export type OutputRole = typeof OUTPUT_ROLES[number];
export const FILE_INPUT_TYPES = ["image", "audio", "video"] as const;
export const VALUE_INPUT_TYPES = ["text", "string", "integer", "number", "boolean", "seed", "choice", "model"] as const;
export const INPUT_TYPES = [...VALUE_INPUT_TYPES, ...FILE_INPUT_TYPES] as const;
export type InputType = typeof INPUT_TYPES[number];
export type FileInputType = typeof FILE_INPUT_TYPES[number];

/** The placeholder the runner fills with a folder of its own under the server's output/. */
export const OUTPUT_PREFIX = "outputPrefix";
/** A workflow's name: its file's, without .json. */
export const WORKFLOW_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** The extensions an uploaded file of each type may have: what ComfyUI's loader nodes read. */
export const FILE_EXTENSIONS: Record<FileInputType, readonly string[]> = {
  image: ["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff"],
  audio: ["wav", "flac", "mp3", "ogg", "opus", "m4a", "aac"],
  video: ["mp4", "mov", "mkv", "webm", "avi", "gif"],
};

export interface InputDeclaration {
  type: InputType;
  description?: string;
  /** Not for a file, nor a seed. */
  default?: WorkflowValue;
  /** integer, number, seed. */
  min?: number;
  max?: number;
  /** choice. */
  options?: string[];
  /** May be absent with no default: the template's optionalNodes (or bypassNodes) name it. */
  optional?: boolean;
}

export interface ModelRequirement {
  /** The loader node, by id in the prompt. */
  node: string;
  /** Its input that names the file, e.g. unet_name. */
  input: string;
  /** Where the file goes under ComfyUI's models/, e.g. diffusion_models: for the person who installs it. */
  folder?: string;
  /** Where to get it, for the person who installs it. Nothing downloads it. */
  source?: string;
}

export interface WorkflowRequirements {
  nodes?: string[];
  packs?: string[];
  models?: ModelRequirement[];
}

export interface DeclaredWorkflow extends GraphTemplate {
  description: string;
  kind: WorkflowKind;
  inputs: Record<string, InputDeclaration>;
  /** node id → what it saves. */
  outputs: Record<string, OutputRole>;
  requires?: WorkflowRequirements;
  verifiedOn?: string;
}

export interface WorkflowProblem {
  level: "error" | "warning";
  message: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** What is wrong with a declaration; errors make it unusable, warnings do not. */
export function checkWorkflow(value: unknown): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  const error = (message: string) => problems.push({ level: "error", message });
  const warn = (message: string) => problems.push({ level: "warning", message });
  if (!isObject(value)) return [{ level: "error", message: "a workflow is a JSON object" }];
  const w = value as Partial<DeclaredWorkflow>;
  if (typeof w.description !== "string" || w.description.trim() === "") error("description: say what the workflow makes");
  if (!WORKFLOW_KINDS.includes(w.kind as WorkflowKind)) error(`kind: one of ${WORKFLOW_KINDS.join(", ")}`);
  if (!isObject(w.prompt) || Object.keys(w.prompt).length === 0) {
    error("prompt: the graph in ComfyUI's API format (Export (API)), node id → { class_type, inputs }");
    return problems;
  }
  const prompt = w.prompt as ComfyUiPrompt;
  for (const [id, node] of Object.entries(prompt)) {
    if (!isObject(node) || typeof node.class_type !== "string" || !isObject(node.inputs)) {
      error(`prompt.${id}: a node has a class_type and inputs (is this the API format? The UI format has "nodes" and "links")`);
      continue;
    }
    for (const [input, v] of Object.entries(node.inputs)) {
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "number" && !prompt[v[0]]) {
        error(`prompt.${id}.inputs.${input} reads node ${v[0]}, which the graph does not have`);
      }
    }
  }
  if (problems.some((p) => p.level === "error")) return problems;

  const inputs = isObject(w.inputs) ? w.inputs as Record<string, InputDeclaration> : {};
  if (w.inputs !== undefined && !isObject(w.inputs)) error("inputs: name → { type, … }");
  const optionalNames = new Set([...Object.keys(w.optionalNodes ?? {}), ...Object.keys(w.bypassNodes ?? {})]);
  for (const [name, d] of Object.entries(inputs)) {
    const at = `inputs.${name}`;
    if (name === OUTPUT_PREFIX) { error(`${at}: ${OUTPUT_PREFIX} is the runner's, not an input`); continue; }
    if (!PLACEHOLDER.test(`{{${name}}}`)) error(`${at}: a name is letters and digits, starting with a letter`);
    if (!isObject(d) || !INPUT_TYPES.includes(d.type)) { error(`${at}.type: one of ${INPUT_TYPES.join(", ")}`); continue; }
    const file = (FILE_INPUT_TYPES as readonly string[]).includes(d.type);
    if (d.default !== undefined) {
      if (file || d.type === "seed") error(`${at}: a ${d.type} has no default`);
      else if (problemOfValue(d, d.default)) error(`${at}.default: ${problemOfValue(d, d.default)}`);
    }
    if (d.type === "choice" && (!Array.isArray(d.options) || d.options.length === 0 || d.options.some((o) => typeof o !== "string"))) error(`${at}.options: the choices, as strings`);
    if (d.optional && !optionalNames.has(name)) error(`${at}: optional, but no optionalNodes or bypassNodes entry is named after it`);
    if (optionalNames.has(name) && !d.optional && d.default === undefined && !(w.bypassNodes && name in w.bypassNodes)) warn(`${at}: optionalNodes names it; mark it optional`);
  }
  const used = new Set(placeholdersOf({ prompt }));
  for (const name of used) {
    if (name !== OUTPUT_PREFIX && !(name in inputs)) error(`the graph's {{${name}}} is not declared under inputs`);
  }
  for (const name of Object.keys(inputs)) {
    if (!used.has(name) && !(w.bypassNodes && name in w.bypassNodes)) error(`inputs.${name} is declared, and no {{${name}}} in the graph reads it`);
  }
  const modelInputs = new Set((Array.isArray(w.requires?.models) ? w.requires!.models : []).flatMap((m) => {
    const v = isObject(m) && typeof m.node === "string" && typeof m.input === "string" ? prompt[m.node]?.inputs[m.input] : undefined;
    const p = typeof v === "string" ? PLACEHOLDER.exec(v) : null;
    return p ? [p[1]!] : [];
  }));
  for (const [name, d] of Object.entries(inputs)) {
    if (isObject(d) && d.type === "model" && !modelInputs.has(name)) error(`inputs.${name} is a model, and no requires.models entry reads it: name the loader's node and input there`);
  }
  for (const [name, ids] of Object.entries({ ...(w.optionalNodes ?? {}), ...(w.bypassNodes ?? {}) })) {
    for (const id of typeof ids === "string" ? [ids] : ids) if (!prompt[id]) error(`node ${id}, named for ${name}, is not in the graph`);
  }

  if (!isObject(w.outputs) || Object.keys(w.outputs).length === 0) error("outputs: node id → image | video | audio, for each node that saves a result");
  else {
    for (const [id, role] of Object.entries(w.outputs)) {
      if (!prompt[id]) error(`outputs.${id}: the graph has no node ${id}`);
      else if (!OUTPUT_ROLES.includes(role)) error(`outputs.${id}: one of ${OUTPUT_ROLES.join(", ")}`);
      else if ("filename_prefix" in prompt[id]!.inputs && prompt[id]!.inputs.filename_prefix !== `{{${OUTPUT_PREFIX}}}`) {
        warn(`outputs.${id}: its filename_prefix is not {{${OUTPUT_PREFIX}}}, so runs share file names on the server`);
      }
    }
  }

  const requires = w.requires;
  if (requires !== undefined && !isObject(requires)) error("requires: { nodes, packs, models }");
  else if (requires) {
    if (requires.nodes !== undefined && (!Array.isArray(requires.nodes) || requires.nodes.some((n) => typeof n !== "string"))) error("requires.nodes: class names");
    if (requires.packs !== undefined && (!Array.isArray(requires.packs) || requires.packs.some((n) => typeof n !== "string"))) error("requires.packs: names of custom node packs");
    if (requires.models !== undefined && !Array.isArray(requires.models)) error("requires.models: [{ node, input, folder }]");
    for (const [i, m] of (Array.isArray(requires.models) ? requires.models : []).entries()) {
      if (!isObject(m) || typeof m.node !== "string" || typeof m.input !== "string") { error(`requires.models[${i}]: { node, input }`); continue; }
      const node = prompt[m.node];
      if (!node) error(`requires.models[${i}]: the graph has no node ${m.node}`);
      else if (!(m.input in node.inputs)) error(`requires.models[${i}]: node ${m.node} (${node.class_type}) has no input ${m.input}`);
      else if (typeof node.inputs[m.input] === "string" && !PLACEHOLDER.test(node.inputs[m.input] as string)) {
        warn(`requires.models[${i}]: node ${m.node} names its file in the graph; a server that names it otherwise cannot run it without a copy of the workflow. Make it a model input with a default`);
      }
    }
  }
  if (w.verifiedOn !== undefined && typeof w.verifiedOn !== "string") error("verifiedOn: when and where it last ran, as text");
  return problems;
}

/** Why a value does not fit its declaration; null when it does. */
export function problemOfValue(d: InputDeclaration, v: unknown): string | null {
  switch (d.type) {
    case "text":
    case "string":
      return typeof v === "string" ? null : "a string";
    case "model":
      return typeof v === "string" && v.trim() !== "" ? null : "a model's file name, as the loader lists it";
    case "boolean":
      return typeof v === "boolean" ? null : "true or false";
    case "choice":
      return typeof v === "string" && (d.options ?? []).includes(v) ? null : `one of ${(d.options ?? []).join(", ")}`;
    case "integer":
    case "seed":
    case "number": {
      if (typeof v !== "number" || !Number.isFinite(v)) return "a number";
      if (d.type !== "number" && !Number.isInteger(v)) return "a whole number";
      if (d.type === "seed" && (v < 0 || v > Number.MAX_SAFE_INTEGER)) return "a whole number from 0";
      if (d.min !== undefined && v < d.min) return `at least ${d.min}`;
      if (d.max !== undefined && v > d.max) return `at most ${d.max}`;
      return null;
    }
    default:
      return typeof v === "string" && v !== "" ? null : "a file";
  }
}

export const isFileInput = (d: InputDeclaration): d is InputDeclaration & { type: FileInputType } => (FILE_INPUT_TYPES as readonly string[]).includes(d.type);

/** The node classes a workflow needs: its graph's and those it declares. */
export function requiredNodes(workflow: Pick<DeclaredWorkflow, "prompt" | "requires">, prompt: ComfyUiPrompt = workflow.prompt): string[] {
  return [...new Set([...Object.values(prompt).map((n) => n.class_type), ...(workflow.requires?.nodes ?? [])])].sort();
}

/**
 * The model files a graph names, for each requirement: null when a
 * placeholder has no value or default yet. `inputName` is the workflow's
 * input that sets it, when one does.
 */
export function requiredModels(workflow: DeclaredWorkflow, prompt: ComfyUiPrompt = workflow.prompt): (ModelRequirement & { classType: string; file: string | null; inputName?: string })[] {
  return (workflow.requires?.models ?? []).flatMap((m) => {
    const node = prompt[m.node];
    if (!node) return []; // an optional node left out: its model is not needed
    let value = node.inputs[m.input];
    const placeholder = typeof value === "string" ? PLACEHOLDER.exec(value) : null;
    if (placeholder) value = workflow.inputs[placeholder[1]!]?.default;
    const inputName = placeholder?.[1] ?? workflowInputOf(workflow, m);
    return [{ ...m, classType: node.class_type, file: typeof value === "string" && value !== "" ? value : null, ...(inputName ? { inputName } : {}) }];
  });
}

/** The input a filled graph's model came from, read from the template. */
function workflowInputOf(workflow: DeclaredWorkflow, m: ModelRequirement): string | undefined {
  const v = workflow.prompt[m.node]?.inputs[m.input];
  const p = typeof v === "string" ? PLACEHOLDER.exec(v) : null;
  return p?.[1];
}

/** The workflow with other defaults for some inputs (a library's, for its server), each checked against its declaration. */
export function withDefaults(workflow: DeclaredWorkflow, defaults: Record<string, unknown>): DeclaredWorkflow {
  const inputs = { ...workflow.inputs };
  for (const [name, value] of Object.entries(defaults)) {
    const d = inputs[name];
    if (!d) throw new Error(`the workflow has no input ${name}`);
    if (isFileInput(d) || d.type === "seed") throw new Error(`${name}: a ${d.type} has no default`);
    const wrong = problemOfValue(d, value);
    if (wrong) throw new Error(`${name}: ${wrong}`);
    inputs[name] = { ...d, default: value as WorkflowValue };
  }
  return { ...workflow, inputs };
}

/** One workflow file, read and checked. */
export interface WorkflowEntry {
  name: string;
  /** Where it came from: "built-in", or the caller's label for a folder. */
  origin: string;
  path: string;
  /** Of the file's bytes: what a receipt names it by. */
  sha256: string;
  /** Present when the file has no error. */
  workflow?: DeclaredWorkflow;
  problems: WorkflowProblem[];
  /** The entry of the same name it hides, from an earlier folder. */
  shadows?: { origin: string; path: string };
}

export function readWorkflowFile(path: string, origin: string): WorkflowEntry {
  const name = basename(path).replace(/\.json$/i, "");
  const bytes = readFileSync(path);
  const entry: WorkflowEntry = { name, origin, path, sha256: createHash("sha256").update(bytes).digest("hex"), problems: [] };
  if (!WORKFLOW_NAME.test(name)) entry.problems.push({ level: "error", message: `"${name}" is not a workflow name: lowercase letters, digits, . _ and -` });
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf-8"));
  } catch (e) {
    entry.problems.push({ level: "error", message: `not JSON: ${e instanceof Error ? e.message : String(e)}` });
    return entry;
  }
  entry.problems.push(...checkWorkflow(value));
  if (!entry.problems.some((p) => p.level === "error")) entry.workflow = value as DeclaredWorkflow;
  return entry;
}

/** The workflow files of a folder (none when it does not exist), by name. */
export function readWorkflowDir(dir: string, origin: string): WorkflowEntry[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".json") && !f.startsWith(".")).sort().map((f) => readWorkflowFile(join(dir, f), origin));
}

/** The workflows this package ships. */
// ../workflows/ from both src/ (tests, tsx) and dist/ (the built package)
export const BUILT_IN_WORKFLOWS_DIR = fileURLToPath(new URL("../workflows/", import.meta.url));
export const BUILT_IN = "built-in";

/**
 * Every workflow of the folders given, in order: a later folder's workflow
 * hides an earlier one of the same name, and says so. The built-in ones come
 * first unless `builtIn` is false.
 */
export function listWorkflows(folders: { dir: string; origin: string }[], options: { builtIn?: boolean } = {}): WorkflowEntry[] {
  const all = [
    ...(options.builtIn === false ? [] : [{ dir: BUILT_IN_WORKFLOWS_DIR, origin: BUILT_IN }]),
    ...folders,
  ];
  const byName = new Map<string, WorkflowEntry>();
  for (const folder of all) {
    for (const entry of readWorkflowDir(folder.dir, folder.origin)) {
      const hidden = byName.get(entry.name);
      byName.set(entry.name, hidden ? { ...entry, shadows: { origin: hidden.origin, path: hidden.path } } : entry);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
