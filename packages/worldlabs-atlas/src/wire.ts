// ---------------------------------------------------------------------------
// The provider's JSON: every path, request body and answer, in one place
// ---------------------------------------------------------------------------
// NOT VERIFIED AGAINST THE LIVE API. The documentation could not be read when
// this was written, and no call was made (docs/notes/worldlabs-atlas-api.md).
// What is here is: the paths its reference lists; the few field names third
// parties report (`refine`, `posedFrames`, `contextFrames`, `targetCameras`,
// `prompt`); and, for the rest, the plainest shape consistent with them.
//
// So the two directions are treated differently:
//
// - what is SENT is one guess per request, here and nowhere else, and every
//   builder takes `extra`, merged last, so a wrong or missing field can be
//   corrected by a caller before this file is;
// - what is READ accepts the spellings such an API is likely to use, and
//   fails with AtlasContractError, naming this file, when it finds none.
//
// A task's result goes back to the next task untouched wherever it can (the
// posed frames of `images2PosedRGBD` into `posedImages2Splats`), so that what
// this file does not understand still travels.
//
// When a real run has settled a shape, correct it here and set `verifiedLive`.
// ---------------------------------------------------------------------------

import { flipYZ, invertRigid, type AtlasCamera, type Mat4 } from "./cameras.js";
import { AtlasContractError, AtlasValidationError } from "./errors.js";
import type { AtlasAsset, AtlasOperation, AtlasTask, OperationState, OutputFile, OutputKind, PosedFrame } from "./types.js";

/** Which reading of the API this is, kept in every provenance record. */
export const WIRE = {
  api: "/api/v2",
  revision: "2026-11-25",
  /** When and on what these shapes last ran against the real service: never, so far. */
  verifiedLive: null as string | null,
} as const;

export const API_PREFIX = "/api/v2";
export const AUTH_HEADER = "WLT-Api-Key";

const seg = (id: string): string => encodeURIComponent(id);

export const paths = {
  health: () => `${API_PREFIX}/health`,
  task: (task: AtlasTask) => `${API_PREFIX}/tasks:${task}`,
  operations: () => `${API_PREFIX}/operations`,
  operation: (id: string) => `${API_PREFIX}/operations/${seg(id)}`,
  wait: (id: string) => `${API_PREFIX}/operations/${seg(id)}:wait`,
  cancel: (id: string) => `${API_PREFIX}/operations/${seg(id)}:cancel`,
  trace: (id: string) => `${API_PREFIX}/operations/${seg(id)}:trace`,
  createUploadUrl: () => `${API_PREFIX}/assets:createUploadUrl`,
  completeUpload: (id: string) => `${API_PREFIX}/assets/${seg(id)}:completeUpload`,
  createReadUrl: (id: string) => `${API_PREFIX}/assets/${seg(id)}:createReadUrl`,
  asset: (id: string) => `${API_PREFIX}/assets/${seg(id)}`,
};

// ── Small readers ───────────────────────────────────────────────────────────

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
const number = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

function first<T>(from: Json | undefined, keys: readonly string[], read: (value: unknown) => T | undefined): T | undefined {
  if (!from) return undefined;
  for (const key of keys) {
    const found = read(from[key]);
    if (found !== undefined) return found;
  }
  return undefined;
}
const object = (value: unknown): Json | undefined => (isObject(value) ? value : undefined);
/** "operations/abc" → "abc": a resource's name, as Google-style APIs give it. */
const lastSegment = (value: unknown): string | undefined => text(value)?.split("/").filter(Boolean).pop();

// ── Operations ──────────────────────────────────────────────────────────────

