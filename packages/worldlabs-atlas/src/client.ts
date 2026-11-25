// ---------------------------------------------------------------------------
// World Labs Atlas client
// ---------------------------------------------------------------------------
// Assets in, a task submitted, an operation waited for, files out.
//
// Three rules shape it, all about money and long jobs:
//
// - One logical task is one `Idempotency-Key`. A submission whose answer is
//   lost may be a job accepted and billed, so it is asked again only with
//   the same body and the same key, which returns the first operation and
//   starts nothing. A caller that names the key itself can do that from
//   another process, after a crash. Never a new key for the same work.
// - A wait that ends early leaves the job running. The error names the
//   operation, and `waitUntilDone` can be called on it again, later, from
//   another process: nothing is lost but the time.
// - Nothing is chosen silently: no other host, no other quality, no other
//   task is tried when one fails.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { resolveConfig } from "./config.js";
import {
  AtlasCancelledError, AtlasContractError, AtlasError, AtlasHttpError, AtlasNetworkError, AtlasOperationError, AtlasTimeoutError, AtlasUnavailableError,
} from "./errors.js";
import { SystemClock, SystemSleeper } from "./time.js";
import { FetchTransport, fetchBytes as defaultFetchBytes } from "./transport.js";
import type {
  AtlasAsset, AtlasConfig, AtlasOperation, AtlasTask, AtlasUpload, Clock, FetchBytes, HttpResponse, OutputFile, Sleeper, TaskRun, Transport,
} from "./types.js";
import {
  AUTH_HEADER, IDEMPOTENCY_HEADER, WAIT_CAP_SECONDS, atlasGenerateBody, atlasTextToImageBody, cancelBody, collectFiles, createAssetBody, createUploadUrlBody,
  images2PosedRGBDBody, paths, posedImages2SplatsBody, readAsset, readOperation, readOperationList, readReadUrl, readUploadTicket, splats2MeshBody, waitBody,
  type GenerateInput, type MeshInput, type PoseImagesInput, type SplatsInput, type TextToImageInput,
} from "./wire.js";

type Json = Record<string, unknown>;

/** What happened, for whoever is watching: a line for a log or a progress note. */
export interface AtlasEvent {
  readonly kind: "uploaded" | "submitted" | "waiting" | "retrying" | "cancelling" | "done";
  readonly operationId?: string;
  readonly task?: AtlasTask;
  readonly state?: string;
  readonly progress?: number | null;
  readonly waitedMs?: number;
  readonly note?: string;
}

export interface AtlasClientOptions {
  readonly config: AtlasConfig | AtlasUnavailableError;
  readonly transport?: Transport;
  readonly fetchBytes?: FetchBytes;
  readonly clock?: Clock;
  readonly sleeper?: Sleeper;
  /** 0–1, to spread the pauses between looks so that many waiters do not look together. Default Math.random. */
  readonly random?: () => number;
  readonly onEvent?: (event: AtlasEvent) => void;
}

export interface WaitOptions {
  /** Give up waiting after this long. The job goes on. Default 45 minutes. */
  readonly maxWaitMs?: number;
  /** First pause between two looks; it grows by half each time. Default 5 s. */
  readonly pollMs?: number;
  /** The longest pause. Default 30 s. */
  readonly maxPollMs?: number;
  readonly signal?: AbortSignal;
  /** When the caller gives up through `signal`, ask the provider to cancel the job too. Default false. */
  readonly cancelOnAbort?: boolean;
  /**
   * Let the server hold each look open (`:wait`, 30 seconds at most there)
   * instead of sleeping here between looks. It may still answer `done:
   * false`. Default false.
   */
  readonly serverWait?: boolean;
}

export interface SubmitOptions {
  readonly signal?: AbortSignal;
  /**
   * The name of this logical task, stable across every attempt at it. Sent
   * as `Idempotency-Key`: the same key with the same body returns the first
   * operation; with another body it is refused (409). Default: a new one,
   * which makes retries safe within this call only.
   */
  readonly idempotencyKey?: string;
  /** A URL the provider POSTs one signed event to when the operation ends. https, port 443, a DNS name. The client's own wait does not need it. */
  readonly webhookUrl?: string;
  /** Called with the operation as soon as it has an id, before any waiting: the moment to write it down. */
  readonly onSubmitted?: (operation: AtlasOperation) => void | Promise<void>;
}

