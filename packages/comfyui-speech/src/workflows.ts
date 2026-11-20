// The workflows this package runs, kept as API-format JSON in ../workflows/
// with named placeholders (@av/comfyui's templates: a string value that is
// exactly "{{name}}" is replaced by the value of that name, keeping its type;
// `optionalNodes` and `bypassNodes` name nodes a fill may leave out).

import type { GraphTemplate } from "@av/comfyui";
import { readTemplateFile } from "@av/comfyui";

export { fillWorkflow, nodeClassesOf, placeholdersOf } from "@av/comfyui";
export type { WorkflowValue } from "@av/comfyui";

export const WORKFLOW_NAMES = ["speaker", "clone", "saved-voice", "clean-clone", "clean", "design"] as const;
export type WorkflowName = typeof WORKFLOW_NAMES[number];

export interface WorkflowTemplate extends GraphTemplate {
  description: string;
  /** Which node saves which result: role → node id. */
  outputs: Record<string, string>;
  /** When and where it last ran well on a real server; absent, never from here. */
  verifiedOn?: string;
}

/** The template as stored; a fresh copy each time. */
export function loadWorkflow(name: WorkflowName): WorkflowTemplate {
  // ../workflows/ from both src/ (tests, tsx) and dist/ (the built package)
  return readTemplateFile<WorkflowTemplate>(new URL(`../workflows/${name}.json`, import.meta.url));
}