const STATES: Readonly<Record<string, OperationState>> = {
  PENDING: "pending", QUEUED: "pending", CREATED: "pending", SUBMITTED: "pending", WAITING: "pending",
  RUNNING: "running", IN_PROGRESS: "running", PROCESSING: "running", STARTED: "running", ACTIVE: "running",
  SUCCEEDED: "succeeded", SUCCESS: "succeeded", COMPLETED: "succeeded", COMPLETE: "succeeded", DONE: "succeeded", FINISHED: "succeeded",
  FAILED: "failed", FAILURE: "failed", ERROR: "failed", ERRORED: "failed",
  CANCELLED: "cancelled", CANCELED: "cancelled", CANCELLING: "cancelled", ABORTED: "cancelled",
};
const CREDIT_KEYS = ["credits", "creditsCharged", "credits_charged", "chargedCredits", "totalCredits", "total_credits", "creditsUsed", "credits_used"] as const;

/** An operation, from whichever of the likely spellings the answer uses. */
export function readOperation(answer: unknown): AtlasOperation {
  const raw = object(isObject(answer) && isObject(answer["operation"]) && answer["done"] === undefined ? answer["operation"] : answer);
  const id = first(raw, ["id", "operationId", "operation_id"], text) ?? lastSegment(raw?.["name"]);
  if (!raw || !id) throw new AtlasContractError("an operation", answer);

  const metadata = object(raw["metadata"]);
  const named = first(raw, ["state", "status"], text) ?? first(metadata, ["state", "status"], text);
  const failure = raw["error"] !== undefined && raw["error"] !== null ? raw["error"] : undefined;
  let state: OperationState = (named && STATES[named.toUpperCase()]) || "pending";
  const done = raw["done"] === true || state === "succeeded" || state === "failed" || state === "cancelled";
  if (done && state !== "cancelled") state = failure !== undefined || state === "failed" ? "failed" : "succeeded";
  if (!done && state === "pending" && named === undefined && metadata && first(metadata, ["progress"], (v) => v) !== undefined) state = "running";

  const error = state === "failed" || state === "cancelled"
    ? {
      code: first(object(failure), ["code", "status", "type"], (v) => text(v) ?? (number(v) !== undefined ? String(v) : undefined)) ?? null,
      message: text(failure) ?? first(object(failure), ["message", "detail", "description"], text) ?? (state === "cancelled" ? "cancelled" : "no reason given"),
    }
    : null;

  const response = state === "succeeded" ? first(raw, ["response", "result", "output", "outputs"], object) ?? null : null;
  return { id, done, state, progress: readProgress(raw, metadata), error, response, credits: readCredits(raw, metadata, response), raw };
}

function readProgress(raw: Json, metadata: Json | undefined): number | null {
  for (const holder of [metadata, raw]) {
    const value = holder?.["progress"];
    const share = number(value) ?? first(object(value), ["fraction", "percent", "percentage", "value"], number);
    if (share === undefined) continue;
    const fraction = share > 1 ? share / 100 : share;
    return Math.min(1, Math.max(0, fraction));
  }
  return null;
}

/** Credits only where the answer says "credits": a bare `cost` could be dollars. */
function readCredits(raw: Json, metadata: Json | undefined, response: Json | null): number | null {
  for (const holder of [raw, object(raw["cost"]), object(raw["usage"]), object(raw["billing"]), metadata, object(metadata?.["cost"]), object(metadata?.["usage"]), object(response?.["cost"]), object(response?.["usage"])]) {
    const credits = first(holder, CREDIT_KEYS, number);
    if (credits !== undefined && credits >= 0) return credits;
  }
  return null;
}

/** The operations of a listing. */
export function readOperationList(answer: unknown): AtlasOperation[] {
  const list = Array.isArray(answer) ? answer : first(object(answer), ["operations", "items", "data", "results"], (v) => (Array.isArray(v) ? v : undefined));
  if (!list) throw new AtlasContractError("a list of operations", answer);
  return list.map(readOperation);
}

// ── Assets ──────────────────────────────────────────────────────────────────

export interface UploadTicket {
  readonly assetId: string;
  readonly uploadUrl: string;
  readonly method: string;
  /** Headers the upload itself must carry, as the provider names them. */
  readonly headers: Record<string, string>;
}

