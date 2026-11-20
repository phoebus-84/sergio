// A small client for a ComfyUI server's HTTP API: queue a graph in API
// format, wait for it by polling its history entry, upload an input file,
// download an output file. Nothing about the server is known here: its
// address is the caller's, and a server that listens only on its own
// loopback is reached through whatever the caller set up (an SSH tunnel,
// usually) — this client just sees a URL.

import { ComfyUiError } from "./errors.js";

/** A graph in ComfyUI's API format: node id → class and inputs. */
export type ComfyUiPrompt = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

/** A file the server holds, as its history names it and `/view` serves it. */
export interface ComfyUiFile {
  filename: string;
  subfolder: string;
  type: string;
}

export interface ComfyUiClientOptions {
  /** e.g. http://127.0.0.1:8188 — never defaulted here. */
  baseUrl: string;
  /** Tests: the fetch to use. */
  fetch?: typeof fetch;
  /** Tests: how to wait between two looks at the history. */
  sleep?: (ms: number) => Promise<void>;
  /** How often the history is read while a graph runs. Default 500 ms. */
  pollIntervalMs?: number;
  /** How long one HTTP request may take. Default 30 s. */
  requestTimeoutMs?: number;
}

export interface WaitOptions {
  /** How long the graph may take, queue time included. Default 10 minutes. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** What a finished graph left: each output node's files, by node id. */
export interface PromptOutputs {
  promptId: string;
  outputs: Record<string, Record<string, unknown>>;
  /** The history entry's status messages, as the server sent them (execution_start, execution_cached, execution_success…). */
  messages?: unknown[];
}

export interface ComfyUiClient {
  readonly baseUrl: string;
  /** GET /system_stats: the server's version and devices. */
  systemStats(signal?: AbortSignal): Promise<Record<string, unknown>>;
  /** GET /object_info/<class>: the node's definition, or null when the server has no such node. */
  nodeInfo(classType: string, signal?: AbortSignal): Promise<Record<string, unknown> | null>;
  /** POST /prompt: queue the graph; returns its prompt id. */
  queuePrompt(prompt: ComfyUiPrompt, signal?: AbortSignal): Promise<string>;
  /** Poll GET /history/<id> until the graph has finished. */
  waitForPrompt(promptId: string, options?: WaitOptions): Promise<PromptOutputs>;
  /** POST /upload/image: put a file in the server's input folder (it takes audio and video too); returns the name a loader node (LoadImage, LoadAudio, LoadVideo) reads it by. */
  uploadInput(file: { bytes: Uint8Array; filename: string; subfolder?: string }, signal?: AbortSignal): Promise<string>;
  /** GET /view: a file's bytes. */
  download(file: ComfyUiFile, signal?: AbortSignal): Promise<Buffer>;
  /** POST /queue {delete}: take a graph that has not started out of the queue. */
  dequeue(promptId: string): Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The server's own words for a refused graph: the error and each node's complaints. */
function refusal(body: unknown, status: number): string {
  const b = body as { error?: { message?: unknown; details?: unknown } | string; node_errors?: Record<string, { class_type?: string; errors?: { message?: string; details?: string }[] }> } | null;
  const parts: string[] = [];
  if (typeof b?.error === "string") parts.push(b.error);
  else if (typeof b?.error?.message === "string") parts.push([b.error.message, b.error.details].filter((x) => typeof x === "string" && x !== "").join(": "));
  for (const [id, node] of Object.entries(b?.node_errors ?? {})) {
    for (const e of node.errors ?? []) parts.push(`node ${id} (${node.class_type ?? "?"}): ${[e.message, e.details].filter(Boolean).join(": ")}`);
  }
  return parts.length > 0 ? parts.join("; ") : `HTTP ${status}`;
}

/** Why a queued graph failed, from its history entry's messages. */
function executionError(messages: unknown): string {
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (Array.isArray(m) && (m[0] === "execution_error" || m[0] === "execution_interrupted")) {
        const d = (m[1] ?? {}) as { node_id?: unknown; node_type?: unknown; exception_message?: unknown };
        if (m[0] === "execution_interrupted") return `interrupted at node ${String(d.node_id ?? "?")} (${String(d.node_type ?? "?")})`;
        return `node ${String(d.node_id ?? "?")} (${String(d.node_type ?? "?")}): ${String(d.exception_message ?? "no message").trim()}`;
      }
    }
  }
  return "the server gave no reason";
}

