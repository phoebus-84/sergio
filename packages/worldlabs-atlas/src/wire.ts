// ---------------------------------------------------------------------------
// The provider's JSON: every path, request body and answer, in one place
// ---------------------------------------------------------------------------
// Written from the Atlas Developer API documentation as it stood on
// 2026-11-25 (docs.atlas.worldlabs.ai: the task guides and the API
// reference, which the provider says is generated from the service's own
// schemas). NOT YET RUN AGAINST THE LIVE API: no call has been made. So the
// shapes here are the documented ones, and `verifiedLive` stays null until a
// real run has confirmed them.
//
// Two things the documentation is strict about shape this file:
//
// - request objects refuse fields they do not know (`additionalProperties:
//   false`, HTTP 422). A frame that posing returned carries more than a
//   splat's frame may (`centroidWorld`), so a frame is never passed on as it
//   came: `posedFrame` keeps exactly what the next task takes;
// - a task's result names each file by `assetId` and `url` together. The
//   url expires (24 hours), the id does not; the pair is accepted as input
//   and the id is what counts.
//
// One thing it is not consistent about: the task guide documents `refine`
// and `draftSplat` for posedImages2Splats, and the reference's schema lists
// neither. The guide is followed. If a draft is refused with a 422, that is
// where to look.
// ---------------------------------------------------------------------------

import { flipYZ, matrixOf, quaternionOf, type AtlasCamera, type Vec3 } from "./cameras.js";
import { AtlasContractError, AtlasValidationError } from "./errors.js";
import type { AtlasAsset, AtlasOperation, AtlasTask, OperationState, OutputFile, OutputKind } from "./types.js";

/** Which reading of the API this is, kept in every provenance record. */
export const WIRE = {
  api: "/api/v2",
  /** The documentation these shapes were written from. */
  documentation: "docs.atlas.worldlabs.ai, read 2026-11-25",
  /** When and on what these shapes last ran against the real service: never, so far. */
  verifiedLive: null as string | null,
} as const;

export const AUTH_HEADER = "WLT-Api-Key";
export const IDEMPOTENCY_HEADER = "Idempotency-Key";
/** The server holds a `:wait` for at most this long. */
export const WAIT_CAP_SECONDS = 30;

const seg = (id: string): string => encodeURIComponent(id);

/** Paths under the API root (`…/api/v2`). */
export const paths = {
  health: () => "/health",
  task: (task: AtlasTask) => `/tasks:${task}`,
  operations: () => "/operations",
  operation: (id: string) => `/operations/${seg(id)}`,
  wait: (id: string) => `/operations/${seg(id)}:wait`,
  cancel: (id: string) => `/operations/${seg(id)}:cancel`,
  trace: (id: string) => `/operations/${seg(id)}:trace`,
  assets: () => "/assets",
  asset: (id: string) => `/assets/${seg(id)}`,
  createUploadUrl: (id: string) => `/assets/${seg(id)}:createUploadUrl`,
  completeUpload: (id: string) => `/assets/${seg(id)}:completeUpload`,
  createReadUrl: (id: string) => `/assets/${seg(id)}:createReadUrl`,
};

// ── Shapes ──────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

/** Media named by asset id, by a public URL, or carried inline. On a result: `assetId` and an expiring `url` together. */
export interface TaskAsset {
  assetId?: string | null;
  url?: string | null;
  base64?: string | null;
}

export type CoordinateSystem = "rub" | "rdf";

/** A posed pinhole camera as Atlas writes it: camera-to-world, quaternion x y z w, intrinsics in pixels of its own grid. */
export interface PinholeCamera {
  extrinsics: { position: [number, number, number]; quaternion: [number, number, number, number]; coordinateSystem?: CoordinateSystem };
  intrinsics: { fx: number; fy: number; cx: number; cy: number; width: number; height: number };
}

/** A depth buffer aligned to a camera: a linear-depth EXR, or an inverted log-depth PNG with its range. */
export type DepthBuffer =
  | { depthAsset: TaskAsset; confidenceAsset?: TaskAsset | null }
  | { logDepthAsset: TaskAsset; zMin: number; zMax: number; confidenceAsset?: TaskAsset | null };

/** A frame a task takes: an image, the camera that saw it, the depth under it. Nothing else is accepted. */
export interface PosedFrame {
  imageAsset: TaskAsset;
  camera: PinholeCamera;
  depth: DepthBuffer;
  maskAsset?: TaskAsset | null;
}

