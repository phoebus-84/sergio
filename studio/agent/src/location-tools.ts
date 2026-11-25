// ---------------------------------------------------------------------------
// A location's 3D set (ADR-0057)
// ---------------------------------------------------------------------------
// A film's location is an entry in its bible and a few pictures. A *set* is
// that place in three dimensions, made once from those pictures by World Labs
// Atlas, from which every angle is then taken: stills to hold a generated
// shot to, a mesh for Blender's camera, a plate to build on.
//
// It is made in steps, each paid, each looked at before the next:
//
//   pva_location_set     pictures → posed frames (cameras and depth)
//   pva_location_views   posed frames + a path of cameras → stills, a plate
//   pva_location_splat   frames → a Gaussian splat: a draft first, the
//                        refined one only on the operator's word
//   pva_location_mesh    a splat → a GLB for pva_stage_shot
//   pva_location_sets    what a film's sets hold, and their jobs
//
// Shaped like the other paid tools: paths are guarded, every paid step is
// reserved and settled on the film's spend ledger at the price of what is
// asked, and everything lands in the film, under locations/<name>/sets/<set>/,
// with a provenance record per operation and the licence it was made under.
// What is its own:
//
// - a job outlasts a tool call. An operation's id is written into the set
//   (jobs/<step>.json) the moment Atlas accepts it; a wait that runs out, or
//   a session that ends, is taken up by calling the same tool again, which
//   waits on that operation and submits nothing;
// - a price nobody published is the operator's to give, in
//   library/.render/worldlabs-atlas.json. Without it the step is unpriced,
//   and a film with a budget refuses it;
// - a set is never written over: a quality's splat is made once, a views id
//   is used once, a retake is another set.
//
// The provider's API had not been met when this was written. What the tools
// say about that comes from the package's own mark (`WIRE.verifiedLive`).
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import {
  API_KEY_ENV, ATLAS_TARGET_SIZES, AtlasCancelledError, AtlasHttpError, AtlasOperationError, AtlasValidationError, MESH_TEXTURES, PRICE_KEYS, WIRE,
  atlasGenerateBody, collectFiles, createAtlasClient, creditsToUsd, describePrices, estimate, frameCamera, images2PosedRGBDBody, orbit, placed,
  posedImages2SplatsBody, provenanceOf, push, readGeneratedFrames, readPosedFrames, sceneFocus, sha256, splats2MeshBody, wireCamera,
  type AtlasCamera, type AtlasClient, type AtlasClientOptions, type AtlasEstimate, type AtlasEvent, type AtlasTask, type MeshTexture, type OperatorCredits,
  type PosedFrame, type PriceKey, type TaskRun,
} from "@av/worldlabs-atlas";
import { toMicros } from "@studio/contracts/src/budget.mjs";
import { SELF, channelPath, projectKind } from "@studio/contracts/src/layout.mjs";
import { describeModel, pictureExtension, summarizeModel, type ModelSummary } from "./model-tools.js";
import { paidCall } from "./spend.js";
import { guardPath } from "./trust-guards.js";

export const LOCATION_SET_TOOL = "pva_location_set";
export const LOCATION_VIEWS_TOOL = "pva_location_views";
export const LOCATION_SPLAT_TOOL = "pva_location_splat";
export const LOCATION_MESH_TOOL = "pva_location_mesh";
export const LOCATION_SETS_TOOL = "pva_location_sets";

/** The operator's account, as far as it is not a secret: beside the other providers' files. */
export const ATLAS_SETTINGS_RELATIVE = join(".render", "worldlabs-atlas.json");
export const ATLAS_PROVIDER = "worldlabs-atlas";
/** The studio's own limits; the provider's were not known. */
export const LOCATION_LIMITS = { pictures: 32, views: 48, frames: 64 } as const;
export const SPLAT_QUALITIES = ["draft", "refined"] as const;
export type SplatQuality = (typeof SPLAT_QUALITIES)[number];
export const VIEW_PATHS = ["orbit", "push", "cameras"] as const;
export const VIEW_SIZES = ATLAS_TARGET_SIZES.map(([width, height]) => `${width}x${height}`) as [string, ...string[]];

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PICTURE_TYPES: Readonly<Record<string, string>> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const DEFAULT_MAX_WAIT_MINUTES = 45;
const HEARTBEAT_MS = 15_000;

const usd = (amount: number) => `$${Number(amount.toFixed(4))}`;
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

// ── The operator's settings ─────────────────────────────────────────────────

export interface AtlasSettings {
  /** The plan the key belongs to, as the operator states it: the API does not say. */
  plan: "paid" | "free" | null;
  /** Prices from the account's rate card, in credits. */
  credits: OperatorCredits;
  maxWaitMinutes: number;
  /** What in the file could not be used. */
  problems: string[];
}

/** library/.render/worldlabs-atlas.json, or what holds without it. Never throws: a broken file is said, not fatal. */
export function readAtlasSettings(libraryRoot: string): AtlasSettings {
  const settings: AtlasSettings = { plan: null, credits: {}, maxWaitMinutes: DEFAULT_MAX_WAIT_MINUTES, problems: [] };
  const file = join(libraryRoot, ATLAS_SETTINGS_RELATIVE);
  if (!existsSync(file)) return settings;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("it is not an object");
  } catch (e) {
    settings.problems.push(`${ATLAS_SETTINGS_RELATIVE} could not be read: ${e instanceof Error ? e.message : String(e)}`);
    return settings;
  }
  if (raw.plan === "paid" || raw.plan === "free") settings.plan = raw.plan;
  else if (raw.plan !== undefined) settings.problems.push(`plan is "paid" or "free", not ${JSON.stringify(raw.plan)}`);
  const credits: Partial<Record<PriceKey, number>> = {};
  for (const [key, value] of Object.entries((raw.credits ?? {}) as Record<string, unknown>)) {
    if (!PRICE_KEYS.includes(key as PriceKey)) settings.problems.push(`credits.${key} is not a price this studio knows: ${PRICE_KEYS.join(", ")}`);
    else if (typeof value !== "number" || !Number.isFinite(value) || value < 0) settings.problems.push(`credits.${key} is a number of credits, not ${JSON.stringify(value)}`);
    else credits[key as PriceKey] = value;
  }
  settings.credits = credits;
  if (typeof raw.maxWaitMinutes === "number" && raw.maxWaitMinutes >= 1 && raw.maxWaitMinutes <= 180) settings.maxWaitMinutes = raw.maxWaitMinutes;
  else if (raw.maxWaitMinutes !== undefined) settings.problems.push("maxWaitMinutes is from 1 to 180");
  return settings;
}

/**
 * Under which terms a set may be used. The studio did not read the terms and
 * does not judge them: it writes down the plan the operator stated and what
 * was reported of that plan, and treats an unstated plan as the stricter one.
 */
export function licenceOf(settings: AtlasSettings): Record<string, unknown> {
  return {
    version: 1,
    provider: "World Labs Atlas",
    plan: settings.plan ?? "unstated",
    statedBy: settings.plan ? `the operator, in ${ATLAS_SETTINGS_RELATIVE}` : null,
    commercialUse: settings.plan === "paid",
    basis: settings.plan === "paid"
      ? "Paid API access is reported to permit commercial use, subject to the agreement."
      : settings.plan === "free"
        ? "Outputs of a free account are reported to be licensed for personal, non-commercial use only, with rights kept by World Labs."
        : `No plan was stated (${ATLAS_SETTINGS_RELATIVE}, "plan"): treated as a free account's, not for commercial use, until it is.`,
    inputs: "What is uploaded may be used by World Labs, training included; paid users are reported to be able to opt out.",
    terms: "https://worldlabs.ai/terms-of-service",
    termsReadByStudio: false,
    note: "Reported terms, from docs/notes/worldlabs-atlas-api.md. Read the terms of the plan in use before a set, or anything made from it, is published.",
  };
}

