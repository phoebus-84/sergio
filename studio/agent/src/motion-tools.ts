// ---------------------------------------------------------------------------
// Motion for a rig
// ---------------------------------------------------------------------------
// A rig moves as far as its clips go. Two tools give it more of them:
//
// - `pva_retarget_clip` carries a clip from another skeleton to the rig's.
//   Local and free: Blender reads the clip (@av/blender/clip-sample) and the
//   rest is arithmetic (retarget.ts). The source is anything with a skeleton
//   and a motion — a clip a rigging service made for another rig, a motion
//   from a library, a generated one.
// - `pva_generate_motion` makes a motion from a sentence (Hunyuan Motion on
//   fal, capability `motion.generate`, paid per motion on the episode's
//   ledger) and carries it to the rig. What comes back is a person's motion
//   on a skeleton of its own; it is of no use until it is on the rig.
//
// Either way the result is a file beside the rig, `<rig>.clip.<name>.glb`:
// the rig's own body with one motion in it, as the rigging services leave
// their clips. `pva_rig_sheet` plays it; a motion is judged there, by eye.
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { sampleClip } from "@av/blender/clip-sample";
import {
  createFalClient, FalHttpError, FalValidationError, HUNYUAN_MOTION, hunyuanMotion,
  HYPER3D_CLIP_CATEGORIES, HYPER3D_CLIPS_ENDPOINT, readStockClips, type Hyper3dClipCategory, type StockClip,
} from "@av/fal-media";
import { toMicros } from "@studio/contracts/src/budget.mjs";
import { episodePath } from "@studio/contracts/src/layout.mjs";
import { resolveConfig } from "./config.js";
import { FACINGS, type Facing } from "./glb.js";
import { retargetClip, type RetargetReport } from "./retarget.js";
import { examineRig } from "./rig-exam.js";
import { RIG_SHEET_TOOL } from "./rig-sheet-tools.js";
import { paidCall, providerCost } from "./spend.js";
import { guardEpisodePath } from "./trust-guards.js";

export const RETARGET_TOOL = "pva_retarget_clip";
export const MOTION_TOOL = "pva_generate_motion";
export const STOCK_CLIPS_TOOL = "pva_stock_clips";

