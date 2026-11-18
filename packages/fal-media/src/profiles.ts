// ─── Versioned endpoint profiles ──────────────────────────────────────
// Each profile is pure data – no pipeline behavior is hardcoded here.
// The profile defines what parameters are accepted, what capabilities
// the endpoint has, and how it is priced.  Unknown parameters fail
// validation before any HTTP request (spend) is made.

import { createHash } from "node:crypto";
import type {
  EndpointProfile,
  ParameterField,
  EndpointCapabilities,
  PricingMetadata,
  DeprecationInfo,
  ProfileOperation,
} from "./types.js";
import { FalValidationError } from "./errors.js";

// ─── Profile registry ─────────────────────────────────────────────────

/** Look up a profile by its stable id. Returns undefined if not found. */
export function getProfile(
  profileId: string,
): EndpointProfile | undefined {
  return PROFILE_MAP.get(profileId);
}

/** Return all registered profiles. */
export function listProfiles(): readonly EndpointProfile[] {
  return PROFILES;
}

// ─── Schema fingerprinting ────────────────────────────────────────────

/**
 * Compute an immutable fingerprint for a parameter schema.
 * The fingerprint is a SHA-256 hex digest of the canonical JSON
 * representation with sorted keys, so it is stable across runs.
 */
export function computeSchemaFingerprint(
  schema: readonly ParameterField[],
): string {
  const canonical = schema.map((f) => ({
    name: f.name,
    type: f.type,
    required: f.required,
    defaultValue: f.defaultValue ?? null,
    enumValues: f.enumValues ?? null,
    min: f.min ?? null,
    max: f.max ?? null,
  }));
  // Sort by name for deterministic output
  canonical.sort((a, b) => a.name.localeCompare(b.name));
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

// ─── Parameter validation ─────────────────────────────────────────────

/** Result of validating parameters against a profile. */
export interface ValidationResult {
  /** Normalised parameter map (defaults applied). */
  readonly params: Record<string, unknown>;
  /** List of diagnostic messages (empty on success). */
  readonly errors: readonly string[];
}

/**
 * Validate user-supplied parameters against a profile's parameter schema.
 * Unknown parameters are rejected.  Missing required parameters are flagged.
 * Type/constraint violations are diagnosed individually.
 *
 * This runs **before** any HTTP request – no spend occurs on invalid input.
 */
export function validateParameters(
  profile: EndpointProfile,
  rawParams: Record<string, unknown>,
): ValidationResult {
  const schemaByName = new Map<string, ParameterField>();
  for (const field of profile.parameterSchema) {
    schemaByName.set(field.name, field);
  }

  const errors: string[] = [];
  const params: Record<string, unknown> = {};

  // Check for unknown parameters
  for (const key of Object.keys(rawParams)) {
    if (!schemaByName.has(key)) {
      errors.push(
        `Unknown parameter "${key}" is not accepted by profile "${profile.profileId}". ` +
          `Accepted parameters: ${profile.parameterSchema.map((f) => f.name).join(", ")}`,
      );
    }
  }

  // If there are unknown parameters, stop here – no point validating further
  if (errors.length > 0) {
    return { params: {}, errors };
  }

  // Validate each defined field
  for (const field of profile.parameterSchema) {
    const raw = rawParams[field.name];

    if (raw === undefined || raw === null) {
      if (field.required) {
        errors.push(
          `Required parameter "${field.name}" is missing.`,
        );
      } else if (field.defaultValue !== undefined) {
        params[field.name] = field.defaultValue;
      }
      continue;
    }

    const validated = validateField(field, raw);
    if (validated.error) {
      errors.push(validated.error);
    } else {
      params[field.name] = validated.value;
    }
  }

  return { params, errors };
}

function validateField(
  field: ParameterField,
  raw: unknown,
): { error?: string; value?: unknown } {
  switch (field.type) {
    case "string":
      if (typeof raw !== "string") {
        return {
          error: `Parameter "${field.name}" must be a string, got ${typeof raw}.`,
        };
      }
      return { value: raw };

    case "number":
      if (typeof raw !== "number" || Number.isNaN(raw)) {
        return {
          error: `Parameter "${field.name}" must be a number, got ${typeof raw}.`,
        };
      }
      if (field.min !== undefined && raw < field.min) {
        return {
          error: `Parameter "${field.name}" must be >= ${field.min}, got ${raw}.`,
        };
      }
      if (field.max !== undefined && raw > field.max) {
        return {
          error: `Parameter "${field.name}" must be <= ${field.max}, got ${raw}.`,
        };
      }
      return { value: raw };

    case "integer":
      if (typeof raw !== "number" || !Number.isInteger(raw)) {
        return {
          error: `Parameter "${field.name}" must be an integer, got ${typeof raw === "number" ? String(raw) : typeof raw}.`,
        };
      }
      if (field.min !== undefined && raw < field.min) {
        return {
          error: `Parameter "${field.name}" must be >= ${field.min}, got ${raw}.`,
        };
      }
      if (field.max !== undefined && raw > field.max) {
        return {
          error: `Parameter "${field.name}" must be <= ${field.max}, got ${raw}.`,
        };
      }
      return { value: raw };

    case "boolean":
      if (typeof raw !== "boolean") {
        return {
          error: `Parameter "${field.name}" must be a boolean, got ${typeof raw}.`,
        };
      }
      return { value: raw };

    case "enum":
      if (typeof raw !== "string") {
        return {
          error: `Parameter "${field.name}" must be a string (enum), got ${typeof raw}.`,
        };
      }
      if (field.enumValues && !field.enumValues.includes(raw)) {
        return {
          error: `Parameter "${field.name}" value "${raw}" is not allowed. ` +
            `Allowed values: ${field.enumValues.join(", ")}.`,
        };
      }
      return { value: raw };

    case "array":
      // Reference URL lists. The count limit matters before a request is made:
      // exceeding it is a paid failure, and the provider's own message would
      // arrive after the spend.
      if (!Array.isArray(raw)) {
        return {
          error: `Parameter "${field.name}" must be an array, got ${typeof raw}.`,
        };
      }
      if (raw.some((item) => typeof item !== "string")) {
        return {
          error: `Parameter "${field.name}" must contain only strings (URLs).`,
        };
      }
      if (field.max !== undefined && raw.length > field.max) {
        return {
          error: `Parameter "${field.name}" accepts at most ${field.max} item(s), got ${raw.length}.`,
        };
      }
      return { value: raw };

    default:
      return {
        error: `Internal: unknown field type "${field.type}" for "${field.name}".`,
      };
  }
}

/**
 * Validate and throw a typed error on failure.
 * Returns the normalised parameter map on success.
 */
export function requireValidParameters(
  profile: EndpointProfile,
  rawParams: Record<string, unknown>,
): Record<string, unknown> {
  const result = validateParameters(profile, rawParams);
  if (result.errors.length > 0) {
    throw new FalValidationError(
      `Parameter validation failed for profile "${profile.profileId}"`,
      { errors: result.errors, profileId: profile.profileId },
    );
  }
  return result.params;
}

// ─── Deprecation diagnostics ──────────────────────────────────────────

/**
 * Check whether a profile is deprecated and return a human-readable
 * diagnostic message.  Returns `null` if the profile is current.
 */
export function deprecationDiagnostic(
  profile: EndpointProfile,
): string | null {
  if (!profile.deprecation) return null;

  let msg = `Profile "${profile.profileId}" is deprecated: ${profile.deprecation.message}`;
  if (profile.deprecation.migrationTarget) {
    msg += ` Migrate to "${profile.deprecation.migrationTarget}".`;
  }
  if (profile.deprecation.sunsetDate) {
    msg += ` Sunset date: ${profile.deprecation.sunsetDate}.`;
  }
  return msg;
}

// ─── Helper builders ──────────────────────────────────────────────────

function defineProfile(opts: {
  profileId: string;
  endpointId: string;
  operation: ProfileOperation;
  contractVersion: string;
  parameterSchema: ParameterField[];
  capabilities: EndpointCapabilities;
  pricing: PricingMetadata;
  deprecation?: DeprecationInfo;
}): EndpointProfile {
  // Freeze schema so it is truly immutable
  const frozenSchema: readonly ParameterField[] = Object.freeze(
    opts.parameterSchema.map((f) => Object.freeze({ ...f })),
  );

  return Object.freeze({
    profileId: opts.profileId,
    endpointId: opts.endpointId,
    operation: opts.operation,
    contractVersion: opts.contractVersion,
    schemaFingerprint: computeSchemaFingerprint(frozenSchema),
    parameterSchema: frozenSchema,
    capabilities: Object.freeze({ ...opts.capabilities }),
    pricing: Object.freeze({ ...opts.pricing }),
    deprecation: opts.deprecation
      ? Object.freeze({ ...opts.deprecation })
      : null,
  });
}

// ─── Predefined profiles ──────────────────────────────────────────────

/** FLUX.1 [dev] – text-to-image generation. */
export const fluxDevV1: EndpointProfile = defineProfile({
  profileId: "fal-ai/flux/dev@v1",
  endpointId: "fal-ai/flux/dev",
  operation: "text-to-image",
  contractVersion: "v1",
  parameterSchema: [
    {
      name: "prompt",
      type: "string",
      required: true,
      description: "Text prompt describing the desired image.",
    },
    {
      name: "image_size",
      type: "enum",
      required: false,
      defaultValue: "landscape_4_3",
      enumValues: [
        "square_hd",
        "square",
        "portrait_4_3",
        "portrait_16_9",
        "landscape_4_3",
        "landscape_16_9",
      ],
      description: "Output image dimensions.",
    },
    {
      name: "num_images",
      type: "integer",
      required: false,
      defaultValue: 1,
      min: 1,
      max: 4,
      description: "Number of images to generate.",
    },
    {
      name: "seed",
      type: "integer",
      required: false,
      min: 0,
      description: "Deterministic seed for reproducible outputs.",
    },
    {
      name: "guidance_scale",
      type: "number",
      required: false,
      defaultValue: 3.5,
      min: 0,
      max: 20,
      description: "Classifier-free guidance scale.",
    },
    {
      name: "num_inference_steps",
      type: "integer",
      required: false,
      defaultValue: 28,
      min: 1,
      max: 50,
      description: "Number of denoising steps.",
    },
    {
      name: "negative_prompt",
      type: "string",
      required: false,
      description: "Text prompt describing what to avoid.",
    },
    {
      name: "enable_safety_checker",
      type: "boolean",
      required: false,
      defaultValue: true,
      description: "Whether to run the safety checker on outputs.",
    },
  ],
  capabilities: {
    supportedAspectRatios: [
      "square_hd",
      "square",
      "portrait_4_3",
      "portrait_16_9",
      "landscape_4_3",
      "landscape_16_9",
    ],
    supportsSeed: true,
    supportsReferenceImages: false,
    maxReferenceImages: 0,
    supportsNegativePrompt: true,
    defaultImageSize: "landscape_4_3",
  },
  pricing: {
    unit: "inference",
    estimatedUnitCost: 0.005,
    currency: "USD",
  },
});

/** FLUX.1 [fill] – inpainting / image editing. */
export const fluxFillV1: EndpointProfile = defineProfile({
  profileId: "fal-ai/flux/fill@v1",
  endpointId: "fal-ai/flux/fill",
  operation: "image-edit",
  contractVersion: "v1",
  parameterSchema: [
    {
      name: "prompt",
      type: "string",
      required: true,
      description: "Text prompt describing the desired edit.",
    },
    {
      name: "image_url",
      type: "string",
      required: true,
      description: "URL of the source image to edit.",
    },
    {
      name: "mask_url",
      type: "string",
      required: true,
      description: "URL of the mask image (white = editable area).",
    },
    {
      name: "image_size",
      type: "enum",
      required: false,
      defaultValue: "landscape_4_3",
      enumValues: [
        "square_hd",
        "square",
        "portrait_4_3",
        "portrait_16_9",
        "landscape_4_3",
        "landscape_16_9",
      ],
      description: "Output image dimensions.",
    },
    {
      name: "num_images",
      type: "integer",
      required: false,
      defaultValue: 1,
      min: 1,
      max: 4,
      description: "Number of edited variants to produce.",
    },
    {
      name: "seed",
      type: "integer",
      required: false,
      min: 0,
      description: "Deterministic seed for reproducible edits.",
    },
    {
      name: "guidance_scale",
      type: "number",
      required: false,
      defaultValue: 3.5,
      min: 0,
      max: 20,
      description: "Classifier-free guidance scale.",
    },
    {
      name: "num_inference_steps",
      type: "integer",
      required: false,
      defaultValue: 28,
      min: 1,
      max: 50,
      description: "Number of denoising steps.",
    },
    {
      name: "negative_prompt",
      type: "string",
      required: false,
      description: "Text prompt describing what to avoid.",
    },
    {
      name: "strength",
      type: "number",
      required: false,
      defaultValue: 0.85,
      min: 0,
      max: 1,
      description: "How strongly the edit is applied (0 = original, 1 = full regeneration).",
    },
  ],
  capabilities: {
    supportedAspectRatios: [
      "square_hd",
      "square",
      "portrait_4_3",
      "portrait_16_9",
      "landscape_4_3",
      "landscape_16_9",
    ],
    supportsSeed: true,
    supportsReferenceImages: true,
    maxReferenceImages: 2,
    supportsNegativePrompt: true,
    defaultImageSize: "landscape_4_3",
  },
  pricing: {
    unit: "inference",
    estimatedUnitCost: 0.006,
    currency: "USD",
  },
});

/**
 * Example deprecated profile for testing deprecation diagnostics.
 * This profile is known-deprecated and should trigger clear diagnostics.
 */
export const deprecationExample: EndpointProfile = defineProfile({
  profileId: "fal-ai/legacy/model@v1",
  endpointId: "fal-ai/legacy/model",
  operation: "text-to-image",
  contractVersion: "v1",
  parameterSchema: [
    {
      name: "prompt",
      type: "string",
      required: true,
      description: "Text prompt.",
    },
    {
      name: "image_size",
      type: "enum",
      required: false,
      defaultValue: "square",
      enumValues: ["square", "landscape", "portrait"],
      description: "Output size.",
    },
  ],
  capabilities: {
    supportedAspectRatios: ["square", "landscape", "portrait"],
    supportsSeed: false,
    supportsReferenceImages: false,
    maxReferenceImages: 0,
    supportsNegativePrompt: false,
    defaultImageSize: "square",
  },
  pricing: {
    unit: "inference",
    estimatedUnitCost: 0.01,
    currency: "USD",
  },
  deprecation: {
    message:
      "This model is no longer maintained and produces sub-par results.",
    migrationTarget: "fal-ai/flux/dev@v1",
    sunsetDate: "2025-01-15T00:00:00Z",
  },
});

// ─── Nano Banana Pro ─────────────────────────────────────────────────

const nanoBananaPro: EndpointProfile = defineProfile({
  profileId: "fal-ai/nano-banana-pro@v1",
  endpointId: "fal-ai/nano-banana-pro",
  operation: "text-to-image",
  contractVersion: "v1",
  parameterSchema: [
    {
      name: "prompt",
      type: "string",
      required: true,
      description: "Text prompt describing the desired image. Supports multi-language text rendering.",
    },
    {
      name: "aspect_ratio",
      type: "enum",
      required: false,
      defaultValue: "16:9",
      enumValues: ["1:1", "16:9", "9:16", "4:3", "3:4"],
      description: "Aspect ratio of the output image.",
    },
    {
      name: "resolution",
      type: "enum",
      required: false,
      defaultValue: "1K",
      enumValues: ["1K", "2K", "4K"],
      description: "Resolution of the output image. 1K ≈ 1080p, 2K ≈ 1440p, 4K ≈ 2160p.",
    },
    {
      name: "output_format",
      type: "enum",
      required: false,
      defaultValue: "jpeg",
      enumValues: ["jpeg", "png"],
      description: "Output image format.",
    },
    {
      name: "num_images",
      type: "integer",
      required: false,
      defaultValue: 1,
      min: 1,
      max: 4,
      description: "Number of images to generate.",
    },
  ],
  capabilities: {
    // Declared with the aspect ratios this endpoint actually accepts, which
    // are ratio strings rather than the named sizes FLUX uses.
    supportedAspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
    supportsSeed: false,
    supportsReferenceImages: false,
    maxReferenceImages: 0,
    supportsNegativePrompt: false,
    defaultImageSize: "16:9",
  },
  pricing: {
    unit: "inference",
    estimatedUnitCost: 0.003,
    currency: "USD",
  },
});


// ─── FLUX 3 Max ─────────────────────────────────────────────────────────

const FLUX3_MAX_COMMON: ParameterField[] = [
  { name: "prompt", type: "string", required: true, description: "The video scene, action, camera and audio to generate." },
  { name: "duration", type: "integer", required: false, defaultValue: 5, min: 5, max: 20, description: "Whole seconds of output video." },
  { name: "resolution", type: "enum", required: false, defaultValue: "720p", enumValues: ["720p", "1080p"], description: "Output resolution." },
  { name: "reasoning_level", type: "enum", required: false, defaultValue: "high", enumValues: ["low", "high"], description: "Prompt reasoning effort." },
  { name: "aspect_ratio", type: "enum", required: false, defaultValue: "auto", enumValues: ["auto", "21:9", "2:1", "16:9", "4:3", "1:1", "3:4", "9:16"], description: "Frame shape; auto is 16:9 for text prompts." },
  { name: "generate_audio", type: "boolean", required: false, defaultValue: true, description: "Generate synchronized native audio." },
  { name: "seed", type: "integer", required: false, min: 0, description: "Random seed; omitted means provider-selected." },
];

const FLUX3_MAX_CAPABILITIES: EndpointCapabilities = {
  supportedAspectRatios: ["21:9", "2:1", "16:9", "4:3", "1:1", "3:4", "9:16"],
  supportsSeed: true,
  supportsReferenceImages: false,
  maxReferenceImages: 0,
  supportsNegativePrompt: false,
  defaultImageSize: "16:9",
};

const FLUX3_MAX_PRICING = { unit: "inference" as const, estimatedUnitCost: 0.2125, currency: "USD" };

/** FLUX 3 Max — text to video with optional native audio. */
export const flux3MaxTextToVideo: EndpointProfile = defineProfile({
  profileId: "blackforestlabs/flux-3-max/text-to-video@v1",
  endpointId: "blackforestlabs/flux-3-max/text-to-video",
  operation: "text-to-video",
  contractVersion: "v1",
  parameterSchema: FLUX3_MAX_COMMON,
  capabilities: FLUX3_MAX_CAPABILITIES,
  // Public 720p price at profile authoring time: $0.0425/second; the studio
  // fetches the authenticated account's live unit price before reserving spend.
  pricing: FLUX3_MAX_PRICING,
});

/** FLUX 3 Max — image to video, optionally constrained by a closing frame. */
export const flux3MaxImageToVideo: EndpointProfile = defineProfile({
  profileId: "blackforestlabs/flux-3-max/image-to-video@v1",
  endpointId: "blackforestlabs/flux-3-max/image-to-video",
  operation: "image-to-video",
  contractVersion: "v1",
  parameterSchema: [
    { name: "image_url", type: "string", required: true, description: "Opening image (PNG, JPEG or WebP)." },
    { name: "end_image_url", type: "string", required: false, description: "Optional closing image (PNG, JPEG or WebP)." },
    ...FLUX3_MAX_COMMON,
  ],
  capabilities: { ...FLUX3_MAX_CAPABILITIES, supportsReferenceImages: true, maxReferenceImages: 2 },
  pricing: FLUX3_MAX_PRICING,
});

// ─── MiniMax H3 ──────────────────────────────────────────────────────────
//
// Three endpoints, one model. Parameters and enums are taken from the live
// fal API documentation rather than assumed; the skill in skills/studio tells
// Pi how to write for it, and reminds it to check the live interface, whose
// limits always win over any snapshot.

/** Shared across all three H3 endpoints. */
const H3_COMMON: ParameterField[] = [
  {
    name: "prompt",
    type: "string",
    required: true,
    description: "Scene description. Reference assets are addressed by modality and order (Image1, Video1, Audio1).",
  },
  {
    name: "duration",
    type: "integer",
    required: false,
    defaultValue: 5,
    min: 4,
    max: 15,
    description: "Seconds of video.",
  },
  {
    name: "resolution",
    type: "enum",
    required: false,
    defaultValue: "2K",
    enumValues: ["480P", "768P", "2K", "4K"],
    description: "Output resolution.",
  },
  {
    name: "seed",
    type: "integer",
    required: false,
    description: "Fixing this makes a generation reproducible.",
  },
  {
    name: "enable_prompt_expansion",
    type: "boolean",
    required: false,
    defaultValue: true,
    description: "Let a vision-language model expand the prompt. Turn off when the prompt is already exact and must not drift.",
  },
  {
    name: "enable_safety_checker",
    type: "boolean",
    required: false,
    defaultValue: true,
    description: "Provider-side safety filter.",
  },
];

const H3_CAPABILITIES: EndpointCapabilities = {
  supportedAspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
  supportsSeed: true,
  supportsReferenceImages: false,
  maxReferenceImages: 0,
  supportsNegativePrompt: false,
  defaultImageSize: "16:9",
};

/** Pricing is per generation and varies with duration and resolution. */
const H3_PRICING = {
  unit: "inference" as const,
  estimatedUnitCost: 0.48,
  currency: "USD",
};

/** MiniMax H3 — text to video. */
export const minimaxH3TextToVideo: EndpointProfile = defineProfile({
  profileId: "minimax/h3/text-to-video@v1",
  endpointId: "minimax/h3/text-to-video",
  operation: "text-to-video",
  contractVersion: "v1",
  parameterSchema: [
    ...H3_COMMON,
    {
      name: "aspect_ratio",
      type: "enum",
      required: false,
      defaultValue: "16:9",
      enumValues: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
      description: "Frame shape.",
    },
  ],
  capabilities: H3_CAPABILITIES,
  pricing: H3_PRICING,
});

// The image-to-video endpoints, read from fal's live pages (llms.txt) on
// 2026-11-07: the closing frame is `end_image_url` (the old `last_image_url`
// was not a field fal knows, so the end frame was silently dropped), and
// prompt expansion is `prompt_expansion_mode`, not a boolean.

/** Per-second prices (USD) of the image-to-video endpoints, by resolution. */
export const H3_PRICES_PER_SECOND_USD: Readonly<Record<"480P" | "768P" | "2K" | "4K", number>> = Object.freeze({
  "480P": 0.05,
  "768P": 0.06,
  "2K": 0.13,
  "4K": 0.16,
});

/**
 * H3 Max Turbo, list price from 2026-11-16 (a promotion runs below it until
 * then; the reservation keeps the list price, the ledger settles at fal's).
 */
export const H3_MAX_TURBO_PRICES_PER_SECOND_USD: Readonly<Record<"480P" | "768P" | "1080P", number>> = Object.freeze({
  "480P": 0.025,
  "768P": 0.04,
  "1080P": 0.08,
});

const H3_I2V_FRAMES: ParameterField[] = [
  {
    name: "image_url",
    type: "string",
    required: true,
    description: "Opening frame. Sets the canvas (aspect ratio follows the image).",
  },
  {
    name: "end_image_url",
    type: "string",
    required: false,
    description: "Closing frame. The same image as image_url closes an exact loop.",
  },
];

const H3_I2V_COMMON: ParameterField[] = [
  ...H3_COMMON.filter((f) => f.name !== "enable_prompt_expansion"),
  {
    name: "prompt_expansion_mode",
    type: "enum",
    required: false,
    defaultValue: "balanced",
    enumValues: ["disabled", "fast", "balanced", "quality"],
    description: "Prompt expansion. 'disabled' keeps an exact prompt from drifting.",
  },
  ...H3_I2V_FRAMES,
];

/** MiniMax H3 — image to video, including first/last frame. */
export const minimaxH3ImageToVideo: EndpointProfile = defineProfile({
  profileId: "minimax/h3/image-to-video@v1",
  endpointId: "minimax/h3/image-to-video",
  operation: "image-to-video",
  contractVersion: "v1",
  parameterSchema: H3_I2V_COMMON,
  capabilities: { ...H3_CAPABILITIES, supportsReferenceImages: true, maxReferenceImages: 2 },
  pricing: H3_PRICING,
});

/** MiniMax H3 Max Turbo — image to video, first/last frame, cheaper and faster, up to 1080P. */
export const minimaxH3MaxTurboImageToVideo: EndpointProfile = defineProfile({
  profileId: "minimax/h3-max-turbo/image-to-video@v1",
  endpointId: "minimax/h3-max-turbo/image-to-video",
  operation: "image-to-video",
  contractVersion: "v1",
  parameterSchema: H3_I2V_COMMON.map((f) => {
    if (f.name === "resolution") {
      return { ...f, defaultValue: "768P", enumValues: ["480P", "768P", "1080P"] };
    }
    if (f.name === "duration") return { ...f, type: "number" as const, min: 1, max: 15 };
    if (f.name === "prompt_expansion_mode") return { ...f, enumValues: ["disabled", "balanced", "quality"] };
    return f;
  }),
  capabilities: { ...H3_CAPABILITIES, supportsReferenceImages: true, maxReferenceImages: 2 },
  pricing: { unit: "inference", estimatedUnitCost: H3_MAX_TURBO_PRICES_PER_SECOND_USD["768P"] * 5, currency: "USD" },
});

/** MiniMax H3 — reference to video, driven by multimodal references. */
export const minimaxH3ReferenceToVideo: EndpointProfile = defineProfile({
  profileId: "minimax/h3/reference-to-video@v1",
  endpointId: "minimax/h3/reference-to-video",
  operation: "reference-to-video",
  contractVersion: "v1",
  parameterSchema: [
    ...H3_COMMON,
    {
      name: "aspect_ratio",
      type: "enum",
      required: false,
      defaultValue: "adaptive",
      enumValues: ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
      description: "Frame shape. Adaptive follows the references.",
    },
    {
      name: "reference_image_urls",
      type: "array",
      required: false,
      max: 9,
      description: "Subject and style references, addressed in order as Image1, Image2, …",
    },
    {
      name: "reference_video_urls",
      type: "array",
      required: false,
      max: 3,
      description: "Motion and camera references, 2-15s each, addressed as Video1, …",
    },
    {
      name: "reference_audio_urls",
      type: "array",
      required: false,
      max: 3,
      description: "Voice references, 2-15s each, addressed as Audio1, … Requires at least one image or video.",
    },
  ],
  capabilities: { ...H3_CAPABILITIES, supportsReferenceImages: true, maxReferenceImages: 9 },
  pricing: H3_PRICING,
});

// ─── MiniMax H3 Max lip-sync ───────────────────────────────────────────
//
// A photo and a voice recording in, the person in the photo saying it out.
// Schema, limits and prices from fal's live API page,
// https://fal.ai/models/minimax/h3-max/lip-sync/image-to-video/api
// (read 2026-11-11). The video is as long as the audio, and the price is per
// second of it, so everything a caller needs to price and to refuse a request
// before it is sent is here, beside the profile, and nowhere else.

export type H3MaxLipSyncResolution = "480P" | "768P" | "1080P" | "2K";

export const H3_MAX_LIP_SYNC: Readonly<{
  /** USD per second of output video, by resolution. */
  pricesPerSecondUsd: Readonly<Record<H3MaxLipSyncResolution, number>>;
  defaultResolution: H3MaxLipSyncResolution;
  /** A video longer than `overSeconds` costs `priceMultiplier` times the per-second price, all of it. */
  longVideo: Readonly<{ overSeconds: number; priceMultiplier: number }>;
  /** The audio fal accepts (`min`), and the longest one call is given (`max`). */
  audioSeconds: Readonly<{ min: number; max: number }>;
  /** Width / height the image must stay within. */
  imageAspectRatio: Readonly<{ min: number; max: number }>;
}> = Object.freeze({
  pricesPerSecondUsd: Object.freeze({ "480P": 0.05, "768P": 0.08, "1080P": 0.16, "2K": 0.32 }),
  defaultResolution: "768P",
  longVideo: Object.freeze({ overSeconds: 15, priceMultiplier: 1.2 }),
  audioSeconds: Object.freeze({ min: 5, max: 60 }),
  imageAspectRatio: Object.freeze({ min: 0.4, max: 2.5 }),
});

/** What `seconds` of lip-synced video cost at a resolution, in USD. */
export function h3MaxLipSyncPriceUsd(resolution: H3MaxLipSyncResolution, seconds: number): number {
  const perSecond = H3_MAX_LIP_SYNC.pricesPerSecondUsd[resolution];
  if (perSecond === undefined) throw new FalValidationError(`MiniMax H3 Max lip-sync does not offer ${String(resolution)}`, { resolution });
  if (!Number.isFinite(seconds) || seconds <= 0) throw new FalValidationError("a lip-sync price needs a positive duration", { seconds });
  const { overSeconds, priceMultiplier } = H3_MAX_LIP_SYNC.longVideo;
  const usd = perSecond * seconds * (seconds > overSeconds ? priceMultiplier : 1);
  return Math.round(usd * 1e6) / 1e6;
}

/** MiniMax H3 Max — lip-sync: one image and one audio to a talking video. */
export const minimaxH3MaxLipSync: EndpointProfile = defineProfile({
  profileId: "minimax/h3-max/lip-sync/image-to-video@v1",
  endpointId: "minimax/h3-max/lip-sync/image-to-video",
  operation: "image-to-video",
  contractVersion: "v1",
  parameterSchema: [
    {
      name: "image_url",
      type: "string",
      required: true,
      description: `The person who speaks. Aspect ratio ${H3_MAX_LIP_SYNC.imageAspectRatio.min}–${H3_MAX_LIP_SYNC.imageAspectRatio.max}.`,
    },
    {
      name: "audio_url",
      type: "string",
      required: true,
      description: `What they say: at least ${H3_MAX_LIP_SYNC.audioSeconds.min} s. The video is as long as the audio.`,
    },
    {
      name: "resolution",
      type: "enum",
      required: false,
      defaultValue: H3_MAX_LIP_SYNC.defaultResolution,
      enumValues: Object.keys(H3_MAX_LIP_SYNC.pricesPerSecondUsd),
      description: "Output resolution; it sets the price per second.",
    },
    {
      name: "enable_transcription",
      type: "boolean",
      required: false,
      defaultValue: true,
      description: "Transcribe the audio to guide the mouth.",
    },
    { name: "seed", type: "integer", required: false, description: "Fixing this makes a generation reproducible." },
    { name: "enable_safety_checker", type: "boolean", required: false, defaultValue: true, description: "Provider-side safety filter." },
  ],
  capabilities: { ...H3_CAPABILITIES, supportsReferenceImages: true, maxReferenceImages: 1 },
  // The shortest video at the default resolution. A caller reserves
  // h3MaxLipSyncPriceUsd(resolution, the audio's seconds) instead.
  pricing: {
    unit: "inference",
    estimatedUnitCost: H3_MAX_LIP_SYNC.pricesPerSecondUsd[H3_MAX_LIP_SYNC.defaultResolution] * H3_MAX_LIP_SYNC.audioSeconds.min,
    currency: "USD",
  },
});

// ─── Wan 2.2 A14B (turbo) ──────────────────────────────────────────────
//
// Image to video, optionally toward an end frame (the same image twice makes
// a closed loop). Schema and prices from fal's live API page,
// https://fal.ai/models/fal-ai/wan/v2.2-a14b/image-to-video/turbo/api
// (read 2026-10-15): the turbo endpoint takes no frame count, frame rate or
// negative prompt — those belong to the non-turbo endpoint. Prices per video:
// 720p $0.10, 580p $0.075, 480p $0.05.

/** The turbo endpoint's price per video, by resolution (USD). */
export const WAN_22_TURBO_PRICES_USD: Readonly<Record<"480p" | "580p" | "720p", number>> = Object.freeze({
  "480p": 0.05,
  "580p": 0.075,
  "720p": 0.1,
});

/** Wan 2.2 A14B turbo — image to video, with an optional end frame. */
export const wan22TurboImageToVideo: EndpointProfile = defineProfile({
  profileId: "wan/v2.2-a14b/image-to-video/turbo@v1",
  endpointId: "fal-ai/wan/v2.2-a14b/image-to-video/turbo",
  operation: "image-to-video",
  contractVersion: "v1",
  parameterSchema: [
    { name: "image_url", type: "string", required: true, description: "Opening frame." },
    { name: "prompt", type: "string", required: true, description: "What moves, and how." },
    {
      name: "end_image_url",
      type: "string",
      required: false,
      description: "Closing frame. The opening frame again makes a seamless loop.",
    },
    { name: "seed", type: "integer", required: false, description: "Omitted: fal picks one at random." },
    {
      name: "resolution",
      type: "enum",
      required: false,
      defaultValue: "720p",
      enumValues: ["480p", "580p", "720p"],
      description: "Output resolution; it sets the price.",
    },
    {
      name: "aspect_ratio",
      type: "enum",
      required: false,
      defaultValue: "auto",
      enumValues: ["auto", "16:9", "9:16", "1:1"],
      description: "Frame shape; auto follows the input image.",
    },
    { name: "enable_safety_checker", type: "boolean", required: false, defaultValue: false, description: "Input safety check." },
    { name: "enable_output_safety_checker", type: "boolean", required: false, defaultValue: false, description: "Output safety check." },
    { name: "enable_prompt_expansion", type: "boolean", required: false, defaultValue: false, description: "Let an LLM expand the prompt." },
    {
      name: "acceleration",
      type: "enum",
      required: false,
      defaultValue: "regular",
      enumValues: ["none", "regular"],
      description: "Speed-up; none is slower and closer to the full model.",
    },
    {
      name: "video_quality",
      type: "enum",
      required: false,
      defaultValue: "high",
      enumValues: ["low", "medium", "high", "maximum"],
      description: "Encoder quality of the output.",
    },
    {
      name: "video_write_mode",
      type: "enum",
      required: false,
      defaultValue: "balanced",
      enumValues: ["fast", "balanced", "small"],
      description: "Encoder speed/size trade-off.",
    },
  ],
  capabilities: {
    supportedAspectRatios: ["16:9", "9:16", "1:1"],
    supportsSeed: true,
    supportsReferenceImages: true,
    maxReferenceImages: 2,
    supportsNegativePrompt: false,
    defaultImageSize: "16:9",
  },
  // The 720p price: the default, and the most a clip costs. The studio tool
  // reserves the price of the resolution it actually asks for.
  pricing: { unit: "inference", estimatedUnitCost: WAN_22_TURBO_PRICES_USD["720p"], currency: "USD" },
});

// ─── Tripo H3.1 — a 3D model from one picture ─────────────────────────
//
// Schema and prices from fal's own description of the endpoint,
// https://fal.ai/models/tripo3d/h3.1/image-to-3d/llms.txt (read 2026-11-17):
// "$0.20 (without textures), $0.30 (with standard textures), or $0.40 (with
// HD textures), plus an additional $0.20 for detailed geometry and $0.05 for
// quad mesh". It returns `model_mesh` (GLB; FBX when a quad mesh comes out as
// one), `rendered_image` and a `task_id`. Its page says Tripo's rig endpoints
// take that id in place of the model, but fal lists no such endpoint: a model
// has no skeleton, and rigging it is another call to another provider (the
// rigging profiles below).

/** How a Tripo H3.1 model is textured; it sets most of the price. */
export type TripoTexture = "none" | "standard" | "detailed";

/** Everything the image-to-3D profile knows in numbers: prices and limits. */
export const TRIPO_H31: Readonly<{
  pricesUsd: Readonly<Record<TripoTexture, number>>;
  detailedGeometryUsd: number;
  quadUsd: number;
  faceLimit: Readonly<{ min: number; max: number }>;
  defaultTexture: TripoTexture;
}> = Object.freeze({
  pricesUsd: Object.freeze({ none: 0.2, standard: 0.3, detailed: 0.4 }),
  detailedGeometryUsd: 0.2,
  quadUsd: 0.05,
  faceLimit: Object.freeze({ min: 1000, max: 2_000_000 }),
  defaultTexture: "standard",
});

/** What one model costs, from what is asked of it (USD). */
export function tripoH31PriceUsd(options: { texture?: TripoTexture; detailedGeometry?: boolean; quad?: boolean } = {}): number {
  const price = TRIPO_H31.pricesUsd[options.texture ?? TRIPO_H31.defaultTexture] +
    (options.detailedGeometry ? TRIPO_H31.detailedGeometryUsd : 0) + (options.quad ? TRIPO_H31.quadUsd : 0);
  return Math.round(price * 100) / 100;
}

/** Tripo H3.1 — one picture to a textured 3D model. */
export const tripoH31ImageTo3d: EndpointProfile = defineProfile({
  profileId: "tripo3d/h3.1/image-to-3d@v1",
  endpointId: "tripo3d/h3.1/image-to-3d",
  operation: "image-to-3d",
  contractVersion: "v1",
  parameterSchema: [
    { name: "image_url", type: "string", required: true, description: "The picture the model is made from." },
    {
      name: "face_limit", type: "integer", required: false, min: TRIPO_H31.faceLimit.min, max: TRIPO_H31.faceLimit.max,
      description: "Target number of faces. Omitted: the model decides.",
    },
    { name: "texture", type: "boolean", required: false, defaultValue: true, description: "Make textures." },
    { name: "pbr", type: "boolean", required: false, defaultValue: true, description: "Make PBR materials; implies textures." },
    { name: "model_seed", type: "integer", required: false, description: "Seed of the geometry." },
    { name: "texture_seed", type: "integer", required: false, description: "Seed of the textures." },
    {
      name: "texture_quality", type: "enum", required: false, defaultValue: "standard", enumValues: ["standard", "detailed"],
      description: "detailed is HD textures, at the higher price.",
    },
    {
      name: "geometry_quality", type: "enum", required: false, defaultValue: "standard", enumValues: ["standard", "detailed"],
      description: "detailed geometry costs more.",
    },
    {
      name: "texture_alignment", type: "enum", required: false, defaultValue: "original_image", enumValues: ["original_image", "geometry"],
      description: "What the textures are aligned to.",
    },
    { name: "auto_size", type: "boolean", required: false, defaultValue: false, description: "Scale the model to real-world metres." },
    {
      name: "orientation", type: "enum", required: false, defaultValue: "default", enumValues: ["default", "align_image"],
      description: "align_image turns the model to face as the picture does.",
    },
    { name: "quad", type: "boolean", required: false, defaultValue: false, description: "A quad mesh; it may come back as FBX." },
    { name: "enable_safety_checker", type: "boolean", required: false, defaultValue: true, description: "Input safety check." },
  ],
  capabilities: {
    supportedAspectRatios: [],
    supportsSeed: true,
    supportsReferenceImages: true,
    maxReferenceImages: 1,
    supportsNegativePrompt: false,
    defaultImageSize: "",
  },
  // The default request: standard textures, standard geometry. The studio's
  // tool reserves the price of what it actually asks for (tripoH31PriceUsd).
  pricing: { unit: "inference", estimatedUnitCost: TRIPO_H31.pricesUsd.standard, currency: "USD" },
});

// ─── Rigging: a skeleton for a model ──────────────────────────────────
// Two endpoints, read from fal's pages (llms.txt and the OpenAPI schema) on
// 2026-11-17. Tripo's own rig endpoints, which its image-to-3D answer names,
// are not on fal.

export type Hyper3dRigTemplate = "auto" | "human" | "quadruped" | "bird" | "dragon" | "kaiju" | "custom";
export type Hyper3dSkinning = "shell" | "core";

/** What the Hyper3D rigging profile knows in numbers and names. */
export const HYPER3D_RIG: Readonly<{
  priceUsd: number;
  templates: readonly Hyper3dRigTemplate[];
  skinning: readonly Hyper3dSkinning[];
  formats: readonly string[];
  maxClips: number;
}> = Object.freeze({
  priceUsd: 0.2,
  templates: Object.freeze(["auto", "human", "quadruped", "bird", "dragon", "kaiju", "custom"] as const),
  skinning: Object.freeze(["shell", "core"] as const),
  formats: Object.freeze(["glb", "fbx", "usdz"]),
  maxClips: 10,
});

/**
 * Hyper3D Rigging — a skeleton for a body of any of six kinds, or one
 * described in words; stock clips come at no further price. It wants the
 * model +y up and facing +z.
 */
export const hyper3dRigging: EndpointProfile = defineProfile({
  profileId: "hyper3d/rigging@v1",
  endpointId: "hyper3d/rigging",
  operation: "model-to-rig",
  contractVersion: "v1",
  parameterSchema: [
    { name: "model_url", type: "string", required: true, description: "The model: OBJ, GLB, STL, FBX or USD with its materials inside, +y up, facing +z." },
    {
      name: "bone_template", type: "enum", required: false, defaultValue: "auto", enumValues: [...HYPER3D_RIG.templates],
      description: "The kind of skeleton. auto chooses among the presets; custom needs skeleton_description.",
    },
    { name: "image_url", type: "string", required: false, description: "A picture of the character, to guide auto and a described skeleton." },
    {
      name: "skinning_method", type: "enum", required: false, defaultValue: "shell", enumValues: [...HYPER3D_RIG.skinning],
      description: "shell: smooth weights on the visible mesh. core: influences held close to the joints.",
    },
    { name: "skeleton_description", type: "string", required: false, description: "Anatomy and limbs in words. Only with bone_template custom." },
    {
      name: "animation_presets", type: "array", required: false, max: HYPER3D_RIG.maxClips,
      description: "Stock animation ids that fit the skeleton (see hyper3d/rigging/animations). Not with animation_urls.",
    },
    {
      name: "animation_urls", type: "array", required: false, max: HYPER3D_RIG.maxClips,
      description: "FBX clips made for this rig, one take each. Not with animation_presets.",
    },
    { name: "in_place", type: "boolean", required: false, defaultValue: false, description: "Looping stock clips stay where they are." },
    {
      name: "geometry_file_format", type: "enum", required: false, defaultValue: "fbx", enumValues: [...HYPER3D_RIG.formats],
      description: "The format of the rigged model.",
    },
  ],
  capabilities: {
    supportedAspectRatios: [],
    supportsSeed: false,
    supportsReferenceImages: true,
    maxReferenceImages: 1,
    supportsNegativePrompt: false,
    defaultImageSize: "",
  },
  pricing: { unit: "inference", estimatedUnitCost: HYPER3D_RIG.priceUsd, currency: "USD" },
});

/** The kinds of body Hyper3D has stock clips for. */
export const HYPER3D_CLIP_CATEGORIES = Object.freeze(["human", "canine", "bird", "fish", "heavyhooved", "leanhooved", "lizard", "rodentia", "seaturtle"] as const);
export type Hyper3dClipCategory = (typeof HYPER3D_CLIP_CATEGORIES)[number];

/** A stock clip Hyper3D can add to a rig it makes: asked for by its id, at no price of its own. */
export interface StockClip {
  id: string;
  category: string;
  name: string;
  description: string;
  seconds: number;
  /** Whether it comes round to where it began, and so can be repeated. */
  loops: boolean;
}

/** The free endpoint that lists them. */
export const HYPER3D_CLIPS_ENDPOINT = "hyper3d/rigging/animations";

/** Read the catalogue's answer: entries that have no id are left out. */
export function readStockClips(answer: Record<string, unknown>): StockClip[] {
  const list = Array.isArray(answer["animations"]) ? (answer["animations"] as unknown[]) : [];
  const clips: StockClip[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = record["animation_id"];
    if (typeof id !== "string" || !id) continue;
    const loop = record["loop"] && typeof record["loop"] === "object" ? (record["loop"] as Record<string, unknown>)["kind"] : undefined;
    clips.push({
      id,
      category: typeof record["category"] === "string" ? (record["category"] as string) : "",
      name: typeof record["display_name"] === "string" && record["display_name"] ? (record["display_name"] as string) : id,
      description: typeof record["content_description"] === "string" ? (record["content_description"] as string) : "",
      seconds: typeof record["duration_seconds"] === "number" ? Math.round((record["duration_seconds"] as number) * 100) / 100 : 0,
      loops: typeof loop === "string" && loop !== "none",
    });
  }
  return clips;
}

/** What the Hunyuan Motion profile knows in numbers. */
export const HUNYUAN_MOTION: Readonly<{
  priceUsd: number;
  seconds: Readonly<{ min: number; max: number; default: number }>;
  guidance: Readonly<{ min: number; max: number; default: number }>;
}> = Object.freeze({
  priceUsd: 0.08,
  seconds: Object.freeze({ min: 0.5, max: 12, default: 5 }),
  guidance: Object.freeze({ min: 1, max: 10, default: 5 }),
});

/**
 * Hunyuan Motion on fal: a human motion from a sentence, as an FBX.
 *
 * What comes back is a skeleton that moves, on a body of its own — the SMPL
 * family's, whose bones are named for the joint they start at (`L_Shoulder`
 * is the upper arm, `L_Knee` the shin) and rest in a T-pose with the pelvis
 * at the origin. It is of no use until it is carried to the rig that will
 * play it. A person's body only: no animal, no object.
 */
export const hunyuanMotion: EndpointProfile = defineProfile({
  profileId: "fal-ai/hunyuan-motion@v1",
  endpointId: "fal-ai/hunyuan-motion",
  operation: "text-to-motion",
  contractVersion: "v1",
  parameterSchema: [
    { name: "prompt", type: "string", required: true, description: "The motion in a sentence: who does what, in which order." },
    { name: "seed", type: "integer", required: false, min: 0, description: "The same seed and sentence give the same motion." },
    {
      name: "duration", type: "number", required: false, defaultValue: HUNYUAN_MOTION.seconds.default,
      min: HUNYUAN_MOTION.seconds.min, max: HUNYUAN_MOTION.seconds.max, description: "Seconds of motion.",
    },
    {
      name: "guidance_scale", type: "number", required: false, defaultValue: HUNYUAN_MOTION.guidance.default,
      min: HUNYUAN_MOTION.guidance.min, max: HUNYUAN_MOTION.guidance.max, description: "How closely the sentence is followed.",
    },
    { name: "output_format", type: "enum", required: false, defaultValue: "fbx", enumValues: ["fbx", "dict"], description: "fbx: an animation file. dict: raw numbers." },
  ],
  capabilities: {
    supportedAspectRatios: [],
    supportsSeed: true,
    supportsReferenceImages: false,
    maxReferenceImages: 0,
    supportsNegativePrompt: false,
    defaultImageSize: "",
  },
  pricing: { unit: "inference", estimatedUnitCost: HUNYUAN_MOTION.priceUsd, currency: "USD" },
});

export type MeshyRigTemplate =
  | "meshyrig" | "mixamo" | "ue5_mannequin" | "unity_humanoid" | "maya_human_ik"
  | "blender_rigify_basic_human" | "max_biped" | "cc5_hd_neutral_base" | "daz_genesis9";

/** What the Meshy rigging profile knows in numbers and names. */
export const MESHY_RIG: Readonly<{
  priceUsd: number;
  animationUsd: number;
  templates: readonly MeshyRigTemplate[];
  defaultHeightMeters: number;
  actionIds: Readonly<{ min: number; max: number }>;
}> = Object.freeze({
  priceUsd: 0.2,
  animationUsd: 0.12,
  templates: Object.freeze([
    "meshyrig", "mixamo", "ue5_mannequin", "unity_humanoid", "maya_human_ik",
    "blender_rigify_basic_human", "max_biped", "cc5_hd_neutral_base", "daz_genesis9",
  ] as const),
  defaultHeightMeters: 1.7,
  actionIds: Object.freeze({ min: 0, max: 696 }),
});

/** What one Meshy rig costs (USD): the rig, and one preset clip when asked. */
export function meshyRigPriceUsd(options: { animation?: boolean } = {}): number {
  return Math.round((MESHY_RIG.priceUsd + (options.animation ? MESHY_RIG.animationUsd : 0)) * 100) / 100;
}

/**
 * Meshy Rigging — a humanoid's skeleton on one of the industry's standard
 * templates, with a walk and a run added. Humanoids with clear limbs only,
 * and GLB only.
 */
export const meshyRigging: EndpointProfile = defineProfile({
  profileId: "meshy/rigging@v1",
  endpointId: "meshy/rigging",
  operation: "model-to-rig",
  contractVersion: "v1",
  parameterSchema: [
    { name: "model_url", type: "string", required: true, description: "The model, as GLB: a humanoid with clearly defined limbs." },
    { name: "height_meters", type: "number", required: false, defaultValue: MESHY_RIG.defaultHeightMeters, min: 0.01, max: 100, description: "About how tall the character is, in metres." },
    {
      name: "skeleton_template", type: "enum", required: false, enumValues: [...MESHY_RIG.templates],
      description: "The standard the skeleton follows. Omitted: Meshy's own (meshyrig).",
    },
    { name: "include_fingers", type: "boolean", required: false, defaultValue: false, description: "Rig the fingers." },
    { name: "enable_animation", type: "boolean", required: false, defaultValue: false, description: "Apply one preset clip, at a further price." },
    {
      name: "animation_action_id", type: "integer", required: false, min: MESHY_RIG.actionIds.min, max: MESHY_RIG.actionIds.max,
      description: "The preset to apply, from Meshy's animation library. Only with enable_animation.",
    },
    { name: "enable_safety_checker", type: "boolean", required: false, defaultValue: true, description: "Input safety check." },
  ],
  capabilities: {
    supportedAspectRatios: [],
    supportsSeed: false,
    supportsReferenceImages: false,
    maxReferenceImages: 0,
    supportsNegativePrompt: false,
    defaultImageSize: "",
  },
  pricing: { unit: "inference", estimatedUnitCost: MESHY_RIG.priceUsd, currency: "USD" },
});

// ─── Registry ─────────────────────────────────────────────────────────

const PROFILES: readonly EndpointProfile[] = Object.freeze([
  fluxDevV1,
  fluxFillV1,
  nanoBananaPro,
  flux3MaxTextToVideo,
  flux3MaxImageToVideo,
  minimaxH3TextToVideo,
  minimaxH3ImageToVideo,
  minimaxH3MaxTurboImageToVideo,
  minimaxH3ReferenceToVideo,
  minimaxH3MaxLipSync,
  wan22TurboImageToVideo,
  tripoH31ImageTo3d,
  hyper3dRigging,
  meshyRigging,
  hunyuanMotion,
  deprecationExample,
]);

const PROFILE_MAP = new Map<string, EndpointProfile>();
for (const p of PROFILES) {
  PROFILE_MAP.set(p.profileId, p);
}
