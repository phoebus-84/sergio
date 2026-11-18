// ---------------------------------------------------------------------------
// A skeleton for a 3D model
// ---------------------------------------------------------------------------
// `pva_rig_model` sends a model that has no skeleton to a rigging service
// (through fal) and gets it back with one: the second step of a character's
// 3D form (ADR-0052, capability `rig.create`), after `pva_generate_model`.
//
// Two services, because a character can be anything:
//
// - Hyper3D rigs a human, a quadruped, a bird, a dragon, a kaiju, or a body
//   described in words; it takes a GLB or an FBX;
// - Meshy rigs humanoids only, on the skeleton standards animation tools
//   expect, and adds a walk and a run to every rig.
//
// Shaped like the other paid fal tools: paths are guarded, the model is
// uploaded, the call is reserved and settled on the episode's spend ledger at
// the profile's price, and what comes back lands under the episode with a
// provenance sidecar. What is its own: the rig is examined before the tool
// answers (rig-exam.ts). Automatic rigging fails quietly; the exam is how a
// broken rig is found now and not in the shot.
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import {
  createFalClient,
  FalHttpError,
  FalValidationError,
  HYPER3D_RIG,
  hyper3dRigging,
  MESHY_RIG,
  meshyRigging,
  type EndpointProfile,
} from "@av/fal-media";
import { toMicros } from "@studio/contracts/src/budget.mjs";
import { episodePath } from "@studio/contracts/src/layout.mjs";
import { resolveConfig } from "./config.js";
import { guardEpisodePath } from "./trust-guards.js";
import { paidCall, providerCost } from "./spend.js";
import { FACINGS, turnToFaceZ, type Facing } from "./glb.js";
import { describeRigExam, examineRig, type RigExam } from "./rig-exam.js";
import { pictureExtension } from "./model-tools.js";

export const RIG_TOOL = "pva_rig_model";

export type RigEngine = "hyper3d" | "meshy";
export const RIG_ENGINES: readonly [RigEngine, ...RigEngine[]] = ["hyper3d", "meshy"];

interface EngineTerms {
  profile: EndpointProfile;
  label: string;
  priceUsd: number;
  skeletons: readonly string[];
  /** The model files it takes, by extension. */
  takes: readonly string[];
  what: string;
}

export const RIG_ENGINE_TERMS: Readonly<Record<RigEngine, EngineTerms>> = {
  hyper3d: {
    profile: hyper3dRigging, label: "Hyper3D Rigging", priceUsd: HYPER3D_RIG.priceUsd,
    skeletons: HYPER3D_RIG.templates, takes: [".glb", ".fbx"],
    what: "a human, a quadruped, a bird, a dragon, a kaiju, or (custom) a body described in words",
  },
  meshy: {
    profile: meshyRigging, label: "Meshy Rigging", priceUsd: MESHY_RIG.priceUsd,
    skeletons: MESHY_RIG.templates, takes: [".glb"],
    what: "humanoids with clear limbs only, on a standard skeleton (mixamo, rigify, …), with a walk and a run added",
  },
};

const usd = (amount: number) => `$${Number(amount.toFixed(4))}`;

/** The engines and their prices, for the description and the status report. */
export function rigTerms(): string {
  return RIG_ENGINES.map((engine) => `${engine} ${usd(RIG_ENGINE_TERMS[engine].priceUsd)} a rig (${RIG_ENGINE_TERMS[engine].what})`).join("; ");
}

const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
/**
 * Hyper3D's skinning when none is asked for. The service's own default is
 * shell; on the two figures rigged both ways, core tore the surface a tenth
 * as often in the same poses (pva_rig_sheet), so core is the studio's.
 */
export const HYPER3D_SKINNING_DEFAULT = "core";

const HEARTBEAT_MS = 15_000;
const MAX_WAIT_MS = 900_000;
const MODEL_TYPES: Readonly<Record<string, string>> = { ".glb": "model/gltf-binary", ".fbx": "application/octet-stream" };
const IMAGE_TYPES: Readonly<Record<string, string>> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