/** The catalogue as lines: an id, what the clip is, how long, whether it comes round. */
export function describeStockClips(clips: readonly StockClip[], asked: { category?: string; search?: string }): string[] {
  const words = (asked.search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const found = clips.filter((clip) => words.every((word) => `${clip.name} ${clip.description}`.toLowerCase().includes(word)));
  const shown = found.slice(0, 150);
  return [
    `${found.length} stock clip${found.length === 1 ? "" : "s"}${asked.category ? ` for a ${asked.category} body` : ""}${words.length ? ` matching "${asked.search}"` : ""}` +
      (found.length !== clips.length ? ` (of ${clips.length})` : "") + ": id — what it is, seconds, ↻ when it can be repeated",
    ...shown.map((clip) => `${clip.id} — ${clip.name}${clip.description && clip.description.toLowerCase() !== clip.name.toLowerCase() ? `: ${clip.description}` : ""}, ${clip.seconds}s${clip.loops ? " ↻" : ""}`),
    ...(found.length > shown.length ? [`… and ${found.length - shown.length} more: narrow it with \`search\``] : []),
    "They are made for the rig Hyper3D makes: name up to ten in `clips` on pva_rig_model with engine hyper3d, and they come with the rig at no price of their own. " +
      `To put one on another rig, carry it there afterwards with ${RETARGET_TOOL}`,
  ];
}

const CLIP_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const HEARTBEAT_MS = 15_000;
const MAX_WAIT_MS = 600_000;
const usd = (amount: number) => `$${Number(amount.toFixed(4))}`;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export interface CarryRequest {
  /** The rig, absolute. */
  rigFull: string;
  /** The file the motion is in (.glb or .fbx), absolute. */
  sourceFull: string;
  name: string;
  action?: string;
  faces?: Facing;
  sourceFaces?: Facing;
  inPlace?: boolean;
  map?: Record<string, string>;
  signal?: AbortSignal;
}

export interface Carried {
  /** The clip, absolute: <rig>.clip.<name>.glb beside the rig. */
  clipFull: string;
  provenanceFull: string;
  report: RetargetReport;
  /** The motion the source held under this name, and the others it holds. */
  action: string;
  actions: string[];
  bytes: number;
  /** What the exam of the written clip found wrong. */
  failures: string[];
}

/** Where a rig's clip of this name goes. */
export const clipPathOf = (rigFull: string, name: string) => join(dirname(rigFull), `${basename(rigFull).replace(/\.glb$/i, "")}.clip.${name}.glb`);

/** Read a motion out of one file and write it, on the rig's skeleton, beside the rig. */
export async function carryClip(request: CarryRequest, extra: Record<string, unknown> = {}): Promise<Carried> {
  const work = mkdtempSync(join(tmpdir(), "clip-carry-"));
  try {
    const clip = await sampleClip({ path: request.sourceFull, outputDir: join(work, "sample"), ...(request.action ? { action: request.action } : {}) }, request.signal ? { signal: request.signal } : {});
    const rigBytes = readFileSync(request.rigFull);
    const { bytes, report } = retargetClip(rigBytes, clip, {
      name: request.name,
      ...(request.faces ? { faces: request.faces } : {}), ...(request.sourceFaces ? { sourceFaces: request.sourceFaces } : {}),
      ...(request.inPlace ? { inPlace: true } : {}), ...(request.map ? { map: request.map } : {}),
    });
    const clipFull = clipPathOf(request.rigFull, request.name);
    writeFileSync(clipFull, bytes);
    const exam = examineRig(bytes);
    const provenanceFull = clipFull.replace(/\.glb$/, ".provenance.json");
    writeFileSync(provenanceFull, `${JSON.stringify({
      version: 1,
      clip: basename(clipFull),
      clipSha256: sha256(bytes),
      rig: basename(request.rigFull),
      rigSha256: sha256(rigBytes),
      source: basename(request.sourceFull),
      sourceSha256: sha256(readFileSync(request.sourceFull)),
      action: clip.action,
      faces: request.faces ?? "+z",
      sourceFaces: request.sourceFaces ?? "+z",
      ...(request.inPlace ? { inPlace: true } : {}),
      ...(request.map ? { map: request.map } : {}),
      ...extra,
      report,
      madeAt: new Date().toISOString(),
    }, null, 2)}\n`);
    return {
      clipFull, provenanceFull, report, action: clip.action, actions: clip.actions, bytes: bytes.length,
      failures: exam.findings.filter((finding) => finding.level === "fail").map((finding) => finding.message),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** What was carried, as lines the agent reads. */
export function describeCarried(carried: Carried, shown: { clip: string; rig: string }): string[] {
  const { report } = carried;
  const others = carried.actions.filter((name) => name !== carried.action);
  return [
    `${carried.failures.length ? "❌" : "✅"} ${shown.clip} — ${Number(report.seconds.toFixed(2))}s, ${report.frames} frames, ${report.pairs.length} bones carried` +
      (report.travel < 0.1 ? ", played on the spot" : `, the body travels about ${report.travel} of its height`),
    `   from ${carried.action}${others.length ? ` (the file also holds ${others.slice(0, 8).join(", ")}${others.length > 8 ? ` and ${others.length - 8} more` : ""}: name one with \`action\`)` : ""}`,
    `   the clip's skeleton names its bones for ${report.sourceNaming === "joints" ? "the joint they start at" : "the part they are"}; the rig's legs are ${report.scale} of the clip's, and the hips travel by as much`,
    ...(report.unpaired.length ? [`   not carried: ${report.unpaired.join(", ")}`] : []),
    ...report.notes.map((note) => `   ${note}`),
    ...carried.failures.map((failure) => `   ❌ ${failure}`),
    `   a motion is judged by eye: ${RIG_SHEET_TOOL} { channel, series, episode, rigPath: "${shown.rig}" } plays it over six moments. Feet that slide, a hand through the body and a limb bent the wrong way are not measured`,
  ];
}

export function registerMotionTools(pi: ExtensionAPI): void {
  const LIBRARY_ROOT = process.env.AVG_LIBRARY_ROOT || join(process.cwd(), "library");
  const identity = {
    channel: Type.String({ description: "Channel slug" }),
    series: Type.String({ description: "Series slug" }),
    episode: Type.String({ description: "Episode slug" }),
  };
  const facing = (description: string) => Type.Optional(StringEnum(FACINGS as unknown as [Facing, ...Facing[]], { default: "+z", description }));

  type Ref = { channel: string; series: string; episode: string };
  const inEpisode = async (ref: Ref, path: string, what: string, extensions: RegExp): Promise<string> => {
    const guard = await guardEpisodePath(LIBRARY_ROOT, ref.channel, ref.series, ref.episode, path);
    if (!guard.allowed) throw new Error(guard.reason ?? `${what} path rejected: ${path}`);
    const full = join(episodePath(LIBRARY_ROOT, ref.channel, ref.series, ref.episode), path);
    if (!existsSync(full) || !statSync(full).isFile()) throw new Error(`${what} not found: ${path}`);
    if (!extensions.test(full)) throw new Error(`${what} must be ${extensions.source.includes("fbx") ? "a .glb or an .fbx" : "a binary glTF (.glb)"}: ${path}`);
    return full;
  };
  const freshClip = (rigFull: string, name: string, overwrite: boolean | undefined): void => {
    if (!CLIP_NAME.test(name)) throw new Error("name must contain only letters, numbers, underscores and hyphens (max 48)");
    if (existsSync(clipPathOf(rigFull, name)) && !overwrite) throw new Error(`the rig already has a clip named ${name}: pick another name, or pass overwrite: true`);
  };

  pi.registerTool({
    name: STOCK_CLIPS_TOOL,
    label: "Stock Clips",
    description:
      "List the stock clips Hyper3D can add to a rig it makes (walks, runs, jumps, gestures, sports, reactions, and clips for dogs, birds, fish, hoofed animals, lizards, rodents and turtles), free. " +
      "Each has an id, a name, how long it lasts and whether it comes round to where it began. Name up to ten by id in `clips` on pva_rig_model (engine hyper3d): they arrive with the rig, " +
      `filed under their names, at no price beyond the rig's. Narrow the list with category and search. For a motion that is not on the list, ${MOTION_TOOL} makes one from a sentence.`,
    parameters: Type.Object({
      category: Type.Optional(StringEnum(HYPER3D_CLIP_CATEGORIES as unknown as [Hyper3dClipCategory, ...Hyper3dClipCategory[]], { description: "The kind of body. Default: every kind" })),
      search: Type.Optional(Type.String({ description: "Words the clip's name or description must hold: \"walk\", \"wave\", \"sit\"" })),
    }),
    async execute(_toolCallId, params, signal) {
      const config = await resolveConfig();
      if (!config.falKeyRef) throw new Error("FAL_KEY env var not set");
      const answer = await createFalClient(config.falKeyRef).lookup(HYPER3D_CLIPS_ENDPOINT, params.category ? { category: params.category } : {}, signal);
      const clips = readStockClips(answer);
      return {
        content: [{ type: "text" as const, text: describeStockClips(clips, { ...(params.category ? { category: params.category } : {}), ...(params.search ? { search: params.search } : {}) }).join("\n") }],
        details: { clips } as unknown as Record<string, unknown>,
      };
    },
  });

  pi.registerTool({
    name: RETARGET_TOOL,
    label: "Carry a Clip to a Rig",
    description:
      "Carry a motion from one skeleton to a rig's own: a clip made for another rig, a motion from a library, a generated one. Local (Blender reads the clip), free, repeatable. " +
      "The source is an episode file, a .glb or an .fbx with a skeleton and at least one motion; the rig is a rigged .glb. Bones are paired by the part they play (hips, a thigh, a forearm), read from their names " +
      "in either of two conventions and from which side of the body they are on; every turn is copied in the world from the rest pose, so the two skeletons may name, point and size their bones differently, " +
      "and rest in different poses. Writes <rig>.clip.<name>.glb beside the rig — the rig's own body with this one motion — and its provenance. " +
      "Two-legged bodies only, unless you give `map` (source bone to target bone). The fingers and the face are not carried. " +
      `Then play it with ${RIG_SHEET_TOOL}: a motion is judged by eye.`,
    parameters: Type.Object({
      ...identity,
      rigPath: Type.String({ description: "The rig that will play the motion, episode-relative: assets/models/<rigId>.glb" }),
      sourcePath: Type.String({ description: "The file the motion is in, episode-relative: a .glb or an .fbx with a skeleton and a clip" }),
      name: Type.String({ description: "What the clip is called on the rig: letters, digits, _ and -. It becomes an action the form can list" }),
      action: Type.Optional(Type.String({ description: "Which of the source's clips, by name. Default: the longest" })),
      faces: facing("Which way the rig faces in its file. A rig from pva_rig_model faces +z"),
      sourceFaces: facing("Which way the source's body faces in its own file"),
      inPlace: Type.Optional(Type.Boolean({ description: "Keep the body where it stands: the hips rise and fall, and do not travel. For a walk a scene will move itself" })),
      map: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Bones the names did not pair, or paired wrongly: source bone → rig bone. Needed for a body that is not two-legged" })),
      overwrite: Type.Optional(Type.Boolean({ default: false, description: "Replace the rig's clip of this name" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const dir = episodePath(LIBRARY_ROOT, params.channel, params.series, params.episode);
      const rigFull = await inEpisode(params, params.rigPath, "Rig", /\.glb$/i);
      const sourceFull = await inEpisode(params, params.sourcePath, "Source", /\.(glb|fbx)$/i);
      freshClip(rigFull, params.name, params.overwrite);
      onUpdate?.({ content: [{ type: "text" as const, text: `Reading the motion in ${params.sourcePath}…` }], details: { rigPath: params.rigPath } });
      const carried = await carryClip({
        rigFull, sourceFull, name: params.name,
        ...(params.action ? { action: params.action } : {}), ...(params.faces ? { faces: params.faces } : {}), ...(params.sourceFaces ? { sourceFaces: params.sourceFaces } : {}),
        ...(params.inPlace ? { inPlace: true } : {}), ...(params.map ? { map: params.map } : {}), ...(signal ? { signal } : {}),
      }, { tool: RETARGET_TOOL });
      return {
        content: [{ type: "text" as const, text: describeCarried(carried, { clip: relative(dir, carried.clipFull), rig: params.rigPath }).join("\n") }],
        details: { clipPath: carried.clipFull, provenancePath: carried.provenanceFull, report: carried.report, failures: carried.failures },
        ...(carried.failures.length ? { isError: true as unknown as boolean } : {}),
      };
    },
  });

  pi.registerTool({
    name: MOTION_TOOL,
    label: "Generate Motion",
    description:
      `Make a motion from a sentence and put it on a rig: Hunyuan Motion through fal.ai, ${usd(HUNYUAN_MOTION.priceUsd)} a motion, reserved on the episode's spend ledger. ` +
      "A person's motion only (walking, waving, sitting down, a dance step): no animal, no object, no face, no fingers worth the name. " +
      `Say who does what, in order, in one sentence; ${HUNYUAN_MOTION.seconds.min}–${HUNYUAN_MOTION.seconds.max} seconds. ` +
      "What comes back is kept as assets/motion/<name>.fbx with its provenance, then carried to the rig as <rig>.clip.<name>.glb (as pva_retarget_clip does). " +
      "If it cannot be carried, the motion is still kept and paid for: carry it later with pva_retarget_clip. " +
      `Play it with ${RIG_SHEET_TOOL} before it is used: a generated motion is often not what was asked. The same seed and sentence give the same motion. Check pva_budget_status first.`,
    parameters: Type.Object({
      ...identity,
      rigPath: Type.String({ description: "The rig that will play the motion, episode-relative: assets/models/<rigId>.glb. Two-legged" }),
      name: Type.String({ description: "What the clip is called: letters, digits, _ and -" }),
      prompt: Type.String({ minLength: 3, maxLength: 500, description: "The motion in one sentence, in English: \"A person waves hello with the right hand, then bows.\"" }),
      seconds: Type.Optional(Type.Number({ minimum: HUNYUAN_MOTION.seconds.min, maximum: HUNYUAN_MOTION.seconds.max, description: `How long (default ${HUNYUAN_MOTION.seconds.default})` })),
      seed: Type.Optional(Type.Integer({ minimum: 0, description: "For the same motion again; another seed is another take" })),
      guidance: Type.Optional(Type.Number({ minimum: HUNYUAN_MOTION.guidance.min, maximum: HUNYUAN_MOTION.guidance.max, description: `How closely the sentence is followed (default ${HUNYUAN_MOTION.guidance.default})` })),
      faces: facing("Which way the rig faces in its file. A rig from pva_rig_model faces +z"),
      inPlace: Type.Optional(Type.Boolean({ description: "Keep the body where it stands" })),
      overwrite: Type.Optional(Type.Boolean({ default: false, description: "Replace the motion and the rig's clip of this name" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const dir = episodePath(LIBRARY_ROOT, params.channel, params.series, params.episode);
      const rigFull = await inEpisode(params, params.rigPath, "Rig", /\.glb$/i);
      freshClip(rigFull, params.name, params.overwrite);
      const motionDir = join(dir, "assets", "motion");
      const motionFull = join(motionDir, `${params.name}.fbx`);
      if (existsSync(motionFull) && !params.overwrite) throw new Error(`assets/motion/${params.name}.fbx already exists: pick another name, or pass overwrite: true`);
      const config = await resolveConfig();
      if (!config.falKeyRef) throw new Error("FAL_KEY env var not set");

      const parameters = {
        prompt: params.prompt,
        ...(params.seconds !== undefined ? { duration: params.seconds } : {}),
        ...(params.seed !== undefined ? { seed: params.seed } : {}),
        ...(params.guidance !== undefined ? { guidance_scale: params.guidance } : {}),
        output_format: "fbx",
      };
      const requestHash = sha256(Buffer.from(JSON.stringify({ ...parameters, at: Date.now() }))).slice(0, 20);
      const client = createFalClient(config.falKeyRef);
      const startedMs = Date.now();
      const heartbeat = setInterval(() => {
        onUpdate?.({ content: [{ type: "text" as const, text: `Motion ${params.name}: waiting on fal… ${Math.round((Date.now() - startedMs) / 1000)}s` }], details: { name: params.name } });
      }, HEARTBEAT_MS);
      heartbeat.unref?.();

      let result;
      try {
        result = await paidCall(
          { libraryRoot: LIBRARY_ROOT, channel: params.channel, series: params.series, episode: params.episode },
          {
            capability: "motion.generate", provider: "fal", model: hunyuanMotion.profileId, purpose: `motion ${params.name}`,
            estimate: { estimate: { currency: "USD", micros: toMicros(HUNYUAN_MOTION.priceUsd) }, priced: true, profile: hunyuanMotion.profileId },
          },
          async (spend) => {
            try {
              onUpdate?.({ content: [{ type: "text" as const, text: `Submitting ${params.name} (Hunyuan Motion, ~${usd(HUNYUAN_MOTION.priceUsd)})…` }], details: { name: params.name } });
              spend.sending();
              const made = await client.submitAndWait({
                idempotencyKey: `${params.channel}-${params.series}-${params.episode}-motion-${params.name}-${requestHash}`,
                binding: { endpointId: hunyuanMotion.endpointId, contractVersion: hunyuanMotion.contractVersion, baseUrl: "" },
                parameters, timeoutMs: MAX_WAIT_MS,
              }, signal, { maxWaitMs: MAX_WAIT_MS });
              return { value: made, cost: providerCost(made.cost), providerRequestId: made.providerRequestId };
            } catch (e) {
              // Refused before it ran: nothing was made. Anything else may have been billed and stays reserved.
              if (e instanceof FalValidationError || (e instanceof FalHttpError && e.status >= 400 && e.status < 500 && e.status !== 429)) spend.refused();
              throw e;
            }
          },
        );
      } finally {
        clearInterval(heartbeat);
      }

      const output = result.outputs.find((o) => o.role === "motion");
      if (!output) throw new Error("Hunyuan Motion completed without a motion");
      const fetched = await fetch(output.url, { signal });
      if (!fetched.ok) throw new Error(`Failed to download the motion (fal request ${result.providerRequestId}): HTTP ${fetched.status}`);
      const motionBytes = Buffer.from(await fetched.arrayBuffer());
      mkdirSync(motionDir, { recursive: true });
      writeFileSync(motionFull, motionBytes);
      const seed = result.details?.["seed"] !== undefined ? Number(result.details["seed"]) : params.seed;
      const generation = {
        provider: "fal.ai", model: "Hunyuan Motion", endpointId: hunyuanMotion.endpointId, profileId: result.profileId,
        providerRequestId: result.providerRequestId, prompt: params.prompt,
        ...(params.seconds !== undefined ? { seconds: params.seconds } : {}), ...(seed !== undefined ? { seed } : {}),
        ...(params.guidance !== undefined ? { guidance: params.guidance } : {}),
        estimatedCost: { amount: HUNYUAN_MOTION.priceUsd, currency: "USD" }, cost: result.cost,
      };
      writeFileSync(join(motionDir, `${params.name}.provenance.json`), `${JSON.stringify({
        version: 1, file: `${params.name}.fbx`, sha256: sha256(motionBytes), bytes: motionBytes.length, ...generation, completedAt: result.completedAt.toISOString(),
      }, null, 2)}\n`);

      const price = result.cost ? `$${result.cost.amount}` : `~${usd(HUNYUAN_MOTION.priceUsd)}`;
      const kept = `assets/motion/${params.name}.fbx — ${(motionBytes.length / 1024 / 1024).toFixed(1)}MB, Hunyuan Motion${seed !== undefined ? `, seed ${seed}` : ""}, ${price}`;
      let carried;
      try {
        carried = await carryClip({
          rigFull, sourceFull: motionFull, name: params.name,
          ...(params.faces ? { faces: params.faces } : {}), ...(params.inPlace ? { inPlace: true } : {}), ...(signal ? { signal } : {}),
        }, { tool: MOTION_TOOL, generation });
      } catch (error) {
        return {
          content: [{
            type: "text" as const,
            text: [
              `⚠️ ${kept}`,
              `   it was made and paid for, and could not be put on the rig: ${error instanceof Error ? error.message : String(error)}`,
              `   carry it when the cause is fixed: ${RETARGET_TOOL} { channel, series, episode, rigPath: "${params.rigPath}", sourcePath: "assets/motion/${params.name}.fbx", name: "${params.name}" }`,
            ].join("\n"),
          }],
          details: { motionPath: motionFull, providerRequestId: result.providerRequestId, cost: result.cost, estimatedCostUsd: HUNYUAN_MOTION.priceUsd },
          isError: true as unknown as boolean,
        };
      }
      return {
        content: [{ type: "text" as const, text: [...describeCarried(carried, { clip: relative(dir, carried.clipFull), rig: params.rigPath }), `   the motion as it came: ${kept}`].join("\n") }],
        details: {
          clipPath: carried.clipFull, motionPath: motionFull, provenancePath: carried.provenanceFull, report: carried.report, failures: carried.failures,
          providerRequestId: result.providerRequestId, cost: result.cost, estimatedCostUsd: HUNYUAN_MOTION.priceUsd, ...(seed !== undefined ? { seed } : {}),
        },
        ...(carried.failures.length ? { isError: true as unknown as boolean } : {}),
      };
    },
  });
}

/** Whether a motion can be made here: for the capability report. */
export function motionTerms(): string {
  return `${MOTION_TOOL}: a sentence → a person's motion on a rig, ${usd(HUNYUAN_MOTION.priceUsd)} a motion; ${RETARGET_TOOL}: a clip carried from another skeleton, local and free`;
}
