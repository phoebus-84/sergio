// ---------------------------------------------------------------------------
// Characters on a set, filmed
// ---------------------------------------------------------------------------
// `pva_rig_shot` films one character on an empty stage. `pva_stage_shot` is
// the picture with more than one thing in it: several characters, each a
// role of the cast or a rig of the episode, standing on marks, turned to
// each other, each doing one thing after another — and, when a set is
// named, in a place. A set is a film location's 3D set (a .glb, ADR-0057), a
// .glb of the episode, or a .blend of the episode, made as any Blender
// scene is; an object in it named `mark.<name>` is a place by that name.
//
// Free. Blender runs where the library's machines file prefers (prefer.blender,
// ADR-0056), else here; `machine` names the place. Nothing a caller wrote is run: the
// staging is described, not scripted, and the set's own Python stays off.
// What a look at one frame does not show is measured and said: whether each
// character was in the picture, whether the set hid it, whether two came to
// stand in one place, whether a body was moved faster than its feet step,
// and whether a part of a body passed into another: a hand into the head.
// A character that plays no clip stands with its arms beside it.
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { RIG_SHOT_DEFAULTS, RIG_SHOT_LIMITS, SHOT_CAMERAS, type ShotCamera } from "@av/blender/rig-shot";
import { RIG_FACINGS, type RigFacing } from "@av/blender/rig-sheet";
import {
  STAGE_FRAMINGS, STAGE_SHOT_LIMITS, stageSettings, stageShot,
  type StageAct, type StageFraming, type StagePlace, type StagePlayer, type StageShotReport, type StageShotRequest,
} from "@av/blender/stage-shot";
import { channelPath, episodePath, projectKind } from "@studio/contracts/src/layout.mjs";
import { CLIP_NAME, resolveRig } from "./rig-source.js";
import { THROUGH_MARK, throughText } from "./rig-sheet-tools.js";
import { guardEpisodePath, guardPath } from "./trust-guards.js";
import { blenderKey, MACHINE_PARAM, placeBlender, placeLines, runBlenderAt } from "./blender-place.js";

export const STAGE_SHOT_TOOL = "pva_stage_shot";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const XY = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fileSha = (path: string) => sha256(readFileSync(path));

/** A place as it is asked for: a mark's name, or "x, y" in metres. */
export function placeOf(text: string): StagePlace {
  const xy = XY.exec(text);
  return xy ? [Number(xy[1]), Number(xy[2])] : text.trim();
}

const metres = (value: number) => `${Number(value.toFixed(2))} m`;
const secs = (value: number) => `${Number(value.toFixed(2))}s`;
const share = (value: number) => `${Math.round(value * 100)}%`;
const placed = (place: readonly number[]) => `${Number(place[0]!.toFixed(2))}, ${Number(place[1]!.toFixed(2))}`;

/** A body moved this much faster or slower than its clip walks is said to slide. */
export const SLIDE_SLACK = 0.15;

export interface StagedPlayer {
  name: string;
  /** How its place was asked for, at the start and in each act: a mark's name is said by name. */
  at?: string;
  does: { clip?: string; to?: string; towards?: string; turn?: number }[];
  who: string;
}