const licenceLine = (settings: AtlasSettings) => settings.plan === "paid"
  ? "licence: paid plan, as the operator states it — reported to allow commercial use (licence.json)"
  : `⚠️ licence: ${settings.plan === "free" ? "free plan" : `no plan stated in ${ATLAS_SETTINGS_RELATIVE}`} — not for commercial use (licence.json)`;

// ── A set on disk ───────────────────────────────────────────────────────────

interface FileRecord { file: string; sha256: string; bytes: number }
interface StepRecord { operationId: string; at: string; costUsd: number | null; costBasis: string }

export interface LocationSetRecord {
  version: 1;
  film: string;
  location: string;
  set: string;
  provider: typeof ATLAS_PROVIDER;
  createdAt: string;
  /** The pictures it was made from, by their path in the film. */
  pictures: (FileRecord & { width?: number; height?: number })[];
  posed?: StepRecord & { frames: number; camerasRead: number; kept: string[] };
  views: Record<string, StepRecord & { dir: string; frames: number; width: number; height: number; path: string; plate?: string }>;
  splats: Partial<Record<SplatQuality, StepRecord & FileRecord & { assetId: string | null; frames: number; withViews: string[]; approvedBy?: string }>>;
  meshes: Record<string, StepRecord & FileRecord & { from: SplatQuality; holds: ModelSummary; texture?: string; targetFaces?: number }>;
}

interface PendingJob {
  step: string;
  task: AtlasTask;
  operationId: string;
  /** What was asked, as its hash: a call for something else must not collect this job as its own. */
  asked: string;
  submittedAt: string;
  price: AtlasEstimate;
  request: Record<string, unknown>;
}

interface SetPlace {
  filmDir: string;
  /** Absolute. */
  dir: string;
  /** Film-relative, as it is shown. */
  shown: string;
}

function setPlace(libraryRoot: string, film: string, location: string, set: string): SetPlace {
  for (const [what, value] of [["film", film], ["location", location], ["set", set]] as const) {
    if (!NAME.test(value)) throw new Error(`${what} is a slug: lower-case letters, digits, underscores and hyphens (max 64), not "${value}"`);
  }
  if (projectKind(libraryRoot, film) !== "film") throw new Error(`${film} is not a film: a location's set belongs to a film (library/${film}/film.yaml). Create one with pva_create_film`);
  const filmDir = channelPath(libraryRoot, film);
  const shown = `locations/${location}/sets/${set}`;
  return { filmDir, dir: join(filmDir, shown), shown };
}

const recordPath = (place: SetPlace) => join(place.dir, "set.json");

function readRecord(place: SetPlace): LocationSetRecord | null {
  if (!existsSync(recordPath(place))) return null;
  return JSON.parse(readFileSync(recordPath(place), "utf-8")) as LocationSetRecord;
}

function requireRecord(place: SetPlace): LocationSetRecord {
  const record = readRecord(place);
  if (!record?.posed) throw new Error(`${place.shown} has no posed frames yet: start it with ${LOCATION_SET_TOOL} { film, location, set, pictures }`);
  return record;
}

const writeRecord = (place: SetPlace, record: LocationSetRecord) => writeFileSync(recordPath(place), json(record));
const jobPath = (place: SetPlace, step: string) => join(place.dir, "jobs", `${step}.json`);

/** A job that is over, one way or another: its note goes, and the folder with the last of them. */
function forgetJob(place: SetPlace, step: string): void {
  rmSync(jobPath(place, step), { force: true });
  const dir = join(place.dir, "jobs");
  if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
}

function pendingJobs(place: SetPlace): PendingJob[] {
  const dir = join(place.dir, "jobs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json")).sort().map((name) => JSON.parse(readFileSync(join(dir, name), "utf-8")) as PendingJob);
}

/** A picture's size from its first bytes: PNG and JPEG. null for anything else. */
export function pictureSize(bytes: Uint8Array): { width: number; height: number } | null {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.length >= 24 && data.readUInt32BE(0) === 0x89504e47) return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  for (let at = 2; at + 9 < data.length;) {
    if (data[at] !== 0xff) return null;
    const marker = data[at + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: data.readUInt16BE(at + 5), width: data.readUInt16BE(at + 7) };
    at += 2 + data.readUInt16BE(at + 2);
  }
  return null;
}

// ── A paid step ─────────────────────────────────────────────────────────────

export interface LocationToolDeps {
  /** In tests: a client that talks to a fake. */
  client?: (options: Pick<AtlasClientOptions, "onEvent">) => AtlasClient;
}

interface StepContext {
  libraryRoot: string;
  film: string;
  place: SetPlace;
  settings: AtlasSettings;
  client: () => AtlasClient;
  signal: AbortSignal | undefined;
  say: (text: string) => void;
}

interface Step {
  /** The step's name in the set: one job of it can be pending. */
  step: string;
  task: AtlasTask;
  capability: "world.reconstruct" | "world.mesh" | "world.render";
  purpose: string;
  price: AtlasEstimate;
  /** What decides the result, as the caller asked for it: two calls that differ here are two jobs. */
  asked: unknown;
  /** The request's body. What it needs uploaded is uploaded here: free, and before anything is sent. */
  prepare: (client: AtlasClient) => Promise<Record<string, unknown>>;
}

const priceText = (price: AtlasEstimate) => price.priced
  ? `~${usd(price.usd)} (${price.credits} credits, ${price.basis === "operator" ? "the operator's price" : "published"})`
  : "no price known";

interface StepDone {
  run: TaskRun;
  request: Record<string, unknown>;
  resumed: boolean;
  /** Call when what the job made is on disk and in the set's record: only then is its note dropped. */
  collected: () => void;
}

/**
 * Reserve, submit, wait, settle — or, when a job of this step is already
 * written in the set, wait for that one and reserve nothing: it was settled
 * when its first wait ended.
 *
 * The job's note outlives the wait on purpose. It is dropped by `collected`,
 * once its files are kept: a download that fails after a job succeeded is
 * then one more call of the same tool, not one more payment.
 *
 * A caller who gives up stops the waiting, not the job: stopping a job is
 * asked for by name (pva_location_sets { cancel }), because what a job
 * stopped part-way is charged is not known.
 */