/** A frame as posing returns it: a posed frame, and where its scene sits on the ground. */
export interface PosedResult extends PosedFrame {
  /** The middle of what the frame sees, in the world, dropped onto the ground (y 0). */
  centroidWorld?: [number, number, number];
}

/** A frame a render returns: depth only when it was asked for. */
export interface GeneratedFrame {
  imageAsset: TaskAsset;
  camera: PinholeCamera;
  depth?: DepthBuffer | null;
  maskAsset?: TaskAsset | null;
}

// ── Small readers ───────────────────────────────────────────────────────────

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
const number = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const numbers = (value: unknown, count: number): number[] | undefined =>
  Array.isArray(value) && value.length === count && value.every((entry) => typeof entry === "number" && Number.isFinite(entry)) ? (value as number[]) : undefined;

function taskAsset(value: unknown): TaskAsset | undefined {
  if (!isObject(value)) return undefined;
  const assetId = text(value["assetId"]), url = text(value["url"]), base64 = text(value["base64"]);
  if (!assetId && !url && !base64) return undefined;
  return { ...(assetId ? { assetId } : {}), ...(url ? { url } : {}), ...(base64 ? { base64 } : {}) };
}

// ── Operations ──────────────────────────────────────────────────────────────

/** google.rpc.Code 1: the operation was cancelled. Every other error is a failure. */
const RPC_CANCELLED = 1;

/**
 * An operation. `done` is the only terminal signal: done with an `error` it
 * failed, done without one it succeeded. What `metadata` says of phase or
 * progress is for showing, never for deciding.
 */
export function readOperation(answer: unknown): AtlasOperation {
  const raw = isObject(answer) ? answer : undefined;
  const id = text(raw?.["id"]);
  if (!raw || !id || typeof raw["done"] !== "boolean") throw new AtlasContractError("an operation", answer);
  const done = raw["done"];
  const metadata = isObject(raw["metadata"]) ? raw["metadata"] : {};
  const failure = isObject(raw["error"]) ? raw["error"] : undefined;

  let state: OperationState = "running";
  let error: AtlasOperation["error"] = null;
  if (done && failure) {
    const code = number(failure["code"]) ?? null;
    const details = Array.isArray(failure["details"]) ? failure["details"] : [];
    const reason = details.map((detail) => (isObject(detail) ? text(detail["reason"]) : undefined)).find(Boolean) ?? null;
    state = code === RPC_CANCELLED || reason === "CANCELLED" ? "cancelled" : "failed";
    error = { code, reason, message: text(failure["message"]) ?? (state === "cancelled" ? "cancelled" : "no reason given") };
  } else if (done) {
    state = "succeeded";
  }

  const share = number(metadata["progress"]) ?? number(metadata["progressPercent"]) ?? (isObject(metadata["progress"]) ? number(metadata["progress"]["percent"]) : undefined);
  return {
    id, done, state,
    task: text(metadata["task"]) ?? null,
    phase: text(metadata["phase"]) ?? text(metadata["state"]) ?? null,
    progress: share === undefined ? null : Math.min(1, Math.max(0, share > 1 ? share / 100 : share)),
    error,
    response: state === "succeeded" && isObject(raw["response"]) ? raw["response"] : null,
    createdAtSecs: number(raw["createdAtSecs"]) ?? null,
    expiresAtSecs: number(raw["expiresAtSecs"]) ?? null,
    raw,
  };
}

/** A page of operations, newest first. A listed operation has no `response`: get it by id. */
export function readOperationList(answer: unknown): { operations: AtlasOperation[]; nextPageToken: string | null } {
  const list = isObject(answer) && Array.isArray(answer["operations"]) ? answer["operations"] : undefined;
  if (!list) throw new AtlasContractError("a list of operations", answer);
  return { operations: list.map(readOperation), nextPageToken: text((answer as Json)["nextPageToken"]) ?? null };
}

/** How long the server may hold the connection: capped there at 30 seconds, and it may answer `done: false`. */
export const waitBody = (timeoutSeconds: number): Json => ({ timeoutSecs: Math.max(1, Math.min(WAIT_CAP_SECONDS, Math.round(timeoutSeconds))) });

/** A cancellation, with the id that makes a repeat of it the same request. At most 36 characters. */
export const cancelBody = (requestId: string, reason?: string): Json => ({ requestId: requestId.slice(0, 36), ...(reason ? { reason } : {}) });

// ── Assets ──────────────────────────────────────────────────────────────────

