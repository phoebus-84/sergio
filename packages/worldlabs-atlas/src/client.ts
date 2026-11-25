// ---------------------------------------------------------------------------
// World Labs Atlas client
// ---------------------------------------------------------------------------
// Assets in, a task submitted, an operation waited for, files out.
//
// Three rules shape it, all about money and long jobs:
//
// - A task is submitted ONCE. A submission whose answer is lost may be a job
//   accepted and billed, so it is never retried here; requests that only
//   read (an operation's state, a trace, a read URL) are, with a backoff.
// - A wait that ends early leaves the job running. The error names the
//   operation, and `waitUntilDone` can be called on it again, later, from
//   another process: nothing is lost but the time.
// - Nothing is chosen silently: no other host, no other quality, no other
//   task is tried when one fails.
// ---------------------------------------------------------------------------

import { resolveConfig } from "./config.js";
import {
  AtlasCancelledError, AtlasContractError, AtlasError, AtlasHttpError, AtlasNetworkError, AtlasOperationError, AtlasTimeoutError, AtlasUnavailableError,
} from "./errors.js";
import { chargedFor } from "./pricing.js";
import { SystemClock, SystemSleeper } from "./time.js";
import { FetchTransport, fetchBytes as defaultFetchBytes } from "./transport.js";
import type {
  AtlasAsset, AtlasConfig, AtlasOperation, AtlasTask, AtlasUpload, Clock, FetchBytes, HttpResponse, OutputFile, PosedFrame, Sleeper, TaskRun, Transport,
} from "./types.js";
import {
  AUTH_HEADER, atlasChiselBody, atlasGenerateBody, atlasTextToImageBody, collectFiles, createUploadUrlBody, images2PosedRGBDBody, paths, posedImages2SplatsBody,
  readAsset, readOperation, readOperationList, readReadUrl, readUploadTicket, splats2MeshBody, waitBody, withWebhook,
  type ChiselInput, type GenerateInput, type MeshInput, type PoseImagesInput, type SplatsInput, type TextToImageInput,
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
   * Let the server hold the connection (`:wait`) for this many seconds at a
   * time in place of sleeping here. Off by default: the cap is the provider's
   * and is not known.
   */
  readonly serverWaitSeconds?: number;
}

export interface SubmitOptions {
  readonly signal?: AbortSignal;
  /** A URL the provider calls when the operation ends. The client's own wait does not need it. */
  readonly webhookUrl?: string;
  /** Called with the operation as soon as it has an id, before any waiting: the moment to write it down. */
  readonly onSubmitted?: (operation: AtlasOperation) => void | Promise<void>;
}

export type RunOptions = SubmitOptions & WaitOptions;

export const DEFAULT_MAX_WAIT_MS = 45 * 60_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** The longest a provider's Retry-After is obeyed: a longer one is a refusal, and is thrown. */
const RETRY_AFTER_MAX_MS = 120_000;

