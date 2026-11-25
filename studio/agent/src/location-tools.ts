// ---------------------------------------------------------------------------
// A location's 3D set (ADR-0057)
// ---------------------------------------------------------------------------
// A film's location is an entry in its bible and a few pictures. A *set* is
// that place in three dimensions, made once from those pictures by World Labs
// Atlas, from which every angle is then taken: stills to hold a generated
// shot to, a mesh for Blender's camera, a plate to build on.
//
// It is made in the order Atlas's own workflow guides give, each step paid,
// each looked at before the next:
//
//   pva_location_set     pictures → posed frames (cameras and depth)
//   pva_location_views   posed frames + a path of cameras → stills (with
//                        depth, they can join the splat), or a plate
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
//   waits on that operation and submits nothing. And every submission is
//   named (Idempotency-Key) from the film, the set, the step and what was
//   asked: should the note itself be lost, the same call gets the same
//   operation back from Atlas, not a second one;
// - Atlas publishes one price, a splat's, and says to read the rest on the
//   account's rate card: the operator writes them in
//   library/.render/worldlabs-atlas.json. Without one a step is unpriced,
//   and a film with a budget refuses it. An operation does not say what it
//   was charged, so the ledger is settled at these prices;
// - a set is never written over: a quality's splat is made once, a views id
//   is used once, a retake is another set.
//
// Written from Atlas's documentation, and not yet run against the service:
// what the tools say about that comes from the package's own mark
// (`WIRE.verifiedLive`).
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import {
  API_KEY_ENV, ATLAS_TARGET_SIZES, AtlasCancelledError, AtlasHttpError, AtlasOperationError, AtlasValidationError, FAILED_RUNS_FREE, KEY_SCOPES, MESH_CAMERAS,
  MESH_TEXTURES, PRICE_KEYS, SPLAT_FRAME_LIMITS, WIRE, atlasGenerateBody, createAtlasClient, describePrices, estimate, frameCamera, images2PosedRGBDBody, orbit,
  placed, posedFrame, posedImages2SplatsBody, provenanceOf, push, readGeneratedFrames, readMesh, readPosedFrames, readSplat, sceneFocus, sha256, splats2MeshBody,
  wireCamera,
  type AtlasCamera, type AtlasClient, type AtlasClientOptions, type AtlasEstimate, type AtlasEvent, type AtlasTask, type GeneratedFrame, type MeshCameras,
  type MeshTexture, type OperatorCredits, type PosedFrame, type PosedResult, type PriceKey, type TaskAsset, type TaskRun,
} from "@av/worldlabs-atlas";
import { toMicros } from "@studio/contracts/src/budget.mjs";
import { SELF, channelPath, projectKind } from "@studio/contracts/src/layout.mjs";
import { describeModel, pictureExtension, summarizeModel, type ModelSummary } from "./model-tools.js";
import { paidCall, settleLeftOpen } from "./spend.js";
import { guardPath } from "./trust-guards.js";

export const LOCATION_SET_TOOL = "pva_location_set";
export const LOCATION_VIEWS_TOOL = "pva_location_views";
export const LOCATION_SPLAT_TOOL = "pva_location_splat";
export const LOCATION_MESH_TOOL = "pva_location_mesh";
export const LOCATION_SETS_TOOL = "pva_location_sets";

/** The operator's account, as far as it is not a secret: beside the other providers' files. */
export const ATLAS_SETTINGS_RELATIVE = join(".render", "worldlabs-atlas.json");
export const ATLAS_PROVIDER = "worldlabs-atlas";
/** Atlas's own limits: 1 to 64 pictures in a posing; about 1,500 target cameras in a render with eight context frames, refused there when too many. */
export const LOCATION_LIMITS = { pictures: 64, views: 1500 } as const;
export const SPLAT_QUALITIES = ["draft", "refined"] as const;
export type SplatQuality = (typeof SPLAT_QUALITIES)[number];
export const VIEW_PATHS = ["orbit", "push", "cameras"] as const;
export const VIEW_SIZES = ATLAS_TARGET_SIZES.map(([width, height]) => `${width}x${height}`) as [string, ...string[]];

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PICTURE_TYPES: Readonly<Record<string, string>> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const DEFAULT_MAX_WAIT_MINUTES = 45;
const HEARTBEAT_MS = 15_000;
const DEFAULT_SIZE = VIEW_SIZES[0];
const gridOf = (size: string) => size.split("x").map(Number) as [number, number];

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
 * Under which terms a set may be used: World Labs' Terms of Service, as
 * dated 11.10.26. What was made through "Eligible Paid Access" (paid API
 * access among it) is the customer's, for any purpose; what was made through
 * "Low-Tier Access" (a free or Standard tier, a trial, promotional credits)
 * stays World Labs', licensed for personal, non-commercial use, and stays so
 * after an upgrade. The API does not say which a key's usage was, so the
 * operator states it, and an unstated plan is treated as the stricter one.
 * The studio writes this down; it does not judge it.
 */
export function licenceOf(settings: AtlasSettings): Record<string, unknown> {
  const paid = settings.plan === "paid";
  return {
    version: 1,
    provider: "World Labs Atlas",
    plan: settings.plan ?? "unstated",
    access: paid ? "Eligible Paid Access" : "Low-Tier Access",
    statedBy: settings.plan ? `the operator, in ${ATLAS_SETTINGS_RELATIVE}` : null,
    commercialUse: paid,
    basis: paid
      ? "Terms of Service 2.3(b): the customer owns Outputs generated through Eligible Paid Access and may use them for any purpose, including Commercial Purposes, subject to the Terms (1.12 for API access)."
      : settings.plan === "free"
        ? "Terms of Service 2.3(a): World Labs retains all rights in Output generated through Low-Tier Access and licenses it solely for personal, Non-Commercial Use. 2.3(c): this holds even after an upgrade."
        : `No plan was stated (${ATLAS_SETTINGS_RELATIVE}, "plan"): treated as Low-Tier Access, not for commercial use, until it is.`,
    inputs: paid
      ? "2.6: World Labs may use what is uploaded and generated to improve its services and train models; the account can opt out (Settings → General, \"Use my data to improve models\"), from then on."
      : "2.6: for Low-Tier Access the licence to use what is uploaded and generated, training included, is irrevocable and has no opt-out.",
    obligations: "2.7: do not misrepresent how an Output was made; identify World Labs as the service provider on its reasonable request; leave provenance data in place. 1.10(d): Outputs may not be used to train or build a competing model.",
    terms: "https://docs.atlas.worldlabs.ai/terms-of-service",
    termsDated: "11.10.26",
    note: "A summary by the studio, not legal advice: read the Terms, and any Order Form, before a set or anything made from it is published.",
  };
}

const licenceLine = (settings: AtlasSettings) => settings.plan === "paid"
  ? "licence: paid access, as the operator states it — yours to use, commercially too, under World Labs' Terms (licence.json)"
  : `⚠️ licence: ${settings.plan === "free" ? "free or trial access" : `no plan stated in ${ATLAS_SETTINGS_RELATIVE}`} — personal, non-commercial use only, and it stays so (licence.json)`;