export type RunOptions = SubmitOptions & WaitOptions;

export const DEFAULT_MAX_WAIT_MS = 45 * 60_000;
/** A new operation can be unreadable for a moment: a 404 this soon after it was accepted is asked again, later it is an error. */
const NOT_READABLE_YET_MS = 60_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** The longest a provider's Retry-After is obeyed: a longer one is a refusal, and is thrown. */
const RETRY_AFTER_MAX_MS = 120_000;

/** A client from the environment (`WLT_API_KEY`, `WLT_API_BASE_URL`). Throws AtlasUnavailableError without a key. */
export function createAtlasClient(options: Omit<AtlasClientOptions, "config"> & { env?: NodeJS.ProcessEnv } = {}): AtlasClient {
  const { env, ...rest } = options;
  return new AtlasClient({ ...rest, config: resolveConfig(env) });
}

export class AtlasClient {
  private readonly config: AtlasConfig;
  private readonly transport: Transport;
  private readonly bytesOf: FetchBytes;
  private readonly clock: Clock;
  private readonly sleeper: Sleeper;
  private readonly random: () => number;
  private readonly onEvent: (event: AtlasEvent) => void;

  private _tasksSubmitted = 0;

  /** Tasks this client had accepted. What they cost is on the account's Usage page: an operation does not say. */
  get tasksSubmitted(): number { return this._tasksSubmitted; }

  constructor(options: AtlasClientOptions) {
    if (options.config instanceof AtlasUnavailableError) throw options.config;
    this.config = options.config;
    this.transport = options.transport ?? new FetchTransport();
    this.bytesOf = options.fetchBytes ?? defaultFetchBytes;
    this.clock = options.clock ?? new SystemClock();
    this.sleeper = options.sleeper ?? new SystemSleeper();
    this.random = options.random ?? Math.random;
    this.onEvent = options.onEvent ?? (() => {});
  }

  // ── Reachability ──────────────────────────────────────────────────────────

  /** Whether the host answers. No key is sent, and nothing is charged. */
  async health(signal?: AbortSignal): Promise<{ ok: boolean; status: number; body: string }> {
    const response = await this.transport.request({ method: "GET", url: this.url(paths.health()), headers: { accept: "application/json" } }, signal);
    return { ok: response.status >= 200 && response.status < 300, status: response.status, body: response.body.slice(0, 500) };
  }

  // ── Assets ────────────────────────────────────────────────────────────────

  /**
   * Hand a local file to the project: make its record, ask where to put it,
   * put it there, say it is there. Four requests; the third carries no key,
   * because the upload URL is its own authorization. Up to 1 GiB. An upload
   * left unfinished is deleted there after two hours.
   */
  async uploadFile(file: AtlasUpload, signal?: AbortSignal): Promise<AtlasAsset> {
    if (file.bytes.byteLength === 0) throw new AtlasError(`${file.fileName} is empty`, "ATLAS_VALIDATION");
    const created = readAsset(await this.call("POST", paths.assets(), createAssetBody(file.fileName), "the creation of an asset", { signal, retry: true }));
    const ticket = readUploadTicket(await this.call("POST", paths.createUploadUrl(created.id), createUploadUrlBody({ contentType: file.contentType, bytes: file.bytes.byteLength }), "a request for an upload URL", { signal, retry: true }));
    let put: HttpResponse;
    try {
      put = await this.transport.request({ method: ticket.method, url: ticket.uploadUrl, headers: { "content-type": file.contentType, ...ticket.headers }, body: file.bytes }, signal);
    } catch (err) {
      if (signal?.aborted) throw new AtlasCancelledError("cancelled during an upload");
      throw err;
    }
    if (put.status < 200 || put.status >= 300) throw new AtlasHttpError(put.status, put.body, `the upload of ${file.fileName}`);
    const asset = readAsset(await this.call("POST", paths.completeUpload(created.id), {}, "the end of an upload", { signal, retry: true }));
    if (asset.state !== undefined && asset.state !== "READY") throw new AtlasContractError(`an uploaded asset that is ${asset.state}, not READY`, asset);
    this.onEvent({ kind: "uploaded", note: `${file.fileName} → ${asset.id}` });
    return { fileName: file.fileName, contentType: file.contentType, bytes: file.bytes.byteLength, ...asset };
  }

  async getAsset(assetId: string, signal?: AbortSignal): Promise<AtlasAsset> {
    return readAsset(await this.call("GET", paths.asset(assetId), undefined, "an asset", { signal, retry: true }));
  }

