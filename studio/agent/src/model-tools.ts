// ---------------------------------------------------------------------------
// A 3D model from one picture
// ---------------------------------------------------------------------------
// `pva_generate_model` gives Tripo H3.1 (through fal) a picture and gets back
// a textured 3D model of what it shows, with a preview render. It is the
// first step of a character's 3D form (ADR-0052, capability `model.generate`),
// and of any prop or object a shot needs in the round.
//
// Shaped like the other paid fal tools: paths are guarded, the picture is
// uploaded, the call is reserved and settled on the episode's spend ledger
// (avg-91o) at the price of what is asked, and the model lands under the
// episode with a provenance sidecar. What is its own:
//
// - the model is read after it arrives: how many triangles, materials and
//   textures it has, and that it has no skeleton. A model is not a rig;
//   rigging it is another step, and the provenance keeps the provider's task
//   id that step can start from;
// - every number — the prices, the face limits — is read from the profile in
//   @av/fal-media.
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createHash, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import {
  createFalClient,
  FalHttpError,
  FalValidationError,
  TRIPO_H31,
  tripoH31ImageTo3d,
  tripoH31PriceUsd,
  type TripoTexture,
} from "@av/fal-media";
import { toMicros } from "@studio/contracts/src/budget.mjs";
import { episodePath } from "@studio/contracts/src/layout.mjs";
import { resolveConfig } from "./config.js";
import { guardEpisodePath } from "./trust-guards.js";
import { guardWorkspacePath, workspaceOf } from "./workspace-target.js";
import { paidCall, providerCost } from "./spend.js";

export const MODEL_TOOL = "pva_generate_model";
export const MODEL_PROFILE = tripoH31ImageTo3d;
export const MODEL_TEXTURES = Object.keys(TRIPO_H31.pricesUsd) as [TripoTexture, ...TripoTexture[]];

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const HEARTBEAT_MS = 15_000;
const MAX_WAIT_MS = 900_000;
const IMAGE_TYPES: Readonly<Record<string, string>> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const PREVIEW_EXTENSIONS: Readonly<Record<string, string>> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };
/** Above this a model is heavy to rig, animate or render in number; Tripo's own choice is far above it. */
export const HEAVY_TRIANGLES = 200_000;

/**
 * A picture's extension from its first bytes, or null when they say nothing.
 * The service names its preview `.png` and sends a WebP: the bytes are right.
 */
export function pictureExtension(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, 12));
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return ".jpg";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return ".webp";
  return null;
}

const usd = (amount: number) => `$${Number(amount.toFixed(4))}`;

/** What the tool says about its price, from the profile. */
export function modelTerms(): string {
  const { pricesUsd, detailedGeometryUsd, quadUsd } = TRIPO_H31;
  return `per model: ${MODEL_TEXTURES.map((t) => `${t === "none" ? "no textures" : `${t} textures`} ${usd(pricesUsd[t])}`).join(", ")}; ` +
    `+${usd(detailedGeometryUsd)} for detailed geometry, +${usd(quadUsd)} for a quad mesh`;
}

export interface ModelRequest {
  imageUrl: string;
  texture: TripoTexture;
  seed: number;
  detailedGeometry?: boolean;
  quad?: boolean;
  faceLimit?: number;
  alignToImage?: boolean;
}

/** The request body fal's Tripo endpoint takes, from the tool's parameters. */
export function modelRequestBody(r: ModelRequest): Record<string, unknown> {
  return {
    image_url: r.imageUrl,
    texture: r.texture !== "none",
    pbr: r.texture !== "none",
    ...(r.texture === "detailed" ? { texture_quality: "detailed" } : {}),
    ...(r.detailedGeometry ? { geometry_quality: "detailed" } : {}),
    ...(r.quad ? { quad: true } : {}),
    ...(r.faceLimit !== undefined ? { face_limit: r.faceLimit } : {}),
    ...(r.alignToImage ? { orientation: "align_image" } : {}),
    model_seed: r.seed,
    texture_seed: r.seed,
    enable_safety_checker: true,
  };
}