export interface RigRequest {
  engine: RigEngine;
  modelUrl: string;
  skeleton?: string;
  skeletonDescription?: string;
  skinning?: string;
  imageUrl?: string;
  fingers?: boolean;
  heightMeters?: number;
}

/** The tool's request as each endpoint's own parameters. */
export function rigRequestBody(r: RigRequest): Record<string, unknown> {
  if (r.engine === "meshy") {
    return {
      model_url: r.modelUrl,
      ...(r.skeleton ? { skeleton_template: r.skeleton } : {}),
      ...(r.fingers ? { include_fingers: true } : {}),
      ...(r.heightMeters !== undefined ? { height_meters: r.heightMeters } : {}),
      enable_safety_checker: true,
    };
  }
  return {
    model_url: r.modelUrl,
    bone_template: r.skeleton ?? "auto",
    ...(r.skeletonDescription ? { skeleton_description: r.skeletonDescription } : {}),
    skinning_method: r.skinning ?? HYPER3D_SKINNING_DEFAULT,
    ...(r.imageUrl ? { image_url: r.imageUrl } : {}),
    // A binary glTF is what the exam reads.
    geometry_file_format: "glb",
  };
}

/** A model file's extension from its first bytes, or null. */
function modelExtension(bytes: Uint8Array): ".glb" | ".fbx" | null {
  if (bytes.byteLength >= 4 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46) return ".glb";
  if (bytes.byteLength >= 18 && Buffer.from(bytes.subarray(0, 18)).toString("latin1") === "Kaydara FBX Binary") return ".fbx";
  return null;
}