async function paidStep(ctx: StepContext, step: Step): Promise<StepDone> {
  const pending = jobPath(ctx.place, step.step);
  const collected = () => forgetJob(ctx.place, step.step);
  const wait = { maxWaitMs: ctx.settings.maxWaitMinutes * 60_000, ...(ctx.signal ? { signal: ctx.signal } : {}) };
  /** A job that ended there, or that Atlas was asked to stop, is not one to take up again. */
  const over = (e: unknown) => e instanceof AtlasOperationError || (e instanceof AtlasCancelledError && e.cancelledThere);

  const asked = sha256(JSON.stringify(step.asked));
  if (existsSync(pending)) {
    const job = JSON.parse(readFileSync(pending, "utf-8")) as PendingJob;
    if (job.asked !== asked) {
      throw new Error(
        `${ctx.place.shown} already has a job for this step (${step.step}, Atlas operation ${job.operationId}, submitted ${job.submittedAt}), and it was asked for something else. ` +
          `Call this tool with the arguments it was started with to collect it, or stop it with ${LOCATION_SETS_TOOL} { cancel }: nothing was submitted now`,
      );
    }
    ctx.say(`Taking up Atlas operation ${job.operationId} again (${step.step}, submitted ${job.submittedAt}): nothing is submitted, nothing more is reserved`);
    try {
      const run = await ctx.client().resume(job.task, job.operationId, wait);
      return { run, request: job.request, resumed: true, collected };
    } catch (e) {
      if (over(e)) forgetJob(ctx.place, step.step);
      throw e;
    }
  }

  let request: Record<string, unknown> = {};
  let accepted = false;
  let outcome: { run: TaskRun } | { failed: AtlasOperationError };
  try {
    outcome = await paidCall<{ run: TaskRun } | { failed: AtlasOperationError }>(
      { libraryRoot: ctx.libraryRoot, channel: ctx.film, series: SELF, episode: SELF },
      {
        capability: step.capability, provider: ATLAS_PROVIDER, model: `${ATLAS_PROVIDER}/${step.price.key}`, purpose: step.purpose,
        estimate: { estimate: { currency: "USD", micros: toMicros(step.price.usd) }, priced: step.price.priced, profile: `${ATLAS_PROVIDER}/${step.price.key}` },
      },
      async (spend) => {
        try {
          request = await step.prepare(ctx.client());
          // Said here, after the reservation: a step the budget refuses was never submitted.
          ctx.say(`Submitting ${step.purpose} to Atlas (tasks:${step.task}, ${priceText(step.price)})…`);
          spend.sending();
          const run = await ctx.client().run(step.task, request, {
            ...wait,
            onSubmitted: (operation) => {
              accepted = true;
              mkdirSync(join(ctx.place.dir, "jobs"), { recursive: true });
              writeFileSync(pending, json({ step: step.step, task: step.task, operationId: operation.id, asked, submittedAt: new Date().toISOString(), price: step.price, request } satisfies PendingJob));
            },
          });
          return { value: { run }, cost: run.cost ? { currency: "USD", micros: toMicros(run.cost.usd) } : null, providerRequestId: run.operation.id };
        } catch (e) {
          // Refused before it left, or by Atlas when it arrived: nothing ran.
          if (e instanceof AtlasValidationError || (e instanceof AtlasHttpError && e.refused && !accepted)) spend.refused();
          if (over(e)) forgetJob(ctx.place, step.step);
          // A run that failed there and says what it was charged is settled at that, not at the estimate.
          if (e instanceof AtlasOperationError && e.credits !== null) {
            return { value: { failed: e }, cost: { currency: "USD", micros: toMicros(creditsToUsd(e.credits)) }, providerRequestId: e.operationId };
          }
          // Anything else after it left — a wait that ran out, a failure with no charge stated — stays reserved at the estimate.
          throw e;
        }
      },
    );
  } catch (e) {
    if ((e as { code?: string }).code === "BUDGET_UNPRICED") {
      throw new Error(
        `${(e as Error).message}. Atlas publishes no price for ${step.price.key}: read it on the account's rate card and write it, in credits, ` +
          `in library/${ATLAS_SETTINGS_RELATIVE} as { "credits": { "${step.price.key}": <credits> } } (1,000 credits to the dollar)`,
      );
    }
    if (e instanceof Error && existsSync(pending)) e.message += `. The job is written in ${ctx.place.shown}/jobs/${step.step}.json: call this tool again with the same arguments to wait for it without paying twice, or stop it with ${LOCATION_SETS_TOOL} { cancel }`;
    throw e;
  }
  if ("failed" in outcome) throw outcome.failed;
  return { run: outcome.run, request, resumed: false, collected };
}

