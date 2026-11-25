// ---------------------------------------------------------------------------
// @av/worldlabs-atlas
// ---------------------------------------------------------------------------

export { ATLAS_TASKS } from "./types.js";
export type {
  AtlasAsset, AtlasConfig, AtlasOperation, AtlasTask, AtlasUpload, Clock, FetchBytes, HttpRequest, HttpResponse,
  OperationFailure, OperationState, OutputFile, OutputKind, Sleeper, TaskRun, Transport,
} from "./types.js";

export {
  AtlasCancelledError, AtlasContractError, AtlasError, AtlasHttpError, AtlasNetworkError, AtlasOperationError, AtlasTimeoutError,
  AtlasUnavailableError, AtlasValidationError,
} from "./errors.js";

export { API_KEY_ENV, BASE_URL_ENV, DEFAULT_BASE_URL, KEY_SCOPES, redactKey, requireConfig, resolveConfig } from "./config.js";
export { FetchTransport, fetchBytes } from "./transport.js";
export { ManualClock, NoopSleeper, SystemClock, SystemSleeper } from "./time.js";

export { AtlasClient, createAtlasClient, DEFAULT_MAX_WAIT_MS } from "./client.js";
export type { AtlasClientOptions, AtlasEvent, RunOptions, SubmitOptions, WaitOptions } from "./client.js";

export {
  AUTH_HEADER, IDEMPOTENCY_HEADER, MESH_CAMERAS, MESH_TEXTURES, SPLAT_FRAME_LIMITS, TEXT_TO_IMAGE_ASPECTS, WAIT_CAP_SECONDS, WIRE, atlasGenerateBody, atlasTextToImageBody,
  collectFiles, frameCamera, images2PosedRGBDBody, paths, posedFrame, posedImages2SplatsBody, readCamera, readGeneratedFrames, readMesh, readOperation, readPosedFrames,
  readSplat, splats2MeshBody, wireAsset, wireCamera,
} from "./wire.js";
export type {
  CoordinateSystem, DepthBuffer, GenerateInput, GeneratedFrame, Grid, MeshCameras, MeshInput, MeshTexture, PinholeCamera, PoseImagesInput, PosedFrame, PosedResult,
  SplatsInput, TaskAsset, TextToImageInput, UploadTicket,
} from "./wire.js";

export {
  ATLAS_TARGET_SIZES, cameraForward, cameraPosition, flipYZ, fovYDegrees, invertRigid, isTargetSize, lookAt, matrixOf, orbit, pinhole, placed, push, quaternionOf, sceneFocus,
} from "./cameras.js";
export type { AtlasCamera, Mat4, OrbitPath, PushPath, Vec3 } from "./cameras.js";

export { CREDITS_PER_USD, FAILED_RUNS_FREE, PRICE_KEYS, PUBLISHED_CREDITS, creditsToUsd, describePrices, estimate, priceKeyOf } from "./pricing.js";
export type { AtlasEstimate, OperatorCredits, PriceKey } from "./pricing.js";

export { PROVIDER, provenanceOf, sha256, withoutSignatures } from "./provenance.js";
export type { AtlasProvenance } from "./provenance.js";

export { FAKE_API_ROOT, FakeAtlas, fakeGlb } from "./fake-provider.js";
export type { FakeAtlasOptions } from "./fake-provider.js";