export function registerRigTools(pi: ExtensionAPI): void {
  const LIBRARY_ROOT = process.env.AVG_LIBRARY_ROOT || join(process.cwd(), "library");
  const skeletons = [...new Set(RIG_ENGINES.flatMap((engine) => RIG_ENGINE_TERMS[engine].skeletons))];

  pi.registerTool({
    name: RIG_TOOL,
    label: "Rig 3D Model",
    description:
      "Give a 3D model a skeleton and skin weights, so it can be posed and animated: a rigging service through fal.ai. " +
      `Paid: ${rigTerms()}; reserved on the episode's spend ledger. ` +
      "The model is an episode file (a .glb, or an .fbx with hyper3d), as pva_generate_model leaves it or brought in; a light one — 10,000–50,000 faces — rigs better than a heavy one. " +
      "It must face +z: say which way it faces with `faces` and a .glb is turned before it is sent (a model from pva_generate_model faces +x). " +
      "Saves assets/models/<rigId>.glb (the rigged model), any clips that came with it as <rigId>.clip.<name>.glb, and <rigId>.provenance.json, " +
      "then examines the rig — vertices no bone moves, bones outside the body, nothing near the ground, a left with no right — and says what it found. " +
      "A rig that fails the exam is kept on disk and must not be released: make another attempt, with another engine, skeleton or skinning. " +
      "A rig that passes is still not proven: pose it and look, with pva_rig_sheet. Check pva_budget_status first.",
    parameters: Type.Object({
      channel: Type.String({ description: "Channel slug" }),
      series: Type.String({ description: "Series slug" }),
      episode: Type.String({ description: "Episode slug" }),
      rigId: Type.String({ description: "Safe name (letters, digits, _ and -) for the rigged model; not the name of the model it is made from" }),
      modelPath: Type.String({ description: "The model with no skeleton, episode-relative: assets/models/<modelId>.glb" }),
      engine: Type.Optional(StringEnum(RIG_ENGINES, { default: "hyper3d", description: "hyper3d: any of six kinds of body, or one described. meshy: humanoids, on a standard skeleton, with a walk and a run" })),
      skeleton: Type.Optional(StringEnum(skeletons as [string, ...string[]], {
        description: `The kind of skeleton. hyper3d: ${HYPER3D_RIG.templates.join(", ")} (default auto). meshy: ${MESHY_RIG.templates.join(", ")} (default meshyrig)`,
      })),
      skeletonDescription: Type.Optional(Type.String({ description: "hyper3d with skeleton custom: the body's anatomy and limbs in words" })),
      skinning: Type.Optional(StringEnum(HYPER3D_RIG.skinning as unknown as [string, ...string[]], { description: `hyper3d: core (weights held close to the joints; the default here, it tears less) or shell (the service's own default, smoother and looser)` })),
      imagePath: Type.Optional(Type.String({ description: "hyper3d: a picture of the character, episode-relative, to guide auto and custom skeletons" })),
      fingers: Type.Optional(Type.Boolean({ description: "meshy: rig the fingers" })),
      heightMeters: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 100, description: `meshy: about how tall the character is, in metres (default ${MESHY_RIG.defaultHeightMeters})` })),
      faces: Type.Optional(StringEnum(FACINGS as unknown as [Facing, ...Facing[]], { default: "+z", description: "Which way the model faces in its file. Other than +z, a .glb is turned to face +z before it is sent" })),
      overwrite: Type.Optional(Type.Boolean({ default: false, description: "Replace an existing rig of this rigId" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      if (!SAFE_NAME.test(params.rigId)) throw new Error("rigId must contain only letters, numbers, underscores and hyphens (max 64)");
      const engine: RigEngine = params.engine ?? "hyper3d";
      const terms = RIG_ENGINE_TERMS[engine];
      if (!terms) throw new Error(`engine is one of ${RIG_ENGINES.join(", ")}`);
      const dir = episodePath(LIBRARY_ROOT, params.channel, params.series, params.episode);

      const guard = await guardEpisodePath(LIBRARY_ROOT, params.channel, params.series, params.episode, params.modelPath);
      if (!guard.allowed) throw new Error(guard.reason ?? `Model path rejected: ${params.modelPath}`);
      const modelFull = join(dir, params.modelPath);
      if (!existsSync(modelFull) || !statSync(modelFull).isFile()) throw new Error(`Model not found: ${params.modelPath}`);
      const sourceBytes = readFileSync(modelFull);
      const kind = modelExtension(sourceBytes);
      if (!kind) throw new Error(`${params.modelPath} is neither a binary glTF nor a binary FBX`);
      if (!terms.takes.includes(kind)) throw new Error(`${terms.label} takes ${terms.takes.join(" or ")}, and ${params.modelPath} is ${kind}: use engine hyper3d, or convert it to .glb`);

      const modelDir = join(dir, "assets", "models");
      // What the rig's name will hold is cleared before it is written: it must not be the model it is made from.
      if (resolve(modelFull).startsWith(resolve(modelDir) + "/") && basename(modelFull).startsWith(`${params.rigId}.`)) {
        throw new Error(`rigId "${params.rigId}" is the name of the model it is made from: give the rig its own name`);
      }
      const provenancePath = join(modelDir, `${params.rigId}.provenance.json`);
      if (existsSync(provenancePath) && !params.overwrite) {
        throw new Error(`assets/models/${params.rigId} already exists: pick another rigId, or pass overwrite: true`);
      }

      // What each engine does not take is refused here, not after a paid 422.
      if (params.skeleton !== undefined && !terms.skeletons.includes(params.skeleton)) {
        throw new Error(`${terms.label} has no skeleton "${params.skeleton}": it has ${terms.skeletons.join(", ")}`);
      }
      if (engine === "hyper3d") {
        if (params.fingers !== undefined || params.heightMeters !== undefined) throw new Error("fingers and heightMeters are for engine meshy");
        if (params.skeleton === "custom" && !params.skeletonDescription?.trim()) throw new Error("skeleton custom needs skeletonDescription: the body's anatomy and limbs in words");
        if (params.skeleton !== "custom" && params.skeletonDescription !== undefined) throw new Error("skeletonDescription is only for skeleton custom");
      } else if (params.skeletonDescription !== undefined || params.skinning !== undefined || params.imagePath !== undefined) {
        throw new Error("skeletonDescription, skinning and imagePath are for engine hyper3d");
      }

      const faces: Facing = params.faces ?? "+z";
      let sendBytes: Buffer = sourceBytes;
      if (faces !== "+z") {
        if (kind !== ".glb") throw new Error(`a ${kind} cannot be turned here: turn it to face +z in Blender, or rig the .glb`);
        const turned = turnToFaceZ(sourceBytes, faces);
        if (!turned) throw new Error(`${params.modelPath} could not be read to turn it`);
        sendBytes = turned;
      }

      let imageFull: string | null = null;
      if (params.imagePath !== undefined) {
        const imageGuard = await guardEpisodePath(LIBRARY_ROOT, params.channel, params.series, params.episode, params.imagePath);
        if (!imageGuard.allowed) throw new Error(imageGuard.reason ?? `Image path rejected: ${params.imagePath}`);
        imageFull = join(dir, params.imagePath);
        if (!existsSync(imageFull) || !statSync(imageFull).isFile()) throw new Error(`Image not found: ${params.imagePath}`);
        if (!IMAGE_TYPES[extname(imageFull).toLowerCase()]) throw new Error(`Unsupported image type: ${extname(imageFull) || "no extension"} (png, jpg or webp)`);
      }

      const config = await resolveConfig();
      if (!config.falKeyRef) throw new Error("FAL_KEY env var not set");

      const modelSha256 = createHash("sha256").update(sourceBytes).digest("hex");
      const settings = {
        engine,
        ...(params.skeleton !== undefined ? { skeleton: params.skeleton } : {}),
        ...(params.skeletonDescription !== undefined ? { skeletonDescription: params.skeletonDescription } : {}),
        ...(engine === "hyper3d" ? { skinning: params.skinning ?? HYPER3D_SKINNING_DEFAULT } : {}),
        ...(params.fingers ? { fingers: true } : {}),
        ...(params.heightMeters !== undefined ? { heightMeters: params.heightMeters } : {}),
        faces,
      };
      // A rig has no seed: asking twice is two attempts, and each is its own request.
      const requestHash = createHash("sha256").update(JSON.stringify({ ...settings, modelSha256, at: Date.now() })).digest("hex").slice(0, 20);
      const what = `${params.rigId} (${terms.label}${params.skeleton ? `, ${params.skeleton}` : ""}, ~${usd(terms.priceUsd)})`;

      const client = createFalClient(config.falKeyRef);
      const startedMs = Date.now();
      const heartbeat = setInterval(() => {
        onUpdate?.({
          content: [{ type: "text" as const, text: `Rig ${params.rigId}: waiting on fal… ${Math.round((Date.now() - startedMs) / 1000)}s` }],
          details: { rigId: params.rigId, elapsedMs: Date.now() - startedMs },
        });
      }, HEARTBEAT_MS);
      heartbeat.unref?.();

      let result;
      try {
        result = await paidCall(
          { libraryRoot: LIBRARY_ROOT, channel: params.channel, series: params.series, episode: params.episode },
          {
            capability: "rig.create",
            provider: "fal",
            model: terms.profile.profileId,
            purpose: `rig ${params.rigId}`,
            estimate: { estimate: { currency: "USD", micros: toMicros(terms.priceUsd) }, priced: true, profile: terms.profile.profileId },
          },
          async (spend) => {
            try {
              onUpdate?.({
                content: [{ type: "text" as const, text: `Submitting ${what}…` }],
                details: { rigId: params.rigId, profileId: terms.profile.profileId },
              });
              // The uploads are free and come first: if they fail, nothing was rigged.
              const modelUrl = await client.uploadFile({ bytes: sendBytes, fileName: `model${kind}`, contentType: MODEL_TYPES[kind]! }, signal);
              const imageUrl = imageFull
                ? await client.uploadFile({ bytes: readFileSync(imageFull), fileName: `image${extname(imageFull).toLowerCase()}`, contentType: IMAGE_TYPES[extname(imageFull).toLowerCase()]! }, signal)
                : undefined;
              spend.sending();
              const rigged = await client.submitAndWait({
                idempotencyKey: `${params.channel}-${params.series}-${params.episode}-${params.rigId}-${requestHash}`,
                binding: { endpointId: terms.profile.endpointId, contractVersion: terms.profile.contractVersion, baseUrl: "" },
                parameters: rigRequestBody({
                  engine, modelUrl, skeleton: params.skeleton, skeletonDescription: params.skeletonDescription, skinning: params.skinning,
                  imageUrl, fingers: params.fingers, heightMeters: params.heightMeters,
                }),
                timeoutMs: MAX_WAIT_MS,
              }, signal, { maxWaitMs: MAX_WAIT_MS });
              return { value: rigged, cost: providerCost(rigged.cost), providerRequestId: rigged.providerRequestId };
            } catch (e) {
              // Refused before submit, or by fal with a 4xx: nothing rigged. Anything else may have been billed and stays reserved.
              if (e instanceof FalValidationError || (e instanceof FalHttpError && e.status >= 400 && e.status < 500 && e.status !== 429)) spend.refused();
              throw e;
            }
          },
        );
      } finally {
        clearInterval(heartbeat);
      }

      const fetchBytes = async (url: string, what: string): Promise<Buffer> => {
        const fetched = await fetch(url, { signal });
        if (!fetched.ok) throw new Error(`Failed to download ${what} (fal request ${result.providerRequestId}): HTTP ${fetched.status}`);
        return Buffer.from(await fetched.arrayBuffer());
      };
      const rigOutput = result.outputs.find((o) => o.role === "rig");
      if (!rigOutput) throw new Error(`${terms.label} completed without a rigged model`);
      const rigBytes = await fetchBytes(rigOutput.url, "the rig");
      const rigKind = modelExtension(rigBytes) ?? ([".glb", ".fbx"].includes(extname(rigOutput.fileName ?? "").toLowerCase()) ? extname(rigOutput.fileName!).toLowerCase() : ".glb");
      const rigFile = `${params.rigId}${rigKind}`;

      mkdirSync(modelDir, { recursive: true });
      // A second attempt may come back with other files: what the name held before goes.
      for (const entry of readdirSync(modelDir)) {
        if (entry.startsWith(`${params.rigId}.`)) rmSync(join(modelDir, entry), { force: true });
      }
      writeFileSync(join(modelDir, rigFile), rigBytes);
      const files: { role: string; file: string; sha256: string; bytes: number }[] = [
        { role: "rig", file: rigFile, sha256: createHash("sha256").update(rigBytes).digest("hex"), bytes: rigBytes.length },
      ];

      // Everything else is kept when it can be: a rig without its extras is still a rig.
      const clips: { name: string; file: string; exam: RigExam }[] = [];
      const lost: string[] = [];
      for (const output of result.outputs) {
        if (output === rigOutput || !output.role) continue;
        try {
          const bytes = await fetchBytes(output.url, output.role);
          const ext = modelExtension(bytes) ?? pictureExtension(bytes) ?? (extname(output.fileName ?? "").toLowerCase() || ".bin");
          const clip = output.role.startsWith("clip:") ? output.role.slice(5) : null;
          const file = clip ? `${params.rigId}.clip.${clip}${ext}`
            : output.role === "rig-with-clips" ? `${params.rigId}.with-clips${ext}`
            : output.role === "rig-fbx" ? `${params.rigId}.fbx`
            : null;
          if (!file || file === rigFile) continue;
          writeFileSync(join(modelDir, file), bytes);
          files.push({ role: output.role, file, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
          if (clip) clips.push({ name: clip, file, exam: examineRig(bytes) });
        } catch {
          lost.push(output.role);
        }
      }

      const exam = examineRig(rigBytes);
      const taskId = result.details?.taskId ?? null;
      const provenance = {
        version: 1,
        provider: "fal.ai",
        model: terms.label,
        endpointId: terms.profile.endpointId,
        profileId: result.profileId,
        schemaFingerprint: result.schemaFingerprint,
        providerRequestId: result.providerRequestId,
        ...(taskId ? { providerTaskId: taskId } : {}),
        idempotencyKey: result.idempotencyKey,
        rigId: params.rigId,
        modelPath: params.modelPath,
        modelSha256,
        ...(params.imagePath !== undefined ? { imagePath: params.imagePath } : {}),
        ...settings,
        estimatedCost: { amount: terms.priceUsd, currency: "USD" },
        cost: result.cost,
        output: rigFile,
        files,
        exam,
        clips: clips.map((clip) => ({ name: clip.name, file: clip.file, clips: clip.exam.clips, findings: clip.exam.findings })),
        completedAt: result.completedAt.toISOString(),
      };
      writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

      const clipLines = clips.map((clip) => {
        const inside = clip.exam.clips.find((one) => !one.still) ?? clip.exam.clips[0];
        const broken = clip.exam.findings.filter((finding) => finding.level === "fail").map((finding) => finding.message);
        return `   clip ${clip.name}: assets/models/${clip.file}` +
          (inside ? ` — ${inside.seconds}s, moves ${inside.joints} joints` : clip.exam.format === "glb" ? " — ⚠️ no animation inside" : "") +
          (broken.length > 0 ? ` — ❌ ${broken.join("; ")}` : "");
      });
      return {
        content: [{
          type: "text" as const,
          text: [
            `${exam.ok ? "✅" : "❌"} assets/models/${rigFile} — ${(rigBytes.length / 1024 / 1024).toFixed(1)}MB, ${terms.label}` +
              `${params.skeleton ? ` (${params.skeleton})` : ""}, ${result.cost ? `$${result.cost.amount}` : `~${usd(terms.priceUsd)}`} (${result.profileId})`,
            ...describeRigExam(exam).map((line) => `   ${line}`),
            ...clipLines,
            ...(lost.length > 0 ? [`   ⚠️ not downloaded: ${lost.join(", ")} (fal request ${result.providerRequestId})`] : []),
            exam.ok
              ? `   pose it and look before anything else: pva_rig_sheet { channel, series, episode, rigPath: "assets/models/${rigFile}" }\n` +
                "   then, to make it a character's form: copy the rig, its clips and this provenance into characters/<id>/forms/<form>/<release>/ and record it " +
                `with pva_update_character { form: { id, medium: "rig-3d", can: { actions: [${clips.map((clip) => `"${clip.name}"`).join(", ")}] } }, release: { form, release, entry: "${rigFile}", ` +
                `madeWith: [{ tool: "${RIG_TOOL}", provider: "fal", model: "${terms.profile.endpointId}" }] } }`
              : "   it is kept for you to look at, and must not be released. Another attempt is another paid call: change the engine, the skeleton or the skinning, or lighten and clean the model first",
          ].join("\n"),
        }],
        details: {
          outputPath: join(modelDir, rigFile),
          provenancePath,
          size: rigBytes.length,
          exam,
          clips: clips.map((clip) => ({ name: clip.name, path: join(modelDir, clip.file) })),
          profileId: result.profileId,
          providerRequestId: result.providerRequestId,
          ...(taskId ? { providerTaskId: taskId } : {}),
          cost: result.cost,
          estimatedCostUsd: terms.priceUsd,
        },
      };
    },
  });
}