/** What was filmed and what was measured, as lines the agent reads before it looks at the film. */
export function describeStageShot(report: StageShotReport, staged: readonly StagedPlayer[], file: string, megabytes: number, setShown: string | null): string[] {
  const lines = [`✅ ${file} — ${secs(report.seconds)}, ${report.width}×${report.height} at ${report.fps} fps, ${megabytes.toFixed(1)}MB, no sound`];
  // A model of a place has no marks: where it lies on the stage is what a place in metres is chosen from.
  const box = report.setBounds;
  const lies = box ? ` (a model of a place: it fills x ${box.min[0]} to ${box.max[0]}, y ${box.min[1]} to ${box.max[1]}, z ${box.min[2]} to ${box.max[2]} m on the stage)` : null;
  const camera = report.camera.kind === "set"
    ? "the set's own camera"
    : `camera ${report.camera.view}, ${report.camera.framing}, on ${report.camera.on?.join(" and ") ?? (report.players.length > 1 ? "everyone" : report.players[0]!.name)}, ${report.camera.follow ? "going with them" : "staying where it is"}`;
  lines.push(`   ${setShown ? `on the set ${setShown}${lies ?? (report.marks.length ? ` (marks: ${report.marks.join(", ")})` : " (it has no marks)")}` : "on an empty stage"}; ${camera}`);
  const warnings: string[] = [];
  report.players.forEach((player, index) => {
    const asked = staged[index]!;
    const did = player.does.map((act, number) => {
      const how = asked.does[number] ?? {};
      const clip = how.clip ? `plays ${how.clip}` : null;
      if (act.to) {
        const way = `goes to ${how.to && !XY.test(how.to) ? how.to : placed(act.to)}${how.clip ? ` playing ${how.clip}` : ""}, ${metres(act.metres ?? 0)} in ${secs(act.seconds)}`;
        if (act.pace !== undefined && act.speed !== undefined && act.pace > 0) {
          const off = act.speed / act.pace - 1;
          if (Math.abs(off) > SLIDE_SLACK) {
            warnings.push(`   ⚠️ ${player.name} is moved at ${Number(act.speed.toFixed(2))} m/s on its way to ${how.to && !XY.test(how.to) ? how.to : placed(act.to)} and its clip walks at ${Number(act.pace.toFixed(2))}: its feet will slide. Leave \`seconds\` out of that act and it goes at its clip's pace`);
            return way;
          }
          return `${way} at its clip's pace (${Number(act.pace.toFixed(2))} m/s)`;
        }
        return way;
      }
      const turns = how.towards ? `turns to ${how.towards}` : how.turn !== undefined ? `turns to ${how.turn}°` : null;
      if (clip) return `${clip} for ${secs(act.seconds)}${turns ? `, ${turns.replace("turns", "turned")}` : ""}`;
      return turns ? `${turns} (${secs(act.seconds)})` : `waits ${secs(act.seconds)}`;
    });
    lines.push(
      `   ${player.name} (${asked.who}), ${metres(player.tall)} tall, at ${asked.at && !XY.test(asked.at) ? asked.at : placed(player.at)}` +
        (did.length ? `: ${did.join("; then ")}` : player.skeleton ? ": stands" : ": stands (it has no skeleton)"),
    );
    if (player.inFrame < 0.995) {
      warnings.push(player.inFrame === 0 ? `   ⚠️ ${player.name} is never in the picture` : `   ⚠️ ${player.name} is in the picture for ${share(player.inFrame)} of the shot`);
    }
    if (player.hidden > 0.005) warnings.push(`   ⚠️ ${player.name} is behind something of the set for ${share(player.hidden)} of the shot`);
    const hangs = Object.values(player.standing ?? {});
    if (hangs.some((degrees) => degrees > -75)) {
      lines.push(`   ${player.name} stands with its arms ${hangs.length > 1 && hangs[0] !== hangs[1] ? `at ${hangs.join("° and ")}°` : `at ${hangs[0]}°`} below the horizontal when it plays nothing: lower, a hand would pass into its body`);
    }
    for (const through of player.through ?? []) {
      const deep = through.depth / Math.max(player.tall, 1e-6) >= THROUGH_MARK;
      const text = throughText({ ...through, depth: through.depth / Math.max(player.tall, 1e-6) }, `${Math.max(1, Math.round(through.depth * 100))} cm`);
      (deep ? warnings : lines).push(`   ${deep ? "⚠️ " : ""}${player.name}: ${text}, deepest at ${secs(through.at)}`);
    }
  });
  for (const pair of report.tooClose) warnings.push(`   ⚠️ ${pair.players[0]} and ${pair.players[1]} stand in the same place from ${secs(pair.from)}: one passes through the other`);
  lines.push(...warnings, ...report.notes.map((note) => `   ${note}`));
  lines.push("   look at it before it is used (pva_inspect_media): what is measured is where each body's chest is, and whether a part of a body passes into another of it. A hand through a wall or someone else, a look that misses the other's face, a light that flatters nobody are seen, not measured");
  return lines;
}

