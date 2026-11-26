// ---------------------------------------------------------------------------
// Characters on a set, filmed
// ---------------------------------------------------------------------------
// rig-shot films one character on an empty stage. This puts several in one
// picture and, when a set is given, in a place: each player stands on a
// mark, turned the way it is told, and does one thing after another — plays
// a clip, walks to another mark while a clip plays, waits, turns to someone.
//
// A stage is laid out as it is seen from the front: x to the right, y away
// from the audience, in metres on the floor. A player turned 0 faces the
// audience. A set is a .blend; an object in it named `mark.<name>` is a
// place a player can be sent to by that name.
//
// A walk goes round what stands in its way — a thing of the set, a player
// who stays where it is — and steps onto what is low enough. With no way
// round, the shot is refused and what stands in the way is named.
//
// A two-legged body stands with its arms beside it whenever it plays no
// clip, and is watched in every frame for a part passing into another: a
// hand into its head, its body or its other hand, a leg through the other;
// and for its skin passing through a thing of the set.
//
// A hand or a foot reaches for a mark, a thing of the set or a part of
// another player and stays on it, over whatever its clip does. A thing of
// the set is taken in a hand, carried, and put down on a place.
//
// No script comes with a request, and the set's own Python is not run.
// python/stage-shot.py does the staging; the frames are joined here.
// ---------------------------------------------------------------------------

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { joinFrames, nonempty } from "./frames.js";
import { blenderExecutable, probe } from "./index.js";
import { runProcess } from "./process.js";
import { RIG_FACINGS, type RigClipThrough, type RigFacing } from "./rig-sheet.js";
import { RIG_SHOT_DEFAULTS, RIG_SHOT_LIMITS, SHOT_CAMERAS, type ShotCamera } from "./rig-shot.js";

/** wide: everyone with air around them. full, medium, close: as for one character, of the tallest it is on. */
export const STAGE_FRAMINGS = ["wide", "full", "medium", "close"] as const;
export type StageFraming = (typeof STAGE_FRAMINGS)[number];

/** A place on the stage: a mark of the set by name, or [x, y] in metres (x to the right, y away from the audience). */
export type StagePlace = string | readonly [number, number];

/** What reaches: a hand or a foot of a two-legged body. */
export const STAGE_LIMBS = ["left hand", "right hand", "left foot", "right foot"] as const;
export type StageLimb = (typeof STAGE_LIMBS)[number];

/** What of another player is reached for: a hand or a foot (its middle), a shoulder (on top of it), or the nearest of a part. */
export const STAGE_PARTS = [...STAGE_LIMBS, "left shoulder", "right shoulder", "head", "body", "left upper arm", "right upper arm", "left leg", "right leg"] as const;
export type StagePart = (typeof STAGE_PARTS)[number];

/**
 * A hand or a foot brought to something and kept on it while the act lasts, over what the clip does.
 * It reaches for one thing: a mark, a thing of the set, or a part of another player.
 */
export interface StageReach {
  with: StageLimb;
  /** A mark of the set: where it is, at its own height. */
  mark?: string;
  /** A thing of the set, by its object's name: the place on its surface nearest the shoulder. */
  object?: string;
  /** Another player, and what of it. Two hands that reach for each other meet between the two. */
  player?: string;
  part?: StagePart;
  /** Seconds into the act at which it starts. Default 0. */
  after?: number;
  /** How long, the coming and the going among it. Default: until the act ends; 1.5 s in an act with nothing else. */
  seconds?: number;
}

/** A thing of the set taken in a hand: the hand goes to it, and from then it goes where the hand goes. */
export interface StageTake {
  object: string;
  with: StageLimb;
  /** Seconds into the act at which the hand starts for it. Default 0. */
  after?: number;
}

/** A thing in a hand put down: on a mark, or on the floor at [x, y]. It stays there. */
export interface StagePut {
  object: string;
  at: StagePlace;
  after?: number;
}