/** A client from the environment (`WORLDLABS_API_KEY`). Throws AtlasUnavailableError without a key. */
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
  private readonly onEvent: (event: AtlasEvent) => void;

  private _creditsCharged = 0;
  private _tasksSubmitted = 0;

  /** Credits the provider reported charging through this client. Tasks that reported nothing are not in it. */
  get creditsCharged(): number { return this._creditsCharged; }
  get tasksSubmitted(): number { return this._tasksSubmitted; }

  constructor(options: AtlasClientOptions) {
    if (options.config instanceof AtlasUnavailableError) throw options.config;
    this.config = options.config;
    this.transport = options.transport ?? new FetchTransport();
    this.bytesOf = options.fetchBytes ?? defaultFetchBytes;
    this.clock = options.clock ?? new SystemClock();
    this.sleeper = options.sleeper ?? new SystemSleeper();
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
   * Hand a local file to the provider: ask where to put it, put it there,
   * say it is there. Three requests; the middle one carries no key, because
   * the URL is its own authorization.
   */
  async uploadFile(file: AtlasUpload, signal?: AbortSignal): Promise<AtlasAsset> {
    if (file.bytes.byteLength === 0) throw new AtlasError(`${file.fileName} is empty`, "ATLAS_VALIDATION");
    const ticket = readUploadTicket(await this.call("POST", paths.createUploadUrl(), createUploadUrlBody({ fileName: file.fileName, contentType: file.contentType, bytes: file.bytes.byteLength }), "a request for an upload URL", { signal, retry: true }));
    let put: HttpResponse;
    try {
      put = await this.transport.request({ method: ticket.method, url: ticket.uploadUrl, headers: { "content-type": file.contentType, ...ticket.headers }, body: file.bytes }, signal);
    } catch (err) {
      if (signal?.aborted) throw new AtlasCancelledError("cancelled during an upload");
      throw err;
    }
    if (put.status < 200 || put.status >= 300) throw new AtlasHttpError(put.status, put.body, `the upload of ${file.fileName}`);
    const completed = await this.call("POST", paths.completeUpload(ticket.assetId), {}, "the end of an upload", { signal, retry: true });
    const asset = readAsset(Object.keys(completed).length ? completed : { id: ticket.assetId }, ticket.assetId);
    this.onEvent({ kind: "uploaded", note: `${file.fileName} → ${asset.id}` });
    return { fileName: file.fileName, contentType: file.contentType, bytes: file.bytes.byteLength, ...asset };
  }

  async getAsset(assetId: string, signal?: AbortSignal): Promise<AtlasAsset> {
    return readAsset(await this.call("GET", paths.asset(assetId), undefined, "an asset", { signal, retry: true }), assetId);
  }

  /** A URL the asset's bytes can be read from, for a while. */
  async createReadUrl(assetId: string, signal?: AbortSignal): Promise<string> {
    return readReadUrl(await this.call("POST", paths.createReadUrl(assetId), {}, "a request for a read URL", { signal, retry: true }));
  }

  /** The bytes of a file a result named: from its URL when it has one, else through its asset. */
  async download(file: Pick<OutputFile, "url" | "assetId">, signal?: AbortSignal): Promise<Uint8Array> {
    const url = file.url ?? (file.assetId ? await this.createReadUrl(file.assetId, signal) : undefined);
    if (!url) throw new AtlasContractError("a file with neither a URL nor an asset", file);
    return this.bytesOf(url, signal);
  }

  // ── Operations ────────────────────────────────────────────────────────────

  async getOperation(operationId: string, signal?: AbortSignal): Promise<AtlasOperation> {
    return readOperation(await this.call("GET", paths.operation(operationId), undefined, "an operation", { signal, retry: true }));
  }

  async listOperations(signal?: AbortSignal): Promise<AtlasOperation[]> {
    return readOperationList(await this.call("GET", paths.operations(), undefined, "the operations", { signal, retry: true }));
  }

  /** Ask the server to hold the connection until the operation ends, or `timeoutSeconds` pass. It answers with the operation as it then is. */
  async waitOperation(operationId: string, timeoutSeconds: number, signal?: AbortSignal): Promise<AtlasOperation> {
    return readOperation(await this.call("POST", paths.wait(operationId), waitBody(timeoutSeconds), "a wait", { signal, retry: true }));
  }

  /** Ask the provider to stop a job. Whether a job stopped part-way is charged is the provider's to say. */
  async cancelOperation(operationId: string, signal?: AbortSignal): Promise<AtlasOperation | null> {
    const answer = await this.call("POST", paths.cancel(operationId), {}, "a cancellation", { signal, retry: true });
    try {
      return readOperation(answer);
    } catch {
      return null;
    }
  }

  /** The provider's own account of an operation: the request it received beside its result. Kept as provenance. */
  async traceOperation(operationId: string, signal?: AbortSignal): Promise<Json> {
    return this.call("GET", paths.trace(operationId), undefined, "a trace", { signal, retry: true });
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────

  /** Submit a task with a body already built. Sent once: see the note at the top. */
  async submit(task: AtlasTask, body: Json, options: SubmitOptions = {}): Promise<AtlasOperation> {
    if (options.signal?.aborted) throw new AtlasCancelledError("cancelled before the task was submitted");
    // Once it leaves, the request is seen through: a submission abandoned half-way is a job nobody can name.
    const operation = readOperation(await this.call("POST", paths.task(task), withWebhook(body, options.webhookUrl), `tasks:${task}`, { retry: false }));
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
      let operation: AtlasOperation;
      try {
        operation = options.serverWaitSeconds
          ? await this.waitOperation(operationId, options.serverWaitSeconds, options.signal)
          : await this.getOperation(operationId, options.signal);
      } catch (err) {
        if (options.signal?.aborted) return this.abandoned(operationId, options);
        throw err;
      }
      if (operation.done) {
        this.onEvent({ kind: "done", operationId, state: operation.state, waitedMs: waited() });
        if (operation.state === "succeeded") return operation;
        throw new AtlasOperationError(operationId, operation.state === "cancelled" ? "cancelled" : "failed", operation.error?.code ?? null, operation.error?.message ?? "no reason given", operation.credits);
      }
      this.onEvent({ kind: "waiting", operationId, state: operation.state, progress: operation.progress, waitedMs: waited() });
      if (waited() >= maxWaitMs) throw new AtlasTimeoutError(operationId, waited());
      const pause = Math.min(pollMs, Math.max(0, maxWaitMs - waited()));
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
      await this.cancelOperation(operationId);
    } catch (err) {
      throw new AtlasCancelledError(`stopped waiting for Atlas operation ${operationId}, and could not cancel it there (${err instanceof Error ? err.message : String(err)}): it may still run, and be charged`, operationId);
    }
    throw new AtlasCancelledError(`stopped waiting for Atlas operation ${operationId} and asked Atlas to cancel it`, operationId, true);
  }

  /** What a finished operation left: its files, its trace, what it says it cost. */
  async collect(task: AtlasTask, operation: AtlasOperation, startedAtMs: number, signal?: AbortSignal): Promise<TaskRun> {
    // The trace is evidence, not a result: a job that succeeded is not failed for want of it.
    let trace: Json | null = null;
    try {
      trace = await this.traceOperation(operation.id, signal);
    } catch (err) {
      if (signal?.aborted) throw new AtlasCancelledError("cancelled while reading a trace", operation.id);
    }
    const cost = chargedFor(operation);
    if (cost) this._creditsCharged += cost.credits;
    return { task, operation, files: collectFiles(operation.response), trace, cost, startedAtMs, finishedAtMs: this.clock.nowMs() };
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

  // ── The six tasks ─────────────────────────────────────────────────────────

  /** Pictures → the same pictures with an estimated camera and depth. */
  async poseImages(input: PoseImagesInput, options?: RunOptions): Promise<TaskRun> {
    return this.run("images2PosedRGBD", images2PosedRGBDBody(input), options);
  }

  /** Posed frames → a Gaussian splat (.spz): a draft, or refined. */
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

  async textToImage(input: TextToImageInput, options?: RunOptions): Promise<TaskRun> {
    return this.run("atlasTextToImage", atlasTextToImageBody(input), options);
  }

  async chisel(input: ChiselInput, options?: RunOptions): Promise<TaskRun> {
    return this.run("atlasChisel", atlasChiselBody(input), options);
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  private url(path: string): string {
    return `${this.config.baseUrl}${path}`;
  }

  /** One request to the API, as JSON, asked again when it only reads and the failure may pass. */
  private async call(method: string, path: string, body: Json | undefined, what: string, options: { signal?: AbortSignal | undefined; retry: boolean }): Promise<Json> {
    const attempts = options.retry ? this.config.maxRetries + 1 : 1;
    let pauseMs = RETRY_BASE_MS;
    for (let attempt = 1; ; attempt++) {
      if (options.signal?.aborted) throw new AtlasCancelledError(`cancelled before ${what}`);
      let failure: AtlasHttpError | AtlasNetworkError;
      try {
        const response = await this.transport.request({
          method, url: this.url(path),
          headers: { [AUTH_HEADER]: this.config.apiKey, accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
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

/** The frames of a posing run, for the next task. */
export { readGeneratedFrames, readPosedFrames } from "./wire.js";
export type { PosedFrame };
