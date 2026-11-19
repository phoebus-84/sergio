import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { runBlender } from "../src/index.js";
import { stageShot } from "../src/stage-shot.js";
import { stickFigure } from "./fixtures/stick-figure.js";

const live = { skip: process.env.BLENDER_LIVE !== "1", timeout: 600_000 };
const small = { width: 128, height: 72, fps: 12, samples: 1 };
const near = (value: number, wanted: number, slack: number, what: string) => assert.ok(Math.abs(value - wanted) <= slack, `${what}: ${value}, wanted ${wanted} ± ${slack}`);

/** The same file with no skin: a statue. */
function statue(rig: Buffer): Buffer {
  const length = rig.readUInt32LE(12);
  const json = JSON.parse(rig.subarray(20, 20 + length).toString("utf8"));
  delete json.skins;
  delete json.animations;
  for (const node of json.nodes) delete node.skin;
  let text = Buffer.from(JSON.stringify(json));
  if (text.length % 4) text = Buffer.concat([text, Buffer.alloc(4 - (text.length % 4), 0x20)]);
  const rest = rig.subarray(20 + length);
  const head = Buffer.alloc(20);
  rig.copy(head, 0, 0, 20);
  head.writeUInt32LE(20 + text.length + rest.length, 8);
  head.writeUInt32LE(text.length, 12);
  return Buffer.concat([head, text, rest]);
}

test("LIVE: two figures share an empty stage, each turned to the other, and one walks to the other at its clip's pace", live, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stage-shot-live-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "figure.glb");
  await writeFile(path, stickFigure());

  const facing = await stageShot({
    outputDir: join(root, "facing"), ...small, seconds: 1,
    players: [{ name: "left", path, at: [-1, 0], towards: "right" }, { name: "right", path, at: [1, 0], towards: "left", does: [{ clip: path, loops: 0 }] }],
  });
  assert.deepEqual({ frames: facing.report.frames, set: facing.report.set, marks: facing.report.marks, tooClose: facing.report.tooClose }, { frames: 12, set: false, marks: [], tooClose: [] });
  assert.deepEqual(facing.report.camera, { kind: "words", view: "three-quarter", framing: "wide", follow: true });
  // Each faces where the other stands: the right of the picture, and the left.
  assert.deepEqual(facing.report.players.map((player) => [player.name, player.at, player.turn, player.inFrame, player.hidden]), [["left", [-1, 0, 0], 90, 1, 0], ["right", [1, 0, 0], -90, 1, 0]]);
  assert.deepEqual(facing.report.players[1]!.does.map((act) => [act.action, act.clipSeconds, act.from]), [["walk", 1, 0]]);
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height,nb_frames", "-of", "json", facing.mediaPath], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout).streams, [{ codec_name: "h264", width: 128, height: 72, nb_frames: "12" }]);

  // The walk swings each thigh, 0.45 long, a quarter of a turn in half a second: under the hip, the knee that
  // carries the body goes back at 0.45 × π, about 1.41 m/s.
  const walked = await stageShot({
    outputDir: join(root, "walked"), ...small, camera: { view: "front", framing: "wide", follow: false },
    players: [{ name: "walker", path, at: [-1, 0], does: [{ clip: path, to: [1, 0] }, { towards: "waiting", seconds: 0.5 }] }, { name: "waiting", path, at: [1, 0.2], turn: 180 }],
  });
  const [walker, waiting] = walked.report.players as [typeof walked.report.players[0], typeof walked.report.players[0]];
  const walk = walker.does[0]!;
  near(walk.pace!, 1.41, 0.06, "the pace read from the feet");
  assert.equal(walk.speed, walk.pace);
  assert.equal(walk.metres, 2);
  near(walk.seconds, 2 / walk.pace!, 0.01, "the walk takes as long as its pace says");
  near(walker.travel, 2, 0.1, "it gets there");
  assert.equal(walker.turn, 0);
  near(walker.ends, walk.seconds + 0.5, 0.01, "then it turns");
  near(walked.report.seconds, walker.ends, 1 / 12, "the shot lasts as long as what is done in it");
  assert.equal(waiting.turn, 180);
  // It walked into where the other stands, and the report says from when.
  assert.equal(walked.report.tooClose.length, 1);
  assert.deepEqual(walked.report.tooClose[0]!.players, ["walker", "waiting"]);
  assert.ok(walked.report.tooClose[0]!.from > 0.5 && walked.report.tooClose[0]!.from <= walk.seconds);

  // The way is given a time of its own: the body is moved faster than its feet step, and both are said.
  const hurried = await stageShot({ outputDir: join(root, "hurried"), ...small, players: [{ name: "walker", path, at: [-1, 0], does: [{ clip: path, to: [1, 0], seconds: 1 }] }] });
  assert.deepEqual({ seconds: hurried.report.players[0]!.does[0]!.seconds, speed: hurried.report.players[0]!.does[0]!.speed }, { seconds: 1, speed: 2 });
  near(hurried.report.players[0]!.does[0]!.pace!, 1.41, 0.06, "the pace is the clip's, whatever the speed");

  await assert.rejects(stageShot({ outputDir: join(root, "long"), ...small, fps: 60, seconds: 60, players: [{ name: "walker", path }] }), /the shot would be 3600 frames .*: at most 1800/);
});

