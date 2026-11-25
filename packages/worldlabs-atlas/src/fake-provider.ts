// ---------------------------------------------------------------------------
// A fake Atlas, for tests
// ---------------------------------------------------------------------------
// An Atlas that lives in memory: it takes uploads, accepts the tasks, lets
// their operations ripen over a few looks, and hands back files. The real
// client talks to it through `transport` and `fetchBytes`, or through
// `fetch` when a test replaces the global one, so the client's own code runs
// and no request leaves the machine.
//
// It is written from the same documentation as wire.ts, and is as strict as
// the documentation says the service is: a request with a field its schema
// does not list is refused with a 422, an Idempotency-Key seen before
// returns the first operation or a 409, an operation is readable a moment
// after it is accepted. That catches a client that drifts from the
// documentation. It cannot show that the service agrees with it.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { ATLAS_TASKS, type AtlasTask, type FetchBytes, type HttpRequest, type HttpResponse, type Transport } from "./types.js";
import { AUTH_HEADER, IDEMPOTENCY_HEADER } from "./wire.js";

type Json = Record<string, unknown>;

export interface FakeAtlasOptions {
  /** The key it accepts. Default: any that is not empty. */
  readonly apiKey?: string;
  /** How many looks an operation takes to end. Default 2. */
  readonly looksUntilDone?: number;
  /** Tasks that end in failure, with the reason the provider would give. */
  readonly failing?: Partial<Record<AtlasTask, { reason: string; message: string }>>;
  /** Tasks refused at submission, with this status and code. */
  readonly refusing?: Partial<Record<AtlasTask, number | { status: number; code: string }>>;
  /** How many looks at a new operation answer 404 before it is readable. Default 0. */
  readonly unreadableLooks?: number;
  /** false: `:trace` answers 404. */
  readonly traces?: boolean;
}

interface FakeAsset { id: string; displayName: string; mimeType: string; bytes: Uint8Array | null; state: "CREATED" | "UPLOADING" | "READY" }
interface FakeOperation { id: string; task: AtlasTask; body: Json; looks: number; unreadable: number; done: boolean; cancelled: boolean; response: Json | null; error: Json | null; createdAtSecs: number }

export const FAKE_API_ROOT = "https://atlas.fake.invalid/api/v2";
const STORE = "https://store.fake.invalid";

/** The fields each request's schema lists: anything else is a 422, as `additionalProperties: false` makes it. */
const COMMON = ["webhookUrl", "purgeContentOnOperationCompletion"];
const REQUEST_FIELDS: Readonly<Record<AtlasTask, readonly string[]>> = {
  images2PosedRGBD: [...COMMON, "base64Outputs", "frames", "canonicalizeToFirstFrame", "targetResolution", "refinePoses"],
  // `refine` is in the task guide and not in the reference's schema: the guide is followed, here as in wire.ts.
  posedImages2Splats: [...COMMON, "prompt", "enhancePrompt", "regionOfInterest", "posedFrames", "refine"],
  splats2Mesh: [...COMMON, "cameras", "advancedOptions", "orientedBoundingBox", "targetFaces", "textureMode", "textureSize", "colliderBoxes", "splatAsset"],
  atlasGenerate: [...COMMON, "base64Outputs", "contextFrames", "targetCameras", "prompt", "enhancePrompt", "returnDepth", "modelParameters"],
  atlasTextToImage: [...COMMON, "prompt", "aspectRatio", "enhancePrompt", "seed", "numSteps", "numSamples", "returnDepth"],
  atlasChisel: [...COMMON, "base64Outputs", "targetFrames", "contextFrames", "styleReferenceImageAsset", "prompt", "enhancePrompt", "voxelSize", "voxelGridOrientation", "modelParameters", "returnDepth"],
};
const POSED_FRAME_FIELDS = ["imageAsset", "maskAsset", "camera", "depth"];
const GRIDS = ["1280x720", "720x1280", "960x720", "528x704"];