/** Keep how a step was made, beside what it made. */
function keepProvenance(ctx: StepContext, step: Step, done: StepDone, tool: string): StepRecord {
  const dir = join(ctx.place.dir, "provenance");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${done.run.operation.id}.json`), json({
    tool, film: ctx.film, set: ctx.place.shown, step: step.step, capability: step.capability,
    ...provenanceOf(done.run, done.request, step.price),
    ...(done.resumed ? { resumed: true } : {}),
    licence: licenceOf(ctx.settings),
  }));
  const cost = done.run.cost;
  return {
    operationId: done.run.operation.id, at: new Date().toISOString(),
    costUsd: cost ? cost.usd : step.price.priced ? step.price.usd : null,
    costBasis: cost ? "provider" : step.price.priced ? `estimate (${step.price.basis})` : "unknown",
  };
}

const costText = (record: StepRecord) => record.costUsd === null ? "cost not known" : `${record.costBasis === "provider" ? "" : "~"}${usd(record.costUsd)} (${record.costBasis})`;

/** Said once per result while the API is unmet. */
const unverifiedLine = () => WIRE.verifiedLive
  ? null
  : "   ⚠️ this studio's reading of Atlas's API has not been confirmed by a real run: if what came back looks wrong, read provenance/<operation>.json before paying again";

// ── Tools ───────────────────────────────────────────────────────────────────

export function registerLocationTools(pi: ExtensionAPI, deps: LocationToolDeps = {}): void {
  const LIBRARY_ROOT = process.env.AVG_LIBRARY_ROOT || join(process.cwd(), "library");

  const SET_PARAMS = {
    film: Type.String({ description: "The film's slug" }),
    location: Type.String({ description: "The location's slug, as in locations/<location>.md" }),
    set: Type.String({ description: "The set's name (lower-case letters, digits, _ and -): locations/<location>/sets/<set>/" }),
  };

  type Update = ((update: { content: { type: "text"; text: string }[]; details: Record<string, unknown> }) => void) | undefined;

  function context(params: { film: string; location: string; set: string }, signal: AbortSignal | undefined, onUpdate: Update): StepContext {
    const place = setPlace(LIBRARY_ROOT, params.film, params.location, params.set);
    const say = (text: string) => onUpdate?.({ content: [{ type: "text" as const, text }], details: { set: place.shown } });
    let lastBeat = 0;
    const onEvent = (event: AtlasEvent) => {
      if (event.kind === "retrying") say(`Atlas: ${event.note}`);
      if (event.kind !== "waiting" || Date.now() - lastBeat < HEARTBEAT_MS) return;
      lastBeat = Date.now();
      say(`Atlas operation ${event.operationId}: ${event.state}${event.progress !== null && event.progress !== undefined ? ` ${Math.round(event.progress * 100)}%` : ""}, ${Math.round((event.waitedMs ?? 0) / 1000)}s`);
    };
    let client: AtlasClient | undefined;
    return {
      libraryRoot: LIBRARY_ROOT, film: params.film, place, settings: readAtlasSettings(LIBRARY_ROOT), signal, say,
      client: () => (client ??= deps.client ? deps.client({ onEvent }) : createAtlasClient({ onEvent })),
    };
  }

  /** A file a result named, onto disk; its extension from the bytes when they say, else from its name. */
  async function keep(ctx: StepContext, file: { url?: string; assetId?: string; fileName?: string }, directory: string, stem: string, fallback: string): Promise<FileRecord> {
    const bytes = await ctx.client().download(file, ctx.signal);
    const named = extname(file.fileName ?? "").toLowerCase() || extname(new URL(file.url ?? "file:///x").pathname).toLowerCase();
    const extension = pictureExtension(bytes) ?? (named || fallback);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${stem}${extension}`), bytes);
    return { file: `${stem}${extension}`, sha256: sha256(bytes), bytes: bytes.byteLength };
  }

  const settingsLines = (settings: AtlasSettings) => settings.problems.map((problem) => `   ⚠️ ${ATLAS_SETTINGS_RELATIVE}: ${problem}`);
  const tail = (ctx: StepContext, ...lines: (string | null)[]) => [...lines, `   ${licenceLine(ctx.settings)}`, unverifiedLine(), ...settingsLines(ctx.settings)].filter((line): line is string => line !== null);

  // --- pva_location_set: pictures → posed frames ----------------------------

  pi.registerTool({
    name: LOCATION_SET_TOOL,
    label: "Start a Location's 3D Set",
    description:
      "Start a 3D set of a film's location from pictures of it: World Labs Atlas estimates each picture's camera and depth (images2PosedRGBD), which is what every later step is made from. " +
      "Paid, on the film's spend ledger (capability world.reconstruct); Atlas publishes no price for this step, so under a budget the operator gives it in library/.render/worldlabs-atlas.json. Check pva_budget_status first. " +
      "The pictures decide everything: one place, wide or medium views, overlapping, taken from positions that differ and not only turned on the spot; all of one size; nothing that moves (people, cars, water). Two or three can do, 8–16 make a room. " +
      "They are files of the film (locations/<location>/…, references/…, footage stills), uploaded to World Labs: do not send a picture of a real person or a private place without the right to. " +
      `Saves locations/<location>/sets/<set>/ (set.json, posed.json, the depth maps, provenance/, licence.json). Next: ${LOCATION_VIEWS_TOOL} to see the place from other sides, then ${LOCATION_SPLAT_TOOL}. ` +
      "A set is made once: other pictures are another set. If the wait runs out, call again with the same arguments: it waits for the same job and pays nothing more.",
    parameters: Type.Object({
      ...SET_PARAMS,
      pictures: Type.Array(Type.String(), { minItems: 1, maxItems: LOCATION_LIMITS.pictures, description: "The pictures, film-relative (png, jpg or webp), in a sensible order round the place" }),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const ctx = context(params, signal, onUpdate);
      const existing = readRecord(ctx.place);
      if (existing?.posed) throw new Error(`${ctx.place.shown} already has its posed frames: go on with ${LOCATION_VIEWS_TOOL} or ${LOCATION_SPLAT_TOOL}. Other pictures are another set`);
      if (new Set(params.pictures).size !== params.pictures.length) throw new Error("a picture is named twice");

      const pictures: (LocationSetRecord["pictures"][number] & { full: string; type: string })[] = [];
      for (const relative of params.pictures) {
        const guard = await guardPath(ctx.place.filmDir, relative);
        if (!guard.allowed) throw new Error(guard.reason ?? `Picture path rejected: ${relative}`);
        const full = join(ctx.place.filmDir, relative);
        if (!existsSync(full) || !statSync(full).isFile()) throw new Error(`Picture not found in the film: ${relative}`);
        const type = PICTURE_TYPES[extname(full).toLowerCase()];
        if (!type) throw new Error(`Unsupported picture type: ${relative} (png, jpg or webp)`);
        const bytes = readFileSync(full);
        const size = pictureSize(bytes);
        pictures.push({ file: relative, sha256: sha256(bytes), bytes: bytes.length, ...(size ?? {}), full, type });
      }
      if (existing && JSON.stringify(existing.pictures.map((p) => p.sha256)) !== JSON.stringify(pictures.map((p) => p.sha256))) {
        throw new Error(`${ctx.place.shown} was started with other pictures (${existing.pictures.map((p) => p.file).join(", ")}): give those again to go on, or start another set`);
      }
      const sizes = new Set(pictures.filter((p) => p.width).map((p) => `${p.width}×${p.height}`));

      const record: LocationSetRecord = existing ?? {
        version: 1, film: params.film, location: params.location, set: params.set, provider: ATLAS_PROVIDER, createdAt: new Date().toISOString(),
        pictures: pictures.map(({ full: _full, type: _type, ...kept }) => kept), views: {}, splats: {}, meshes: {},
      };

      const step: Step = {
        step: "pose", task: "images2PosedRGBD", capability: "world.reconstruct", purpose: `location ${params.location}, set ${params.set}: pose ${pictures.length} pictures`,
        price: estimate("images2PosedRGBD", {}, ctx.settings.credits),
        asked: pictures.map((picture) => picture.sha256),
        prepare: async (client) => {
          // The set begins here: once the step is reserved, and before anything is sent, so a job taken up later finds what it was for.
          mkdirSync(ctx.place.dir, { recursive: true });
          writeRecord(ctx.place, record);
          writeFileSync(join(ctx.place.dir, "licence.json"), json(licenceOf(ctx.settings)));
          const assets = [];
          for (const [index, picture] of pictures.entries()) {
            ctx.say(`Uploading ${picture.file} (${index + 1}/${pictures.length})…`);
            assets.push(await client.uploadFile({ bytes: readFileSync(picture.full), fileName: `picture-${String(index + 1).padStart(3, "0")}${extname(picture.full).toLowerCase()}`, contentType: picture.type }, signal));
          }
          return images2PosedRGBDBody({ images: assets });
        },
      };
      const done = await paidStep(ctx, step);
      const frames = readPosedFrames(done.run.operation.response);
      writeFileSync(join(ctx.place.dir, "posed.json"), json({ operationId: done.run.operation.id, frames }));
      // What came back beside the pictures themselves, the depth maps above all: kept, so the set does not live only at the provider.
      const kept: string[] = [];
      for (const file of done.run.files.filter((f) => f.kind !== "image").slice(0, LOCATION_LIMITS.frames * 2)) {
        const index = /\[(\d+)\]/.exec(file.path)?.[1] ?? String(kept.length);
        try {
          kept.push(`posed/${(await keep(ctx, file, join(ctx.place.dir, "posed"), `${file.kind}-${String(Number(index) + 1).padStart(3, "0")}`, file.kind === "depth" ? ".exr" : ".bin")).file}`);
        } catch { /* a depth map that cannot be fetched is not the set */ }
      }
      const camerasRead = frames.filter((frame) => frameCamera(frame) !== null).length;
      record.posed = { ...keepProvenance(ctx, step, done, LOCATION_SET_TOOL), frames: frames.length, camerasRead, kept };
      writeRecord(ctx.place, record);
      done.collected();

      return {
        content: [{
          type: "text" as const,
          text: tail(ctx,
            `✅ ${ctx.place.shown} — ${frames.length} posed frame${frames.length === 1 ? "" : "s"} from ${pictures.length} picture${pictures.length === 1 ? "" : "s"}, ${costText(record.posed)}, ${Math.round((done.run.finishedAtMs - done.run.startedAtMs) / 1000)}s${done.resumed ? " (a job taken up again)" : ""}`,
            `   posed.json holds the frames as Atlas returned them; ${kept.length} depth map${kept.length === 1 ? "" : "s"} kept in posed/`,
            sizes.size > 1 ? `   ⚠️ the pictures are of ${sizes.size} sizes (${[...sizes].join(", ")}): Atlas is reported to want one size for a splat` : null,
            camerasRead === frames.length ? null : `   ⚠️ the cameras of ${frames.length - camerasRead} frame${frames.length - camerasRead === 1 ? "" : "s"} could not be read here: ${LOCATION_VIEWS_TOOL} can then only take cameras given in full (path "cameras")`,
            `   next: ${LOCATION_VIEWS_TOOL} { film, location, set, viewsId, path: "orbit" } to see the place from other sides before paying for a splat; ` +
              `then ${LOCATION_SPLAT_TOOL} { film, location, set } for a draft`,
          ).join("\n"),
        }],
        details: { setPath: ctx.place.dir, frames: frames.length, camerasRead, operationId: done.run.operation.id, cost: done.run.cost, estimate: step.price },
      };
    },
  });

  // --- pva_location_views: a path of cameras → stills and a plate ------------

  pi.registerTool({
    name: LOCATION_VIEWS_TOOL,
    label: "Render Views of a Location's Set",
    description:
      "See a location's set from cameras it is given: World Labs Atlas renders the place from each one (atlasGenerate), held to the set's posed frames. Stills for a generator's references, and joined into a plate when asked. " +
      "Paid per view, on the film's spend ledger (capability world.render); the price per view is the operator's to give (atlasGenerate.perView in library/.render/worldlabs-atlas.json). " +
      `A path is: "orbit" — \`count\` cameras on an arc of \`sweepDegrees\` round what the pictures look at, starting from posed frame \`from\`; "push" — \`count\` cameras going \`distance\` along that frame's line of sight; ` +
      '"cameras" — each given as where it stands and what it looks at, in the set\'s own coordinates (y up; the units are the reconstruction\'s, not metres). The whole path goes in one request. ' +
      `720p at most (${VIEW_SIZES.join(", ")}): these are references and plates, never a film's final picture. What no picture showed is invented: look at every view. ` +
      `Saves locations/<location>/sets/<set>/views/<viewsId>/ (numbered stills, views.json, plate.mp4 with \`plate\`). Views that hold up can join the splat: ${LOCATION_SPLAT_TOOL} { withViews }. A viewsId is used once.`,
    parameters: Type.Object({
      ...SET_PARAMS,
      viewsId: Type.String({ description: "A name for these views (lower-case letters, digits, _ and -)" }),
      path: StringEnum(VIEW_PATHS as unknown as [string, ...string[]], { description: "orbit, push, or cameras given in full" }),
      from: Type.Optional(Type.Integer({ minimum: 1, description: "orbit, push: the posed frame the path starts from, counted from 1. Default 1" })),
      sweepDegrees: Type.Optional(Type.Number({ minimum: -360, maximum: 360, description: "orbit: how far round, in degrees; negative goes the other way. Default 60" })),
      distance: Type.Optional(Type.Number({ description: "push: how far along the line of sight, in the set's units; negative pulls back. Required for push" })),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: LOCATION_LIMITS.views, description: "orbit, push: how many views. Default 8. Each is paid" })),
      cameras: Type.Optional(Type.Array(Type.Object({
        at: Type.Array(Type.Number(), { minItems: 3, maxItems: 3, description: "Where it stands: x, y, z (y up)" }),
        lookAt: Type.Array(Type.Number(), { minItems: 3, maxItems: 3, description: "What it looks at" }),
        fov: Type.Optional(Type.Number({ minimum: 10, maximum: 120, description: "Vertical field of view, degrees. Default 50" })),
      }), { minItems: 1, maxItems: LOCATION_LIMITS.views, description: "cameras: the path, in order" })),
      size: Type.Optional(StringEnum(VIEW_SIZES, { default: VIEW_SIZES[0], description: "Width x height. Use the one nearest the film's frame" })),
      prompt: Type.Optional(Type.String({ description: "Words for what the views should hold to: the location's entry in the bible, its light" })),
      plate: Type.Optional(Type.Boolean({ default: false, description: "Join the stills into plate.mp4 (FFmpeg), at fps" })),
      fps: Type.Optional(Type.Integer({ minimum: 1, maximum: 60, description: "For a plate. Default 24: use the film's" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const ctx = context(params, signal, onUpdate);
      if (!NAME.test(params.viewsId)) throw new Error("viewsId is lower-case letters, digits, underscores and hyphens (max 64)");
      const record = requireRecord(ctx.place);
      if (record.views[params.viewsId]) throw new Error(`${ctx.place.shown}/views/${params.viewsId} already exists: views are made once, pick another viewsId`);
      const { frames } = JSON.parse(readFileSync(join(ctx.place.dir, "posed.json"), "utf-8")) as { frames: PosedFrame[] };
      const [width, height] = (params.size ?? VIEW_SIZES[0]).split("x").map(Number) as [number, number];
      const kind = params.path as (typeof VIEW_PATHS)[number];

      let targets: AtlasCamera[];
      let described: string;
      const notes: string[] = [];
      if (kind === "cameras") {
        if (!params.cameras?.length) throw new Error('path "cameras" needs `cameras`: where each stands and what it looks at');
        targets = params.cameras.map((camera) => placed(camera.at as [number, number, number], camera.lookAt as [number, number, number], width, height, camera.fov ?? 50));
        described = `${targets.length} camera${targets.length === 1 ? "" : "s"} given in full`;
      } else {
        const index = (params.from ?? 1) - 1;
        if (index >= frames.length) throw new Error(`from is ${params.from}, and the set has ${frames.length} posed frame${frames.length === 1 ? "" : "s"}`);
        const start = frameCamera(frames[index]!);
        if (!start) throw new Error(`the camera of posed frame ${index + 1} could not be read (this studio's reading of Atlas's API: packages/worldlabs-atlas/src/wire.ts): give the path as "cameras"`);
        const count = params.count ?? 8;
        if (kind === "orbit") {
          const read = frames.map((frame) => frameCamera(frame)).filter((camera): camera is AtlasCamera => camera !== null);
          const focus = sceneFocus(read);
          if (focus.guessed) notes.push("the posed cameras do not look at one point, so what the orbit goes round is a guess two units ahead of them: check the views, or give cameras in full");
          targets = orbit({ from: start, centre: focus.centre, sweepDegrees: params.sweepDegrees ?? 60, count, width, height });
          described = `an orbit of ${params.sweepDegrees ?? 60}° in ${count} views from frame ${index + 1}`;
        } else {
          if (params.distance === undefined) throw new Error('path "push" needs `distance`, in the set\'s units');
          targets = push({ from: start, distance: params.distance, count, width, height });
          described = `a push of ${params.distance} in ${count} views from frame ${index + 1}`;
        }
      }
      if (params.plate && spawnSync(process.env.FFMPEG_BIN ?? "ffmpeg", ["-version"], { timeout: 5000, stdio: "ignore" }).status !== 0) {
        throw new Error("a plate is joined with FFmpeg, and it was not found: install it, or leave `plate` out");
      }

      const step: Step = {
        step: `views-${params.viewsId}`, task: "atlasGenerate", capability: "world.render",
        purpose: `location ${params.location}, set ${params.set}: views ${params.viewsId} (${targets.length})`,
        price: estimate("atlasGenerate", { views: targets.length }, ctx.settings.credits),
        asked: { cameras: targets, prompt: params.prompt ?? null },
        prepare: async () => atlasGenerateBody({ contextFrames: frames, targetCameras: targets, ...(params.prompt ? { prompt: params.prompt } : {}) }),
      };
      const done = await paidStep(ctx, step);
      const generated = readGeneratedFrames(done.run.operation.response);
      const viewsDir = join(ctx.place.dir, "views", params.viewsId);
      const stills: FileRecord[] = [];
      for (const [index, frame] of generated.entries()) {
        const picture = collectFiles(frame).find((file) => file.kind === "image");
        if (!picture) throw new Error(`view ${index + 1} came back without a picture (Atlas operation ${done.run.operation.id}): read provenance, it was paid for`);
        stills.push(await keep(ctx, picture, viewsDir, String(index + 1).padStart(6, "0"), ".png"));
      }
      writeFileSync(join(viewsDir, "views.json"), json({
        viewsId: params.viewsId, operationId: done.run.operation.id, path: kind, described, width, height,
        ...(params.prompt ? { prompt: params.prompt } : {}),
        cameras: targets.map(wireCamera), stills,
        // As Atlas returned them, cameras and depth with them: what a splat is made from when these views join it.
        frames: generated,
      }));

      let plate: string | undefined;
      const extension = extname(stills[0]!.file);
      if (params.plate) {
        if (stills.some((still) => extname(still.file) !== extension)) notes.push("the stills are not all of one kind of file: no plate was joined");
        else {
          await joinPlate(viewsDir, extension, params.fps ?? 24, signal);
          plate = "plate.mp4";
        }
      }
      const kept = keepProvenance(ctx, step, done, LOCATION_VIEWS_TOOL);
      record.views[params.viewsId] = { ...kept, dir: `views/${params.viewsId}`, frames: stills.length, width, height, path: described, ...(plate ? { plate } : {}) };
      writeRecord(ctx.place, record);
      done.collected();

      return {
        content: [{
          type: "text" as const,
          text: tail(ctx,
            `✅ ${ctx.place.shown}/views/${params.viewsId}/ — ${stills.length} still${stills.length === 1 ? "" : "s"} at ${width}×${height} (${described}), ${costText(kept)}${done.resumed ? " (a job taken up again)" : ""}`,
            plate ? `   plate: ${ctx.place.shown}/views/${params.viewsId}/plate.mp4, ${stills.length} frames at ${params.fps ?? 24} fps, no sound` : null,
            ...notes.map((note) => `   ⚠️ ${note}`),
            "   720p: a reference to hold a shot to, a background to build on, a previsualisation — not the film's final picture",
            "   open every still: Atlas invents what no picture showed, and a wall that was never photographed is a guess",
            `   views that hold up can join the splat: ${LOCATION_SPLAT_TOOL} { withViews: ["${params.viewsId}"] }; as references for a generated shot, name the stills in the shot's plan`,
          ).join("\n"),
        }],
        details: { viewsPath: viewsDir, stills: stills.map((still) => still.file), ...(plate ? { platePath: join(viewsDir, plate) } : {}), operationId: done.run.operation.id, cost: done.run.cost, estimate: step.price },
      };
    },
  });

  // --- pva_location_splat: frames → a Gaussian splat -------------------------

  pi.registerTool({
    name: LOCATION_SPLAT_TOOL,
    label: "Make a Location Set's Splat",
    description:
      "Make the Gaussian splat of a location's set from its posed frames (posedImages2Splats): the place itself, in three dimensions. On the film's spend ledger (capability world.reconstruct). " +
      `Two qualities, and an order between them. "draft" (${priceLine("posedImages2Splats.draft")}; minutes) is always made first: it shows whether the pictures hold together. ` +
      `"refined" (${priceLine("posedImages2Splats.refined")}; 15–25 minutes) is made only after the draft, and only when the operator has said so: ask them, stop, and pass who approved in \`approvedBy\`. Never decide it yourself. ` +
      `A draft that is wrong is not fixed by refining it: start another set with better pictures. \`withViews\` adds the frames of views rendered with ${LOCATION_VIEWS_TOOL} to the posed ones; a splat needs at least two frames. ` +
      `Saves locations/<location>/sets/<set>/<quality>.spz with its provenance. Next: ${LOCATION_MESH_TOOL} for a mesh Blender can film. ` +
      "A splat of each quality is made once. If the wait runs out or the call is interrupted, the job goes on at Atlas: call again with the same arguments, and it waits for the same job and pays nothing more.",
    parameters: Type.Object({
      ...SET_PARAMS,
      quality: Type.Optional(StringEnum(SPLAT_QUALITIES as unknown as [string, ...string[]], { default: "draft", description: "draft first. refined: only with the operator's go-ahead" })),
      approvedBy: Type.Optional(Type.String({ description: "For refined: who approved it and how, in a few words (\"the operator, in chat, after the draft's views\"). Kept in the set" })),
      withViews: Type.Optional(Type.Array(Type.String(), { description: "viewsIds whose frames join the posed ones" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const ctx = context(params, signal, onUpdate);
      const quality = (params.quality ?? "draft") as SplatQuality;
      if (!SPLAT_QUALITIES.includes(quality)) throw new Error(`quality is one of ${SPLAT_QUALITIES.join(", ")}`);
      const record = requireRecord(ctx.place);
      if (record.splats[quality]) throw new Error(`${ctx.place.shown}/${record.splats[quality]!.file} already exists: a ${quality} splat is made once. For other pictures, start another set`);
      if (quality === "refined") {
        if (!record.splats.draft) throw new Error(`a refined splat is made after a draft of the same set, and ${ctx.place.shown} has none: make the draft first (${usd(estimate("posedImages2Splats", { refine: false }, ctx.settings.credits).usd)}), look at it, and ask the operator`);
        if (!params.approvedBy || params.approvedBy.trim().length < 3) throw new Error("a refined splat needs the operator's go-ahead: ask them, and pass who approved it in `approvedBy`. Do not approve it yourself");
      }
      const { frames: posed } = JSON.parse(readFileSync(join(ctx.place.dir, "posed.json"), "utf-8")) as { frames: PosedFrame[] };
      const withViews = params.withViews ?? [];
      const frames = [...posed];
      for (const id of withViews) {
        if (!record.views[id]) throw new Error(`the set has no views named ${id}: its views are ${Object.keys(record.views).join(", ") || "none"}`);
        frames.push(...(JSON.parse(readFileSync(join(ctx.place.dir, "views", id, "views.json"), "utf-8")) as { frames: PosedFrame[] }).frames);
      }
      if (frames.length < 2) throw new Error(`a splat needs at least two frames, and the set has ${frames.length}: render views first (${LOCATION_VIEWS_TOOL}) and name them in withViews`);
      if (frames.length > LOCATION_LIMITS.frames) throw new Error(`at most ${LOCATION_LIMITS.frames} frames in one splat: this would be ${frames.length}`);

      const step: Step = {
        step: `splat-${quality}`, task: "posedImages2Splats", capability: "world.reconstruct",
        purpose: `location ${params.location}, set ${params.set}: ${quality} splat from ${frames.length} frames`,
        price: estimate("posedImages2Splats", { refine: quality === "refined" }, ctx.settings.credits),
        asked: { quality, withViews },
        prepare: async () => posedImages2SplatsBody({ posedFrames: frames, refine: quality === "refined" }),
      };
      const done = await paidStep(ctx, step);
      const splat = done.run.files.find((file) => file.kind === "splat");
      if (!splat) throw new Error(`Atlas operation ${done.run.operation.id} finished without a splat this studio can find in its result: it was paid for; read ${ctx.place.shown}/provenance/ after correcting packages/worldlabs-atlas/src/wire.ts`);
      const file = await keep(ctx, splat, ctx.place.dir, quality, ".spz");
      const kept = keepProvenance(ctx, step, done, LOCATION_SPLAT_TOOL);
      record.splats[quality] = { ...kept, ...file, assetId: splat.assetId ?? null, frames: frames.length, withViews, ...(quality === "refined" ? { approvedBy: params.approvedBy!.trim() } : {}) };
      writeRecord(ctx.place, record);
      done.collected();

      return {
        content: [{
          type: "text" as const,
          text: tail(ctx,
            `✅ ${ctx.place.shown}/${file.file} — a ${quality} splat from ${frames.length} frames, ${megabytes(file.bytes)}, ${costText(kept)}, ${Math.round((done.run.finishedAtMs - done.run.startedAtMs) / 60_000)} min${done.resumed ? " (a job taken up again)" : ""}`,
            quality === "refined" ? `   approved by: ${params.approvedBy!.trim()}` : null,
            `   next: ${LOCATION_MESH_TOOL} { film, location, set } turns it into a GLB for pva_stage_shot; an .spz itself opens in a splat viewer, not in this studio`,
            quality === "draft"
              ? `   a draft is for judging the place, not for showing it. If it holds together and the film needs more, ask the operator before ${LOCATION_SPLAT_TOOL} { quality: "refined", approvedBy } (${priceText(estimate("posedImages2Splats", { refine: true }, ctx.settings.credits))})`
              : null,
          ).join("\n"),
        }],
        details: { splatPath: join(ctx.place.dir, file.file), quality, frames: frames.length, operationId: done.run.operation.id, cost: done.run.cost, estimate: step.price },
      };
    },
  });

  // --- pva_location_mesh: a splat → a GLB ------------------------------------

  pi.registerTool({
    name: LOCATION_MESH_TOOL,
    label: "Make a Location Set's Mesh",
    description:
      "Turn a location set's splat into a polygon mesh (splats2Mesh): a GLB that Blender can film, so characters can stand in the place (pva_stage_shot with `locationSet`). " +
      "Paid, on the film's spend ledger (capability world.mesh); Atlas publishes no price for this step, so under a budget the operator gives it (splats2Mesh in library/.render/worldlabs-atlas.json). " +
      "`from` is the splat it is made of: the refined one when there is one, else the draft. `texture` and `targetFaces` are passed as asked; a set to stage in wants tens of thousands of faces, not millions. " +
      "Saves locations/<location>/sets/<set>/<meshId>.glb and says what it holds and how big it is. Its units and its origin are the reconstruction's, not metres on a floor: read its size, and give pva_stage_shot a `setScale`. " +
      "A mesh is geometry seen from where the pictures were taken: behind what they showed it has holes. A meshId is used once.",
    parameters: Type.Object({
      ...SET_PARAMS,
      from: Type.Optional(StringEnum(SPLAT_QUALITIES as unknown as [string, ...string[]], { description: "Which splat. Default: refined when the set has one, else draft" })),
      meshId: Type.Optional(Type.String({ description: "The mesh's file name. Default: the splat's quality (draft.glb, refined.glb)" })),
      texture: Type.Optional(StringEnum(MESH_TEXTURES as unknown as [string, ...string[]], { description: "textured, vertex-colors, or none. Omitted: Atlas decides" })),
      targetFaces: Type.Optional(Type.Integer({ minimum: 100, maximum: 5_000_000, description: "How many faces to aim for. Omitted: Atlas decides" })),
      reupload: Type.Optional(Type.Boolean({ default: false, description: "Send the splat's file again in place of naming the one Atlas kept: when Atlas no longer has it" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const ctx = context(params, signal, onUpdate);
      const record = requireRecord(ctx.place);
      const from = (params.from ?? (record.splats.refined ? "refined" : "draft")) as SplatQuality;
      const splat = record.splats[from];
      if (!splat) throw new Error(`${ctx.place.shown} has no ${from} splat: make it with ${LOCATION_SPLAT_TOOL}`);
      const meshId = params.meshId ?? from;
      if (!NAME.test(meshId)) throw new Error("meshId is lower-case letters, digits, underscores and hyphens (max 64)");
      if (record.meshes[meshId]) throw new Error(`${ctx.place.shown}/${meshId}.glb already exists: a mesh is made once, pick another meshId`);
      const splatFull = join(ctx.place.dir, splat.file);
      if ((params.reupload || !splat.assetId) && !existsSync(splatFull)) throw new Error(`${ctx.place.shown}/${splat.file} is not on this machine, and it has to be sent: restore the film's media first`);

      const step: Step = {
        step: `mesh-${meshId}`, task: "splats2Mesh", capability: "world.mesh",
        purpose: `location ${params.location}, set ${params.set}: mesh ${meshId} from the ${from} splat`,
        price: estimate("splats2Mesh", {}, ctx.settings.credits),
        asked: { from, texture: params.texture ?? null, targetFaces: params.targetFaces ?? null },
        prepare: async (client) => {
          let asset = splat.assetId;
          if (params.reupload || !asset) {
            ctx.say(`Uploading ${splat.file}…`);
            asset = (await client.uploadFile({ bytes: readFileSync(splatFull), fileName: splat.file, contentType: "application/octet-stream" }, signal)).id;
          }
          return splats2MeshBody({ splat: asset, ...(params.texture ? { texture: params.texture as MeshTexture } : {}), ...(params.targetFaces !== undefined ? { targetFaces: params.targetFaces } : {}) });
        },
      };
      const done = await paidStep(ctx, step);
      const mesh = done.run.files.find((file) => file.kind === "mesh");
      if (!mesh) throw new Error(`Atlas operation ${done.run.operation.id} finished without a mesh this studio can find in its result: it was paid for; read ${ctx.place.shown}/provenance/`);
      const bytes = await ctx.client().download(mesh, signal);
      const holds = summarizeModel(bytes);
      if (holds.format !== "glb") throw new Error(`what Atlas returned for ${done.run.operation.id} is not a binary glTF: it was paid for and is not kept as a set's mesh; read ${ctx.place.shown}/provenance/`);
      writeFileSync(join(ctx.place.dir, `${meshId}.glb`), bytes);
      const kept = keepProvenance(ctx, step, done, LOCATION_MESH_TOOL);
      record.meshes[meshId] = {
        ...kept, file: `${meshId}.glb`, sha256: sha256(bytes), bytes: bytes.byteLength, from, holds,
        ...(params.texture ? { texture: params.texture } : {}), ...(params.targetFaces !== undefined ? { targetFaces: params.targetFaces } : {}),
      };
      writeRecord(ctx.place, record);
      done.collected();

      return {
        content: [{
          type: "text" as const,
          text: tail(ctx,
            `✅ ${ctx.place.shown}/${meshId}.glb — ${megabytes(bytes.byteLength)}, from the ${from} splat, ${costText(kept)}${done.resumed ? " (a job taken up again)" : ""}`,
            `   ${describeModel(holds)}`,
            "   its units are the reconstruction's: compare its size with something in it whose size you know (a door is about 2 m) and give that ratio as setScale",
            `   to stage in it: pva_stage_shot { channel: "${params.film}", series: <scene>, episode: <shot>, locationSet: { location: "${params.location}", set: "${params.set}", mesh: "${meshId}" }, setScale, players: [{ …, at: "x, y" }] }`,
            "   it has no marks and no light of its own: places are given in metres, and the stage lights it. Look at the first shot before staging more",
          ).join("\n"),
        }],
        details: { meshPath: join(ctx.place.dir, `${meshId}.glb`), from, holds, operationId: done.run.operation.id, cost: done.run.cost, estimate: step.price },
      };
    },
  });

  // --- pva_location_sets: what there is, and its jobs ------------------------

  pi.registerTool({
    name: LOCATION_SETS_TOOL,
    label: "Location Sets",
    description:
      "List a film's location sets: what each holds (posed frames, views, splats, meshes), what it cost, the licence it was made under, and any Atlas job still running for it. Free. " +
      "With `cancel` (a location, a set and the step's name as listed), asks Atlas to stop that job; whether a job stopped part-way is charged is Atlas's to say. " +
      "Also says what each step is priced at, and what the operator has still to state in library/.render/worldlabs-atlas.json.",
    parameters: Type.Object({
      film: Type.String({ description: "The film's slug" }),
      location: Type.Optional(Type.String({ description: "Only this location's sets" })),
      cancel: Type.Optional(Type.Object({
        location: Type.String(), set: Type.String(), step: Type.String({ description: "The job's step, as listed: pose, splat-draft, mesh-draft, views-<id>" }),
      }, { description: "Ask Atlas to stop a job" })),
    }),
    async execute(_toolCallId, params, signal) {
      if (!NAME.test(params.film) || projectKind(LIBRARY_ROOT, params.film) !== "film") throw new Error(`${params.film} is not a film`);
      const settings = readAtlasSettings(LIBRARY_ROOT);
      const keyed = Boolean(process.env[API_KEY_ENV]) || Boolean(deps.client);
      let client: AtlasClient | undefined;
      const atlas = () => (client ??= deps.client ? deps.client({}) : createAtlasClient());
      const lines: string[] = [];

      if (params.cancel) {
        const place = setPlace(LIBRARY_ROOT, params.film, params.cancel.location, params.cancel.set);
        const file = jobPath(place, params.cancel.step);
        if (!/^[a-z0-9][a-z0-9_-]{0,80}$/.test(params.cancel.step) || !existsSync(file)) throw new Error(`${place.shown} has no job named ${params.cancel.step}: its jobs are ${pendingJobs(place).map((job) => job.step).join(", ") || "none"}`);
        const job = JSON.parse(readFileSync(file, "utf-8")) as PendingJob;
        const after = await atlas().cancelOperation(job.operationId, signal);
        forgetJob(place, params.cancel.step);
        lines.push(`🛑 asked Atlas to stop ${job.operationId} (${place.shown}, ${job.step})${after ? `: it is now ${after.state}` : ""}. It was reserved at ${priceText(job.price)}; what Atlas charged for it, if anything, is on the account`);
      }

      const locationsDir = join(channelPath(LIBRARY_ROOT, params.film), "locations");
      const locations = existsSync(locationsDir)
        ? readdirSync(locationsDir).filter((name) => NAME.test(name) && (!params.location || name === params.location) && existsSync(join(locationsDir, name, "sets")))
        : [];
      const listed: Record<string, unknown>[] = [];
      for (const location of locations.sort()) {
        for (const set of readdirSync(join(locationsDir, location, "sets")).filter((name) => NAME.test(name)).sort()) {
          const place = setPlace(LIBRARY_ROOT, params.film, location, set);
          const record = readRecord(place);
          if (!record) continue;
          const spent = [record.posed, ...Object.values(record.views), ...Object.values(record.splats), ...Object.values(record.meshes)].reduce((sum, step) => sum + (step?.costUsd ?? 0), 0);
          lines.push(`${place.shown} — ${record.pictures.length} pictures; ${record.posed ? `${record.posed.frames} posed frames` : "not posed yet"}; about ${usd(spent)} so far`);
          for (const [id, views] of Object.entries(record.views)) lines.push(`   views/${id}/: ${views.frames} stills at ${views.width}×${views.height} (${views.path})${views.plate ? ", plate.mp4" : ""}`);
          for (const quality of SPLAT_QUALITIES) {
            const splat = record.splats[quality];
            if (splat) lines.push(`   ${splat.file}: ${quality} splat, ${megabytes(splat.bytes)}${splat.approvedBy ? `, approved by ${splat.approvedBy}` : ""}`);
          }
          for (const [id, mesh] of Object.entries(record.meshes)) lines.push(`   ${mesh.file}: mesh ${id} from the ${mesh.from} splat, ${describeModel(mesh.holds)}`);
          const jobs = pendingJobs(place);
          for (const job of jobs) {
            let state = keyed ? "" : ` (${API_KEY_ENV} is not set: its state cannot be asked)`;
            if (keyed) {
              try {
                const operation = await atlas().getOperation(job.operationId, signal);
                state = `: ${operation.state} at Atlas${operation.done ? " — call the step's tool again to collect it" : ""}`;
              } catch (e) {
                state = ` (its state could not be asked: ${e instanceof Error ? e.message.slice(0, 120) : String(e)})`;
              }
            }
            lines.push(`   ⏳ job ${job.step}: Atlas operation ${job.operationId}, submitted ${job.submittedAt}, reserved at ${priceText(job.price)}${state}`);
          }
          const licence = existsSync(join(place.dir, "licence.json")) ? JSON.parse(readFileSync(join(place.dir, "licence.json"), "utf-8")) as { plan?: string; commercialUse?: boolean } : null;
          lines.push(`   licence: plan ${licence?.plan ?? "unstated"}, ${licence?.commercialUse ? "reported to allow commercial use" : "not for commercial use"}`);
          listed.push({ location, set, record, jobs });
        }
      }
      if (listed.length === 0) lines.push(`${params.film} has no location sets${params.location ? ` for ${params.location}` : ""}: start one with ${LOCATION_SET_TOOL}`);
      lines.push(
        "", "prices, in credits (1,000 to the dollar):", ...describePrices(settings.credits).map((line) => `   ${line}`),
        `   ${licenceLine(settings)}`, ...settingsLines(settings),
        ...(WIRE.verifiedLive ? [] : ["   ⚠️ this studio's reading of Atlas's API has not been confirmed by a real run (ADR-0057): the first paid step is its test, make it a small one"]),
      );
      return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { sets: listed, settings } as unknown as Record<string, unknown> };
    },
  });

  function priceLine(key: PriceKey): string {
    const price = estimate(key.startsWith("posedImages2Splats") ? "posedImages2Splats" : "splats2Mesh", { refine: key.endsWith("refined") });
    return price.priced ? `${usd(price.usd)}, published` : "no published price";
  }
}

/** Join numbered stills into an H.264 file with no sound. */
function joinPlate(directory: string, extension: string, fps: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_BIN ?? "ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-framerate", String(fps), "-i", `%06d${extension}`,
      "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "plate.mp4",
    ], { cwd: directory, stdio: ["ignore", "ignore", "pipe"], ...(signal ? { signal } : {}) });
    let said = "";
    child.stderr.on("data", (chunk: Buffer) => { said += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`FFmpeg could not join the plate: ${said.trim().slice(-300) || `exit ${code}`}`))));
  });
}

/** What pva_capability_status says of location sets. */
export function locationSetsStatus(keySet: boolean, settings: AtlasSettings): { "location-sets": { available: boolean; detail: string } } {
  if (!keySet) return { "location-sets": { available: false, detail: `${API_KEY_ENV} not set` } };
  const unpriced = PRICE_KEYS.filter((key) => !key.startsWith("atlasChisel") && !key.startsWith("atlasTextToImage") && !estimate(taskOf(key), { refine: key.endsWith("refined") }, settings.credits).priced);
  return {
    "location-sets": {
      available: true,
      detail: `${API_KEY_ENV} set (World Labs Atlas: ${LOCATION_SET_TOOL} → ${LOCATION_VIEWS_TOOL} → ${LOCATION_SPLAT_TOOL} → ${LOCATION_MESH_TOOL}; ` +
        `a draft splat ${usd(estimate("posedImages2Splats", { refine: false }, settings.credits).usd)}, refined ${usd(estimate("posedImages2Splats", { refine: true }, settings.credits).usd)}; 720p at most); ` +
        `plan ${settings.plan ?? `not stated in ${ATLAS_SETTINGS_RELATIVE}: sets are marked not for commercial use`}; ` +
        (unpriced.length ? `no price for ${unpriced.join(", ")}: a film with a budget refuses those steps until ${ATLAS_SETTINGS_RELATIVE} gives them; ` : "") +
        (WIRE.verifiedLive ? `verified against the live API ${WIRE.verifiedLive}` : "wired, not yet verified against the live API (ADR-0057)"),
    },
  };
}

function taskOf(key: PriceKey): AtlasTask {
  return key.split(".")[0] as AtlasTask;
}