/** The record a file is then uploaded into. */
export const createAssetBody = (displayName: string): Json => ({ asset: { displayName } });

/** What will be sent to the upload URL: both must match the file exactly. */
export const createUploadUrlBody = (file: { contentType: string; bytes: number }): Json => ({ contentType: file.contentType, contentLength: file.bytes });

export interface UploadTicket {
  readonly uploadUrl: string;
  readonly method: string;
  /** Headers the upload itself must carry. */
  readonly headers: Record<string, string>;
}

export function readUploadTicket(answer: unknown): UploadTicket {
  const raw = isObject(answer) ? answer : undefined;
  const uploadUrl = text(raw?.["uploadUrl"]);
  if (!raw || !uploadUrl) throw new AtlasContractError("an upload URL", answer);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(isObject(raw["headers"]) ? raw["headers"] : {})) {
    if (typeof value === "string") headers[name] = value;
  }
  return { uploadUrl, method: (text(raw["method"]) ?? "PUT").toUpperCase(), headers };
}

export function readAsset(answer: unknown): AtlasAsset {
  const raw = isObject(answer) ? answer : undefined;
  const id = text(raw?.["id"]);
  if (!raw || !id) throw new AtlasContractError("an asset", answer);
  // Sizes come as strings, for JSON readers that lose large integers.
  const size = typeof raw["sizeBytes"] === "string" ? Number(raw["sizeBytes"]) : number(raw["sizeBytes"]);
  const state = text(raw["state"]), displayName = text(raw["displayName"]), mimeType = text(raw["mimeType"]);
  const width = number(raw["width"]), height = number(raw["height"]);
  return {
    id,
    ...(state ? { state } : {}), ...(displayName ? { fileName: displayName } : {}), ...(mimeType ? { contentType: mimeType } : {}),
    ...(size !== undefined && Number.isFinite(size) ? { bytes: size } : {}), ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}),
  };
}