/** One thing a player does. They are done one after another. */
export interface StageAct {
  /** A clip of this player's body to play: a .glb with one motion. Without it the body is at rest. */
  clip?: string;
  /** How many times the clip is played. Default 1. 0, on the last act only: for as long as the shot lasts. */
  loops?: number;
  /** How long the act takes. Default: the clip's length times `loops`; on the way `to` a place, as long as the clip's own pace takes. */
  seconds?: number;
  /** Go there while the clip plays, facing the way. */
  to?: StagePlace;
  /** Turn to face: degrees (0 the audience, 90 the right of the picture, -90 the left, 180 away), or another player by name. */
  turn?: number;
  towards?: string;
  /** Touch something while the act lasts: one of the three in an act. The same reach in the next act stays on. */
  reach?: StageReach;
  take?: StageTake;
  put?: StagePut;
}

export interface StagePlayer {
  /** How the player is called in `towards`, `on` and the report. */
  name: string;
  /** Its body: a rigged binary glTF, or a model with no skeleton, which can stand and be moved. */
  path: string;
  /** Which way the body faces in its file. Default +z. */
  faces?: RigFacing;
  /** Where it starts. Default the middle of the stage. */
  at?: StagePlace;
  /** Which way it faces at the start: degrees, or another player by name. Default: as its mark is turned, or the audience. */
  turn?: number;
  towards?: string;
  does?: StageAct[];
}

/** The set's own camera, or one asked for in a shot's words. */
export type StageCamera = "set" | {
  /** Where it stands, seen from the stage: front is the audience's side. */
  view?: ShotCamera;
  framing?: StageFraming;
  /** The players it is on, by name. Default: all of them. */
  on?: string[];
  /** It goes with the players it is on as they move. Default true; false holds everywhere they go. */
  follow?: boolean;
};

export interface StageShotRequest {
  /** A new directory. */
  outputDir: string;
  /** The place: a .blend. Without it, an empty stage of one colour with a floor. */
  set?: string;
  players: StagePlayer[];
  camera?: StageCamera;
  /** How long. Default: until the last player has done all it does, or two seconds when nobody does anything. */
  seconds?: number;
  width?: number;
  height?: number;
  /** Default: the set's own, or 24 on an empty stage. */
  fps?: number;
  /** An empty stage's colour, as #rrggbb. A set has its own world. */
  background?: string;
  /** A floor on an empty stage that takes the shadows. Default true. */
  ground?: boolean;
  samples?: number;
}

export interface StageActReport {
  /** When it starts, in seconds from the start of the shot. */
  from: number;
  seconds: number;
  clip?: string;
  action?: string;
  clipSeconds?: number;
  to?: [number, number, number];
  metres?: number;
  /** How fast the body was moved, in metres a second. */
  speed?: number;
  /** The pace its clip walks at, read from its feet: a body moved faster or slower than that slides. */
  pace?: number;
  /** What stood in the straight way, which it went round: things of the set and players, by name. `metres` is the way it took. */
  round?: string[];
  /** What it reached for and how near it came. */
  reach?: StageTouch & { for: string; /** How long the hand was on it. */ seconds: number };
  /** `taken` false: the hand stayed too far from it (over a twentieth of the body's height), and it was left where it was. */
  take?: StageTouch & { object: string; taken: boolean };
  /** `put` false: it did not have it. `gap`: how far from its place it was left, in metres. */
  put?: { object: string; with: StageLimb; at: number | null; put: boolean; gap: number; place: [number, number, number] };
}

/** A hand on something: when, and how near. */
export interface StageTouch {
  with: StageLimb;
  /** From when the hand was on it, in the shot's seconds. null: the shot ended before it got there. */
  from?: number | null;
  at?: number | null;
  /** The furthest the middle of the hand was from what it reached for while it was on it, in metres. */
  gap: number;
  /** The furthest that was from the shoulder (or the hip), beside how `long` the limb is: further, and it cannot be reached. */
  far: number;
  long: number;
}

