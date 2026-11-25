// ---------------------------------------------------------------------------
// Types of the World Labs Atlas adapter
// ---------------------------------------------------------------------------
// What a caller passes and gets back, and the few things that are injected
// so that no test reaches the network or waits a real second.
//
// The shapes of the provider's own JSON are in wire.ts.
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
  /** The API root, version included: https://api.atlas.worldlabs.ai/api/v2. */
  readonly baseUrl: string;
  /** How many times a request is asked again after a 429, a 5xx or no answer. */
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

export type OperationState = "running" | "succeeded" | "failed" | "cancelled";

export interface OperationFailure {
  /** A google.rpc.Code number: broad. */
  readonly code: number | null;
  /** The specific reason: EXECUTION_FAILED, EXECUTION_TIMEOUT, THROTTLED, CONTENT_POLICY. */
  readonly reason: string | null;
  readonly message: string;
}

/** An operation: the envelope round every task's result. */
export interface AtlasOperation {
  readonly id: string;
  /** The only terminal signal. */
  readonly done: boolean;
  readonly state: OperationState;
  readonly task: string | null;
  /** What the task says it is doing, when it says: for showing only. */
  readonly phase: string | null;
  /** 0–1, when the task says: for showing only. */
  readonly progress: number | null;
  readonly error: OperationFailure | null;
  /** The task's result, once done and not failed. */
  readonly response: Record<string, unknown> | null;
  readonly createdAtSecs: number | null;
  /** The task's deadline, when it has one. */
  readonly expiresAtSecs: number | null;
  /** The answer as it came. */
  readonly raw: Record<string, unknown>;
}

/** A file kept in the project, named by its id. */
export interface AtlasAsset {
  readonly id: string;
  /** CREATED, UPLOADING, READY: only a READY asset can be read or used. */
  readonly state?: string;
  readonly fileName?: string;
  readonly contentType?: string;
  readonly bytes?: number;
  readonly width?: number;
  readonly height?: number;
}

/** A local file to hand to a task. */
export interface AtlasUpload {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly contentType: string;
}

export type OutputKind = "splat" | "mesh" | "collider" | "image" | "depth" | "confidence" | "mask" | "other";

/** A file a task's result names: by an asset's id, and by a URL that expires. */
export interface OutputFile {
  /** Where it was in the result: "draftSplat", "frames[2].depth.depthAsset". */
  readonly path: string;
  readonly kind: OutputKind;
  readonly assetId?: string;
  readonly url?: string;
}

/** A finished task: its operation, what it left, and how it was made. */
export interface TaskRun {
  readonly task: AtlasTask;
  readonly operation: AtlasOperation;
  readonly files: readonly OutputFile[];
  /** The provider's own account of the request and its result (`:trace`), or null when it could not be read. */
  readonly trace: Record<string, unknown> | null;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
}