export interface ModelSummary {
  format: "glb" | "fbx" | "unknown";
  meshes?: number;
  triangles?: number;
  materials?: number;
  textures?: number;
  /** Joints of its skins: 0 for what a generator returns. */
  joints?: number;
  animations?: number;
  /** The box it fills in its own units, as placed by its scene: glTF is y up. Absent when the file does not say. */
  bounds?: { min: [number, number, number]; max: [number, number, number] };
}

type Mat4 = number[];
const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** Column-major, as glTF writes them. */
const multiply = (a: Mat4, b: Mat4): Mat4 => IDENTITY.map((_, i) => {
  const column = Math.floor(i / 4), row = i % 4;
  return a[row]! * b[column * 4]! + a[4 + row]! * b[column * 4 + 1]! + a[8 + row]! * b[column * 4 + 2]! + a[12 + row]! * b[column * 4 + 3]!;
});
function nodeMatrix(node: { matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }): Mat4 {
  if (node.matrix?.length === 16) return node.matrix;
  const [tx, ty, tz] = node.translation ?? [0, 0, 0], [x, y, z, w] = node.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = node.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y! * y! + z! * z!)) * sx!, 2 * (x! * y! + z! * w!) * sx!, 2 * (x! * z! - y! * w!) * sx!, 0,
    2 * (x! * y! - z! * w!) * sy!, (1 - 2 * (x! * x! + z! * z!)) * sy!, 2 * (y! * z! + x! * w!) * sy!, 0,
    2 * (x! * z! + y! * w!) * sz!, 2 * (y! * z! - x! * w!) * sz!, (1 - 2 * (x! * x! + y! * y!)) * sz!, 0,
    tx!, ty!, tz!, 1,
  ];
}

interface GltfDocument {
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: { mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[];
  meshes?: { primitives: { mode?: number; indices?: number; attributes: Record<string, number> }[] }[];
  accessors?: { count: number; min?: number[]; max?: number[] }[];
  materials?: unknown[]; images?: unknown[]; skins?: { joints: number[] }[]; animations?: unknown[];
}

/** The box the default scene's meshes fill, from the bounds every position accessor must state. */
function sceneBounds(gltf: GltfDocument): ModelSummary["bounds"] {
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const visit = (index: number, parent: Mat4, depth: number): void => {
    const node = gltf.nodes?.[index];
    if (!node || depth > 64) return;
    const world = multiply(parent, nodeMatrix(node));
    for (const primitive of gltf.meshes?.[node.mesh ?? -1]?.primitives ?? []) {
      const box = gltf.accessors?.[primitive.attributes?.POSITION ?? -1];
      if (box?.min?.length !== 3 || box.max?.length !== 3) continue;
      for (let corner = 0; corner < 8; corner++) {
        const p = [0, 1, 2].map((axis) => (corner >> axis) & 1 ? box.max![axis]! : box.min![axis]!);
        for (let axis = 0; axis < 3; axis++) {
          const v = world[axis]! * p[0]! + world[4 + axis]! * p[1]! + world[8 + axis]! * p[2]! + world[12 + axis]!;
          if (v < min[axis]!) min[axis] = v;
          if (v > max[axis]!) max[axis] = v;
        }
      }
    }
    for (const child of node.children ?? []) visit(child, world, depth + 1);
  };
  for (const root of gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? []) visit(root, IDENTITY, 0);
  if (![...min, ...max].every(Number.isFinite)) return undefined;
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return { min: min.map(round) as [number, number, number], max: max.map(round) as [number, number, number] };
}

/**
 * What a model file holds, read from its bytes: a binary glTF's own counts,
 * or only the format for anything else. Never throws: a file that cannot be
 * read is `unknown`, and the tool says so.
 */
export function summarizeModel(bytes: Uint8Array): ModelSummary {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength >= 23 && new TextDecoder().decode(bytes.subarray(0, 18)) === "Kaydara FBX Binary") return { format: "fbx" };
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(16, true) !== 0x4e4f534a) return { format: "unknown" };
  const length = view.getUint32(12, true);
  if (20 + length > bytes.byteLength) return { format: "unknown" };
  try {
    const gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length))) as GltfDocument;
    let triangles = 0;
    for (const mesh of gltf.meshes ?? []) {
      for (const primitive of mesh.primitives ?? []) {
        if ((primitive.mode ?? 4) !== 4) continue;
        triangles += Math.floor((gltf.accessors?.[primitive.indices ?? primitive.attributes?.POSITION ?? -1]?.count ?? 0) / 3);
      }
    }
    const bounds = sceneBounds(gltf);
    return {
      format: "glb",
      meshes: gltf.meshes?.length ?? 0,
      triangles,
      materials: gltf.materials?.length ?? 0,
      textures: gltf.images?.length ?? 0,
      joints: new Set((gltf.skins ?? []).flatMap((skin) => skin.joints)).size,
      animations: gltf.animations?.length ?? 0,
      ...(bounds ? { bounds } : {}),
    };
  } catch {
    return { format: "unknown" };
  }
}

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** One line a person or the agent reads to know what came back. */
export function describeModel(summary: ModelSummary): string {
  if (summary.format === "fbx") return "an FBX (a quad mesh comes back as one): open it in Blender to see what it holds";
  if (summary.format === "unknown") return "⚠️ not a binary glTF this tool can read: open it before using it";
  return [
    count(summary.triangles ?? 0, "triangle"), count(summary.meshes ?? 0, "mesh", "meshes"), count(summary.materials ?? 0, "material"),
    count(summary.textures ?? 0, "texture"),
    (summary.joints ?? 0) === 0 ? "no skeleton: it can be placed, turned and lit, not posed" : `${count(summary.joints!, "joint")}, ${count(summary.animations ?? 0, "clip")}`,
    ...(summary.bounds ? [describeBounds(summary.bounds)] : []),
  ].join(", ");
}