/** A binary glTF holding one triangle on the ground: small, and a real file. */
export function fakeGlb(): Uint8Array {
  const positions = new Float32Array([-1, 0, -1, 1, 0, -1, 0, 0, 1]);
  const bin = Buffer.from(positions.buffer);
  let json = JSON.stringify({
    asset: { version: "2.0", generator: "fake-atlas" },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: "set" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [-1, 0, -1], max: [1, 0, 1] }],
    bufferViews: [{ buffer: 0, byteLength: bin.length }], buffers: [{ byteLength: bin.length }],
  });
  while (json.length % 4 !== 0) json += " ";
  const head = Buffer.alloc(12), jsonHead = Buffer.alloc(8), binHead = Buffer.alloc(8);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  jsonHead.writeUInt32LE(json.length, 0); jsonHead.writeUInt32LE(0x4e4f534a, 4);
  binHead.writeUInt32LE(bin.length, 0); binHead.writeUInt32LE(0x004e4942, 4);
  return new Uint8Array(Buffer.concat([head, jsonHead, Buffer.from(json), binHead, bin]));
}

const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0];
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const bytesOf = (label: string, head: number[] = []): Uint8Array => new Uint8Array([...head, ...Buffer.from(label)]);
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

export class FakeAtlas {
  readonly assets = new Map<string, FakeAsset>();
  readonly operations = new Map<string, FakeOperation>();
  /** Every request it received, in order: method, path, parsed body and headers (lower-case names). */
  readonly requests: { method: string; path: string; body: unknown; headers: Record<string, string> }[] = [];
  /** Statuses answered to the next requests in place of handling them, first first. */
  readonly interruptions: { status: number; headers?: Record<string, string>; code?: string; afterAccepting?: boolean }[] = [];
  private readonly idempotent = new Map<string, { hash: string; operationId: string }>();
  private counter = 0;

  constructor(private readonly options: FakeAtlasOptions = {}) {}

  /** For the client's `transport`. */
  get transport(): Transport {
    return { request: async (req, signal) => this.handle(req, signal) };
  }

  /** For the client's `fetchBytes`. */
  get fetchBytes(): FetchBytes {
    return async (url) => {
      const asset = this.assets.get(new URL(url).pathname.split("/").pop() ?? "");
      if (!url.startsWith(`${STORE}/read/`) || !asset?.bytes) throw new Error(`fake Atlas has nothing at ${url}`);
      return asset.bytes;
    };
  }

