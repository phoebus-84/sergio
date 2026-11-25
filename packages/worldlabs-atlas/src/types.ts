// ---------------------------------------------------------------------------
// Types of the World Labs Atlas adapter
// ---------------------------------------------------------------------------
// What a caller passes and gets back, and the few things that are injected
// so that no test reaches the network or waits a real second.
//
// Nothing here is a shape of the provider's JSON: those live in wire.ts, the
// one file to correct when the live API disagrees.
// ---------------------------------------------------------------------------

// ── Injected ────────────────────────────────────────────────────────────────

export interface HttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  /** JSON as text, or the bytes of a file being uploaded. */
  readonly body?: string | Uint8Array;
}

export interface HttpResponse {
  readonly status: number;
  /** Lower-case names. */
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** One HTTP round trip. It answers with whatever status came back; it throws only when no answer did. */
export interface Transport {
  request(req: HttpRequest, signal?: AbortSignal): Promise<HttpResponse>;
}

/** The bytes behind a URL: a file the provider made. */
export type FetchBytes = (url: string, signal?: AbortSignal) => Promise<Uint8Array>;

export interface Clock {
  nowMs(): number;
}

export interface Sleeper {
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

// ── Configuration ───────────────────────────────────────────────────────────

export interface AtlasConfig {
  readonly apiKey: string;
  /** Scheme and host, no path: the client adds /api/v2. */
  readonly baseUrl: string;
  /** How many times a request that only reads is asked again after a 429, a 5xx or no answer. */
  readonly maxRetries: number;
}

// ── Tasks and operations ────────────────────────────────────────────────────

export const ATLAS_TASKS = [
  "atlasGenerate",
  "atlasChisel",
  "atlasTextToImage",
  "images2PosedRGBD",
  "posedImages2Splats",
  "splats2Mesh",
] as const;
export type AtlasTask = (typeof ATLAS_TASKS)[number];

export type OperationState = "pending" | "running" | "succeeded" | "failed" | "cancelled";

/** An operation as the client understands it, whatever spelling the provider used. */
export interface AtlasOperation {
  readonly id: string;
  readonly done: boolean;
  readonly state: OperationState;
  /** 0–1, when the provider says. */
  readonly progress: number | null;
  readonly error: { readonly code: string | null; readonly message: string } | null;
  /** The task's result, once done and not failed. */
  readonly response: Record<string, unknown> | null;
  /** What the provider says it charged, in credits; null when it does not say. */
  readonly credits: number | null;
  /** The answer as it came. */
  readonly raw: Record<string, unknown>;
}

/** A file kept by the provider, named by its id. */
export interface AtlasAsset {
  readonly id: string;
  readonly fileName?: string;
  readonly contentType?: string;
  readonly bytes?: number;
}

/** A local file to hand to a task. */
export interface AtlasUpload {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly contentType: string;
}

export type OutputKind = "splat" | "mesh" | "image" | "depth" | "video" | "other";

/** A file a task's result names: by URL, by asset, or both. */
export interface OutputFile {
  /** Where it was in the result: "splat", "frames[2].depth". */
  readonly path: string;
  readonly kind: OutputKind;
  readonly url?: string;
  readonly assetId?: string;
  readonly fileName?: string;
  readonly contentType?: string;
}

/** A frame with its camera and depth, as `images2PosedRGBD` returned it: handed back untouched. */
export type PosedFrame = Record<string, unknown>;

// ── Money ───────────────────────────────────────────────────────────────────

export interface AtlasCost {
  readonly credits: number;
  readonly usd: number;
  /** provider: the operation said so. published / operator: a price list. */
  readonly basis: "provider" | "published" | "operator";
}

/** A finished task: its operation, what it left, and how it was made. */
export interface TaskRun {
  readonly task: AtlasTask;
  readonly operation: AtlasOperation;
  readonly files: readonly OutputFile[];
  /** The provider's own account of the request and its result (`:trace`), or null when it could not be read. */
  readonly trace: Record<string, unknown> | null;
  /** What the operation says it cost; null when it does not say. */
  readonly cost: AtlasCost | null;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
}
