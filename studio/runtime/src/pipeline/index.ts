// ---------------------------------------------------------------------------
// Pipeline module — public API
// ---------------------------------------------------------------------------

export {
  resolvePipeline,
  PipelineResolutionError,
} from "./resolver.js";
export type { ResolveOptions } from "./resolver.js";

export { InMemoryPipelineLoader } from "./fixture-loader.js";
export { FileSystemPipelineLoader, createDefaultLoader } from "./fs-loader.js";
export { declaredPipeline, defaultPipeline, pipelineOf, PipelineDeclarationError, DEFAULT_EPISODE_PIPELINE, DEFAULT_FILM_PIPELINES } from "./declared.js";
export type { DeclaredPipeline } from "./declared.js";

export { InMemorySnapshotStore } from "./fixture-store.js";

export {
  createSnapshot,
  computeSnapshotHash,
  validateSnapshot,
  isSnapshotMutable,
  SnapshotError,
} from "./snapshot.js";
export type {
  SourceSnapshotRef,
  ProviderBinding,
  PipelineSnapshot,
  SnapshotInput,
  SnapshotStore,
} from "./snapshot.js";

export type {
  CapabilityRequest,
  ArtifactRef,
  StageDefinition,
  StageGates,
  SkillRef,
  PipelineExtends,
  PipelineDefinition,
  ResolvedStage,
  ResolutionDiagSeverity,
  ResolutionDiag,
  ResolvedPipeline,
  PipelineLoader,
} from "./types.js";