export function createUploadUrlBody(file: { fileName: string; contentType: string; bytes: number }): Json {
  return { fileName: file.fileName, contentType: file.contentType, sizeBytes: file.bytes };
}

const ASSET_ID_KEYS = ["assetId", "asset_id", "id", "mediaAssetId", "media_asset_id"] as const;
const assetIdOf = (from: Json | undefined): string | undefined => first(from, ASSET_ID_KEYS, text) ?? lastSegment(from?.["name"]);

export function readUploadTicket(answer: unknown): UploadTicket {
  const raw = object(answer);
  const info = first(raw, ["upload", "uploadInfo", "upload_info"], object);
  const assetId = assetIdOf(object(raw?.["asset"])) ?? text(raw?.["asset"]) ?? assetIdOf(raw);
  const uploadUrl = first(info, ["uploadUrl", "upload_url", "url"], text) ?? first(raw, ["uploadUrl", "upload_url", "url"], text);
  if (!raw || !assetId || !uploadUrl) throw new AtlasContractError("an upload URL", answer);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(first(info, ["headers", "requiredHeaders", "required_headers"], object) ?? first(raw, ["headers", "requiredHeaders", "required_headers"], object) ?? {})) {
    if (typeof value === "string") headers[name] = value;
  }
  const method = first(info, ["method", "uploadMethod", "upload_method"], text) ?? first(raw, ["method", "uploadMethod", "upload_method"], text) ?? "PUT";
  return { assetId, uploadUrl, method: method.toUpperCase(), headers };
}

export function readAsset(answer: unknown, fallbackId?: string): AtlasAsset {
  const outer = object(answer);
  const raw = object(outer?.["asset"]) ?? outer;
  const id = assetIdOf(raw) ?? fallbackId;
  if (!id) throw new AtlasContractError("an asset", answer);
  const fileName = first(raw, ["fileName", "file_name", "filename", "displayName"], text);
  const contentType = first(raw, ["contentType", "content_type", "mimeType", "mime_type"], text);
  const bytes = first(raw, ["sizeBytes", "size_bytes", "size", "bytes", "fileSize", "file_size"], number);
  return { id, ...(fileName ? { fileName } : {}), ...(contentType ? { contentType } : {}), ...(bytes !== undefined ? { bytes } : {}) };
}

const URL_KEYS = ["readUrl", "read_url", "downloadUrl", "download_url", "signedUrl", "signed_url", "url", "uri"] as const;

