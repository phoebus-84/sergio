// ---------------------------------------------------------------------------
// A fake Atlas, for tests
// ---------------------------------------------------------------------------
// An Atlas that lives in memory: it takes uploads, accepts the six tasks,
// lets their operations ripen over a few looks, and hands back files. The
// real client talks to it through `transport` and `fetchBytes`, or through
// `fetch` when a test replaces the global one, so the client's own code runs
// and no request leaves the machine.
//
// It speaks the shapes of wire.ts. That makes it a check of this package
// against itself: it cannot show that the real service agrees.
// ---------------------------------------------------------------------------

import { ATLAS_TASKS, type AtlasTask, type FetchBytes, type HttpRequest, type HttpResponse, type OperationState, type Transport } from "./types.js";
import { API_PREFIX, AUTH_HEADER } from "./wire.js";

type Json = Record<string, unknown>;

export interface FakeAtlasOptions {
  /** The key it accepts. Default: any that is not empty. */
  readonly apiKey?: string;
  /** How many looks an operation takes to end. Default 2. */
  readonly looksUntilDone?: number;
  /** Tasks that end in failure, with the provider's reason. */
  readonly failing?: Partial<Record<AtlasTask, { code: string; message: string }>>;
  /** Tasks refused at submission, with this status. */
  readonly refusing?: Partial<Record<AtlasTask, number>>;
  /** What an operation reports charging. Default: 500 or 5,000 for a splat, nothing said for the rest. */
  readonly credits?: Partial<Record<AtlasTask, number | null>>;
  /** false: no operation says what it cost. */
  readonly reportsCost?: boolean;
  /** false: `:trace` answers 404. */
  readonly traces?: boolean;
}

interface FakeAsset { id: string; fileName: string; contentType: string; bytes: Uint8Array | null; complete: boolean }
interface FakeOperation { id: string; task: AtlasTask; body: Json; looks: number; state: OperationState; response: Json | null; credits: number | null }

export const FAKE_HOST = "https://atlas.fake.invalid";
const STORE = "https://store.fake.invalid";

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

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const bytesOf = (label: string, head: number[] = []): Uint8Array => new Uint8Array([...head, ...Buffer.from(label)]);

