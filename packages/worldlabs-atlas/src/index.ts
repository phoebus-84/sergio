// ---------------------------------------------------------------------------
// @av/worldlabs-atlas
// ---------------------------------------------------------------------------

export { ATLAS_TASKS } from "./types.js";
export type {
  AtlasAsset, AtlasConfig, AtlasCost, AtlasOperation, AtlasTask, AtlasUpload, Clock, FetchBytes, HttpRequest, HttpResponse,
  OperationState, OutputFile, OutputKind, PosedFrame, Sleeper, TaskRun, Transport,
} from "./types.js";

export {
  AtlasCancelledError, AtlasContractError, AtlasError, AtlasHttpError, AtlasNetworkError, AtlasOperationError, AtlasTimeoutError,
  AtlasUnavailableError, AtlasValidationError,
} from "./errors.js";

export { API_KEY_ENV, BASE_URL_ENV, DEFAULT_BASE_URL, redactKey, requireConfig, resolveConfig } from "./config.js";
export { FetchTransport, fetchBytes } from "./transport.js";
export { ManualClock, NoopSleeper, SystemClock, SystemSleeper } from "./time.js";

export { AtlasClient, createAtlasClient, DEFAULT_MAX_WAIT_MS } from "./client.js";
export type { AtlasClientOptions, AtlasEvent, RunOptions, SubmitOptions, WaitOptions } from "./client.js";

export {
  API_PREFIX, AUTH_HEADER, MESH_TEXTURES, WIRE, atlasChiselBody, atlasGenerateBody, atlasTextToImageBody, collectFiles, frameCamera, images2PosedRGBDBody,
  kindOf, paths, posedImages2SplatsBody, readCamera, readGeneratedFrames, readOperation, readPosedFrames, splats2MeshBody, wireAsset, wireCamera,
} from "./wire.js";
export type { ChiselInput, GenerateInput, MeshInput, MeshTexture, PoseImagesInput, SplatsInput, TextToImageInput, UploadTicket } from "./wire.js";

export {
  ATLAS_TARGET_SIZES, cameraForward, cameraPosition, flipYZ, fovYDegrees, invertRigid, isTargetSize, lookAt, orbit, pinhole, placed, push, sceneFocus,
} from "./cameras.js";
export type { AtlasCamera, Mat4, OrbitPath, PushPath, Vec3 } from "./cameras.js";

export { CREDITS_PER_USD, PRICE_KEYS, PUBLISHED_CREDITS, chargedFor, creditsToUsd, describePrices, estimate, priceKeyOf } from "./pricing.js";
export type { AtlasEstimate, OperatorCredits, PriceKey } from "./pricing.js";

export { PROVIDER, provenanceOf, sha256, withoutSignatures } from "./provenance.js";
export type { AtlasProvenance } from "./provenance.js";

export { FAKE_HOST, FakeAtlas, fakeGlb } from "./fake-provider.js";
export type { FakeAtlasOptions } from "./fake-provider.js";