export function registerStageShotTools(pi: ExtensionAPI): void {
  const LIBRARY_ROOT = process.env.AVG_LIBRARY_ROOT || join(process.cwd(), "library");

  const TURN = {
    turn: Type.Optional(Type.Number({ minimum: -360, maximum: 360, description: "Turn to face, in degrees: 0 the audience, 90 the right of the picture, -90 the left, 180 away" })),
    towards: Type.Optional(Type.String({ description: "Turn to face another player, by name: it keeps facing where that player goes" })),
  };

  pi.registerTool({
    name: STAGE_SHOT_TOOL,
    label: "Film Characters on a Set",
    description:
      "Film several rigged characters in one picture, on a set or on an empty stage: a clip of video in the episode, with no sound. Local (Blender and FFmpeg), free, repeatable. " +
      "Each player is a `role` of the series' cast (its released rig, read back against its record) or a rig of the episode (`rigPath`). It starts `at` a place, turned as its mark is or as `turn`/`towards` say, and `does` one thing after another: " +
      "play a `clip` (once, `loops` times, or for `seconds`); go `to` a place while a clip plays, facing the way; turn; wait `seconds`. The last act may go on for as long as the shot (`loops: 0`). " +
      "A walk takes as long as its clip's own pace says — the pace is read from the foot that carries the body — unless `seconds` is given; a body moved faster or slower than that slides, and the tool says so. " +
      "A place is a mark of the set by name, or \"x, y\" in metres on the floor as seen from the front: x to the right, y away from the audience. " +
      "`set` is a .blend of the episode (pva_blender_create_scene), in metres, z up, its front towards -y: an object named mark.<name> is a place called <name>, turned the way its -y points; a place in metres stands on the set's floor there. " +
      "In a film, `locationSet` names a location's 3D set in its place (pva_location_mesh): a .glb, as is a `set` ending in .glb. A .glb is only a mesh: the stage lights it, it has no marks, and its size and origin are its maker's — " +
      "`setScale` (metres to one of its units), `setTurn` and `setMove` put it right, and the report says the box it then fills, to choose places in. " +
      "A .blend brings its light and its world; `setCamera: true` films with the set's own camera. Otherwise the camera is asked for in words — `view` front, three-quarter, side or back, seen from the audience; `framing` wide, full, medium or close; `on` the players it is about — and goes with them unless `follow` is false. " +
      "A two-legged character that plays no clip — before its first, between two, after its last — stands with its arms beside it, not in its rig's rest pose. " +
      "It reports for each player the share of the shot it was in the picture and the share the set hid it, pairs that came to stand in one place, and a part of a body that went into another of it (a hand into the head), how deep and when. " +
      "Release each character at its own height first (pva_release_model): two in one picture are in proportion only then. Saves assets/video/<shotId>.mp4 and <shotId>.provenance.json. Look at the result before it is used: pva_inspect_media.",
    parameters: Type.Object({
      channel: Type.String({ description: "Channel slug" }),
      series: Type.String({ description: "Series slug" }),
      episode: Type.String({ description: "Episode slug" }),
      shotId: Type.String({ description: "Safe name (letters, digits, _ and -) for the clip of video" }),
      set: Type.Optional(Type.String({ description: "The set, episode-relative: a .blend made with pva_blender_create_scene, or a .glb of a place. Without it and locationSet, an empty stage of one colour with a floor" })),
      locationSet: Type.Optional(Type.Object({
        location: Type.String({ description: "The location's slug" }),
        set: Type.String({ description: "The set's name: locations/<location>/sets/<set>/" }),
        mesh: Type.Optional(Type.String({ description: "Which mesh of the set. Default: refined when it has one, else draft" })),
      }, { description: "In a film, in place of set: a location's 3D set (pva_location_mesh). channel is the film" })),
      setScale: Type.Optional(Type.Number({ minimum: STAGE_SHOT_LIMITS.setScale[0], maximum: STAGE_SHOT_LIMITS.setScale[1], description: "For a .glb set: metres to one of its units. Default 1" })),
      setTurn: Type.Optional(Type.Number({ minimum: -360, maximum: 360, description: "For a .glb set: degrees about the vertical. Default 0" })),
      setMove: Type.Optional(Type.String({ description: "For a .glb set: where its origin goes on the stage, \"x, y, z\" in metres (z up). Default 0, 0, 0" })),
      players: Type.Array(Type.Object({
        name: Type.Optional(Type.String({ description: "How the player is called in towards, on and the report. Default: its role, or its rig's file name" })),
        role: Type.Optional(Type.String({ description: "A role of the series' cast (pva_cast): the released form the role pins" })),
        rigPath: Type.Optional(Type.String({ description: "In place of role: a rig of the episode, assets/models/<rigId>.glb" })),
        faces: Type.Optional(StringEnum(RIG_FACINGS as unknown as [RigFacing, ...RigFacing[]], { description: "For a rigPath: which way the body faces in its file. Default +z. A released one faces +z" })),
        at: Type.Optional(Type.String({ description: "Where it starts: a mark's name, or \"x, y\" in metres. Default the middle of the stage" })),
        ...TURN,
        does: Type.Optional(Type.Array(Type.Object({
          clip: Type.Optional(Type.String({ description: "One of the player's clips, by name: an action of the role's form, or the <name> of <rig>.clip.<name>.glb" })),
          loops: Type.Optional(Type.Integer({ minimum: 0, maximum: RIG_SHOT_LIMITS.loops, description: "How many times the clip is played. Default 1. 0, on the last act only: for as long as the shot lasts" })),
          seconds: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: RIG_SHOT_LIMITS.seconds, description: "How long the act takes. Default: the clip times loops; on the way to a place, as long as the clip's pace takes" })),
          to: Type.Optional(Type.String({ description: "Go there while the clip plays, facing the way: a mark's name, or \"x, y\" in metres" })),
          ...TURN,
        }), { maxItems: STAGE_SHOT_LIMITS.acts, description: "What it does, one thing after another. Without it, it stands" })),
      }), { minItems: 1, maxItems: STAGE_SHOT_LIMITS.players, description: "Who is in the picture" }),
      setCamera: Type.Optional(Type.Boolean({ default: false, description: "Film with the set's own camera, as the set moves it. Then view, framing, on and follow are not used" })),
      view: Type.Optional(StringEnum(SHOT_CAMERAS as unknown as [ShotCamera, ...ShotCamera[]], { default: RIG_SHOT_DEFAULTS.camera, description: "Where the camera stands, seen from the audience's side of the stage" })),
      framing: Type.Optional(StringEnum(STAGE_FRAMINGS as unknown as [StageFraming, ...StageFraming[]], { description: "wide: everyone with air around them. full, medium (waist up), close (head and shoulders): of the tallest it is on. Default wide, or full for one player" })),
      on: Type.Optional(Type.Array(Type.String(), { description: "The players the camera is about, by name. Default: all of them" })),
      follow: Type.Optional(Type.Boolean({ default: true, description: "The camera goes with the players it is on. false: it stays, and holds everywhere they go" })),
      seconds: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: RIG_SHOT_LIMITS.seconds, description: "How long. Default: until the last player has done all it does" })),
      width: Type.Optional(Type.Integer({ minimum: RIG_SHOT_LIMITS.side[0], maximum: RIG_SHOT_LIMITS.side[1], description: `Even. Default ${RIG_SHOT_DEFAULTS.width}` })),
      height: Type.Optional(Type.Integer({ minimum: RIG_SHOT_LIMITS.side[0], maximum: RIG_SHOT_LIMITS.side[1], description: `Even. Default ${RIG_SHOT_DEFAULTS.height}` })),
      fps: Type.Optional(Type.Integer({ minimum: RIG_SHOT_LIMITS.fps[0], maximum: RIG_SHOT_LIMITS.fps[1], description: "Default: the set's own, or 24 on an empty stage. Use the film's" })),
      background: Type.Optional(Type.String({ description: `An empty stage's colour, as #rrggbb. Default ${RIG_SHOT_DEFAULTS.background}. A set has its own world` })),
      ground: Type.Optional(Type.Boolean({ default: true, description: "On an empty stage, a floor that takes the shadows" })),
      overwrite: Type.Optional(Type.Boolean({ default: false, description: "Replace an existing clip of video of this shotId" })),
      machine: MACHINE_PARAM,
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      if (!SAFE_NAME.test(params.shotId)) throw new Error("shotId must contain only letters, numbers, underscores and hyphens (max 64)");
      const dir = episodePath(LIBRARY_ROOT, params.channel, params.series, params.episode);
      let setFull: string | undefined;
      /** The set as it is shown and recorded: episode-relative, or film-relative for a location's. */
      let setShown: string | undefined;
      if (params.set !== undefined && params.locationSet !== undefined) throw new Error("give set or locationSet, not both");
      if (params.set !== undefined) {
        const guard = await guardEpisodePath(LIBRARY_ROOT, params.channel, params.series, params.episode, params.set);
        if (!guard.allowed) throw new Error(guard.reason ?? `Set path rejected: ${params.set}`);
        setFull = join(dir, params.set);
        setShown = params.set;
        if (!existsSync(setFull) || !statSync(setFull).isFile()) throw new Error(`Set not found: ${params.set}`);
        if (!/\.(blend|glb)$/i.test(setFull)) throw new Error(`a set is a .blend file or a .glb of a place: ${params.set}. Make a .blend with pva_blender_create_scene, or a location's set with pva_location_mesh`);
      }
      if (params.locationSet !== undefined) {
        const { location, set } = params.locationSet;
        if (projectKind(LIBRARY_ROOT, params.channel) !== "film") throw new Error(`a location's set belongs to a film, and ${params.channel} is not one: give the set as a file of the episode (set)`);
        if (![location, set, params.locationSet.mesh ?? "draft"].every((name) => SAFE_NAME.test(name))) throw new Error("locationSet: location, set and mesh are names in letters, digits, underscores and hyphens");
        const filmDir = channelPath(LIBRARY_ROOT, params.channel);
        const setDir = join("locations", location, "sets", set);
        const mesh = params.locationSet.mesh ?? (existsSync(join(filmDir, setDir, "refined.glb")) ? "refined" : "draft");
        setShown = join(setDir, `${mesh}.glb`);
        const guard = await guardPath(filmDir, setShown);
        if (!guard.allowed) throw new Error(guard.reason ?? `Set path rejected: ${setShown}`);
        setFull = join(filmDir, setShown);
        if (!existsSync(setFull) || !statSync(setFull).isFile()) throw new Error(`the film has no ${setShown}: make the set's mesh with pva_location_mesh { film: "${params.channel}", location: "${location}", set: "${set}" }`);
      }
      const modelSet = setFull !== undefined && /\.glb$/i.test(setFull);
      if (!modelSet && (params.setScale !== undefined || params.setTurn !== undefined || params.setMove !== undefined)) {
        throw new Error("setScale, setTurn and setMove put a .glb set on the stage: a .blend is placed by whoever made it, and an empty stage has nothing to place");
      }
      let setMove: [number, number, number] | undefined;
      if (params.setMove !== undefined) {
        const parts = params.setMove.split(",").map((part) => Number(part.trim()));
        if (parts.length !== 3 || !parts.every(Number.isFinite)) throw new Error('setMove is "x, y, z" in metres');
        setMove = parts as [number, number, number];
      }
      const setPlacement = modelSet && (params.setScale !== undefined || params.setTurn !== undefined || setMove !== undefined)
        ? { ...(params.setScale !== undefined ? { scale: params.setScale } : {}), ...(params.setTurn !== undefined ? { turn: params.setTurn } : {}), ...(setMove ? { move: setMove } : {}) }
        : undefined;
      if (params.setCamera && (params.view !== undefined || params.framing !== undefined || params.on !== undefined || params.follow !== undefined)) {
        throw new Error("the set's own camera is not asked for in words: leave view, framing, on and follow out, or setCamera");
      }

      // Who is in the picture: each player's body and the clips it is asked for.
      const players: StagePlayer[] = [];
      const staged: StagedPlayer[] = [];
      const kept: Record<string, unknown>[] = [];
      for (const [index, player] of params.players.entries()) {
        const rig = await resolveRig(LIBRARY_ROOT, params, { role: player.role, rigPath: player.rigPath }, { statue: true });
        const name = player.name ?? player.role ?? basename(player.rigPath!).replace(/\.glb$/i, "");
        if (!SAFE_NAME.test(name)) throw new Error(`player ${index + 1}: give it a name in letters, digits, underscores and hyphens (${name} is not one)`);
        if (rig.stood && player.faces !== undefined && player.faces !== "+z") throw new Error(`${name}: a released rig faces +z: leave \`faces\` out`);
        const clips: Record<string, { file: string; sha256: string }> = {};
        const does: StageAct[] = (player.does ?? []).map((act, number) => {
          if (act.clip !== undefined && !CLIP_NAME.test(act.clip)) throw new Error(`${name}, act ${number + 1}: clip is the name of one of its clips: letters, digits, dots, underscores and hyphens`);
          const clip = act.clip !== undefined ? rig.clip(act.clip) : null;
          if (clip) clips[act.clip!] = { file: clip.shown, sha256: fileSha(clip.full) };
          return {
            ...(clip ? { clip: clip.full } : {}), ...(act.loops !== undefined ? { loops: act.loops } : {}), ...(act.seconds !== undefined ? { seconds: act.seconds } : {}),
            ...(act.to !== undefined ? { to: placeOf(act.to) } : {}), ...(act.turn !== undefined ? { turn: act.turn } : {}), ...(act.towards !== undefined ? { towards: act.towards } : {}),
          };
        });
        players.push({
          name, path: rig.rigFull, ...(player.faces ? { faces: player.faces } : {}), ...(player.at !== undefined ? { at: placeOf(player.at) } : {}),
          ...(player.turn !== undefined ? { turn: player.turn } : {}), ...(player.towards !== undefined ? { towards: player.towards } : {}), does,
        });
        staged.push({
          name, ...(player.at !== undefined ? { at: player.at } : {}),
          does: (player.does ?? []).map((act) => ({ ...(act.clip ? { clip: act.clip } : {}), ...(act.to ? { to: act.to } : {}), ...(act.towards ? { towards: act.towards } : {}), ...(act.turn !== undefined ? { turn: act.turn } : {}) })),
          who: rig.cast ? `the role ${rig.cast.role}: ${rig.cast.character} as "${rig.cast.form}" ${rig.cast.release}` : rig.rigShown,
        });
        kept.push({ name, ...(rig.cast ? { cast: rig.cast } : {}), rig: rig.rigShown, rigSha256: fileSha(rig.rigFull), ...(Object.keys(clips).length ? { clips } : {}), asked: player });
      }

      const videoDir = join(dir, "assets", "video");
      const videoFull = join(videoDir, `${params.shotId}.mp4`);
      if (existsSync(videoFull) && !params.overwrite) throw new Error(`assets/video/${params.shotId}.mp4 already exists: pick another shotId, or pass overwrite: true`);
      const request: Omit<StageShotRequest, "outputDir"> = {
        ...(setFull ? { set: setFull } : {}), ...(setPlacement ? { setPlacement } : {}), players,
        camera: params.setCamera ? "set" : {
          ...(params.view ? { view: params.view } : {}), ...(params.framing ? { framing: params.framing } : {}), ...(params.on ? { on: params.on } : {}), ...(params.follow !== undefined ? { follow: params.follow } : {}),
        },
        ...(params.seconds !== undefined ? { seconds: params.seconds } : {}), ...(params.width !== undefined ? { width: params.width } : {}), ...(params.height !== undefined ? { height: params.height } : {}),
        ...(params.fps !== undefined ? { fps: params.fps } : {}), ...(params.background ? { background: params.background } : {}), ...(params.ground !== undefined ? { ground: params.ground } : {}),
      };
      // Refused here, before Blender is started and a work folder made.
      stageSettings({ ...request, outputDir: "" });

      const where = await placeBlender(LIBRARY_ROOT, params.machine, signal);
      const say = (text: string) => onUpdate?.({ content: [{ type: "text" as const, text }], details: { shotId: params.shotId } });
      say(`Staging ${players.map((player) => player.name).join(", ")}${setShown ? ` on ${setShown}` : ""} in Blender${where.kind === "machine" ? ` on ${where.machine.name}` : ""}…`);
      const work = mkdtempSync(join(tmpdir(), "stage-shot-"));
      try {
        const shot = { ...request, outputDir: join(work, "shot") };
        const { report, mediaPath, machine } = await runBlenderAt(where, "stage-shot", shot, () => stageShot(shot, signal ? { signal } : {}), {
          key: blenderKey(params.channel, params.series, params.episode), allowedRoots: [join(LIBRARY_ROOT, params.channel)], ...(signal ? { signal } : {}), onLog: say,
        });
        mkdirSync(videoDir, { recursive: true });
        copyFileSync(mediaPath, videoFull);
        const bytes = readFileSync(videoFull);
        const provenancePath = join(videoDir, `${params.shotId}.provenance.json`);
        writeFileSync(provenancePath, `${JSON.stringify({
          version: 1, tool: STAGE_SHOT_TOOL, file: `${params.shotId}.mp4`, sha256: sha256(bytes), bytes: bytes.length,
          // Who played and from which files, as they were asked for; the report below says what each did.
          staged: kept,
          ...report,
          // The place, by its file; null for an empty stage.
          set: setFull ? { file: setShown, sha256: fileSha(setFull), ...(params.locationSet ? { locationSet: params.locationSet } : {}), ...(setPlacement ? { placement: setPlacement } : {}) } : null,
          // The machine Blender ran on, when not this one.
          ...(machine ? { machine } : {}),
          madeAt: new Date().toISOString(),
        }, null, 2)}\n`);
        return {
          content: [{ type: "text" as const, text: [...describeStageShot(report, staged, `assets/video/${params.shotId}.mp4`, bytes.length / 1024 / 1024, setShown ?? null), ...placeLines(where, machine)].join("\n") }],
          details: { outputPath: videoFull, provenancePath, report } as unknown as Record<string, unknown>,
        };
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  });
}
