// Workflows kept as API-format JSON with named placeholders. A placeholder is
// a string value that is exactly "{{name}}": it is replaced by the value
// given under that name, keeping the value's type (a number stays a number).
// Nothing else in a template is touched, so a template is a graph that can be
// read, diffed and re-exported from ComfyUI.
//
// A template may name optional nodes: `optionalNodes: { <value name>: <node
// id> }`. When that value is not given the node is left out of the graph.
//
// And nodes to bypass, as ComfyUI's own bypass does: `bypassNodes: { <flag>:
// <node id> }`. Unless the flag is true the node is left out, and what read
// its first output reads its first linked input instead.

import { readFileSync } from "node:fs";
import type { ComfyUiPrompt } from "./client.js";
import { ComfyUiError } from "./errors.js";

/** A graph with placeholders, and the nodes a fill may leave out. */
export interface GraphTemplate {
  prompt: ComfyUiPrompt;
  /** Nodes left out when the value they are named after is absent: value name → node id. */
  optionalNodes?: Record<string, string>;
  /** Nodes passed through unless their flag is true: flag → node id. */
  bypassNodes?: Record<string, string>;
}

export type WorkflowValue = string | number | boolean;

export const PLACEHOLDER = /^\{\{([A-Za-z][A-Za-z0-9]*)\}\}$/;

/** A template file as stored; a fresh copy each time. */
export function readTemplateFile<T = unknown>(file: string | URL): T {
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

/** The names a template's placeholders use. */
export function placeholdersOf(template: Pick<GraphTemplate, "prompt">): string[] {
  const names = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      const m = PLACEHOLDER.exec(value);
      if (m) names.add(m[1]!);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(template.prompt);
  return [...names].sort();
}

/**
 * The graph to queue: the template's prompt with every placeholder replaced.
 * A placeholder with no value is an error, and so is a value no placeholder
 * asks for — a misspelt name must not pass silently.
 */
export function fillWorkflow(template: GraphTemplate, values: Record<string, WorkflowValue | undefined>): ComfyUiPrompt {
  const prompt = structuredClone(template.prompt);
  for (const [name, nodeId] of Object.entries(template.optionalNodes ?? {})) {
    if (values[name] === undefined) delete prompt[nodeId];
  }
  const used = new Set<string>();
  for (const [flag, nodeId] of Object.entries(template.bypassNodes ?? {})) {
    used.add(flag);
    if (values[flag] === true) continue;
    const through = Object.values(prompt[nodeId]?.inputs ?? {}).find((v) => Array.isArray(v));
    if (!through) throw new ComfyUiError("bad-request", `node ${nodeId} has no linked input to pass through`);
    delete prompt[nodeId];
    for (const node of Object.values(prompt)) {
      for (const [k, v] of Object.entries(node.inputs)) {
        if (Array.isArray(v) && v[0] === nodeId && v[1] === 0) node.inputs[k] = [...through];
      }
    }
  }
  const fill = (value: unknown): unknown => {
    if (typeof value === "string") {
      const m = PLACEHOLDER.exec(value);
      if (!m) return value;
      const given = values[m[1]!];
      if (given === undefined) throw new ComfyUiError("bad-request", `the workflow needs a value for ${m[1]}`);
      used.add(m[1]!);
      return given;
    }
    if (Array.isArray(value)) return value.map(fill);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]));
    return value;
  };
  for (const node of Object.values(prompt)) node.inputs = fill(node.inputs) as Record<string, unknown>;
  const unused = Object.keys(values).filter((k) => values[k] !== undefined && !used.has(k));
  if (unused.length > 0) throw new ComfyUiError("bad-request", `the workflow has no placeholder for ${unused.join(", ")}`);
  return prompt;
}

/** The node classes a filled graph needs, to check a server against. */
export function nodeClassesOf(prompt: ComfyUiPrompt): string[] {
  return [...new Set(Object.values(prompt).map((n) => n.class_type))].sort();
}