// ── A set on disk ───────────────────────────────────────────────────────────

interface FileRecord { file: string; sha256: string; bytes: number }
/** What a step is taken to have cost: its price when it was asked for. Atlas does not say what an operation was charged; the account's Usage page does. */
interface StepRecord { operationId: string; at: string; costUsd: number | null; costBasis: string }

export interface LocationSetRecord {
  version: 1;
  film: string;
  location: string;
  set: string;
  provider: typeof ATLAS_PROVIDER;
  createdAt: string;
  /** The grid its pictures, depth and cameras are on: width x height. Views that join its splat are on it too. */
  size: string;
  /** The pictures it was made from, by their path in the film. */
  pictures: (FileRecord & { width?: number; height?: number })[];
  /** The scene in Atlas's own words, from its first render: given back to later steps so they need not caption the pictures again. */
  prompt?: string;
  posed?: StepRecord & { frames: number; kept: string[]; poseRefinementAccepted?: boolean | null };
  views: Record<string, StepRecord & { dir: string; frames: number; width: number; height: number; path: string; depth: boolean; plate?: string }>;
  splats: Partial<Record<SplatQuality, StepRecord & FileRecord & { assetId: string | null; frames: number; splats: number | null; withViews: string[]; approvedBy?: string }>>;
  meshes: Record<string, StepRecord & FileRecord & { from: SplatQuality; assetId: string | null; holds: ModelSummary; texture?: string; targetFaces?: number }>;
}

interface PendingJob {
  step: string;
  task: AtlasTask;
  operationId: string;
  /** What was asked, as its hash: a call for something else must not collect this job as its own. */
  asked: string;
  /** Its reservation on the film's ledger: closed by the call that made it, or by whoever collects the job if that call never returned. */
  reserveId?: string;
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

/**
 * Add one step's result to the set's record as it is on disk now, not as it
 * was when the step began: a step waits for minutes, and another may have
 * written its own result meanwhile.
 */
function updateRecord(place: SetPlace, started: LocationSetRecord, change: (record: LocationSetRecord) => void): LocationSetRecord {
  const record = readRecord(place) ?? started;
  change(record);
  writeRecord(place, record);
  return record;
}
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
 * Every submission carries an Idempotency-Key made of the film, the set, the
 * step and what was asked. It is the same on every attempt at the same work,
 * from any process: if the answer is lost, or this process dies before the
 * note is written, asking again returns the operation Atlas already has.
 *
 * A caller who gives up stops the waiting, not the job: stopping a job is
 * asked for by name (pva_location_sets { cancel }).
 */
async function paidStep(ctx: StepContext, step: Step): Promise<StepDone> {
  const pending = jobPath(ctx.place, step.step);
  const target = { libraryRoot: ctx.libraryRoot, channel: ctx.film, series: SELF, episode: SELF };
  const collected = () => forgetJob(ctx.place, step.step);
  const wait = { maxWaitMs: ctx.settings.maxWaitMinutes * 60_000, ...(ctx.signal ? { signal: ctx.signal } : {}) };
  const estimated = { currency: "USD", micros: toMicros(step.price.usd) };
  /** A run that failed costs nothing where Atlas says so (a splat); elsewhere it is not said, and the estimate stands. */
  const freeWhenFailed = FAILED_RUNS_FREE.includes(step.task);
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
    // The call that made the job closed its reservation when its wait ended. One that never returned
    // (its session ended) left it open: it is closed here. Closed already: nothing changes.
    const close = async (failed: boolean) => {
      if (!job.reserveId) return;
      const cost = failed && freeWhenFailed ? { currency: "USD", micros: 0 } : { currency: "USD", micros: toMicros(job.price.usd) };
      await settleLeftOpen(target, job.reserveId, cost, failed && freeWhenFailed ? "provider" : "estimate", job.operationId).catch(() => false);
    };
    try {
      const run = await ctx.client().resume(job.task, job.operationId, wait);
      await close(false);
      return { run, request: job.request, resumed: true, collected };
    } catch (e) {
      if (e instanceof AtlasOperationError) await close(e.state === "failed");
      if (over(e)) forgetJob(ctx.place, step.step);
      throw e;
    }
  }

  let request: Record<string, unknown> = {};
  let accepted = false;
  try {
    const run = await paidCall<TaskRun>(
      target,
      {
        capability: step.capability, provider: ATLAS_PROVIDER, model: `${ATLAS_PROVIDER}/${step.price.key}`, purpose: step.purpose,
        estimate: { estimate: estimated, priced: step.price.priced, profile: `${ATLAS_PROVIDER}/${step.price.key}` },
      },
      async (spend) => {
        try {
          request = await step.prepare(ctx.client());
          // Said here, after the reservation: a step the budget refuses was never submitted.
          ctx.say(`Submitting ${step.purpose} to Atlas (tasks:${step.task}, ${priceText(step.price)})…`);
          // The last moment nothing has been sent: from here the request is seen through, and the job has an id.
          if (ctx.signal?.aborted) throw new Error("interrupted before anything was sent to Atlas: nothing was submitted or spent");
          spend.sending();
          const done = await ctx.client().run(step.task, request, {
            ...wait,
            idempotencyKey: `sergio-${sha256(`${ctx.film}/${ctx.place.shown}/${step.step}/${asked}`).slice(0, 40)}`,
            onSubmitted: (operation) => {
              accepted = true;
              mkdirSync(join(ctx.place.dir, "jobs"), { recursive: true });
              writeFileSync(pending, json({ step: step.step, task: step.task, operationId: operation.id, asked, reserveId: spend.reserveId, submittedAt: new Date().toISOString(), price: step.price, request } satisfies PendingJob));
            },
          });
          // An operation does not say what it was charged: the price it was asked at stands.
          return { value: done, cost: null, providerRequestId: done.operation.id };
        } catch (e) {
          // Refused before it left, or turned away by Atlas when it arrived (a refusal, no credits, too many requests): nothing ran.
          if (e instanceof AtlasValidationError || (e instanceof AtlasHttpError && e.notAccepted && !accepted)) spend.refused();
          // It ran and failed, where Atlas says a failed run is free.
          if (e instanceof AtlasOperationError && e.state === "failed" && freeWhenFailed) spend.refused();
          if (over(e)) forgetJob(ctx.place, step.step);
          // Anything else after it left — a wait that ran out, a failure whose charge is not said, an answer lost on
          // the way — is settled at the estimate: it may have been charged, and a budget that overcounts is the safer mistake.
          throw e;
        }
      },
    );
    return { run, request, resumed: false, collected };
  } catch (e) {
    if ((e as { code?: string }).code === "BUDGET_UNPRICED") {
      throw new Error(
        `${(e as Error).message}. Atlas publishes no price for ${step.price.key}: read it on the account's rate card (atlas.worldlabs.ai, Settings → Developer Platform) and write it, in credits, ` +
          `in library/${ATLAS_SETTINGS_RELATIVE} as { "credits": { "${step.price.key}": <credits> } } (1,000 credits to the dollar)`,
      );
    }
    if (e instanceof AtlasHttpError && e.unpaid) e.message += `. The account is out of credits or at a spend limit (${e.providerCode ?? "402"}): add credits or raise the limit at atlas.worldlabs.ai, then call this tool again unchanged`;
    if (e instanceof AtlasHttpError && e.status === 403 && !accepted) e.message += `. A key needs ${KEY_SCOPES.join(", ")} for this`;
    if (e instanceof Error && existsSync(pending)) e.message += `. The job is written in ${ctx.place.shown}/jobs/${step.step}.json: call this tool again with the same arguments to wait for it without paying twice, or stop it with ${LOCATION_SETS_TOOL} { cancel }`;
    throw e;
  }
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
  return {
    operationId: done.run.operation.id, at: new Date().toISOString(),
    costUsd: step.price.priced ? step.price.usd : null,
    costBasis: step.price.priced ? `estimate (${step.price.basis})` : "unknown",
  };
}