  /** A URL the asset's bytes can be read from, for fifteen minutes: a secret while it lasts. */
  async createReadUrl(assetId: string, signal?: AbortSignal): Promise<string> {
    return readReadUrl(await this.call("POST", paths.createReadUrl(assetId), {}, "a request for a read URL", { signal, retry: true }));
  }

  /**
   * The bytes of a file a result named. Through its asset when it has an id:
   * the url beside it stops working a day after the result was made. Its url
   * otherwise.
   */
  async download(file: Pick<OutputFile, "url" | "assetId">, signal?: AbortSignal): Promise<Uint8Array> {
    const url = file.assetId ? await this.createReadUrl(file.assetId, signal) : file.url;
    if (!url) throw new AtlasContractError("a file with neither a URL nor an asset", file);
    return this.bytesOf(url, signal);
  }

  // ── Operations ────────────────────────────────────────────────────────────

  async getOperation(operationId: string, signal?: AbortSignal): Promise<AtlasOperation> {
    return readOperation(await this.call("GET", paths.operation(operationId), undefined, "an operation", { signal, retry: true }));
  }

  /**
   * The project's operations, newest first, kept for 30 days. A listed
   * operation has no `response`: get it by id for that.
   */
  async listOperations(filter: { task?: AtlasTask; status?: "RUNNING" | "SUCCEEDED" | "FAILED"; pageSize?: number; pageToken?: string } = {}, signal?: AbortSignal): Promise<{ operations: AtlasOperation[]; nextPageToken: string | null }> {
    const query = new URLSearchParams(Object.entries(filter).filter(([, value]) => value !== undefined).map(([key, value]): [string, string] => [key, String(value)]));
    return readOperationList(await this.call("GET", `${paths.operations()}${query.size ? `?${query}` : ""}`, undefined, "the operations", { signal, retry: true }));
  }

  /** Ask the server to hold the connection until the operation ends, or `timeoutSeconds` pass (30 at most there). It may answer `done: false`. */
  async waitOperation(operationId: string, timeoutSeconds: number = WAIT_CAP_SECONDS, signal?: AbortSignal): Promise<AtlasOperation> {
    return readOperation(await this.call("POST", paths.wait(operationId), waitBody(timeoutSeconds), "a wait", { signal, retry: true }));
  }

  /**
   * Ask the provider to stop a job (the key needs `operations.cancel`). It
   * is a request, and best-effort: the operation returned may still be
   * running, and one that had already finished keeps its real result.
   */
  async cancelOperation(operationId: string, options: { reason?: string; requestId?: string } = {}, signal?: AbortSignal): Promise<AtlasOperation> {
    // The same id on every repeat makes them one cancellation.
    const requestId = options.requestId ?? `cancel-${operationId}`.slice(0, 36);
    return readOperation(await this.call("POST", paths.cancel(operationId), cancelBody(requestId, options.reason), "a cancellation", { signal, retry: true }));
  }