test("LIVE: a figure that plays no clip stands with its arms down, no lower than its body lets them", live, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stage-stand-live-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const thin = join(root, "thin.glb"), wide = join(root, "wide.glb"), reacher = join(root, "reacher.glb");
  await writeFile(thin, stickFigure());
  // Its body is a box 0.71 across: forearms hung at -75° would be in it.
  await writeFile(wide, stickFigure({ boxes: { Spine: 0.355, LeftForeArm: 0.05, RightForeArm: 0.05 } }));
  await writeFile(reacher, stickFigure({ boxes: { Head: 0.15 }, walk: false, reach: true }));
  const { report } = await stageShot({
    outputDir: join(root, "shot"), ...small, camera: { view: "front", framing: "wide", follow: false },
    players: [
      { name: "thin", path: thin, at: [-1.5, 0], does: [{ seconds: 0.5 }, { clip: thin }] },
      { name: "wide", path: wide, at: [0, 0] },
      { name: "reacher", path: reacher, at: [1.5, 0], does: [{ clip: reacher }] },
    ],
  });
  const [lean, broad, reaching] = report.players as [typeof report.players[0], typeof report.players[0], typeof report.players[0]];
  assert.deepEqual([lean.standing, broad.standing, reaching.standing], [{ left: -75, right: -75 }, { left: -60, right: -60 }, { left: -75, right: -75 }]);

  // A skeleton whose names say nothing stands as it is, and that is said.
  let n = 0;
  const names = new Map<string, string>();
  const thing = join(root, "thing.glb");
  await writeFile(thing, stickFigure({ walk: false, names: (name) => names.get(name) ?? (names.set(name, `b${n++}`), names.get(name)!) }));
  const odd = await stageShot({ outputDir: join(root, "odd"), ...small, seconds: 0.25, players: [{ name: "thing", path: thing }] });
  assert.equal(odd.report.players[0]!.standing, null);
  assert.match(odd.report.notes.join(" "), /thing's bones were not read as a two-legged body's: when it plays no clip it stands in its rest pose/);
});

test("LIVE: on a set, players stand on its marks and its floors, are filmed by its camera, and one behind a wall is said to be hidden", live, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stage-set-live-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "figure.glb");
  await writeFile(path, stickFigure());
  const still = join(root, "statue.glb");
  await writeFile(still, statue(stickFigure({ walk: false })));
  const set = (await runBlender({ mode: "create", scriptPath: fileURLToPath(new URL("./fixtures/stage-set.py", import.meta.url)), outputDir: join(root, "set"), trustedInput: true, settings: { fps: 12 } })).blendPath;

  const { report } = await stageShot({
    outputDir: join(root, "shot"), set, camera: "set", width: 128, height: 72, samples: 1, seconds: 0.5,
    players: [{ name: "up", path, at: "platform" }, { name: "behind", path, at: "behind" }, { name: "beside", path: still, at: [3.5, 0.5] }],
  });
  // The set's own frame rate, its marks, its camera.
  assert.deepEqual({ fps: report.fps, frames: report.frames, set: report.set, marks: report.marks, camera: report.camera }, { fps: 12, frames: 6, set: true, marks: ["behind", "platform"], camera: { kind: "set" } });
  const [up, behind, beside] = report.players as [typeof report.players[0], typeof report.players[0], typeof report.players[0]];
  // A mark gives a place, a height and a turn; a place given in metres stands on what is under it.
  assert.deepEqual([up.at, up.turn], [[3, 0, 0.5], -90]);
  assert.deepEqual([beside.at, beside.skeleton], [[3.5, 0.5, 0.5], false]);
  assert.deepEqual([behind.at, behind.turn], [[-3, 0, 0], 0]);
  assert.deepEqual([up.inFrame, up.hidden, behind.inFrame, behind.hidden, beside.inFrame], [1, 0, 1, 1, 1]);
  // The figure's own file does not put it on the ground: it is stood on its mark all the same, and that is said.
  assert.match(report.notes.join(" "), /up does not stand on the ground in its own file \(its lowest point is at 0\.20\)/);

  await assert.rejects(
    stageShot({ outputDir: join(root, "nowhere"), set, camera: "set", ...small, players: [{ name: "up", path, at: "balcony" }] }),
    /^Error: the set has no mark named balcony for up \(at\): its marks are behind, platform\. A mark is an object named mark\.<name>$/,
  );
  await assert.rejects(
    stageShot({ outputDir: join(root, "noclip"), ...small, players: [{ name: "beside", path: still, does: [{ clip: path }] }] }),
    /^Error: beside has no skeleton: it can stand, wait and be moved, and plays no clip$/,
  );
  // A walk onto the platform: the floor is followed on the way, and the body ends half a metre up.
  const climbed = await stageShot({ outputDir: join(root, "climbed"), set, ...small, camera: { view: "front", framing: "wide", follow: false }, players: [{ name: "up", path, at: [1, 0], does: [{ clip: path, to: "platform" }] }] });
  assert.deepEqual(climbed.report.players[0]!.does[0]!.to, [3, 0, 0.5]);
});