/** A body's skin through a thing of the set: how far beyond the surface at the deepest (metres), from when, for how long, deepest when. */
export interface StageInSet {
  thing: string;
  depth: number;
  from: number;
  seconds: number;
  at: number;
}

export interface StagePlayerReport {
  name: string;
  skeleton: boolean;
  /** Where it started: x, y on the stage and the height of the floor there. */
  at: [number, number, number];
  turn: number;
  tall: number;
  does: StageActReport[];
  /** When it has done all it does. */
  ends: number;
  /** How far it went over the ground, in metres. */
  travel: number;
  /** The share of the shot its chest is in the picture. */
  inFrame: number;
  /** The share of the shot something of the set is between its chest and the camera. */
  hidden: number;
  /**
   * How far below the horizontal its upper arms hang when it plays no clip — before its first,
   * between two, after its last — in degrees: -75 unless the hand would pass into the body there,
   * then as near it as clears. null: its bones were not read as a two-legged body's, and it stands
   * in its rest pose.
   */
  standing: { left?: number; right?: number } | null;
  /**
   * Parts of it in each other, deepest first, as `pva_rig_sheet` measures them on a clip: here
   * `depth` is in metres, beyond how far they are when it stands, and the times are the shot's.
   */
  through: RigClipThrough[];
  /** Its skin through things of the set, deepest first. What it reaches for or carries is not counted. Empty on an empty stage. */
  inSet?: StageInSet[];
}

export interface StageShotReport {
  frames: number;
  fps: number;
  seconds: number;
  width: number;
  height: number;
  set: boolean;
  /** The marks the set has, by name. */
  marks: string[];
  camera: { kind: "set" } | { kind: "words"; view: ShotCamera; framing: StageFraming; on?: string[]; follow: boolean };
  players: StagePlayerReport[];
  /** Pairs of players that came to stand in the same place, and from when. */
  tooClose: { players: [string, string]; from: number }[];
  /** Things of the set that were in a hand: whose, from when, until when (null: to the end of the shot) and where each was left. */
  carried?: { object: string; by: string; with: StageLimb; from: number; until: number | null; left: [number, number, number] | null }[];
  notes: string[];
  engine: string;
  blender: string;
}

export interface StageShotResult {
  outputDir: string;
  mediaPath: string;
  report: StageShotReport;
}

export const STAGE_SHOT_LIMITS = { players: 8, acts: 12, stage: 1000 };
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MARK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A thing of the set is named as Blender names its objects: anything but control characters, up to 63. */
const THING = /^[^\u0000-\u001f]{1,63}$/;

function checkAfter(after: number | undefined, where: string): void {
  if (after !== undefined && !(Number.isFinite(after) && after >= 0 && after <= RIG_SHOT_LIMITS.seconds)) throw new Error(`${where}: after is seconds into the act, from 0 to ${RIG_SHOT_LIMITS.seconds}`);
}

