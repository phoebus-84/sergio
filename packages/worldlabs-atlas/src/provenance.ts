// ---------------------------------------------------------------------------
// How a file was made
// ---------------------------------------------------------------------------
// One record per operation, kept beside what it made: what was asked, what
// the provider says it did (its `:trace`, which it keeps for 30 days), what
// it was priced at, and which reading of its API was used. No key is in it,
// and no URL that still opens something: a signed URL is cut back to the
// address it signs.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import type { AtlasEstimate } from "./pricing.js";
import type { AtlasTask, OutputFile, TaskRun } from "./types.js";
import { WIRE } from "./wire.js";

export const PROVIDER = "worldlabs-atlas";

export interface AtlasProvenance {
  readonly version: 1;
  readonly provider: typeof PROVIDER;
  readonly task: AtlasTask;
  readonly operationId: string;
  readonly state: string;
  readonly wire: typeof WIRE;
  /** The request's body as it was sent. */
  readonly request: Record<string, unknown>;
  readonly requestSha256: string;
  /** The provider's result, as it came. */
  readonly response: Record<string, unknown> | null;
  /** The provider's own account of the operation; null when it could not be read. */
  readonly trace: Record<string, unknown> | null;
  readonly files: readonly OutputFile[];
  /** What it was priced at when it was asked for. The operation does not say what it was charged: the account's Usage page does. */
  readonly estimate: AtlasEstimate | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly seconds: number;
}

const SIGNED = /^(https?:\/\/[^?#\s]+)[?#]\S*$/i;

/** The same value with every URL's query cut off: what it pointed at stays, what opened it goes. */
export function withoutSignatures<T>(value: T): T {
  if (typeof value === "string") return value.replace(SIGNED, "$1") as T;
  if (Array.isArray(value)) return value.map(withoutSignatures) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, withoutSignatures(inner)])) as T;
  }
  return value;
}

export const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

export function provenanceOf(run: TaskRun, request: Record<string, unknown>, estimate: AtlasEstimate | null = null): AtlasProvenance {
  return {
    version: 1,
    provider: PROVIDER,
    task: run.task,
    operationId: run.operation.id,
    state: run.operation.state,
    wire: WIRE,
    request: withoutSignatures(request),
    requestSha256: sha256(JSON.stringify(request)),
    response: withoutSignatures(run.operation.response),
    trace: withoutSignatures(run.trace),
    files: withoutSignatures(run.files),
    estimate,
    startedAt: new Date(run.startedAtMs).toISOString(),
    finishedAt: new Date(run.finishedAtMs).toISOString(),
    seconds: Math.round((run.finishedAtMs - run.startedAtMs) / 100) / 10,
  };
}
