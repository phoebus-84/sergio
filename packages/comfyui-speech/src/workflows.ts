// The workflows this package runs, kept as API-format JSON in ../workflows/
// with named placeholders. A placeholder is a string value that is exactly
// "{{name}}": it is replaced by the value given under that name, keeping the
// value's type (a number stays a number). Nothing else in a template is
// touched, so a template is a graph that can be read, diffed and re-exported
// from ComfyUI.
//
// A template may name optional nodes: `optionalNodes: { <value name>: <node
// id> }`. When that value is not given the node is left out of the graph.

import { readFileSync } from "node:fs";
import type { ComfyUiPrompt } from "./client.js";
import { ComfyUiError } from "./errors.js";

export const WORKFLOW_NAMES = ["speaker", "clone", "saved-voice", "clean-clone"] as const;
export type WorkflowName = typeof WORKFLOW_NAMES[number];

export interface WorkflowTemplate {
  description: string;
  /** Which node saves which result: role → node id. */
  outputs: Record<string, string>;
  /** Nodes left out when the value they are named after is absent: value name → node id. */
  optionalNodes?: Record<string, string>;
  prompt: ComfyUiPrompt;
}

export type WorkflowValue = string | number | boolean;

const PLACEHOLDER = /^\{\{([A-Za-z][A-Za-z0-9]*)\}\}$/;

/** The template as stored; a fresh copy each time. */
export function loadWorkflow(name: WorkflowName): WorkflowTemplate {
  // ../workflows/ from both src/ (tests, tsx) and dist/ (the built package)
  return JSON.parse(readFileSync(new URL(`../workflows/${name}.json`, import.meta.url), "utf-8")) as WorkflowTemplate;
}

/** The names a template's placeholders use. */
export function placeholdersOf(template: WorkflowTemplate): string[] {
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
export function fillWorkflow(template: WorkflowTemplate, values: Record<string, WorkflowValue | undefined>): ComfyUiPrompt {
  const prompt = structuredClone(template.prompt);
  for (const [name, nodeId] of Object.entries(template.optionalNodes ?? {})) {
    if (values[name] === undefined) delete prompt[nodeId];
  }
  const used = new Set<string>();
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