function checkTouch(act: StageAct, names: ReadonlySet<string>, own: string, where: string): void {
  const asked = [act.reach, act.take, act.put].filter((touch) => touch !== undefined).length;
  if (asked === 0) return;
  if (asked > 1) throw new Error(`${where}: one of reach, take and put in an act: give the others an act each`);
  const limb = (value: unknown, what: string) => {
    if (!STAGE_LIMBS.includes(value as StageLimb)) throw new Error(`${where}, ${what}: with is one of ${STAGE_LIMBS.join(", ")}`);
  };
  const thing = (value: unknown, what: string) => {
    if (typeof value !== "string" || !THING.test(value)) throw new Error(`${where}, ${what}: object is the name of a thing of the set`);
  };
  if (act.reach) {
    const reach = act.reach;
    limb(reach.with, "reach");
    const aims = [reach.mark, reach.object, reach.player].filter((aim) => aim !== undefined).length;
    if (aims !== 1) throw new Error(`${where}, reach: it reaches for one thing: a mark, an object of the set, or a player and a part of it`);
    if (reach.mark !== undefined && !MARK.test(reach.mark)) throw new Error(`${where}, reach: a mark is named in letters, digits, dots, underscores and hyphens`);
    if (reach.object !== undefined) thing(reach.object, "reach");
    if (reach.player !== undefined) {
      if (reach.player === own) throw new Error(`${where}, reach: a player does not reach for itself`);
      if (!names.has(reach.player)) throw new Error(`${where}, reach: there is no player named ${reach.player} to reach for`);
      if (!STAGE_PARTS.includes(reach.part as StagePart)) throw new Error(`${where}, reach: part is one of ${STAGE_PARTS.join(", ")}`);
    } else if (reach.part !== undefined) throw new Error(`${where}, reach: part is a part of a player: name the player`);
    checkAfter(reach.after, `${where}, reach`);
    if (reach.seconds !== undefined && (!(reach.seconds > 0) || reach.seconds > RIG_SHOT_LIMITS.seconds)) throw new Error(`${where}, reach: seconds is more than 0 and at most ${RIG_SHOT_LIMITS.seconds}`);
  }
  if (act.take) {
    thing(act.take.object, "take");
    limb(act.take.with, "take");
    checkAfter(act.take.after, `${where}, take`);
  }
  if (act.put) {
    thing(act.put.object, "put");
    if (act.put.at === undefined) throw new Error(`${where}, put: say where it is put: a mark, or [x, y] on the floor`);
    checkPlace(act.put.at, `${where}, put`);
    checkAfter(act.put.after, `${where}, put`);
  }
}

function checkPlace(place: StagePlace, where: string): void {
  if (typeof place === "string") {
    if (!MARK.test(place)) throw new Error(`${where}: a mark is named in letters, digits, dots, underscores and hyphens`);
    return;
  }
  if (!Array.isArray(place) || place.length !== 2 || !place.every((value) => Number.isFinite(value) && Math.abs(value) <= STAGE_SHOT_LIMITS.stage)) {
    throw new Error(`${where}: a place is a mark's name or [x, y] in metres`);
  }
}

function checkTurn(holder: { turn?: number; towards?: string }, names: ReadonlySet<string>, own: string, where: string): void {
  if (holder.turn !== undefined && holder.towards !== undefined) throw new Error(`${where}: give turn or towards, not both`);
  if (holder.turn !== undefined && !(Number.isFinite(holder.turn) && Math.abs(holder.turn) <= 360)) throw new Error(`${where}: turn is in degrees, from -360 to 360`);
  if (holder.towards !== undefined) {
    if (holder.towards === own) throw new Error(`${where}: a player cannot turn towards itself`);
    if (!names.has(holder.towards)) throw new Error(`${where}: there is no player named ${holder.towards} to turn towards`);
  }
}