export function createComfyUiClient(options: ComfyUiClientOptions): ComfyUiClient {
  let parsed: URL;
  try {
    parsed = new URL(options.baseUrl);
  } catch {
    throw new ComfyUiError("not-configured", `"${options.baseUrl}" is not a URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new ComfyUiError("not-configured", `"${options.baseUrl}" is not an http(s) URL`);
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;

  async function request(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    try {
      return await doFetch(`${baseUrl}${path}`, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch (e) {
      if (signal?.aborted) throw new ComfyUiError("aborted", "stopped by the caller");
      const why = e instanceof Error ? ((e as { cause?: { code?: string } }).cause?.code ?? e.message) : String(e);
      throw new ComfyUiError("unreachable", `no answer from ComfyUI at ${baseUrl} (${why})`);
    }
  }

  async function json(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    const response = await request(path, init, signal);
    if (!response.ok) throw new ComfyUiError("server", `ComfyUI answered ${response.status} for ${path.split("?")[0]}`, response.status);
    return response.json();
  }

  return {
    baseUrl,

    async systemStats(signal) {
      return await json("/system_stats", { method: "GET" }, signal) as Record<string, unknown>;
    },

    async nodeInfo(classType, signal) {
      const response = await request(`/object_info/${encodeURIComponent(classType)}`, { method: "GET" }, signal);
      if (response.status === 404) return null;
      if (!response.ok) throw new ComfyUiError("server", `ComfyUI answered ${response.status} for /object_info/${classType}`, response.status);
      const info = (await response.json() as Record<string, unknown> | null)?.[classType];
      return info && typeof info === "object" ? info as Record<string, unknown> : null;
    },

    async queuePrompt(prompt, signal) {
      const response = await request("/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt }),
      }, signal);
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new ComfyUiError(response.status === 400 ? "bad-request" : "server", `ComfyUI refused the graph: ${refusal(body, response.status)}`, response.status);
      }
      const id = (body as { prompt_id?: unknown } | null)?.prompt_id;
      if (typeof id !== "string" || id === "") throw new ComfyUiError("server", "ComfyUI queued the graph without a prompt id");
      return id;
    },

    async waitForPrompt(promptId, wait = {}) {
      const timeoutMs = wait.timeoutMs ?? 600_000;
      const started = Date.now();
      for (;;) {
        if (wait.signal?.aborted) throw new ComfyUiError("aborted", `stopped by the caller while graph ${promptId} was queued or running`);
        const history = await json(`/history/${encodeURIComponent(promptId)}`, { method: "GET" }, wait.signal) as Record<string, { status?: { status_str?: string; completed?: boolean; messages?: unknown }; outputs?: Record<string, Record<string, unknown>> }>;
        const entry = history?.[promptId];
        const status = entry?.status;
        if (entry && status && (status.completed === true || status.status_str === "error")) {
          if (status.status_str !== "success") throw new ComfyUiError("failed", `graph ${promptId} failed: ${executionError(status.messages)}`);
          return { promptId, outputs: entry.outputs ?? {}, ...(Array.isArray(status.messages) ? { messages: status.messages } : {}) };
        }
        if (Date.now() - started >= timeoutMs) throw new ComfyUiError("timeout", `graph ${promptId} did not finish in ${Math.round(timeoutMs / 1000)} s; it may still be queued or running on the server`);
        await sleep(pollIntervalMs);
      }
    },

    async uploadInput(file, signal) {
      const form = new FormData();
      form.append("image", new Blob([file.bytes]), file.filename);
      form.append("type", "input");
      form.append("overwrite", "true");
      if (file.subfolder) form.append("subfolder", file.subfolder);
      const response = await request("/upload/image", { method: "POST", body: form }, signal);
      if (!response.ok) throw new ComfyUiError(response.status === 400 ? "bad-request" : "server", `ComfyUI answered ${response.status} to the upload of ${file.filename}`, response.status);
      const body = await response.json().catch(() => null) as { name?: unknown; subfolder?: unknown } | null;
      if (typeof body?.name !== "string" || body.name === "") throw new ComfyUiError("server", "ComfyUI took the upload without naming the file");
      return typeof body.subfolder === "string" && body.subfolder !== "" ? `${body.subfolder}/${body.name}` : body.name;
    },

    async download(file, signal) {
      const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
      const response = await request(`/view?${query.toString()}`, { method: "GET" }, signal);
      if (!response.ok) throw new ComfyUiError("no-output", `ComfyUI answered ${response.status} for the file ${file.subfolder ? `${file.subfolder}/` : ""}${file.filename}`, response.status);
      return Buffer.from(await response.arrayBuffer());
    },

    async dequeue(promptId) {
      await request("/queue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ delete: [promptId] }) });
    },
  };
}
