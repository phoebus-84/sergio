/**
 * Canonical capability and artifact-kind vocabulary.
 *
 * Single source of truth — keep identical to the enum values in
 * schemas/v1alpha1/vocabulary.schema.json. The check-vocabulary script
 * asserts they match exactly.
 */

export const CAPABILITIES = Object.freeze([
  "image.generate",
  "image.edit",
  "speech.synthesize",
  // Word timing from audio and the text it says (avg-8hs.2): forced alignment.
  "speech.align",
  "graphics.render",
  // Motion graphics rendered frame-accurately, as distinct from a still
  // graphic: a different provider, different outputs, and a stage should be
  // able to ask for one without getting the other.
  "graphics.animate",
  // Editable 3D sources and rendering existing scenes are separate contracts.
  "scene.create",
  "scene.render",
  "terminal.record",
  // Generating new footage from a prompt and references, as opposed to
  // composing existing footage into a timeline.
  "video.generate",
  // A 3D model made from a picture or from words: a mesh with no skeleton.
  // Giving it one, and making it move, are other capabilities (ADR-0052).
  "model.generate",
  // A skeleton and skin weights for a 3D model, so it can be posed; it may
  // come with stock clips. Motion made for it is another capability.
  "rig.create",
  // A motion for a rig, made from words: what a body does, not the body.
  // Carrying a clip from one skeleton to another is local and is no capability.
  "motion.generate",
  "video.compose",
  "media.probe",
]);

export const ARTIFACT_KINDS = Object.freeze([
  "markdown",
  "json",
  "yaml",
  "audio",
  "video",
  "image",
  "captions",
  "tape",
  "directory",
]);

/** Check whether `name` is a known capability. */
export function isCapability(name) {
  return CAPABILITIES.includes(name);
}

/** Check whether `kind` is a known artifact kind. */
export function isArtifactKind(kind) {
  return ARTIFACT_KINDS.includes(kind);
}