/** A download URL for one asset. It lasts 15 minutes and is a secret while it does. */
export function readReadUrl(answer: unknown): string {
  const url = isObject(answer) ? text(answer["readUrl"]) : undefined;
  if (!url || !/^https?:\/\//i.test(url)) throw new AtlasContractError("a read URL", answer);
  return url;
}

/** How a request names a file the project already holds. */
export const wireAsset = (asset: AtlasAsset | TaskAsset | string): TaskAsset => {
  if (typeof asset === "string") return { assetId: asset };
  const id = "id" in asset ? asset.id : asset.assetId;
  // An id is sent alone: with it, a url is ignored, and without it, a url is fetched and stored again as a new asset.
  return id ? { assetId: id } : { ...(asset as TaskAsset) };
};

// ── Cameras ─────────────────────────────────────────────────────────────────

/** A camera as a request carries it. */
export function wireCamera(camera: AtlasCamera): PinholeCamera {
  const m = camera.cameraToWorld;
  return {
    extrinsics: { position: [m[3]!, m[7]!, m[11]!], quaternion: quaternionOf(m), coordinateSystem: "rub" },
    intrinsics: { fx: camera.fx, fy: camera.fy, cx: camera.cx, cy: camera.cy, width: camera.width, height: camera.height },
  };
}

/** A camera read out of an answer, in this package's own convention ("rub"), or null when it is not one. */
export function readCamera(value: unknown): AtlasCamera | null {
  if (!isObject(value) || !isObject(value["extrinsics"]) || !isObject(value["intrinsics"])) return null;
  const extrinsics = value["extrinsics"], intrinsics = value["intrinsics"];
  const position = numbers(extrinsics["position"], 3), quaternion = numbers(extrinsics["quaternion"], 4);
  const [fx, fy, cx, cy, width, height] = ["fx", "fy", "cx", "cy", "width", "height"].map((key) => number(intrinsics[key]));
  if (!position || !quaternion || fx === undefined || fy === undefined || cx === undefined || cy === undefined || width === undefined || height === undefined) return null;
  // Both spellings are accepted by the service; "rub" when it says nothing.
  const system = text(extrinsics["coordinateSystem"]) ?? text(extrinsics["coordinate_system"]) ?? "rub";
  let cameraToWorld = matrixOf(position as unknown as Vec3, quaternion as [number, number, number, number]);
  if (system === "rdf") cameraToWorld = flipYZ(cameraToWorld);
  else if (system !== "rub") return null;
  return { width, height, fx, fy, cx, cy, cameraToWorld: [...cameraToWorld] };
}

/** The camera of a frame, or null. */
export const frameCamera = (frame: { camera?: unknown }): AtlasCamera | null => readCamera(frame.camera);

// ── Frames ──────────────────────────────────────────────────────────────────

function depthBuffer(value: unknown): DepthBuffer | undefined {
  if (!isObject(value)) return undefined;
  const confidence = taskAsset(value["confidenceAsset"]);
  const linear = taskAsset(value["depthAsset"]);
  if (linear) return { depthAsset: wireAsset(linear), ...(confidence ? { confidenceAsset: wireAsset(confidence) } : {}) };
  const log = taskAsset(value["logDepthAsset"]);
  const zMin = number(value["zMin"]), zMax = number(value["zMax"]);
  if (log && zMin !== undefined && zMax !== undefined) return { logDepthAsset: wireAsset(log), zMin, zMax, ...(confidence ? { confidenceAsset: wireAsset(confidence) } : {}) };
  return undefined;
}

/**
 * A frame as the next task takes it: its image, its camera and its depth,
 * each asset by its id, and nothing more. Null when the frame has no depth.
 */
export function posedFrame(frame: { imageAsset?: unknown; camera?: unknown; depth?: unknown; maskAsset?: unknown }): PosedFrame | null {
  const imageAsset = taskAsset(frame.imageAsset);
  const depth = depthBuffer(frame.depth);
  if (!imageAsset || !isObject(frame.camera) || !frameCamera(frame) || !depth) return null;
  const mask = taskAsset(frame.maskAsset);
  const { extrinsics, intrinsics } = frame.camera as unknown as PinholeCamera;
  return {
    imageAsset: wireAsset(imageAsset),
    camera: {
      extrinsics: { position: extrinsics.position, quaternion: extrinsics.quaternion, coordinateSystem: extrinsics.coordinateSystem ?? "rub" },
      intrinsics: { fx: intrinsics.fx, fy: intrinsics.fy, cx: intrinsics.cx, cy: intrinsics.cy, width: intrinsics.width, height: intrinsics.height },
    },
    depth,
    ...(mask ? { maskAsset: wireAsset(mask) } : {}),
  };
}

function frames<T>(response: Json | null, what: string): T[] {
  const list = response?.["frames"];
  if (!Array.isArray(list) || list.length === 0 || !list.every((frame) => isObject(frame) && taskAsset(frame["imageAsset"]) && frameCamera(frame))) throw new AtlasContractError(what, response);
  return list as T[];
}

/** The frames of a posing, one per picture, in the order the pictures were given. */
export const readPosedFrames = (response: Json | null): PosedResult[] => frames<PosedResult>(response, "posed frames");

/** The frames of a render, one per target camera, in their order. */
export const readGeneratedFrames = (response: Json | null): GeneratedFrame[] => frames<GeneratedFrame>(response, "generated frames");

/**
 * The splat of a reconstruction: the draft when a draft was asked for, else
 * the refined one with the most splats.
 */
export function readSplat(response: Json | null): { asset: TaskAsset; quality: "draft" | "refined"; splats: number | null } {
  const draft = taskAsset(response?.["draftSplat"]);
  if (draft) return { asset: draft, quality: "draft", splats: null };
  const refined = isObject(response?.["refinedSplats"]) ? response!["refinedSplats"] as Json : {};
  const best = Object.entries(refined)
    .map(([count, asset]) => ({ count: Number(count), asset: taskAsset(asset) }))
    .filter((entry): entry is { count: number; asset: TaskAsset } => entry.asset !== undefined)
    .sort((a, b) => (Number.isFinite(b.count) ? b.count : 0) - (Number.isFinite(a.count) ? a.count : 0))[0];
  if (!best) throw new AtlasContractError("a splat", response);
  return { asset: best.asset, quality: "refined", splats: Number.isFinite(best.count) ? best.count : null };
}

/** The mesh of a conversion, and its collider boxes when they were asked for. */
export function readMesh(response: Json | null): { mesh: TaskAsset; colliderBoxes: TaskAsset | null } {
  const mesh = taskAsset(response?.["mesh"]);
  if (!mesh) throw new AtlasContractError("a mesh", response);
  return { mesh, colliderBoxes: taskAsset(response?.["colliderBoxes"]) ?? null };
}

// ── The files of a result, wherever they are ────────────────────────────────

const KEY_KINDS: Readonly<Record<string, OutputKind>> = {
  imageAsset: "image", depthAsset: "depth", logDepthAsset: "depth", confidenceAsset: "confidence", maskAsset: "mask",
  draftSplat: "splat", splatAsset: "splat", mesh: "mesh", colliderBoxes: "collider",
};

/** Every file a result names, with what it is by the place it holds: `frames[2].depth.depthAsset` is a depth map. */
export function collectFiles(result: unknown): OutputFile[] {
  const found: OutputFile[] = [];
  const visit = (value: unknown, path: string, key: string, parent: string, depth: number): void => {
    if (depth > 10 || found.length >= 8192) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`, key, parent, depth + 1));
      return;
    }
    if (!isObject(value)) return;
    const asset = taskAsset(value);
    if (asset && (asset.assetId || asset.url) && Object.keys(value).every((name) => name === "assetId" || name === "url" || name === "base64")) {
      found.push({ path, kind: KEY_KINDS[key] ?? (parent === "refinedSplats" ? "splat" : "other"), ...(asset.assetId ? { assetId: asset.assetId } : {}), ...(asset.url ? { url: asset.url } : {}) });
      return;
    }
    for (const [name, inner] of Object.entries(value)) visit(inner, path ? `${path}.${name}` : name, name, key, depth + 1);
  };
  visit(result, "", "", "", 0);
  return found;
}

// ── Task requests ───────────────────────────────────────────────────────────

type Extra = Readonly<Record<string, unknown>> | undefined;

/** The four grids depth is served on, and views are rendered at: width, height. */
export type Grid = readonly [number, number];

export interface PoseImagesInput {
  /** 1 to 64 pictures of one place, in a stable order: assets of the project. */
  readonly images: readonly (AtlasAsset | TaskAsset | string)[];
  /** Put image, depth and camera on this one grid. Needed when one picture, or pictures taken from one spot, are to feed a splat. */
  readonly targetResolution?: Grid;
  /** Bundle-adjust the estimated cameras: for two or more pictures that a later stage compares with each other. */
  readonly refinePoses?: boolean;
  readonly extra?: Extra;
}

export function images2PosedRGBDBody(input: PoseImagesInput): Json {
  if (input.images.length < 1 || input.images.length > 64) throw new AtlasValidationError("posing takes 1 to 64 pictures");
  return {
    frames: input.images.map((image) => ({ imageAsset: wireAsset(image) })),
    ...(input.targetResolution ? { targetResolution: [...input.targetResolution] } : {}),
    ...(input.refinePoses !== undefined ? { refinePoses: input.refinePoses } : {}),
    ...input.extra,
  };
}

export interface SplatsInput {
  /** Frames with their cameras and depth, in order, all on one of the four grids. */
  readonly posedFrames: readonly PosedFrame[];
  /** false: a draft, a tenth of the price, 2 to 32 frames. true: the refined splat, 2 to 512. */
  readonly refine: boolean;
  readonly prompt?: string;
  readonly enhancePrompt?: boolean;
  readonly extra?: Extra;
}

export const SPLAT_FRAME_LIMITS = { draft: [2, 32], refined: [2, 512] } as const;

export function posedImages2SplatsBody(input: SplatsInput): Json {
  const [least, most] = SPLAT_FRAME_LIMITS[input.refine ? "refined" : "draft"];
  if (input.posedFrames.length < least || input.posedFrames.length > most) {
    throw new AtlasValidationError(`a ${input.refine ? "refined" : "draft"} splat takes ${least} to ${most} posed frames, not ${input.posedFrames.length}`);
  }
  const grids = new Set(input.posedFrames.map((frame) => `${frame.camera.intrinsics.width}x${frame.camera.intrinsics.height}`));
  if (grids.size > 1) throw new AtlasValidationError(`every frame of a splat is on one grid, and these are on ${[...grids].join(", ")}`);
  return {
    posedFrames: input.posedFrames,
    // The default there is true: a draft has to be asked for.
    refine: input.refine,
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.enhancePrompt !== undefined ? { enhancePrompt: input.enhancePrompt } : {}),
    ...input.extra,
  };
}

/** How a mesh is coloured: rendered views on a UV atlas, a colour per vertex, or nothing. */
export const MESH_TEXTURES = ["image_texture", "vertex_color", "none"] as const;
export type MeshTexture = (typeof MESH_TEXTURES)[number];
/** Where the splats are rendered from to find the surface: inside the scene's free space, or from outside an object. */
export const MESH_CAMERAS = ["auto_anchors", "exterior_sphere"] as const;
export type MeshCameras = (typeof MESH_CAMERAS)[number];

export interface MeshInput {
  readonly splat: AtlasAsset | TaskAsset | string;
  readonly texture?: MeshTexture;
  /** The texture atlas's side in pixels, 1 to 8192. Default there: 4096. */
  readonly textureSize?: number;
  /** Decimate to at most this many faces. */
  readonly targetFaces?: number;
  readonly cameras?: MeshCameras;
  readonly extra?: Extra;
}

export function splats2MeshBody(input: MeshInput): Json {
  if (input.targetFaces !== undefined && (!Number.isInteger(input.targetFaces) || input.targetFaces < 1)) throw new AtlasValidationError("targetFaces is a whole number of faces");
  if (input.textureSize !== undefined && (!Number.isInteger(input.textureSize) || input.textureSize < 1 || input.textureSize > 8192)) throw new AtlasValidationError("textureSize is from 1 to 8192");
  if (input.texture !== undefined && !MESH_TEXTURES.includes(input.texture)) throw new AtlasValidationError(`texture is one of ${MESH_TEXTURES.join(", ")}`);
  if (input.cameras !== undefined && !MESH_CAMERAS.includes(input.cameras)) throw new AtlasValidationError(`cameras is one of ${MESH_CAMERAS.join(", ")}`);
  return {
    splatAsset: wireAsset(input.splat),
    ...(input.texture !== undefined ? { textureMode: input.texture } : {}),
    ...(input.textureSize !== undefined ? { textureSize: input.textureSize } : {}),
    ...(input.targetFaces !== undefined ? { targetFaces: input.targetFaces } : {}),
    ...(input.cameras !== undefined ? { cameras: { strategy: input.cameras } } : {}),
    ...input.extra,
  };
}

export interface GenerateInput {
  /** Posed frames with depth the new views are held to: all of one size. */
  readonly contextFrames: readonly PosedFrame[];
  /** The whole path, in order, in one request: all of one of the four sizes. */
  readonly targetCameras: readonly AtlasCamera[];
  /** What the scene is and looks like. Not an edit, and not a camera move. */
  readonly prompt?: string;
  /** false with a prepared prompt (a former `promptUsed`) skips a captioning pass. */
  readonly enhancePrompt?: boolean;
  /** Give each view its depth, so it can be context, or a splat's frame. Cameras must then not all stand in one spot. */
  readonly returnDepth?: boolean;
  readonly seed?: number;
  readonly extra?: Extra;
}

export function atlasGenerateBody(input: GenerateInput): Json {
  if (input.contextFrames.length === 0) throw new AtlasValidationError("a render needs at least one posed frame with depth as context");
  if (input.targetCameras.length === 0) throw new AtlasValidationError("a render needs at least one target camera");
  const sizes = new Set(input.targetCameras.map((camera) => `${camera.width}x${camera.height}`));
  if (sizes.size > 1) throw new AtlasValidationError(`every target camera of a render has one size, and these have ${[...sizes].join(", ")}`);
  return {
    contextFrames: input.contextFrames,
    targetCameras: input.targetCameras.map(wireCamera),
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.enhancePrompt !== undefined ? { enhancePrompt: input.enhancePrompt } : {}),
    ...(input.returnDepth !== undefined ? { returnDepth: input.returnDepth } : {}),
    ...(input.seed !== undefined ? { modelParameters: { seed: input.seed } } : {}),
    ...input.extra,
  };
}

export const TEXT_TO_IMAGE_ASPECTS = ["16:9", "9:16", "4:3", "3:4", "1:1"] as const;

export interface TextToImageInput {
  readonly prompt: string;
  readonly aspectRatio?: (typeof TEXT_TO_IMAGE_ASPECTS)[number];
  readonly enhancePrompt?: boolean;
  readonly seed?: number;
  readonly numSamples?: number;
  /** Also estimate each picture's camera and depth, so it can be context at once. */
  readonly returnDepth?: boolean;
  readonly extra?: Extra;
}

export function atlasTextToImageBody(input: TextToImageInput): Json {
  if (!input.prompt.trim()) throw new AtlasValidationError("a picture from words needs words");
  return {
    prompt: input.prompt,
    ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
    ...(input.enhancePrompt !== undefined ? { enhancePrompt: input.enhancePrompt } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    ...(input.numSamples !== undefined ? { numSamples: input.numSamples } : {}),
    ...(input.returnDepth !== undefined ? { returnDepth: input.returnDepth } : {}),
    ...input.extra,
  };
}