const costText = (record: StepRecord) => record.costUsd === null ? "cost not known: see the account's Usage page" : `~${usd(record.costUsd)} (${record.costBasis})`;

/** Said once per result until a real run has confirmed this studio's reading of the API. */
const unverifiedLine = () => WIRE.verifiedLive
  ? null
  : "   ⚠️ these tools follow Atlas's documentation and have not yet run against the service: if what came back looks wrong, read provenance/<operation>.json before paying again";

/** The frames a task takes, from frames a task returned: each must have its depth. */
function framesFor(frames: readonly (PosedResult | GeneratedFrame)[], what: string): PosedFrame[] {
  return frames.map((frame, index) => {
    const posed = posedFrame(frame);
    if (!posed) throw new Error(`${what}, frame ${index + 1}, has no camera or no depth: it cannot be context, or a splat's frame`);
    return posed;
  });
}

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

  /** A file a result named, onto disk, read through its asset. A picture's extension is what its bytes say it is. */
  async function keep(ctx: StepContext, asset: TaskAsset, directory: string, stem: string, extension: string): Promise<FileRecord> {
    const bytes = await ctx.client().download({ ...(asset.assetId ? { assetId: asset.assetId } : {}), ...(asset.url ? { url: asset.url } : {}) }, ctx.signal);
    const named = pictureExtension(bytes) ?? extension;
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${stem}${named}`), bytes);
    return { file: `${stem}${named}`, sha256: sha256(bytes), bytes: bytes.byteLength };
  }

  const readFrames = <T>(place: SetPlace, file: string): T[] => (JSON.parse(readFileSync(join(place.dir, file), "utf-8")) as { frames: T[] }).frames;
  const settingsLines = (settings: AtlasSettings) => settings.problems.map((problem) => `   ⚠️ ${ATLAS_SETTINGS_RELATIVE}: ${problem}`);
  const tail = (ctx: StepContext, ...lines: (string | null)[]) => [...lines, `   ${licenceLine(ctx.settings)}`, unverifiedLine(), ...settingsLines(ctx.settings)].filter((line): line is string => line !== null);
  const seconds = (run: TaskRun) => Math.round((run.finishedAtMs - run.startedAtMs) / 1000);

  // --- pva_location_set: pictures → posed frames ----------------------------

  pi.registerTool({
    name: LOCATION_SET_TOOL,
    label: "Start a Location's 3D Set",
    description:
      "Start a 3D set of a film's location from pictures of it: World Labs Atlas estimates each picture's camera and depth (images2PosedRGBD), which is what every later step is made from. Seconds, not minutes. " +
      "Paid, on the film's spend ledger (capability world.reconstruct); Atlas publishes no price for this step, so under a budget the operator gives it in library/.render/worldlabs-atlas.json. Check pva_budget_status first. " +
      "Pictures of ONE real place, given together, so their cameras share one world: sharp, wide or medium, overlapping by about half, taken from positions that differ and not only turned on the spot, " +
      "with steady light and nothing that moves (people, cars, water). One picture is enough to start — Atlas then invents what it does not show; 8–16 make a room; 64 at most. " +
      `Everything is put on one grid, \`size\` (${VIEW_SIZES.join(", ")}): choose the one nearest the film's frame, since views and the splat use it too; a picture of another shape is cropped to it. ` +
      "`refinePoses` adjusts the cameras against each other: for two or more pictures that will go on to a refined splat. " +
      "They are files of the film (locations/<location>/…, references/…, footage stills), uploaded to World Labs and kept in the project there: do not send a picture of a real person or a private place without the right to. " +
      `Saves locations/<location>/sets/<set>/ (set.json, posed.json, the depth maps, provenance/, licence.json). Next: ${LOCATION_VIEWS_TOOL} to see the place from other sides, then ${LOCATION_SPLAT_TOOL}. ` +
      "A set is made once: other pictures are another set. If the wait runs out, call again with the same arguments: it waits for the same job and pays nothing more.",
    parameters: Type.Object({
      ...SET_PARAMS,
      pictures: Type.Array(Type.String(), { minItems: 1, maxItems: LOCATION_LIMITS.pictures, description: "The pictures, film-relative (png, jpg or webp), in a stable order round the place" }),
      size: Type.Optional(StringEnum(VIEW_SIZES, { default: DEFAULT_SIZE, description: "The grid everything is put on, width x height" })),
      refinePoses: Type.Optional(Type.Boolean({ default: false, description: "Bundle-adjust the estimated cameras (two or more pictures). A refinement that does not hold is discarded, never an error" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const ctx = context(params, signal, onUpdate);
      const existing = readRecord(ctx.place);
      if (existing?.posed) throw new Error(`${ctx.place.shown} already has its posed frames: go on with ${LOCATION_VIEWS_TOOL} or ${LOCATION_SPLAT_TOOL}. Other pictures are another set`);
      if (new Set(params.pictures).size !== params.pictures.length) throw new Error("a picture is named twice");
      const size = params.size ?? existing?.size ?? DEFAULT_SIZE;
      if (!VIEW_SIZES.includes(size)) throw new Error(`size is one of ${VIEW_SIZES.join(", ")}`);
      if (params.refinePoses && params.pictures.length < 2) throw new Error("refinePoses adjusts cameras against each other: it needs two or more pictures");
      const [width, height] = gridOf(size);

      const pictures: (LocationSetRecord["pictures"][number] & { full: string; type: string })[] = [];
      for (const relative of params.pictures) {
        const guard = await guardPath(ctx.place.filmDir, relative);
        if (!guard.allowed) throw new Error(guard.reason ?? `Picture path rejected: ${relative}`);
        const full = join(ctx.place.filmDir, relative);
        if (!existsSync(full) || !statSync(full).isFile()) throw new Error(`Picture not found in the film: ${relative}`);
        const type = PICTURE_TYPES[extname(full).toLowerCase()];
        if (!type) throw new Error(`Unsupported picture type: ${relative} (png, jpg or webp)`);
        const bytes = readFileSync(full);
        const measured = pictureSize(bytes);
        pictures.push({ file: relative, sha256: sha256(bytes), bytes: bytes.length, ...(measured ?? {}), full, type });
      }
      if (existing && (existing.size !== size || JSON.stringify(existing.pictures.map((p) => p.sha256)) !== JSON.stringify(pictures.map((p) => p.sha256)))) {
        throw new Error(`${ctx.place.shown} was started at ${existing.size} with other pictures (${existing.pictures.map((p) => p.file).join(", ")}): give those again to go on, or start another set`);
      }
      // A picture of another shape than the grid loses what is cropped: said, since it is field of view the set will not have.
      const cropped = pictures.filter((p) => p.width && p.height && Math.abs(p.width / p.height / (width / height) - 1) > 0.02).map((p) => p.file);

      const record: LocationSetRecord = existing ?? {
        version: 1, film: params.film, location: params.location, set: params.set, provider: ATLAS_PROVIDER, createdAt: new Date().toISOString(), size,
        pictures: pictures.map(({ full: _full, type: _type, ...kept }) => kept), views: {}, splats: {}, meshes: {},
      };

      const step: Step = {
        step: "pose", task: "images2PosedRGBD", capability: "world.reconstruct", purpose: `location ${params.location}, set ${params.set}: pose ${pictures.length} picture${pictures.length === 1 ? "" : "s"}`,
        price: estimate("images2PosedRGBD", {}, ctx.settings.credits),
        asked: { pictures: pictures.map((picture) => picture.sha256), size, refinePoses: params.refinePoses ?? false },
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
          // On one grid from the start: one picture, or pictures from one spot, come back on another unless it is asked for, and a splat would refuse them.
          return images2PosedRGBDBody({ images: assets, targetResolution: [width, height], ...(params.refinePoses ? { refinePoses: true } : {}) });
        },
      };
      const done = await paidStep(ctx, step);
      const frames = readPosedFrames(done.run.operation.response);
      framesFor(frames, "what Atlas returned");
      writeFileSync(join(ctx.place.dir, "posed.json"), json({ operationId: done.run.operation.id, frames }));
      // The depth and confidence maps: kept, so the set does not live only in the project at World Labs.
      const kept: string[] = [];
      for (const [index, frame] of frames.entries()) {
        const number = String(index + 1).padStart(3, "0");
        const depth = frame.depth as { depthAsset?: TaskAsset; confidenceAsset?: TaskAsset | null };
        try {
          if (depth.depthAsset) kept.push(`posed/${(await keep(ctx, depth.depthAsset, join(ctx.place.dir, "posed"), `depth-${number}`, ".exr")).file}`);
          if (depth.confidenceAsset) kept.push(`posed/${(await keep(ctx, depth.confidenceAsset, join(ctx.place.dir, "posed"), `confidence-${number}`, ".png")).file}`);
        } catch { /* a depth map that cannot be fetched now is still in the project: the frames name it by id */ }
      }
      const accepted = done.run.operation.response?.["poseRefinementAccepted"];
      const posed = { ...keepProvenance(ctx, step, done, LOCATION_SET_TOOL), frames: frames.length, kept, ...(typeof accepted === "boolean" ? { poseRefinementAccepted: accepted } : {}) };
      updateRecord(ctx.place, record, (now) => { now.posed = posed; });
      done.collected();

      return {
        content: [{
          type: "text" as const,
          text: tail(ctx,
            `✅ ${ctx.place.shown} — ${frames.length} posed frame${frames.length === 1 ? "" : "s"} at ${width}×${height} from ${pictures.length} picture${pictures.length === 1 ? "" : "s"}, ${costText(posed)}, ${seconds(done.run)}s${done.resumed ? " (a job taken up again)" : ""}`,
            `   posed.json holds the frames as Atlas returned them; ${kept.length} depth and confidence map${kept.length === 1 ? "" : "s"} kept in posed/`,
            cropped.length ? `   ⚠️ not ${width}×${height} in shape, so cropped to it: ${cropped.join(", ")}. What was cut off is not in the set` : null,
            accepted === false ? "   the refined cameras were not kept (they moved further than Atlas allows): the set has the unrefined ones, which is not an error" : null,
            frames.length === 1 ? "   one picture: about half its field of view to either side, or a third of its depth forward, still shows what it showed. Beyond that Atlas invents" : null,
            `   next: ${LOCATION_VIEWS_TOOL} { film, location, set, viewsId, path: "orbit" } for 6–12 views round the place, to look at before paying for a splat; ` +
              `then ${LOCATION_SPLAT_TOOL} { film, location, set, withViews } for a draft`,
          ).join("\n"),
        }],
        details: { setPath: ctx.place.dir, frames: frames.length, size, operationId: done.run.operation.id, estimate: step.price },
      };
    },
  });

  // --- pva_location_views: a path of cameras → stills and a plate ------------

  pi.registerTool({
    name: LOCATION_VIEWS_TOOL,
    label: "Render Views of a Location's Set",
    description:
      "See a location's set from cameras it is given: World Labs Atlas renders the place from each one (atlasGenerate), held to the set's posed frames. Two uses, and they differ. " +
      "**Views round the place** — 6 to 12, each from its own position, with depth (the default): open every one, and those that hold up join the splat (`withViews`) and serve as a generator's references. Under a minute. " +
      "**A plate** — a camera path, one camera per frame (seconds × frame rate), `plate: true`: joined into plate.mp4, without depth. A path is sent whole, in one request: frames of separate requests do not match each other. " +
      "Paid per view, on the film's spend ledger (capability world.render); the price per view is the operator's to give (atlasGenerate.perView in library/.render/worldlabs-atlas.json). " +
      `A path is: "orbit" — \`count\` cameras on an arc of \`sweepDegrees\` round what posed frame \`from\` looks at, at that camera's height; "push" — \`count\` cameras going \`distance\` along that frame's line of sight; ` +
      '"cameras" — each given as where it stands and what it looks at, in the set\'s own coordinates (y up, metres as Atlas estimated them). Keep every camera in space the pictures show as empty: one inside an object or behind a wall gets invented shapes in front of its lens. ' +
      "`contextViews` adds earlier views that held up to what Atlas is shown, to cover a gap or go further round. " +
      `720p at most (${VIEW_SIZES.join(", ")}): these are references and plates, never a film's final picture. What no picture showed is invented, in every view the same way: look at every view. ` +
      `Saves locations/<location>/sets/<set>/views/<viewsId>/ (numbered stills, views.json, plate.mp4 with \`plate\`). A viewsId is used once.`,
    parameters: Type.Object({
      ...SET_PARAMS,
      viewsId: Type.String({ description: "A name for these views (lower-case letters, digits, _ and -)" }),
      path: StringEnum(VIEW_PATHS as unknown as [string, ...string[]], { description: "orbit, push, or cameras given in full" }),
      from: Type.Optional(Type.Integer({ minimum: 1, description: "orbit, push: the posed frame the path starts from, counted from 1. Default 1" })),
      sweepDegrees: Type.Optional(Type.Number({ minimum: -360, maximum: 360, description: "orbit: how far round, in degrees; negative goes the other way. Default 360 with depth (views all round), 60 for a plate" })),
      distance: Type.Optional(Type.Number({ description: "push: how far along the line of sight, in the set's units (about metres); negative pulls back. Required for push" })),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: LOCATION_LIMITS.views, description: "orbit, push: how many views. Default 8. Each is paid; for a plate, seconds × frame rate" })),
      cameras: Type.Optional(Type.Array(Type.Object({
        at: Type.Array(Type.Number(), { minItems: 3, maxItems: 3, description: "Where it stands: x, y, z (y up)" }),
        lookAt: Type.Array(Type.Number(), { minItems: 3, maxItems: 3, description: "What it looks at" }),
        fov: Type.Optional(Type.Number({ minimum: 10, maximum: 120, description: "Vertical field of view, degrees. Default 50" })),
      }), { minItems: 1, maxItems: LOCATION_LIMITS.views, description: "cameras: the path, in order" })),
      size: Type.Optional(StringEnum(VIEW_SIZES, { description: "Width x height. Default: the set's own, which views must have to join its splat" })),
      depth: Type.Optional(Type.Boolean({ description: "Give each view its depth, so it can join the splat or be context. Default true, false for a plate. Cameras must then not all stand in one spot" })),
      contextViews: Type.Optional(Type.Array(Type.String(), { description: "viewsIds, made with depth, to show Atlas beside the posed frames" })),
      prompt: Type.Optional(Type.String({ description: "What the place is and looks like: its materials, its light. Not an edit, and not a camera move. Omitted: the set's own description, once it has one" })),
      plate: Type.Optional(Type.Boolean({ default: false, description: "Join the stills into plate.mp4 (FFmpeg), at fps" })),
      fps: Type.Optional(Type.Integer({ minimum: 1, maximum: 60, description: "For a plate. Default 24: use the film's" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const ctx = context(params, signal, onUpdate);
      if (!NAME.test(params.viewsId)) throw new Error("viewsId is lower-case letters, digits, underscores and hyphens (max 64)");
      const record = requireRecord(ctx.place);
      if (record.views[params.viewsId]) throw new Error(`${ctx.place.shown}/views/${params.viewsId} already exists: views are made once, pick another viewsId`);
      const posed = readFrames<PosedResult>(ctx.place, "posed.json");
      const size = params.size ?? record.size;
      const [width, height] = gridOf(size);
      const kind = params.path as (typeof VIEW_PATHS)[number];
      const returnDepth = params.depth ?? !params.plate;

      const context_ = framesFor(posed, "the set's posed frames");
      for (const id of params.contextViews ?? []) {
        const views = record.views[id];
        if (!views) throw new Error(`the set has no views named ${id}: its views are ${Object.keys(record.views).join(", ") || "none"}`);
        if (!views.depth) throw new Error(`views ${id} were made without depth, so they cannot be context: only views with depth can`);
        if (`${views.width}x${views.height}` !== record.size) throw new Error(`views ${id} are ${views.width}×${views.height} and the set is ${record.size.replace("x", "×")}: all context is of one size`);
        context_.push(...framesFor(readFrames<GeneratedFrame>(ctx.place, join("views", id, "views.json")), `views ${id}`));
      }

      let targets: AtlasCamera[];
      let described: string;
      const notes: string[] = [];
      if (kind === "cameras") {
        if (!params.cameras?.length) throw new Error('path "cameras" needs `cameras`: where each stands and what it looks at');
        targets = params.cameras.map((camera) => placed(camera.at as [number, number, number], camera.lookAt as [number, number, number], width, height, camera.fov ?? 50));
        described = `${targets.length} camera${targets.length === 1 ? "" : "s"} given in full`;
      } else {
        const index = (params.from ?? 1) - 1;
        if (index >= posed.length) throw new Error(`from is ${params.from}, and the set has ${posed.length} posed frame${posed.length === 1 ? "" : "s"}`);
        const start = frameCamera(posed[index]!);
        if (!start) throw new Error(`the camera of posed frame ${index + 1} could not be read: give the path as "cameras"`);
        const count = params.count ?? 8;
        if (kind === "orbit") {
          // What the frame looks at: Atlas says where its scene sits on the ground; the orbit goes round that, at the camera's own height.
          const pivot = posed[index]!.centroidWorld;
          const eye = start.cameraToWorld[7]!;
          let centre: [number, number, number];
          if (pivot && pivot.every(Number.isFinite) && Math.hypot(pivot[0] - start.cameraToWorld[3]!, pivot[2] - start.cameraToWorld[11]!) > 1e-3) centre = [pivot[0], eye, pivot[2]];
          else {
            const focus = sceneFocus(posed.map((frame) => frameCamera(frame)).filter((camera): camera is AtlasCamera => camera !== null));
            if (focus.guessed) notes.push("Atlas gave no middle for this frame's scene and the posed cameras do not look at one point, so what the orbit goes round is a guess two units ahead of them: check the views, or give cameras in full");
            centre = [focus.centre[0], eye, focus.centre[2]];
          }
          const sweep = params.sweepDegrees ?? (returnDepth ? 360 : 60);
          targets = orbit({ from: start, centre, sweepDegrees: sweep, count, width, height });
          // The first camera of an orbit is the frame's own: a view from where a picture already stands is paid for nothing.
          if (returnDepth && Math.abs(sweep) === 360 && count > 1) {
            targets = orbit({ from: start, centre, sweepDegrees: sweep, count: count + 1, width, height }).slice(1);
          }
          described = `an orbit of ${sweep}° in ${targets.length} views from frame ${index + 1}`;
        } else {
          if (params.distance === undefined) throw new Error('path "push" needs `distance`, in the set\'s units');
          targets = push({ from: start, distance: params.distance, count, width, height });
          described = `a push of ${params.distance} in ${count} views from frame ${index + 1}`;
        }
      }
      if (targets.length > LOCATION_LIMITS.views) throw new Error(`at most about ${LOCATION_LIMITS.views} cameras in one request, and this is ${targets.length}: shorten the path, or plan separate shots`);
      if (params.plate && spawnSync(process.env.FFMPEG_BIN ?? "ffmpeg", ["-version"], { timeout: 5000, stdio: "ignore" }).status !== 0) {
        throw new Error("a plate is joined with FFmpeg, and it was not found: install it, or leave `plate` out");
      }
      // The scene in Atlas's own words, from an earlier render: with it, the pictures need not be captioned again.
      const prompt = params.prompt ?? record.prompt;

      const step: Step = {
        step: `views-${params.viewsId}`, task: "atlasGenerate", capability: "world.render",
        purpose: `location ${params.location}, set ${params.set}: views ${params.viewsId} (${targets.length})`,
        price: estimate("atlasGenerate", { views: targets.length }, ctx.settings.credits),
        asked: { cameras: targets, returnDepth, context: params.contextViews ?? [], prompt: params.prompt ?? null },
        prepare: async () => atlasGenerateBody({
          contextFrames: context_, targetCameras: targets, returnDepth,
          ...(prompt ? { prompt } : {}), ...(params.prompt === undefined && record.prompt ? { enhancePrompt: false } : {}),
        }),
      };
      const done = await paidStep(ctx, step);
      const generated = readGeneratedFrames(done.run.operation.response);
      if (generated.length !== targets.length) notes.push(`${targets.length} views were asked and paid for, and ${generated.length} came back: read provenance/${done.run.operation.id}.json`);
      const withDepth = generated.every((frame) => posedFrame(frame) !== null);
      if (returnDepth && !withDepth) notes.push("depth was asked for and not every view came back with it: these views cannot join a splat");
      const viewsDir = join(ctx.place.dir, "views", params.viewsId);
      const stills: FileRecord[] = [];
      for (const [index, frame] of generated.entries()) stills.push(await keep(ctx, frame.imageAsset, viewsDir, String(index + 1).padStart(6, "0"), ".jpg"));
      const promptUsed = done.run.operation.response?.["promptUsed"];
      writeFileSync(join(viewsDir, "views.json"), json({
        viewsId: params.viewsId, operationId: done.run.operation.id, path: kind, described, width, height, depth: withDepth,
        ...(typeof promptUsed === "string" ? { promptUsed } : {}),
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
      updateRecord(ctx.place, record, (now) => {
        now.views[params.viewsId] = { ...kept, dir: `views/${params.viewsId}`, frames: stills.length, width, height, path: described, depth: withDepth, ...(plate ? { plate } : {}) };
        if (!now.prompt && typeof promptUsed === "string" && promptUsed) now.prompt = promptUsed;
      });
      done.collected();

      const joins = withDepth && size === record.size;
      return {
        content: [{
          type: "text" as const,
          text: tail(ctx,
            `✅ ${ctx.place.shown}/views/${params.viewsId}/ — ${stills.length} still${stills.length === 1 ? "" : "s"} at ${width}×${height}${withDepth ? ", with depth" : ""} (${described}), ${costText(kept)}, ${seconds(done.run)}s${done.resumed ? " (a job taken up again)" : ""}`,
            plate ? `   plate: ${ctx.place.shown}/views/${params.viewsId}/plate.mp4, ${stills.length} frames at ${params.fps ?? 24} fps, no sound` : null,
            ...notes.map((note) => `   ⚠️ ${note}`),
            "   720p: a reference to hold a shot to, a background to build on, a previsualisation — not the film's final picture",
            "   open every still: objects should keep their place, shape and look from one view to the next. Atlas invents what no picture showed, and a wall that was never photographed is a guess",
            joins
              ? `   views that agree can join the splat: ${LOCATION_SPLAT_TOOL} { withViews: ["${params.viewsId}"] }. Leave out a set of views in which something disagrees: it becomes a doubled, ghosted object. To cover a gap, render more with contextViews: ["${params.viewsId}"]`
              : withDepth ? `   these are ${width}×${height} and the set is ${record.size.replace("x", "×")}: they cannot join its splat, which takes frames of one size` : "   made without depth: for looking at and for a plate, not for a splat",
          ).join("\n"),
        }],
        details: { viewsPath: viewsDir, stills: stills.map((still) => still.file), depth: withDepth, ...(plate ? { platePath: join(viewsDir, plate) } : {}), operationId: done.run.operation.id, estimate: step.price },
      };
    },
  });

  // --- pva_location_splat: frames → a Gaussian splat -------------------------

  pi.registerTool({
    name: LOCATION_SPLAT_TOOL,
    label: "Make a Location Set's Splat",
    description:
      "Make the Gaussian splat of a location's set from its frames (posedImages2Splats): the place itself, in three dimensions. On the film's spend ledger (capability world.reconstruct). A run that fails is free. " +
      `Two qualities, and an order between them. "draft" (${priceLine("posedImages2Splats.draft")}; about half a minute; ${SPLAT_FRAME_LIMITS.draft[0]}–${SPLAT_FRAME_LIMITS.draft[1]} frames) is always made first: it shows the geometry and what is covered. ` +
      `"refined" (${priceLine("posedImages2Splats.refined")}; 15–21 minutes, up to 30 with many frames; ${SPLAT_FRAME_LIMITS.refined[0]}–${SPLAT_FRAME_LIMITS.refined[1]} frames) is made only after the draft, and only when the operator has said so: ask them, stop, and pass who approved in \`approvedBy\`. Never decide it yourself. ` +
      `The frames are the set's posed frames and the views named in \`withViews\` (${LOCATION_VIEWS_TOOL}, made with depth, at the set's size): at least two, and for a room 8–16 that cover what will be looked at — the floor, the walls, the far side of things. ` +
      "What no frame shows comes out blurred or invented; an object that two frames disagree on comes out doubled. Refining does not repair that: fix the frames, in the views, before paying for it. " +
      `Saves locations/<location>/sets/<set>/<quality>.spz with its provenance. Next: ${LOCATION_MESH_TOOL} for a mesh Blender can film. ` +
      "A splat of each quality is made once. If the wait runs out or the call is interrupted, the job goes on at Atlas: call again with the same arguments, and it waits for the same job and pays nothing more.",
    parameters: Type.Object({
      ...SET_PARAMS,
      quality: Type.Optional(StringEnum(SPLAT_QUALITIES as unknown as [string, ...string[]], { default: "draft", description: "draft first. refined: only with the operator's go-ahead" })),
      approvedBy: Type.Optional(Type.String({ description: "For refined: who approved it and how, in a few words (\"the operator, in chat, after the draft's views\"). Kept in the set" })),
      withViews: Type.Optional(Type.Array(Type.String(), { description: "viewsIds whose frames join the posed ones: views made with depth, at the set's size, that agree with each other" })),
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
      const withViews = params.withViews ?? [];
      const frames = framesFor(readFrames<PosedResult>(ctx.place, "posed.json"), "the set's posed frames");
      for (const id of withViews) {
        const views = record.views[id];
        if (!views) throw new Error(`the set has no views named ${id}: its views are ${Object.keys(record.views).join(", ") || "none"}`);
        if (!views.depth) throw new Error(`views ${id} were made without depth (a plate): a splat's frames need depth. Render views with depth, and name those`);
        if (`${views.width}x${views.height}` !== record.size) throw new Error(`views ${id} are ${views.width}×${views.height} and the set is ${record.size.replace("x", "×")}: every frame of a splat is on one grid`);
        frames.push(...framesFor(readFrames<GeneratedFrame>(ctx.place, join("views", id, "views.json")), `views ${id}`));
      }
      const [least, most] = SPLAT_FRAME_LIMITS[quality];
      if (frames.length < least) throw new Error(`a splat needs at least ${least} frames, and the set has ${frames.length}: render views first (${LOCATION_VIEWS_TOOL}) and name them in withViews`);
      if (frames.length > most) throw new Error(`a ${quality} splat takes at most ${most} frames, and this would be ${frames.length}: name fewer views`);

      const step: Step = {
        step: `splat-${quality}`, task: "posedImages2Splats", capability: "world.reconstruct",
        purpose: `location ${params.location}, set ${params.set}: ${quality} splat from ${frames.length} frames`,
        price: estimate("posedImages2Splats", { refine: quality === "refined" }, ctx.settings.credits),
        asked: { quality, withViews },
        // With the scene already described, the pictures are not captioned again.
        prepare: async () => posedImages2SplatsBody({ posedFrames: frames, refine: quality === "refined", ...(record.prompt ? { prompt: record.prompt, enhancePrompt: false } : {}) }),
      };
      const done = await paidStep(ctx, step);
      const splat = readSplat(done.run.operation.response);
      if (splat.quality !== quality) throw new Error(`a ${quality} splat was asked for and Atlas operation ${done.run.operation.id} returned a ${splat.quality} one: it is not kept as what it is not. Read ${ctx.place.shown}/provenance/, and call this tool again to collect it once that is understood`);
      const file = await keep(ctx, splat.asset, ctx.place.dir, quality, ".spz");
      const kept = keepProvenance(ctx, step, done, LOCATION_SPLAT_TOOL);
      updateRecord(ctx.place, record, (now) => {
        now.splats[quality] = { ...kept, ...file, assetId: splat.asset.assetId ?? null, frames: frames.length, splats: splat.splats, withViews, ...(quality === "refined" ? { approvedBy: params.approvedBy!.trim() } : {}) };
      });
      done.collected();

      const took = seconds(done.run);
      return {
        content: [{
          type: "text" as const,
          text: tail(ctx,
            `✅ ${ctx.place.shown}/${file.file} — a ${quality} splat from ${frames.length} frames${splat.splats ? `, ${splat.splats.toLocaleString("en-US")} splats` : ""}, ${megabytes(file.bytes)}, ${costText(kept)}, ${took >= 120 ? `${Math.round(took / 60)} min` : `${took}s`}${done.resumed ? " (a job taken up again)" : ""}`,
            quality === "refined" ? `   approved by: ${params.approvedBy!.trim()}` : null,
            frames.length < 8 ? `   ${frames.length} frames is few for a room (8–16 is a good range): what none of them shows is blurred or invented` : null,
            `   next: ${LOCATION_MESH_TOOL} { film, location, set } turns it into a GLB for pva_stage_shot. An .spz itself opens in a splat viewer (Blender 5.3 imports one), not in this studio: judge it from the mesh, or from views`,
            quality === "draft"
              ? `   a draft is for judging geometry and coverage, not for showing. If it holds together and the film needs more, ask the operator before ${LOCATION_SPLAT_TOOL} { quality: "refined", approvedBy } (${priceText(estimate("posedImages2Splats", { refine: true }, ctx.settings.credits))}, 15–21 minutes)`
              : null,
          ).join("\n"),
        }],
        details: { splatPath: join(ctx.place.dir, file.file), quality, frames: frames.length, splats: splat.splats, operationId: done.run.operation.id, estimate: step.price },
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
      "`from` is the splat it is made of: the refined one when there is one, else the draft. `texture` is image_texture (rendered views on a UV atlas, the default there), vertex_color, or none; `targetFaces` decimates it — a set to stage in wants tens of thousands of faces, not millions. " +
      "`cameras` says where the surface is looked for: auto_anchors (the default: from inside the scene's free space, for a room or a yard) or exterior_sphere (from outside, for one object). What no camera sees is not meshed. " +
      "Saves locations/<location>/sets/<set>/<meshId>.glb and says what it holds and how big it is. It is in the set's own world: y up, and metres as Atlas estimated them, which is approximate — check its size against something in it, and give pva_stage_shot a `setScale` if it is off. " +
      "A meshId is used once.",
    parameters: Type.Object({
      ...SET_PARAMS,
      from: Type.Optional(StringEnum(SPLAT_QUALITIES as unknown as [string, ...string[]], { description: "Which splat. Default: refined when the set has one, else draft" })),
      meshId: Type.Optional(Type.String({ description: "The mesh's file name. Default: the splat's quality (draft.glb, refined.glb)" })),
      texture: Type.Optional(StringEnum(MESH_TEXTURES as unknown as [string, ...string[]], { description: "image_texture, vertex_color, or none. Omitted: image_texture" })),
      textureSize: Type.Optional(Type.Integer({ minimum: 256, maximum: 8192, description: "For image_texture: the atlas's side in pixels. Omitted: 4096" })),
      targetFaces: Type.Optional(Type.Integer({ minimum: 100, maximum: 5_000_000, description: "Decimate to at most this many faces. Omitted: every face is kept" })),
      cameras: Type.Optional(StringEnum(MESH_CAMERAS as unknown as [string, ...string[]], { description: "auto_anchors (a place, from inside) or exterior_sphere (an object, from outside). Omitted: auto_anchors" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const ctx = context(params, signal, onUpdate);
      const record = requireRecord(ctx.place);
      const from = (params.from ?? (record.splats.refined ? "refined" : "draft")) as SplatQuality;
      const splat = record.splats[from];
      if (!splat) throw new Error(`${ctx.place.shown} has no ${from} splat: make it with ${LOCATION_SPLAT_TOOL}`);
      // The splat is named by its asset in the project at World Labs, where it stays until it is deleted there.
      if (!splat.assetId) throw new Error(`${ctx.place.shown}/${splat.file} has no asset id on record, so Atlas cannot be told which splat to mesh: read ${ctx.place.shown}/provenance/${splat.operationId}.json`);
      const meshId = params.meshId ?? from;
      if (!NAME.test(meshId)) throw new Error("meshId is lower-case letters, digits, underscores and hyphens (max 64)");
      if (record.meshes[meshId]) throw new Error(`${ctx.place.shown}/${meshId}.glb already exists: a mesh is made once, pick another meshId`);

      const step: Step = {
        step: `mesh-${meshId}`, task: "splats2Mesh", capability: "world.mesh",
        purpose: `location ${params.location}, set ${params.set}: mesh ${meshId} from the ${from} splat`,
        price: estimate("splats2Mesh", {}, ctx.settings.credits),
        asked: { from, texture: params.texture ?? null, textureSize: params.textureSize ?? null, targetFaces: params.targetFaces ?? null, cameras: params.cameras ?? null },
        prepare: async () => splats2MeshBody({
          splat: splat.assetId!,
          ...(params.texture ? { texture: params.texture as MeshTexture } : {}), ...(params.textureSize !== undefined ? { textureSize: params.textureSize } : {}),
          ...(params.targetFaces !== undefined ? { targetFaces: params.targetFaces } : {}), ...(params.cameras ? { cameras: params.cameras as MeshCameras } : {}),
        }),
      };
      const done = await paidStep(ctx, step);
      const { mesh } = readMesh(done.run.operation.response);
      const bytes = await ctx.client().download({ ...(mesh.assetId ? { assetId: mesh.assetId } : {}), ...(mesh.url ? { url: mesh.url } : {}) }, signal);
      const holds = summarizeModel(bytes);
      if (holds.format !== "glb") throw new Error(`what Atlas returned for ${done.run.operation.id} is not a binary glTF: it was paid for and is not kept as a set's mesh; read ${ctx.place.shown}/provenance/`);
      writeFileSync(join(ctx.place.dir, `${meshId}.glb`), bytes);
      const kept = keepProvenance(ctx, step, done, LOCATION_MESH_TOOL);
      updateRecord(ctx.place, record, (now) => {
        now.meshes[meshId] = {
          ...kept, file: `${meshId}.glb`, sha256: sha256(bytes), bytes: bytes.byteLength, from, assetId: mesh.assetId ?? null, holds,
          ...(params.texture ? { texture: params.texture } : {}), ...(params.targetFaces !== undefined ? { targetFaces: params.targetFaces } : {}),
        };
      });
      done.collected();

      return {
        content: [{
          type: "text" as const,
          text: tail(ctx,
            `✅ ${ctx.place.shown}/${meshId}.glb — ${megabytes(bytes.byteLength)}, from the ${from} splat, ${costText(kept)}, ${seconds(done.run)}s${done.resumed ? " (a job taken up again)" : ""}`,
            `   ${describeModel(holds)}`,
            "   its size is Atlas's estimate of metres: compare it with something in it whose size you know (a door is about 2 m), and give the ratio as setScale if it is off",
            `   to stage in it: pva_stage_shot { channel: "${params.film}", series: <scene>, episode: <shot>, locationSet: { location: "${params.location}", set: "${params.set}", mesh: "${meshId}" }, players: [{ …, at: "x, y" }] }`,
            "   it has no marks and no light of its own: places are given in metres, and the stage lights it. Geometry no camera saw is not in it. Look at the first shot before staging more",
          ).join("\n"),
        }],
        details: { meshPath: join(ctx.place.dir, `${meshId}.glb`), from, holds, operationId: done.run.operation.id, estimate: step.price },
      };
    },
  });

  // --- pva_location_sets: what there is, and its jobs ------------------------

  pi.registerTool({
    name: LOCATION_SETS_TOOL,
    label: "Location Sets",
    description:
      "List a film's location sets: what each holds (posed frames, views, splats, meshes), what it is taken to have cost, the licence it was made under, and any Atlas job still running for it. Free. " +
      "With `cancel` (a location, a set and the step's name as listed), asks Atlas to stop that job: a request, and best-effort — a job that had already finished keeps its result. The key needs `operations.cancel` for it. " +
      "Also says what each step is priced at, and what the operator has still to state in library/.render/worldlabs-atlas.json. What was really charged is on the account's Usage page.",
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
        try {
          const after = await atlas().cancelOperation(job.operationId, { reason: "stopped from the studio" }, signal);
          lines.push(after.state === "succeeded"
            ? `ℹ️ ${job.operationId} (${place.shown}, ${job.step}) had already finished: its result is at Atlas, and its note is dropped here. Ask for the step again to collect it — the same request gets the same operation, at no new charge`
            : `🛑 asked Atlas to stop ${job.operationId} (${place.shown}, ${job.step}): it is now ${after.state}. It was reserved at ${priceText(job.price)}; what Atlas charged for it, if anything, is on the account's Usage page`);
        } catch (e) {
          // Atlas will not stop it — it is gone, or the key may not cancel. The note is dropped all the same, or the step could never be asked for again.
          if (!(e instanceof AtlasHttpError && e.refused)) throw e;
          lines.push(`🛑 Atlas would not stop ${job.operationId} (HTTP ${e.status}${e.status === 403 ? ": the key lacks operations.cancel" : ""}). Its note is dropped from ${place.shown}, so the step can be asked for again; it was reserved at ${priceText(job.price)}, and what Atlas charged is on the account's Usage page`);
        }
        forgetJob(place, params.cancel.step);
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
          lines.push(`${place.shown} — ${record.pictures.length} pictures at ${record.size.replace("x", "×")}; ${record.posed ? `${record.posed.frames} posed frames` : "not posed yet"}; about ${usd(spent)} at the prices known`);
          for (const [id, views] of Object.entries(record.views)) lines.push(`   views/${id}/: ${views.frames} stills at ${views.width}×${views.height}${views.depth ? ", with depth" : ""} (${views.path})${views.plate ? ", plate.mp4" : ""}`);
          for (const quality of SPLAT_QUALITIES) {
            const splat = record.splats[quality];
            if (splat) lines.push(`   ${splat.file}: ${quality} splat from ${splat.frames} frames, ${megabytes(splat.bytes)}${splat.approvedBy ? `, approved by ${splat.approvedBy}` : ""}`);
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
          lines.push(`   licence: plan ${licence?.plan ?? "unstated"}, ${licence?.commercialUse ? "yours to use, commercially too" : "personal, non-commercial use only"}`);
          listed.push({ location, set, record, jobs });
        }
      }
      if (listed.length === 0) lines.push(`${params.film} has no location sets${params.location ? ` for ${params.location}` : ""}: start one with ${LOCATION_SET_TOOL}`);
      lines.push(
        "", "prices, in credits (1,000 to the dollar; the rate card at atlas.worldlabs.ai is what counts):", ...describePrices(settings.credits).map((line) => `   ${line}`),
        `   ${licenceLine(settings)}`, ...settingsLines(settings),
        ...(WIRE.verifiedLive ? [] : ["   ⚠️ these tools follow Atlas's documentation and have not yet run against the service (ADR-0057): the first paid step is their test, make it a small one"]),
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
        `a draft splat ${usd(estimate("posedImages2Splats", { refine: false }, settings.credits).usd)}, refined ${usd(estimate("posedImages2Splats", { refine: true }, settings.credits).usd)}; 720p at most; the key needs ${KEY_SCOPES.join(", ")}); ` +
        `plan ${settings.plan ?? `not stated in ${ATLAS_SETTINGS_RELATIVE}: sets are marked for non-commercial use only`}; ` +
        (unpriced.length ? `no price for ${unpriced.join(", ")}: a film with a budget refuses those steps until ${ATLAS_SETTINGS_RELATIVE} gives them; ` : "") +
        (WIRE.verifiedLive ? `verified against the live API ${WIRE.verifiedLive}` : "written from the documentation, not yet run against the live API (ADR-0057)"),
    },
  };
}

function taskOf(key: PriceKey): AtlasTask {
  return key.split(".")[0] as AtlasTask;
}