export function readReadUrl(answer: unknown): string {
  const raw = object(answer);
  const url = first(raw, URL_KEYS, text) ?? first(object(raw?.["asset"]), URL_KEYS, text);
  if (!url || !/^https?:\/\//i.test(url)) throw new AtlasContractError("a read URL", answer);
  return url;
}

/** How a request names a file the provider already holds. */
export const wireAsset = (asset: AtlasAsset | string): Json => ({ assetId: typeof asset === "string" ? asset : asset.id });

// ── The files of a result ───────────────────────────────────────────────────

const EXTENSION_KINDS: Readonly<Record<string, OutputKind>> = {
  spz: "splat", ply: "splat", splat: "splat", ksplat: "splat",
  glb: "mesh", gltf: "mesh", obj: "mesh", fbx: "mesh", usdz: "mesh",
  exr: "depth",
  png: "image", jpg: "image", jpeg: "image", webp: "image",
  mp4: "video", mov: "video", webm: "video",
};

function extensionOf(name: string | undefined): string | undefined {
  if (!name) return undefined;
  let path = name;
  try { path = new URL(name).pathname; } catch { /* not a URL: a file name */ }
  return /\.([a-z0-9]{2,6})$/i.exec(path)?.[1]?.toLowerCase();
}

/**
 * What a file is: by its name first, then its type, then where it sat in the
 * result. One exception: a picture file sitting where a depth map goes is a
 * depth map, whatever it is stored as.
 */
export function kindOf(file: { fileName?: string; url?: string; contentType?: string; path: string }): OutputKind {
  const byName = EXTENSION_KINDS[extensionOf(file.fileName) ?? ""] ?? EXTENSION_KINDS[extensionOf(file.url) ?? ""];
  const type = file.contentType?.toLowerCase() ?? "";
  const place = file.path.split(".").pop()?.replace(/\[\d+\]$/, "").toLowerCase() ?? "";
  if (place.includes("depth") && (byName === "image" || (!byName && type.startsWith("image/")))) return "depth";
  if (byName) return byName;
  if (type.includes("exr")) return "depth";
  if (type.startsWith("model/")) return "mesh";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  const where = file.path.split(".").pop()?.replace(/\[\d+\]$/, "").toLowerCase() ?? "";
  if (where.includes("splat")) return "splat";
  if (where.includes("mesh") || where.includes("glb")) return "mesh";
  if (where.includes("depth")) return "depth";
  if (where.includes("video")) return "video";
  if (where.includes("image") || where.includes("rgb") || where.includes("picture") || where.includes("frame")) return "image";
  return "other";
}

const MAX_FILES = 4096;

/** Every file a result names, wherever it is in it: an object with a URL or an asset id. */
export function collectFiles(result: unknown): OutputFile[] {
  const found: OutputFile[] = [];
  const visit = (value: unknown, path: string, depth: number): void => {
    if (depth > 10 || found.length >= MAX_FILES) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (typeof value === "string") {
      if (/^https?:\/\//i.test(value) && EXTENSION_KINDS[extensionOf(value) ?? ""]) found.push({ path, kind: kindOf({ url: value, path }), url: value });
      return;
    }
    if (!isObject(value)) return;
    const url = first(value, URL_KEYS, (v) => (text(v) && /^https?:\/\//i.test(v as string) ? (v as string) : undefined));
    const assetId = first(value, ["assetId", "asset_id", "mediaAssetId", "media_asset_id"], text) ?? text(value["asset"]) ?? assetIdOf(object(value["asset"]));
    if (url || assetId) {
      const fileName = first(value, ["fileName", "file_name", "filename", "name"], text) ?? first(object(value["asset"]), ["fileName", "file_name", "filename"], text);
      const contentType = first(value, ["contentType", "content_type", "mimeType", "mime_type"], text);
      const file = { path, ...(url ? { url } : {}), ...(assetId ? { assetId } : {}), ...(fileName ? { fileName } : {}), ...(contentType ? { contentType } : {}) };
      found.push({ ...file, kind: kindOf(file) });
      return;
    }
    for (const [key, inner] of Object.entries(value)) visit(inner, path ? `${path}.${key}` : key, depth + 1);
  };
  visit(result, "", 0);
  return found;
}

// ── Cameras ─────────────────────────────────────────────────────────────────

const rows = (m: Mat4): number[][] => [0, 1, 2, 3].map((r) => m.slice(r * 4, r * 4 + 4));

/** A camera as a request carries it: pinhole intrinsics and a camera-to-world matrix, OpenGL's convention said aloud. */
export function wireCamera(camera: AtlasCamera): Json {
  return {
    width: camera.width,
    height: camera.height,
    intrinsics: { fx: camera.fx, fy: camera.fy, cx: camera.cx, cy: camera.cy },
    cameraToWorld: rows(camera.cameraToWorld),
    convention: "opengl",
  };
}

/** 16 numbers row by row, from a flat list or nested rows (4×4 or 3×4), or undefined. */
function matrix(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const flat = value.every((row) => Array.isArray(row)) ? (value as unknown[][]).flat() : value;
  if (!flat.every((entry) => typeof entry === "number" && Number.isFinite(entry))) return undefined;
  const numbers = flat as number[];
  if (numbers.length === 12) return [...numbers, 0, 0, 0, 1];
  if (numbers.length !== 16) return undefined;
  // A flat list written column by column keeps its move in its last four numbers.
  const columnMajor = !Array.isArray(value[0]) && numbers[3] === 0 && numbers[7] === 0 && numbers[11] === 0 && (numbers[12] !== 0 || numbers[13] !== 0 || numbers[14] !== 0);
  return columnMajor ? [0, 1, 2, 3].flatMap((r) => [0, 1, 2, 3].map((c) => numbers[c * 4 + r]!)) : numbers;
}

/**
 * A camera read out of an answer, or null when it is not understood. Used
 * only to place new cameras round a scene: the frames themselves go back to
 * the provider as they came.
 */
export function readCamera(value: unknown, size?: { width?: number; height?: number }): AtlasCamera | null {
  const raw = object(value);
  if (!raw) return null;
  const toWorld = first(raw, ["cameraToWorld", "camera_to_world", "c2w", "camToWorld", "cam_to_world", "pose", "transform"], matrix);
  const toCamera = toWorld ? undefined : first(raw, ["worldToCamera", "world_to_camera", "w2c", "extrinsics", "extrinsic"], matrix);
  let cameraToWorld = toWorld ?? (toCamera ? [...invertRigid(toCamera)] : undefined);
  if (!cameraToWorld) return null;
  const convention = first(raw, ["convention", "coordinateConvention", "coordinate_convention", "coordinates"], text)?.toLowerCase() ?? "";
  if (convention.includes("opencv") || convention.includes("rdf") || convention.includes("colmap")) cameraToWorld = [...flipYZ(cameraToWorld)];

  const inner = object(raw["intrinsics"]);
  const k = first(raw, ["K", "k", "intrinsicMatrix", "intrinsic_matrix", "intrinsics"], (v) => {
    if (!Array.isArray(v)) return undefined;
    const flat = (v.every((row) => Array.isArray(row)) ? (v as unknown[][]).flat() : v) as unknown[];
    return flat.length === 9 && flat.every((entry) => typeof entry === "number") ? (flat as number[]) : undefined;
  });
  const lens = (key: string, index: number) => first(inner, [key], number) ?? first(raw, [key], number) ?? k?.[index];
  const fx = lens("fx", 0), fy = lens("fy", 4), cx = lens("cx", 2), cy = lens("cy", 5);
  const width = first(raw, ["width", "imageWidth", "image_width"], number) ?? first(inner, ["width"], number) ?? size?.width ?? (cx !== undefined ? Math.round(cx * 2) : undefined);
  const height = first(raw, ["height", "imageHeight", "image_height"], number) ?? first(inner, ["height"], number) ?? size?.height ?? (cy !== undefined ? Math.round(cy * 2) : undefined);
  if (fx === undefined || fy === undefined || width === undefined || height === undefined) return null;
  return { width, height, fx, fy, cx: cx ?? width / 2, cy: cy ?? height / 2, cameraToWorld };
}

/** The camera of a posed frame, or null. */
export function frameCamera(frame: PosedFrame): AtlasCamera | null {
  const size = { width: first(frame, ["width"], number), height: first(frame, ["height"], number) };
  return readCamera(frame["camera"], size) ?? readCamera(frame, size);
}

// ── Task requests ───────────────────────────────────────────────────────────

type Extra = Readonly<Record<string, unknown>> | undefined;

export interface PoseImagesInput {
  /** Pictures of one place, uploaded. */
  readonly images: readonly (AtlasAsset | string)[];
  readonly extra?: Extra;
}

export function images2PosedRGBDBody(input: PoseImagesInput): Json {
  if (input.images.length === 0) throw new AtlasValidationError("posing needs at least one picture");
  return { images: input.images.map(wireAsset), ...input.extra };
}

export interface SplatsInput {
  /** Frames with their cameras and depth, in order, as posing returned them. */
  readonly posedFrames: readonly PosedFrame[];
  /** false: a draft, a tenth of the price. true: the refined splat. */
  readonly refine: boolean;
  readonly extra?: Extra;
}

export function posedImages2SplatsBody(input: SplatsInput): Json {
  if (input.posedFrames.length < 2) throw new AtlasValidationError("a splat needs at least two posed frames");
  return { posedFrames: input.posedFrames, refine: input.refine, ...input.extra };
}

/** How a mesh is coloured. The provider's own words for these are not known: `extra` overrides. */
export const MESH_TEXTURES = ["textured", "vertex-colors", "none"] as const;
export type MeshTexture = (typeof MESH_TEXTURES)[number];

export interface MeshInput {
  readonly splat: AtlasAsset | string;
  readonly texture?: MeshTexture;
  readonly targetFaces?: number;
  readonly extra?: Extra;
}

export function splats2MeshBody(input: MeshInput): Json {
  if (input.targetFaces !== undefined && (!Number.isInteger(input.targetFaces) || input.targetFaces < 100)) throw new AtlasValidationError("targetFaces is a whole number of at least 100");
  if (input.texture !== undefined && !MESH_TEXTURES.includes(input.texture)) throw new AtlasValidationError(`texture is one of ${MESH_TEXTURES.join(", ")}`);
  return {
    splat: wireAsset(input.splat),
    ...(input.texture !== undefined ? { textureMode: input.texture } : {}),
    ...(input.targetFaces !== undefined ? { targetFaces: input.targetFaces } : {}),
    ...input.extra,
  };
}

export interface GenerateInput {
  /** Posed frames the new views are held to. */
  readonly contextFrames: readonly PosedFrame[];
  /** The whole path, in order, in one request. */
  readonly targetCameras: readonly AtlasCamera[];
  readonly prompt?: string;
  readonly extra?: Extra;
}

export function atlasGenerateBody(input: GenerateInput): Json {
  if (input.targetCameras.length === 0) throw new AtlasValidationError("a render needs at least one target camera");
  return {
    contextFrames: input.contextFrames,
    targetCameras: input.targetCameras.map(wireCamera),
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...input.extra,
  };
}

export interface TextToImageInput {
  readonly prompt: string;
  readonly width?: number;
  readonly height?: number;
  readonly extra?: Extra;
}

export function atlasTextToImageBody(input: TextToImageInput): Json {
  if (!input.prompt.trim()) throw new AtlasValidationError("a picture from words needs words");
  return { prompt: input.prompt, ...(input.width !== undefined ? { width: input.width } : {}), ...(input.height !== undefined ? { height: input.height } : {}), ...input.extra };
}

export interface ChiselInput {
  readonly image: AtlasAsset | string;
  readonly prompt: string;
  readonly extra?: Extra;
}

export function atlasChiselBody(input: ChiselInput): Json {
  if (!input.prompt.trim()) throw new AtlasValidationError("an edit needs to say what to change");
  return { image: wireAsset(input.image), prompt: input.prompt, ...input.extra };
}

/** Where a task is told to call when it ends. Not used by the client's own wait. */
export const withWebhook = (body: Json, webhookUrl: string | undefined): Json => (webhookUrl ? { ...body, webhookUrl } : body);

/** A request for the server to hold the connection until the operation ends, or this long. */
export const waitBody = (timeoutSeconds: number): Json => ({ timeoutSeconds });

// ── Task results ────────────────────────────────────────────────────────────

function frames(response: Json | null, keys: readonly string[], what: string): PosedFrame[] {
  const list = first(response ?? undefined, keys, (v) => (Array.isArray(v) ? v : undefined));
  if (!list || list.length === 0 || !list.every(isObject)) throw new AtlasContractError(what, response);
  return list as PosedFrame[];
}

/** The frames of a posing, in the order the pictures were given. */
export const readPosedFrames = (response: Json | null): PosedFrame[] => frames(response, ["posedFrames", "posed_frames", "frames", "views", "posedImages", "posed_images"], "posed frames");

/** The frames of a render, in the order of the target cameras. */
export const readGeneratedFrames = (response: Json | null): PosedFrame[] => frames(response, ["frames", "generatedFrames", "generated_frames", "posedFrames", "posed_frames", "views", "images"], "generated frames");