  /** In place of the global `fetch`, for code that makes its own client. */
  get fetch(): typeof fetch {
    return (async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal }) => {
      const url = String(input);
      if (url.startsWith(`${STORE}/read/`)) return new Response(await this.fetchBytes(url), { status: 200 });
      const body = init?.body;
      const answer = await this.handle({
        method: init?.method ?? "GET", url, headers: init?.headers ?? {},
        ...(typeof body === "string" || body instanceof Uint8Array ? { body } : {}),
      }, init?.signal);
      return new Response(answer.status === 204 ? null : answer.body, { status: answer.status, headers: answer.headers });
    }) as unknown as typeof fetch;
  }

  /** Operations of a task, oldest first. */
  submitted(task: AtlasTask): FakeOperation[] {
    return [...this.operations.values()].filter((operation) => operation.task === task);
  }

  private nextId(prefix: string): string {
    return `${prefix}_${String(++this.counter).padStart(4, "0")}`;
  }

  /** A file the fake made, as a result names it: by id, and by a url that would expire. */
  private store(displayName: string, mimeType: string, bytes: Uint8Array): Json {
    const id = this.nextId("asset");
    this.assets.set(id, { id, displayName, mimeType, bytes, state: "READY" });
    return { assetId: id, url: `${STORE}/read/${id}?X-Signature=fake-day-long` };
  }

  private shownAsset(asset: FakeAsset): Json {
    return { id: asset.id, displayName: asset.displayName, mimeType: asset.mimeType, state: asset.state, sizeBytes: asset.bytes ? String(asset.bytes.byteLength) : null, transient: false, parts: [] };
  }

  private async handle(req: HttpRequest, signal?: AbortSignal): Promise<HttpResponse> {
    if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const url = new URL(req.url);
    const path = url.pathname;
    let body: unknown = req.body;
    if (typeof req.body === "string") {
      try { body = JSON.parse(req.body); } catch { /* not JSON */ }
    }
    const headers = Object.fromEntries(Object.entries(req.headers).map(([name, value]) => [name.toLowerCase(), value]));
    this.requests.push({ method: req.method, path, body, headers });
    const json = (status: number, value: unknown, extra: Record<string, string> = {}): HttpResponse => ({ status, headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(value) });
    const refuse = (status: number, code: string, detail: string, extra: Record<string, string> = {}) => json(status, { code, detail }, extra);

    const interruption = this.interruptions[0];
    if (interruption && !interruption.afterAccepting) {
      this.interruptions.shift();
      return refuse(interruption.status, interruption.code ?? "INTERRUPTED", `interrupted with ${interruption.status}`, interruption.headers);
    }

    // The bucket an upload goes to: the URL is the authorization, and the key has no business there.
    if (url.origin === STORE && req.method === "PUT") {
      const asset = this.assets.get(path.split("/").pop() ?? "");
      if (!asset || !(req.body instanceof Uint8Array) || headers[AUTH_HEADER.toLowerCase()]) return refuse(403, "FORBIDDEN", "no such upload");
      asset.bytes = req.body;
      return { status: 200, headers: {}, body: "" };
    }
    const root = new URL(FAKE_API_ROOT);
    if (url.origin !== root.origin || !path.startsWith(root.pathname)) return refuse(404, "NOT_FOUND", `no ${path} here`);
    const rest = path.slice(root.pathname.length);
    if (rest === "/health") return json(200, { status: "ok" });

    const key = headers[AUTH_HEADER.toLowerCase()];
    if (!key || (this.options.apiKey !== undefined && key !== this.options.apiKey)) return refuse(401, "UNAUTHENTICATED", "missing, unknown or revoked API key");
    const sent = isObject(body) ? body : {};

    // ── Assets ──────────────────────────────────────────────────────────────
    if (rest === "/assets" && req.method === "POST") {
      const asset = isObject(sent["asset"]) ? sent["asset"] : null;
      if (!asset) return refuse(422, "VALIDATION", "asset is required");
      const id = this.nextId("asset");
      this.assets.set(id, { id, displayName: String(asset["displayName"] ?? ""), mimeType: "application/octet-stream", bytes: null, state: "CREATED" });
      return json(201, { ...this.shownAsset(this.assets.get(id)!), uploads: [] });
    }
    const assetCall = /^\/assets\/([^/:]+)(?::(createUploadUrl|completeUpload|createReadUrl))?$/.exec(rest);
    if (assetCall) {
      const asset = this.assets.get(decodeURIComponent(assetCall[1]!));
      if (!asset) return refuse(404, "NOT_FOUND", "no such asset");
      if (assetCall[2] === "createUploadUrl") {
        if (typeof sent["contentType"] !== "string" || typeof sent["contentLength"] !== "number") return refuse(422, "VALIDATION", "contentType and contentLength are required");
        asset.mimeType = sent["contentType"];
        asset.state = "UPLOADING";
        return json(200, { uploadUrl: `${STORE}/upload/${asset.id}`, method: "PUT", headers: { "x-fake-upload": "1" }, expiresAt: "2026-11-25T12:30:00Z" });
      }
      if (assetCall[2] === "completeUpload") {
        if (!asset.bytes) return refuse(400, "FAILED_PRECONDITION", "nothing was uploaded");
        asset.state = "READY";
        return json(200, this.shownAsset(asset));
      }
      if (assetCall[2] === "createReadUrl") {
        if (asset.state !== "READY") return refuse(400, "FAILED_PRECONDITION", "the asset is not READY");
        return json(200, { readUrl: `${STORE}/read/${asset.id}?X-Signature=fake-quarter-hour`, expiresAt: "2026-11-25T12:15:00Z" });
      }
      return json(200, this.shownAsset(asset));
    }

    // ── Tasks ───────────────────────────────────────────────────────────────
    const taskCall = /^\/tasks:([A-Za-z0-9]+)$/.exec(rest);
    if (taskCall && req.method === "POST") {
      const task = taskCall[1] as AtlasTask;
      if (!ATLAS_TASKS.includes(task)) return refuse(404, "NOT_FOUND", `no task ${task}`);
      const refused = this.options.refusing?.[task];
      if (refused) {
        const { status, code } = typeof refused === "number" ? { status: refused, code: refused === 429 ? "RATE_LIMIT_EXCEEDED" : refused === 402 ? "CREDITS_UNAVAILABLE" : "INVALID_ARGUMENT" } : refused;
        return refuse(status, code, `the fake refuses ${task}`, status === 429 ? { "retry-after": "5" } : {});
      }
      const problem = this.invalid(task, sent);
      if (problem) return json(422, { detail: [{ loc: ["body"], msg: problem, type: "value_error" }] });

      // The same key with the same body is the first operation again; with another body it is a conflict.
      const idempotencyKey = headers[IDEMPOTENCY_HEADER.toLowerCase()];
      const hash = createHash("sha256").update(JSON.stringify(sent)).digest("hex");
      const seen = idempotencyKey ? this.idempotent.get(idempotencyKey) : undefined;
      if (seen) {
        if (seen.hash !== hash) return refuse(409, "IDEMPOTENCY_KEY_REUSED", "the idempotency key was used with a different body");
        return json(201, this.shown(this.operations.get(seen.operationId)!));
      }
      const id = this.nextId("op");
      const operation: FakeOperation = { id, task, body: sent, looks: 0, unreadable: this.options.unreadableLooks ?? 0, done: false, cancelled: false, response: null, error: null, createdAtSecs: 1_795_600_000 };
      this.operations.set(id, operation);
      if (idempotencyKey) this.idempotent.set(idempotencyKey, { hash, operationId: id });
      // An answer lost on the way: the task was accepted all the same.
      if (interruption?.afterAccepting) {
        this.interruptions.shift();
        return refuse(interruption.status, "GATEWAY_TIMEOUT", "the answer was lost; the task was accepted");
      }
      return json(201, this.shown(operation));
    }

    // ── Operations ──────────────────────────────────────────────────────────
    if (rest === "/operations" && req.method === "GET") {
      const task = url.searchParams.get("task"), status = url.searchParams.get("status");
      const listed = [...this.operations.values()].reverse()
        .filter((operation) => (!task || operation.task === task) && (!status || status === (operation.done ? (operation.error ? "FAILED" : "SUCCEEDED") : "RUNNING")))
        .map((operation) => { const { response: _response, ...summary } = this.shown(operation); return summary; });
      return json(200, { operations: listed });
    }
    const operationCall = /^\/operations\/([^/:]+)(?::(wait|cancel|trace))?$/.exec(rest);
    if (operationCall) {
      const operation = this.operations.get(decodeURIComponent(operationCall[1]!));
      if (!operation) return refuse(404, "NOT_FOUND", "no such operation");
      if (operationCall[2] === "cancel") {
        if (!operation.done) {
          operation.done = true;
          operation.cancelled = true;
          operation.error = { code: 1, message: `cancelled${typeof sent["reason"] === "string" ? `: ${sent["reason"]}` : ""}`, details: [] };
        }
        return json(200, this.shown(operation));
      }
      if (operationCall[2] === "trace") {
        if (this.options.traces === false) return refuse(404, "NOT_FOUND", "no trace");
        return json(200, { operationId: operation.id, taskName: operation.task, taskVersion: "fake-1", request: operation.body, response: operation.response, error: operation.error });
      }
      if (operation.unreadable > 0) {
        operation.unreadable--;
        return refuse(404, "NOT_FOUND", "the operation is not readable yet");
      }
      this.ripen(operation);
      return json(200, this.shown(operation));
    }
    return refuse(404, "NOT_FOUND", `no ${req.method} ${path}`);
  }

  /** What the service's own validation would refuse, in a few of its words; null when the request is one it takes. */
  private invalid(task: AtlasTask, body: Json): string | null {
    const unknown = Object.keys(body).filter((field) => !REQUEST_FIELDS[task].includes(field));
    if (unknown.length) return `extra fields not permitted: ${unknown.join(", ")}`;
    const posed = (frames: unknown, what: string, least: number): string | null => {
      if (!Array.isArray(frames) || frames.length < least) return `${what} needs at least ${least} frame${least === 1 ? "" : "s"}`;
      for (const [index, frame] of frames.entries()) {
        if (!isObject(frame)) return `${what}[${index}] is not a frame`;
        const extra = Object.keys(frame).filter((field) => !POSED_FRAME_FIELDS.includes(field));
        if (extra.length) return `${what}[${index}]: extra fields not permitted: ${extra.join(", ")}`;
        if (!isObject(frame["imageAsset"]) || !isObject(frame["camera"]) || !isObject(frame["depth"])) return `${what}[${index}] needs imageAsset, camera and depth`;
      }
      return null;
    };
    const grid = (camera: unknown) => (isObject(camera) && isObject(camera["intrinsics"]) ? `${camera["intrinsics"]["width"]}x${camera["intrinsics"]["height"]}` : "none");
    if (task === "images2PosedRGBD") {
      const frames = body["frames"];
      if (!Array.isArray(frames) || frames.length < 1 || frames.length > 64) return "frames holds 1 to 64 images";
      if (frames.some((frame) => !isObject(frame) || !isObject(frame["imageAsset"]) || frame["camera"] || frame["depth"])) return "a frame is an imageAsset and nothing it has to estimate";
      const target = body["targetResolution"];
      if (target !== undefined && target !== null && !(Array.isArray(target) && GRIDS.includes(target.join("x")))) return "targetResolution is one of the four grids";
    }
    if (task === "posedImages2Splats") {
      const problem = posed(body["posedFrames"], "posedFrames", 2);
      if (problem) return problem;
      const frames = body["posedFrames"] as Json[];
      if (frames.length > (body["refine"] === false ? 32 : 512)) return "too many posedFrames";
      const grids = new Set(frames.map((frame) => grid(frame["camera"])));
      if (grids.size !== 1 || !GRIDS.includes([...grids][0]!)) return "every camera grid must be one of the four, and the same";
    }
    if (task === "atlasGenerate") {
      const problem = posed(body["contextFrames"], "contextFrames", 1);
      if (problem) return problem;
      const cameras = body["targetCameras"];
      if (!Array.isArray(cameras) || cameras.length < 1) return "targetCameras needs at least one camera";
      const sizes = new Set(cameras.map(grid));
      if (sizes.size !== 1 || !GRIDS.includes([...sizes][0]!)) return "all target cameras share one of the four sizes";
      if (cameras.some((camera) => !isObject(camera) || Object.keys(camera).some((field) => field !== "extrinsics" && field !== "intrinsics"))) return "a camera is extrinsics and intrinsics";
    }
    if (task === "splats2Mesh" && !isObject(body["splatAsset"])) return "splatAsset is required";
    if (task === "splats2Mesh" && body["textureMode"] !== undefined && !["image_texture", "vertex_color", "none"].includes(String(body["textureMode"]))) return "textureMode is image_texture, vertex_color or none";
    if (task === "atlasTextToImage" && typeof body["prompt"] !== "string") return "prompt is required";
    return null;
  }

  /** One look closer to its end. */
  private ripen(operation: FakeOperation): void {
    if (operation.done) return;
    operation.looks++;
    if (operation.looks < (this.options.looksUntilDone ?? 2)) return;
    operation.done = true;
    const failure = this.options.failing?.[operation.task];
    if (failure) {
      operation.error = { code: 13, message: failure.message, details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: failure.reason, domain: "api.worldlabs.ai" }] };
      return;
    }
    operation.response = this.resultOf(operation);
  }

  private shown(operation: FakeOperation): Json {
    return {
      id: operation.id,
      name: `accounts/acct_fake/projects/project_fake/operations/${operation.id}`,
      ownerId: "acct_fake",
      metadata: { task: operation.task, ...(operation.done ? {} : { progress: Math.min(0.9, operation.looks / Math.max(1, this.options.looksUntilDone ?? 2)) }) },
      done: operation.done,
      response: operation.response,
      error: operation.error,
      createdAtSecs: operation.createdAtSecs,
      expiresAtSecs: operation.createdAtSecs + 3600,
    };
  }

  private resultOf(operation: FakeOperation): Json {
    const { task, body } = operation;
    /** A camera on a circle round the origin at eye height, looking at its middle: position and quaternion, as the service writes one. */
    const camera = (index: number, width: number, height: number): Json => {
      const angle = index * 0.4, radius = 3;
      return {
        extrinsics: { position: [Math.sin(angle) * radius, 1.5, Math.cos(angle) * radius], quaternion: [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)], coordinateSystem: "rub" },
        intrinsics: { fx: 900, fy: 900, cx: width / 2, cy: height / 2, width, height },
      };
    };
    const depth = (name: string): Json => ({ depthAsset: this.store(`${name}.exr`, "image/x-exr", bytesOf(`depth ${name}`)), confidenceAsset: this.store(`${name}-confidence.png`, "image/png", bytesOf(`confidence ${name}`, PNG_HEAD)) });
    if (task === "images2PosedRGBD") {
      const [width, height] = Array.isArray(body["targetResolution"]) ? (body["targetResolution"] as [number, number]) : [1280, 720];
      const frames = body["frames"] as Json[];
      return {
        frames: frames.map((frame, index) => ({
          // Named by id and url together, as every result is.
          imageAsset: { ...(frame["imageAsset"] as Json), url: `${STORE}/read/${(frame["imageAsset"] as Json)["assetId"]}?X-Signature=fake-day-long` },
          camera: camera(index, width, height), depth: depth(`posed-${index}`), centroidWorld: [0, 0, 0],
        })),
        poseRefinementAccepted: body["refinePoses"] === true ? true : null,
      };
    }
    if (task === "posedImages2Splats") {
      return body["refine"] === false
        ? { refinedSplats: {}, draftSplat: this.store("draft.spz", "application/octet-stream", bytesOf("a draft splat")) }
        : { refinedSplats: { "2000000": this.store("refined.spz", "application/octet-stream", bytesOf("a refined splat")) } };
    }
    if (task === "splats2Mesh") {
      return {
        mesh: this.store("mesh.glb", "model/gltf-binary", fakeGlb()),
        colliderBoxes: body["colliderBoxes"] ? this.store("colliders.glb", "model/gltf-binary", fakeGlb()) : null,
        anchorPositions: [[0, 1.5, 0]], metadata: {},
      };
    }
    if (task === "atlasGenerate") {
      const cameras = body["targetCameras"] as Json[];
      return {
        frames: cameras.map((target, index) => ({
          imageAsset: this.store(`view-${index}.jpg`, "image/jpeg", bytesOf(`view ${index}`, JPEG_HEAD)), camera: target,
          ...(body["returnDepth"] === true ? { depth: depth(`view-${index}`) } : {}),
        })),
        promptUsed: body["enhancePrompt"] === false ? body["prompt"] ?? null : `enhanced: ${String(body["prompt"] ?? "the place in the pictures")}`,
        requestId: `request_${operation.id}`,
      };
    }
    if (task === "atlasTextToImage") {
      return { frames: [{ imageAsset: this.store("image.png", "image/png", bytesOf(`a picture of ${String(body["prompt"])}`, PNG_HEAD)) }], promptUsed: body["prompt"], promptsUsed: [body["prompt"]], aspectRatio: body["aspectRatio"] ?? "16:9" };
    }
    return { frames: [], promptUsed: body["prompt"] ?? null };
  }
}