  /** The provider's own account of an operation: the request as it was sent beside its result. Kept there for 30 days; kept here as provenance. */
  async traceOperation(operationId: string, signal?: AbortSignal): Promise<Json> {
    return this.call("GET", paths.trace(operationId), undefined, "a trace", { signal, retry: true });
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────

  /**
   * Submit a task with a body already built. Asked again, when the answer
   * is lost or the service is briefly away, with the same body and the same
   * key: that returns the first operation and starts nothing.
   */
  async submit(task: AtlasTask, body: Json, options: SubmitOptions = {}): Promise<AtlasOperation> {
    if (options.signal?.aborted) throw new AtlasCancelledError("cancelled before the task was submitted");
    const sent = options.webhookUrl ? { ...body, webhookUrl: options.webhookUrl } : body;
    // Once it leaves, the request is seen through: a submission abandoned half-way is a job nobody has the id of.
    const operation = readOperation(await this.call("POST", paths.task(task), sent, `tasks:${task}`, { retry: true, headers: { [IDEMPOTENCY_HEADER]: options.idempotencyKey ?? randomUUID() } }));
    this._tasksSubmitted++;
    this.onEvent({ kind: "submitted", task, operationId: operation.id, state: operation.state });
    await options.onSubmitted?.(operation);
    return operation;
  }

  /**
   * Wait for an operation to end, looking at it with growing pauses.
   *
   * Resolves with the operation when it succeeded. Throws AtlasOperationError
   * when it failed or was cancelled there, AtlasTimeoutError when the wait
   * ran out (the job goes on), AtlasCancelledError when the caller gave up.
   */
  async waitUntilDone(operationId: string, options: WaitOptions = {}): Promise<AtlasOperation> {
    const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    const maxPollMs = options.maxPollMs ?? 30_000;
    let pollMs = Math.min(options.pollMs ?? 5_000, maxPollMs);
    const startedMs = this.clock.nowMs();
    let sleptMs = 0;
    // Whichever moved further, the clock or the time slept: a clock that stands still must not make the wait endless.
    const waited = () => Math.max(this.clock.nowMs() - startedMs, sleptMs);

    for (;;) {
      if (options.signal?.aborted) return this.abandoned(operationId, options);
      let operation: AtlasOperation | null;
      try {
        operation = options.serverWait
          ? await this.waitOperation(operationId, WAIT_CAP_SECONDS, options.signal)
          : await this.getOperation(operationId, options.signal);
      } catch (err) {
        if (options.signal?.aborted) return this.abandoned(operationId, options);
        // "A brief 404 can be retried, but a persistent 404 is an API issue": the operation is not readable yet.
        if (!(err instanceof AtlasHttpError && err.status === 404 && waited() < NOT_READABLE_YET_MS)) throw err;
        operation = null;
      }
      if (operation?.done) {
        this.onEvent({ kind: "done", operationId, state: operation.state, waitedMs: waited() });
        if (operation.state === "succeeded") return operation;
        throw new AtlasOperationError(operationId, operation.state === "cancelled" ? "cancelled" : "failed", operation.error?.reason ?? null, operation.error?.message ?? "no reason given", operation.error?.code ?? null);
      }
      this.onEvent({ kind: "waiting", operationId, state: operation ? operation.phase ?? operation.state : "not readable yet", progress: operation?.progress ?? null, waitedMs: waited() });
      if (waited() >= maxWaitMs) throw new AtlasTimeoutError(operationId, waited());
      // Spread by a tenth either way, so that many waiters do not look together.
      const pause = Math.min(Math.round(pollMs * (0.9 + 0.2 * this.random())), Math.max(0, maxWaitMs - waited()));
      try {
        await this.sleeper.sleep(pause, options.signal);
      } catch (err) {
        if (options.signal?.aborted) return this.abandoned(operationId, options);
        throw err;
      }
      sleptMs += pause;
      pollMs = Math.min(Math.round(pollMs * 1.5), maxPollMs);
    }
  }

  /** The caller gave up while a job was running: cancel it there when asked to, and say which job it was. */
  private async abandoned(operationId: string, options: WaitOptions): Promise<never> {
    if (!options.cancelOnAbort) throw new AtlasCancelledError(`stopped waiting for Atlas operation ${operationId}: it is still running there, and may be charged`, operationId);
    this.onEvent({ kind: "cancelling", operationId });
    try {
      await this.cancelOperation(operationId, { reason: "the caller stopped waiting" });
    } catch (err) {
      throw new AtlasCancelledError(`stopped waiting for Atlas operation ${operationId}, and could not cancel it there (${err instanceof Error ? err.message : String(err)}): it may still run, and be charged`, operationId);
    }
    throw new AtlasCancelledError(`stopped waiting for Atlas operation ${operationId} and asked Atlas to cancel it`, operationId, true);
  }

  /** What a finished operation left: its files and its trace. */
  async collect(task: AtlasTask, operation: AtlasOperation, startedAtMs: number, signal?: AbortSignal): Promise<TaskRun> {
    // The trace is evidence, not a result: a job that succeeded is not failed for want of it.
    let trace: Json | null = null;
    try {
      trace = await this.traceOperation(operation.id, signal);
    } catch (err) {
      if (signal?.aborted) throw new AtlasCancelledError("cancelled while reading a trace", operation.id);
    }
    return { task, operation, files: collectFiles(operation.response), trace, startedAtMs, finishedAtMs: this.clock.nowMs() };
  }

  /** Submit, wait, collect. */
  async run(task: AtlasTask, body: Json, options: RunOptions = {}): Promise<TaskRun> {
    const startedAtMs = this.clock.nowMs();
    const submitted = await this.submit(task, body, options);
    const operation = submitted.done && submitted.state === "succeeded" ? submitted : await this.waitUntilDone(submitted.id, options);
    return this.collect(task, operation, startedAtMs, options.signal);
  }

  /** Wait again for a job submitted earlier, by this process or another, and collect it. Nothing is submitted. */
  async resume(task: AtlasTask, operationId: string, options: WaitOptions = {}): Promise<TaskRun> {
    const startedAtMs = this.clock.nowMs();
    return this.collect(task, await this.waitUntilDone(operationId, options), startedAtMs, options.signal);
  }

  // ── The tasks ─────────────────────────────────────────────────────────────
  // Five of the six have a typed request here. `atlasChisel` (depth-guided
  // generation and masked edits) is reached with `run("atlasChisel", body)`.

  /** Pictures → the same pictures with an estimated camera and depth. */
  async poseImages(input: PoseImagesInput, options?: RunOptions): Promise<TaskRun> {
    return this.run("images2PosedRGBD", images2PosedRGBDBody(input), options);
  }

  /** Posed frames with depth → a Gaussian splat (.spz): a draft, or refined. */
  async splatsFromPosedImages(input: SplatsInput, options?: RunOptions): Promise<TaskRun> {
    return this.run("posedImages2Splats", posedImages2SplatsBody(input), options);
  }

  /** A splat → a polygon mesh (GLB). */
  async meshFromSplats(input: MeshInput, options?: RunOptions): Promise<TaskRun> {
    return this.run("splats2Mesh", splats2MeshBody(input), options);
  }

  /** Posed frames and a path of cameras → the scene seen from each of them. */
  async generateViews(input: GenerateInput, options?: RunOptions): Promise<TaskRun> {
    return this.run("atlasGenerate", atlasGenerateBody(input), options);
  }

  /** Words → a picture of a place, with its camera and depth when asked. */
  async textToImage(input: TextToImageInput, options?: RunOptions): Promise<TaskRun> {
    return this.run("atlasTextToImage", atlasTextToImageBody(input), options);
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  private url(path: string): string {
    return `${this.config.baseUrl}${path}`;
  }

  /** One request to the API, as JSON, asked again when the failure may pass. */
  private async call(method: string, path: string, body: Json | undefined, what: string, options: { signal?: AbortSignal | undefined; retry: boolean; headers?: Record<string, string> }): Promise<Json> {
    const attempts = options.retry ? this.config.maxRetries + 1 : 1;
    let pauseMs = RETRY_BASE_MS;
    for (let attempt = 1; ; attempt++) {
      if (options.signal?.aborted) throw new AtlasCancelledError(`cancelled before ${what}`);
      let failure: AtlasHttpError | AtlasNetworkError;
      try {
        const response = await this.transport.request({
          method, url: this.url(path),
          headers: { [AUTH_HEADER]: this.config.apiKey, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...options.headers },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }, options.signal);
        if (response.status >= 200 && response.status < 300) return parse(response, what);
        const after = Number.parseFloat(response.headers["retry-after"] ?? "");
        failure = new AtlasHttpError(response.status, response.body, what, Number.isFinite(after) && after >= 0 ? after : null);
      } catch (err) {
        if (options.signal?.aborted) throw new AtlasCancelledError(`cancelled during ${what}`);
        if (!(err instanceof AtlasNetworkError)) throw err;
        failure = err;
      }
      const asked = failure instanceof AtlasHttpError && failure.retryAfterSeconds !== null ? failure.retryAfterSeconds * 1000 : 0;
      if (!failure.retryable || attempt >= attempts || asked > RETRY_AFTER_MAX_MS) throw failure;
      const pause = Math.max(Math.min(pauseMs, RETRY_MAX_MS), asked);
      this.onEvent({ kind: "retrying", note: `${what}: ${failure.message.slice(0, 120)}; again in ${Math.round(pause / 1000)}s (${attempt}/${attempts - 1})` });
      await this.sleeper.sleep(pause, options.signal);
      pauseMs = Math.min(pauseMs * 2, RETRY_MAX_MS);
    }
  }
}

function parse(response: HttpResponse, what: string): Json {
  if (!response.body.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(response.body);
  } catch {
    throw new AtlasContractError(`${what} with a body that is not JSON`, response.body);
  }
  if (typeof value !== "object" || value === null) throw new AtlasContractError(what, value);
  return Array.isArray(value) ? { items: value } : (value as Json);
}