export class FakeAtlas {
  readonly assets = new Map<string, FakeAsset>();
  readonly operations = new Map<string, FakeOperation>();
  /** Every request it received, in order: method, path and parsed body. */
  readonly requests: { method: string; path: string; body: unknown }[] = [];
  /** Statuses answered to the next requests in place of handling them, first first. */
  readonly interruptions: { status: number; headers?: Record<string, string> }[] = [];
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
    return `${prefix}-${String(++this.counter).padStart(4, "0")}`;
  }

  private store(fileName: string, contentType: string, bytes: Uint8Array): Json {
    const id = this.nextId("asset");
    this.assets.set(id, { id, fileName, contentType, bytes, complete: true });
    return { assetId: id, fileName, contentType };
  }

  private async handle(req: HttpRequest, signal?: AbortSignal): Promise<HttpResponse> {
    if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const url = new URL(req.url);
    const path = url.pathname;
    let body: unknown = req.body;
    if (typeof req.body === "string") {
      try { body = JSON.parse(req.body); } catch { /* not JSON */ }
    }
    this.requests.push({ method: req.method, path, body });
    const json = (status: number, value: unknown, headers: Record<string, string> = {}): HttpResponse => ({ status, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value) });

    const interruption = this.interruptions.shift();
    if (interruption) return json(interruption.status, { error: { message: `interrupted with ${interruption.status}` } }, interruption.headers);

    // The bucket an upload goes to: the URL is the authorization.
    if (url.origin === STORE && req.method === "PUT") {
      const asset = this.assets.get(path.split("/").pop() ?? "");
      if (!asset || !(req.body instanceof Uint8Array)) return json(403, { error: { message: "no such upload" } });
      asset.bytes = req.body;
      return { status: 200, headers: {}, body: "" };
    }
    if (url.origin !== FAKE_HOST || !path.startsWith(API_PREFIX)) return json(404, { error: { message: `no ${path} here` } });
    if (path === `${API_PREFIX}/health`) return json(200, { status: "ok" });

    const key = Object.entries(req.headers).find(([name]) => name.toLowerCase() === AUTH_HEADER.toLowerCase())?.[1];
    if (!key || (this.options.apiKey !== undefined && key !== this.options.apiKey)) return json(401, { error: { code: "UNAUTHENTICATED", message: "missing or wrong API key" } });

    const rest = path.slice(API_PREFIX.length);
    const sent = (typeof body === "object" && body !== null ? body : {}) as Json;

    if (rest === "/assets:createUploadUrl" && req.method === "POST") {
      const id = this.nextId("asset");
      this.assets.set(id, { id, fileName: String(sent["fileName"] ?? "file"), contentType: String(sent["contentType"] ?? "application/octet-stream"), bytes: null, complete: false });
      return json(200, { assetId: id, uploadUrl: `${STORE}/upload/${id}`, method: "PUT", headers: { "x-fake-upload": "1" } });
    }
    const assetCall = /^\/assets\/([^/:]+)(?::(completeUpload|createReadUrl))?$/.exec(rest);
    if (assetCall) {
      const asset = this.assets.get(decodeURIComponent(assetCall[1]!));
      if (!asset) return json(404, { error: { code: "NOT_FOUND", message: "no such asset" } });
      if (assetCall[2] === "completeUpload") {
        if (!asset.bytes) return json(409, { error: { code: "FAILED_PRECONDITION", message: "nothing was uploaded" } });
        asset.complete = true;
      }
      if (assetCall[2] === "createReadUrl") return json(200, { readUrl: `${STORE}/read/${asset.id}?signature=fake-signature` });
      return json(200, { assetId: asset.id, fileName: asset.fileName, contentType: asset.contentType, sizeBytes: asset.bytes?.byteLength ?? 0 });
    }

    const taskCall = /^\/tasks:([A-Za-z0-9]+)$/.exec(rest);
    if (taskCall && req.method === "POST") {
      const task = taskCall[1] as AtlasTask;
      if (!ATLAS_TASKS.includes(task)) return json(404, { error: { code: "NOT_FOUND", message: `no task ${task}` } });
      const refused = this.options.refusing?.[task];
      if (refused) return json(refused, { error: { code: "INVALID_ARGUMENT", message: `the fake refuses ${task}` } });
      const id = this.nextId("op");
      const operation: FakeOperation = { id, task, body: sent, looks: 0, state: "pending", response: null, credits: null };
      this.operations.set(id, operation);
      return json(200, this.shown(operation));
    }

    if (rest === "/operations" && req.method === "GET") return json(200, { operations: [...this.operations.values()].map((operation) => this.shown(operation)) });
    const operationCall = /^\/operations\/([^/:]+)(?::(wait|cancel|trace))?$/.exec(rest);
    if (operationCall) {
      const operation = this.operations.get(decodeURIComponent(operationCall[1]!));
      if (!operation) return json(404, { error: { code: "NOT_FOUND", message: "no such operation" } });
      if (operationCall[2] === "cancel") {
        if (operation.state === "pending" || operation.state === "running") operation.state = "cancelled";
        return json(200, this.shown(operation));
      }
      if (operationCall[2] === "trace") {
        if (this.options.traces === false) return json(404, { error: { code: "NOT_FOUND", message: "no trace" } });
        return json(200, { operationId: operation.id, task: operation.task, request: operation.body, response: operation.response, state: operation.state });
      }
      this.ripen(operation);
      return json(200, this.shown(operation));
    }
    return json(404, { error: { code: "NOT_FOUND", message: `no ${req.method} ${path}` } });
  }

  /** One look closer to its end. */
  private ripen(operation: FakeOperation): void {
    if (operation.state !== "pending" && operation.state !== "running") return;
    operation.looks++;
    if (operation.looks < (this.options.looksUntilDone ?? 2)) {
      operation.state = "running";
      return;
    }
    if (this.options.failing?.[operation.task]) {
      operation.state = "failed";
      return;
    }
    operation.state = "succeeded";
    operation.response = this.resultOf(operation);
    const asked = this.options.credits?.[operation.task];
    operation.credits = this.options.reportsCost === false ? null
      : asked !== undefined ? asked
      : operation.task === "posedImages2Splats" ? (operation.body["refine"] === false ? 500 : 5000) : null;
  }

  private shown(operation: FakeOperation): Json {
    const done = operation.state === "succeeded" || operation.state === "failed" || operation.state === "cancelled";
    const failure = this.options.failing?.[operation.task];
    return {
      name: `operations/${operation.id}`,
      done,
      metadata: { state: operation.state.toUpperCase(), task: operation.task, progress: done ? 1 : Math.min(0.9, operation.looks / Math.max(1, this.options.looksUntilDone ?? 2)) },
      ...(operation.state === "failed" ? { error: failure ?? { code: "INTERNAL", message: "failed" } } : {}),
      ...(operation.state === "cancelled" ? { error: { code: "CANCELLED", message: "cancelled by the caller" } } : {}),
      ...(operation.response ? { response: operation.response } : {}),
      ...(operation.credits !== null ? { cost: { credits: operation.credits } } : {}),
    };
  }

  private resultOf(operation: FakeOperation): Json {
    const { task, body } = operation;
    const camera = (index: number, width = 1280, height = 720): Json => {
      const angle = index * 0.4, radius = 3;
      const eye = [Math.sin(angle) * radius, 1.5, Math.cos(angle) * radius];
      return {
        width, height, intrinsics: { fx: 900, fy: 900, cx: width / 2, cy: height / 2 }, convention: "opengl",
        // Standing on a circle round the origin at eye height, looking at its middle (0, 1.5, 0).
        cameraToWorld: [[Math.cos(angle), 0, Math.sin(angle), eye[0]], [0, 1, 0, eye[1]], [-Math.sin(angle), 0, Math.cos(angle), eye[2]], [0, 0, 0, 1]],
      };
    };
    if (task === "images2PosedRGBD") {
      const images = Array.isArray(body["images"]) ? (body["images"] as Json[]) : [];
      return { posedFrames: images.map((image, index) => ({ image, depth: this.store(`depth-${index}.exr`, "image/x-exr", bytesOf(`depth ${index}`)), camera: camera(index) })) };
    }
    if (task === "posedImages2Splats") {
      const refined = body["refine"] !== false;
      return { splat: this.store(refined ? "refinedSplats_2000000.spz" : "draftSplats.spz", "application/octet-stream", bytesOf(refined ? "a refined splat" : "a draft splat")) };
    }
    if (task === "splats2Mesh") return { mesh: this.store("mesh.glb", "model/gltf-binary", fakeGlb()) };
    if (task === "atlasGenerate") {
      const cameras = Array.isArray(body["targetCameras"]) ? (body["targetCameras"] as Json[]) : [];
      return { frames: cameras.map((target, index) => ({ image: this.store(`view-${index}.png`, "image/png", bytesOf(`view ${index}`, PNG_HEAD)), camera: target })) };
    }
    return { image: this.store("image.png", "image/png", bytesOf(`${task} ${String(body["prompt"] ?? "")}`, PNG_HEAD)) };
  }
}