/** The request with its defaults, refused before Blender is started when it cannot be made. */
export function stageSettings(request: StageShotRequest) {
  if (request.set !== undefined && !/\.blend$/i.test(request.set)) throw new Error("a set is a .blend file");
  if (!Array.isArray(request.players) || request.players.length === 0) throw new Error("a shot needs at least one player");
  if (request.players.length > STAGE_SHOT_LIMITS.players) throw new Error(`at most ${STAGE_SHOT_LIMITS.players} players in one shot`);
  const names = new Set<string>();
  for (const player of request.players) {
    if (!NAME.test(player.name ?? "")) throw new Error("a player's name is letters, digits, underscores and hyphens");
    if (names.has(player.name)) throw new Error(`two players are named ${player.name}`);
    names.add(player.name);
  }
  const players = request.players.map((player) => {
    const who = player.name;
    if (!/\.glb$/i.test(player.path)) throw new Error(`${who}: a player is filmed from a binary glTF (.glb)`);
    if (player.faces !== undefined && !RIG_FACINGS.includes(player.faces)) throw new Error(`${who}: faces is one of ${RIG_FACINGS.join(", ")}`);
    if (player.at !== undefined) checkPlace(player.at, `${who}, at`);
    checkTurn(player, names, who, who);
    const does = player.does ?? [];
    if (does.length > STAGE_SHOT_LIMITS.acts) throw new Error(`${who}: at most ${STAGE_SHOT_LIMITS.acts} acts`);
    does.forEach((act, index) => {
      const where = `${who}, act ${index + 1}`;
      if (act.clip !== undefined && !/\.glb$/i.test(act.clip)) throw new Error(`${where}: a clip is a binary glTF (.glb)`);
      if (act.to !== undefined) checkPlace(act.to, `${where}, to`);
      checkTurn(act, names, who, where);
      if (act.to !== undefined && (act.turn !== undefined || act.towards !== undefined)) throw new Error(`${where}: on the way to a place a player faces the way: turn in the next act`);
      if (act.seconds !== undefined && (!(act.seconds > 0) || act.seconds > RIG_SHOT_LIMITS.seconds)) throw new Error(`${where}: seconds is more than 0 and at most ${RIG_SHOT_LIMITS.seconds}`);
      if (act.loops !== undefined) {
        if (act.clip === undefined) throw new Error(`${where}: loops counts the playings of a clip, and the act has none`);
        if (!Number.isInteger(act.loops) || act.loops < 0 || act.loops > RIG_SHOT_LIMITS.loops) throw new Error(`${where}: loops is a whole number from 0 to ${RIG_SHOT_LIMITS.loops}`);
        if (act.loops === 0 && index !== does.length - 1) throw new Error(`${where}: loops 0 goes on for as long as the shot lasts, so it is the last thing a player does`);
        if (act.loops === 0 && (act.seconds !== undefined || act.to !== undefined)) throw new Error(`${where}: loops 0 goes on for as long as the shot lasts: leave seconds and to out`);
      }
      checkTouch(act, names, who, where);
      if ((act.reach || act.take || act.put) && request.set === undefined && (act.take || act.put || act.reach?.player === undefined)) {
        throw new Error(`${where}: an empty stage has no marks and no things: only a part of another player is reached for there`);
      }
      if (act.clip === undefined && act.to === undefined && act.seconds === undefined && act.turn === undefined && act.towards === undefined && !act.reach && !act.take && !act.put) {
        throw new Error(`${where} does nothing: give it a clip, a place to go to, a turn, something to reach for, or seconds to wait`);
      }
    });
    return {
      name: who, path: resolve(player.path), faces: player.faces ?? "+z",
      ...(player.at !== undefined ? { at: player.at } : {}), ...(player.turn !== undefined ? { turn: player.turn } : {}), ...(player.towards !== undefined ? { towards: player.towards } : {}),
      does: does.map((act) => ({ ...act, ...(act.clip !== undefined ? { clip: resolve(act.clip) } : {}) })),
    };
  });

  const asked = request.camera ?? {};
  let camera: StageShotReport["camera"];
  if (asked === "set") {
    if (request.set === undefined) throw new Error("the set's own camera was asked for, and there is no set");
    camera = { kind: "set" };
  } else {
    const view = asked.view ?? RIG_SHOT_DEFAULTS.camera, framing = asked.framing ?? (players.length > 1 ? "wide" : "full");
    if (!SHOT_CAMERAS.includes(view)) throw new Error(`camera view is one of ${SHOT_CAMERAS.join(", ")}`);
    if (!STAGE_FRAMINGS.includes(framing)) throw new Error(`camera framing is one of ${STAGE_FRAMINGS.join(", ")}`);
    if (asked.on !== undefined) {
      if (!Array.isArray(asked.on) || asked.on.length === 0) throw new Error("camera on names at least one player");
      for (const name of asked.on) if (!names.has(name)) throw new Error(`the camera is on ${name}, and there is no player of that name`);
    }
    camera = { kind: "words", view, framing, ...(asked.on ? { on: asked.on } : {}), follow: asked.follow ?? true };
  }

  const settings = {
    ...(request.set !== undefined ? { set: resolve(request.set) } : {}),
    players, camera,
    width: request.width ?? RIG_SHOT_DEFAULTS.width, height: request.height ?? RIG_SHOT_DEFAULTS.height,
    ...(request.fps !== undefined ? { fps: request.fps } : {}),
    background: request.background ?? RIG_SHOT_DEFAULTS.background, ground: request.ground ?? true, samples: request.samples ?? RIG_SHOT_DEFAULTS.samples,
    ...(request.seconds !== undefined ? { seconds: request.seconds } : {}),
  };
  for (const [name, value] of [["width", settings.width], ["height", settings.height]] as const) {
    if (!Number.isInteger(value) || value < RIG_SHOT_LIMITS.side[0] || value > RIG_SHOT_LIMITS.side[1] || value % 2) {
      throw new Error(`${name} is an even number of pixels from ${RIG_SHOT_LIMITS.side[0]} to ${RIG_SHOT_LIMITS.side[1]}`);
    }
  }
  if (settings.fps !== undefined && (!Number.isInteger(settings.fps) || settings.fps < RIG_SHOT_LIMITS.fps[0] || settings.fps > RIG_SHOT_LIMITS.fps[1])) throw new Error(`fps is a whole number from ${RIG_SHOT_LIMITS.fps[0]} to ${RIG_SHOT_LIMITS.fps[1]}`);
  if (settings.seconds !== undefined && (!(settings.seconds > 0) || settings.seconds > RIG_SHOT_LIMITS.seconds)) throw new Error(`seconds is more than 0 and at most ${RIG_SHOT_LIMITS.seconds}`);
  if (!Number.isInteger(settings.samples) || settings.samples < RIG_SHOT_LIMITS.samples[0] || settings.samples > RIG_SHOT_LIMITS.samples[1]) throw new Error(`samples is a whole number from ${RIG_SHOT_LIMITS.samples[0]} to ${RIG_SHOT_LIMITS.samples[1]}`);
  if (!/^#[0-9a-f]{6}$/i.test(settings.background)) throw new Error("background is a colour as #rrggbb");
  return settings;
}

/** Film players on a set. The output directory holds shot.mp4, shot.json and the frames. */
export async function stageShot(
  request: StageShotRequest,
  options: { blenderPath?: string; ffmpegPath?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<StageShotResult> {
  const settings = stageSettings(request);
  options.signal?.throwIfAborted();
  if (settings.set) await nonempty(settings.set);
  for (const player of settings.players) {
    await nonempty(player.path);
    for (const act of player.does) if (act.clip) await nonempty(act.clip);
  }
  const executable = options.blenderPath ?? blenderExecutable();
  const health = probe(executable);
  if (!health.available) throw new Error(health.detail);
  const timeoutMs = options.timeoutMs ?? 3_600_000;

  const outputDir = resolve(request.outputDir);
  await mkdir(dirname(outputDir), { recursive: true });
  await mkdir(outputDir);
  const configPath = join(outputDir, "request.json");
  await writeFile(configPath, JSON.stringify({ outputDir, ...settings, maxFrames: RIG_SHOT_LIMITS.frames }, null, 2));
  const worker = fileURLToPath(new URL("../python/stage-shot.py", import.meta.url));
  const logPath = join(outputDir, "blender.log");
  try {
    await runProcess(executable, [
      "--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1", "--python", worker, "--", configPath,
    ], { cwd: outputDir, logPath, timeoutMs, signal: options.signal });
  } catch (error) {
    const log = await readFile(logPath, "utf8").catch(() => "");
    const said = [...log.matchAll(/^RuntimeError: (.+)$/gm)].at(-1)?.[1];
    if (said) throw new Error(said, { cause: error });
    throw error;
  }
  const report = JSON.parse(await readFile(join(outputDir, "shot.json"), "utf8")) as StageShotReport;
  const mediaPath = await joinFrames(outputDir, report, { ffmpegPath: options.ffmpegPath, timeoutMs, signal: options.signal });
  return { outputDir, mediaPath, report };
}