/** How big it is and where it stands: a generated model is not on the ground until someone puts it there. */
function describeBounds({ min, max }: NonNullable<ModelSummary["bounds"]>): string {
  const size = [0, 1, 2].map((axis) => Number((max[axis]! - min[axis]!).toFixed(2)));
  const height = max[1] - min[1];
  const feet = Math.abs(min[1]) <= height * 0.02 ? "it stands on its origin"
    : Math.abs(min[1] + max[1]) <= height * 0.02 ? "its origin is at its middle, not under its feet"
    : `its lowest point is at y ${Number(min[1].toFixed(2))}`;
  return `${size[0]} wide × ${size[1]} tall × ${size[2]} deep in its own units (y up); ${feet}`;
}

/** Said when a model is heavier than what a rig, an animation or a crowd wants. */
export function weightWarning(summary: ModelSummary): string | null {
  if ((summary.triangles ?? 0) <= HEAVY_TRIANGLES) return null;
  return `⚠️ heavy: ${count(summary.triangles!, "triangle")}. Fine for a still or a close render; to rig or animate it, ` +
    "make it again with faceLimit (a figure rigs well at 10,000–50,000 faces) — a new paid call — or reduce it in Blender";
}

export function registerModelTools(pi: ExtensionAPI): void {
  const LIBRARY_ROOT = process.env.AVG_LIBRARY_ROOT || join(process.cwd(), "library");
  const profile = MODEL_PROFILE;

  pi.registerTool({
    name: MODEL_TOOL,
    label: "Generate 3D Model",
    description:
      "Make a 3D model from one picture: Tripo H3.1 through fal.ai (picture → textured GLB and a preview render). " +
      `Paid, ${modelTerms()}; reserved on the episode's spend ledger at the price of what is asked. ` +
      "The picture decides everything: one subject, whole, on a plain ground, from the view the model should face; approve the picture before paying for the model. " +
      "The picture is an episode file, or with imageSource a file of a channel source (library/<channel>/sources/<name>). " +
      "Saves assets/models/<modelId>.glb, <modelId>.preview.* and <modelId>.provenance.json in the episode, and says what the model holds. " +
      "It has no skeleton: it is a character's model-3d form or a prop as it is, and needs rigging before it can be posed. " +
      "A picture of a real person makes a model of that person: the character needs its likeness stated first. Check pva_budget_status first.",
    parameters: Type.Object({
      channel: Type.String({ description: "Channel slug" }),
      series: Type.String({ description: "Series slug" }),
      episode: Type.String({ description: "Episode slug" }),
      modelId: Type.String({ description: "Safe name (letters, digits, _ and -), the model's filename" }),
      imagePath: Type.String({ description: "The picture (png, jpg or webp): episode-relative, or relative to the source when imageSource is given" }),
      imageSource: Type.Optional(Type.String({ description: "A channel source's name: imagePath is then read from library/<channel>/sources/<name>/" })),
      texture: Type.Optional(StringEnum(MODEL_TEXTURES, { default: TRIPO_H31.defaultTexture, description: "none: geometry only. standard. detailed: HD textures. It sets most of the price" })),
      detailedGeometry: Type.Optional(Type.Boolean({ description: `Finer geometry, +${usd(TRIPO_H31.detailedGeometryUsd)}` })),
      quad: Type.Optional(Type.Boolean({ description: `A quad mesh, easier to rig and edit, +${usd(TRIPO_H31.quadUsd)}; it may come back as FBX` })),
      faceLimit: Type.Optional(Type.Integer({ minimum: TRIPO_H31.faceLimit.min, maximum: TRIPO_H31.faceLimit.max, description: "Target number of faces. Omitted: the model decides, and it decides for more than a million triangles; a figure to rig or animate wants 10,000–50,000" })),
      alignToImage: Type.Optional(Type.Boolean({ description: "Turn the model to face as the picture does" })),
      seed: Type.Optional(Type.Integer({ minimum: 0, description: "Omitted: one is picked and recorded" })),
      overwrite: Type.Optional(Type.Boolean({ default: false, description: "Replace an existing model of this modelId" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      if (!SAFE_NAME.test(params.modelId)) throw new Error("modelId must contain only letters, numbers, underscores and hyphens (max 64)");
      const dir = episodePath(LIBRARY_ROOT, params.channel, params.series, params.episode);

      // The picture: in the episode, or in a channel source.
      let imageFull: string;
      if (params.imageSource !== undefined) {
        const source = workspaceOf(LIBRARY_ROOT, { channel: params.channel, source: params.imageSource });
        const guard = await guardWorkspacePath(LIBRARY_ROOT, source, params.imagePath);
        if (!guard.allowed) throw new Error(guard.reason ?? `Image path rejected: ${params.imagePath}`);
        imageFull = join(source.dir, params.imagePath);
      } else {
        const guard = await guardEpisodePath(LIBRARY_ROOT, params.channel, params.series, params.episode, params.imagePath);
        if (!guard.allowed) throw new Error(guard.reason ?? `Image path rejected: ${params.imagePath}`);
        imageFull = join(dir, params.imagePath);
      }
      const imageLabel = params.imageSource !== undefined ? `sources/${params.imageSource}/${params.imagePath}` : params.imagePath;
      if (!existsSync(imageFull) || !statSync(imageFull).isFile()) throw new Error(`Image not found: ${imageLabel}`);
      const imageType = IMAGE_TYPES[extname(imageFull).toLowerCase()];
      if (!imageType) throw new Error(`Unsupported image type: ${extname(imageFull) || "no extension"} (png, jpg or webp)`);

      const modelDir = join(dir, "assets", "models");
      const provenancePath = join(modelDir, `${params.modelId}.provenance.json`);
      // Before anything is spent: a name already taken is a mistake more often than a retake.
      if (existsSync(provenancePath) && !params.overwrite) {
        throw new Error(`assets/models/${params.modelId} already exists: pick another modelId, or pass overwrite: true`);
      }

      const texture: TripoTexture = params.texture ?? TRIPO_H31.defaultTexture;
      if (!MODEL_TEXTURES.includes(texture)) throw new Error(`texture is one of ${MODEL_TEXTURES.join(", ")}`);
      const { min, max } = TRIPO_H31.faceLimit;
      if (params.faceLimit !== undefined && (params.faceLimit < min || params.faceLimit > max)) throw new Error(`faceLimit is ${min}–${max}`);

      const config = await resolveConfig();
      if (!config.falKeyRef) throw new Error("FAL_KEY env var not set");

      const imageBytes = readFileSync(imageFull);
      const imageSha256 = createHash("sha256").update(imageBytes).digest("hex");
      // Picked here when not given, so the provenance always says how to make the same model again.
      const seed = params.seed ?? randomInt(0, 2 ** 31 - 1);
      const settings = {
        texture,
        seed,
        ...(params.detailedGeometry ? { detailedGeometry: true } : {}),
        ...(params.quad ? { quad: true } : {}),
        ...(params.faceLimit !== undefined ? { faceLimit: params.faceLimit } : {}),
        ...(params.alignToImage ? { alignToImage: true } : {}),
      };
      const requestHash = createHash("sha256").update(JSON.stringify({ ...settings, imageSha256 })).digest("hex").slice(0, 20);
      const priceUsd = tripoH31PriceUsd({ texture, detailedGeometry: params.detailedGeometry, quad: params.quad });
      const what = `${params.modelId} (${texture === "none" ? "no textures" : `${texture} textures`}${params.detailedGeometry ? ", detailed geometry" : ""}${params.quad ? ", quad" : ""}, ~${usd(priceUsd)})`;
      const client = createFalClient(config.falKeyRef);
      const startedMs = Date.now();
      const heartbeat = setInterval(() => {
        onUpdate?.({
          content: [{ type: "text" as const, text: `Model ${params.modelId}: waiting on fal… ${Math.round((Date.now() - startedMs) / 1000)}s` }],
          details: { modelId: params.modelId, elapsedMs: Date.now() - startedMs },
        });
      }, HEARTBEAT_MS);
      heartbeat.unref?.();

      let result;
      try {
        // Through the episode's spend ledger (avg-91o), reserved at the price of this request, settled at what fal reports.
        result = await paidCall(
          { libraryRoot: LIBRARY_ROOT, channel: params.channel, series: params.series, episode: params.episode },
          {
            capability: "model.generate",
            provider: "fal",
            model: profile.profileId,
            purpose: `model ${params.modelId}`,
            estimate: { estimate: { currency: "USD", micros: toMicros(priceUsd) }, priced: true, profile: profile.profileId },
          },
          async (spend) => {
            try {
              // Said here, after the reservation: a call the budget refuses was never submitted.
              onUpdate?.({
                content: [{ type: "text" as const, text: `Submitting ${what} to Tripo H3.1…` }],
                details: { modelId: params.modelId, profileId: profile.profileId },
              });
              // The upload is free and comes first: if it fails, nothing was generated.
              const imageUrl = await client.uploadFile({ bytes: imageBytes, fileName: `image${extname(imageFull).toLowerCase()}`, contentType: imageType }, signal);
              spend.sending();
              const generated = await client.submitAndWait({
                idempotencyKey: `${params.channel}-${params.series}-${params.episode}-${params.modelId}-${requestHash}`,
                binding: { endpointId: profile.endpointId, contractVersion: profile.contractVersion, baseUrl: "" },
                parameters: modelRequestBody({ imageUrl, ...settings }),
                timeoutMs: MAX_WAIT_MS,
              }, signal, { maxWaitMs: MAX_WAIT_MS });
              return { value: generated, cost: providerCost(generated.cost), providerRequestId: generated.providerRequestId };
            } catch (e) {
              // Refused before submit, or by fal with a 4xx: nothing generated. Anything else may have been billed and stays reserved.
              if (e instanceof FalValidationError || (e instanceof FalHttpError && e.status >= 400 && e.status < 500 && e.status !== 429)) spend.refused();
              throw e;
            }
          },
        );
      } finally {
        clearInterval(heartbeat);
      }

      const mesh = result.outputs.find((o) => o.role === "model") ?? result.outputs[0];
      if (!mesh) throw new Error("Tripo H3.1 completed without a model");
      const fetched = await fetch(mesh.url, { signal });
      if (!fetched.ok) throw new Error(`Failed to download the model (fal request ${result.providerRequestId}): HTTP ${fetched.status}`);
      const data = Buffer.from(await fetched.arrayBuffer());
      const summary = summarizeModel(data);
      const named = extname(mesh.fileName ?? "").toLowerCase();
      const extension = summary.format === "glb" ? ".glb" : summary.format === "fbx" ? ".fbx" : [".glb", ".fbx", ".obj", ".usdz"].includes(named) ? named : ".glb";
      const modelFile = `${params.modelId}${extension}`;

      mkdirSync(modelDir, { recursive: true });
      // A retake may come back as another kind of file (a quad mesh is an FBX): what the name held before goes.
      for (const entry of readdirSync(modelDir)) {
        if (entry.startsWith(`${params.modelId}.`)) rmSync(join(modelDir, entry), { force: true });
      }
      writeFileSync(join(modelDir, modelFile), data);

      // The preview render is a convenience: a model without one is still a model.
      let previewFile: string | null = null;
      const preview = result.outputs.find((o) => o.role === "preview");
      if (preview) {
        try {
          const picture = await fetch(preview.url, { signal });
          if (picture.ok) {
            const pictureBytes = Buffer.from(await picture.arrayBuffer());
            const pictureType = pictureExtension(pictureBytes) ?? PREVIEW_EXTENSIONS[preview.contentType] ?? (extname(preview.fileName ?? "").toLowerCase() || ".webp");
            previewFile = `${params.modelId}.preview${pictureType}`;
            writeFileSync(join(modelDir, previewFile), pictureBytes);
          }
        } catch { /* no preview */ }
      }

      const taskId = result.details?.taskId ?? null;
      const heavy = weightWarning(summary);
      const provenance = {
        version: 1,
        provider: "fal.ai",
        model: "Tripo H3.1 image to 3D",
        endpointId: profile.endpointId,
        profileId: result.profileId,
        schemaFingerprint: result.schemaFingerprint,
        providerRequestId: result.providerRequestId,
        // Tripo's own id of the model: its rigging endpoints take it in place of the file.
        ...(taskId ? { providerTaskId: taskId } : {}),
        idempotencyKey: result.idempotencyKey,
        modelId: params.modelId,
        imagePath: params.imagePath,
        ...(params.imageSource !== undefined ? { imageSource: params.imageSource } : {}),
        imageSha256,
        ...settings,
        estimatedCost: { amount: priceUsd, currency: "USD" },
        cost: result.cost,
        output: modelFile,
        outputUrl: mesh.url,
        outputSha256: createHash("sha256").update(data).digest("hex"),
        ...(previewFile ? { preview: previewFile } : {}),
        holds: summary,
        completedAt: result.completedAt.toISOString(),
      };
      writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

      return {
        content: [{
          type: "text" as const,
          text: [
            `✅ assets/models/${modelFile} — ${(data.length / 1024 / 1024).toFixed(1)}MB, ${describeModel(summary)}; seed ${seed}, ` +
              `${result.cost ? `$${result.cost.amount}` : `~${usd(priceUsd)}`} (${result.profileId})`,
            ...(heavy ? [`   ${heavy}`] : []),
            // Seen on every model the real service returned (2026-11-17), with and without alignToImage.
            "   it faces +x in its own file, where glTF puts the front at +z: check, and turn it when you place it",
            ...(previewFile ? [`   preview: assets/models/${previewFile} — look at it, and at the model from every side, before it is used`] : []),
            "   to make it a character's form: copy it with its provenance into characters/<id>/forms/<form>/<release>/ and record that folder " +
              `with pva_update_character { release: { form, release, entry: "${modelFile}", madeWith: [{ tool: "${MODEL_TOOL}", provider: "fal", model: "tripo3d/h3.1" }] } }`,
          ].join("\n"),
        }],
        details: {
          outputPath: join(modelDir, modelFile),
          provenancePath,
          ...(previewFile ? { previewPath: join(modelDir, previewFile) } : {}),
          size: data.length,
          holds: summary,
          profileId: result.profileId,
          providerRequestId: result.providerRequestId,
          ...(taskId ? { providerTaskId: taskId } : {}),
          seed,
          cost: result.cost,
          estimatedCostUsd: priceUsd,
        },
      };
    },
  });
}
