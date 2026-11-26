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
    players: [{ name: "walker", path, at: [-1, 0], does: [{ clip: path, to: [1, 0] }, { towards: "waiting", seconds: 0.5 }] }, { name: "waiting", path, at: [1, 0.6], turn: 180 }],
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
  // It stops beside the other, and the straight way was free: it went round nothing.
  assert.deepEqual([walked.report.tooClose, walk.round], [[], undefined]);

  // Two that walk through each other are in one place on the way, and the report says from when: one that moves is in nobody's way.
  const crossed = await stageShot({
    outputDir: join(root, "crossed"), ...small, camera: { view: "front", framing: "wide", follow: false },
    players: [{ name: "one", path, at: [-1, 0], does: [{ clip: path, to: [1, 0] }] }, { name: "other", path, at: [1, 0], does: [{ clip: path, to: [-1, 0] }] }],
  });
  assert.deepEqual(crossed.report.tooClose.map((pair) => pair.players), [["one", "other"]]);
  near(crossed.report.tooClose[0]!.from, 1 / walk.pace!, 0.2, "they meet halfway");

  // The way is given a time of its own: the body is moved faster than its feet step, and both are said.
  const hurried = await stageShot({ outputDir: join(root, "hurried"), ...small, players: [{ name: "walker", path, at: [-1, 0], does: [{ clip: path, to: [1, 0], seconds: 1 }] }] });
  assert.deepEqual({ seconds: hurried.report.players[0]!.does[0]!.seconds, speed: hurried.report.players[0]!.does[0]!.speed }, { seconds: 1, speed: 2 });
  near(hurried.report.players[0]!.does[0]!.pace!, 1.41, 0.06, "the pace is the clip's, whatever the speed");

  await assert.rejects(stageShot({ outputDir: join(root, "long"), ...small, fps: 60, seconds: 60, players: [{ name: "walker", path }] }), /the shot would be 3600 frames .*: at most 1800/);
});

test("LIVE: a walk goes round one who stands in its way, and is refused a place where someone stands", live, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stage-round-live-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "figure.glb");
  await writeFile(path, stickFigure());
  const { report } = await stageShot({
    outputDir: join(root, "round"), ...small, camera: { view: "front", framing: "wide", follow: false },
    players: [{ name: "walker", path, at: [-2, 0], does: [{ clip: path, to: [2, 0] }] }, { name: "standing", path, at: [0, 0] }],
  });
  const walk = report.players[0]!.does[0]!;
  assert.deepEqual([walk.round, report.tooClose], [["standing"], []]);
  // Each is 0.36 across without its arms: it passes 0.47 from the other's middle, which makes four metres 4.11.
  assert.ok(walk.metres! > 4.05 && walk.metres! < 4.3, `the way round: ${walk.metres}`);
  near(walk.seconds, walk.metres! / walk.pace!, 0.01, "the way round takes as long as it is");
  assert.deepEqual(walk.to, [2, 0, 0]);
  await assert.rejects(
    stageShot({ outputDir: join(root, "onto"), ...small, players: [{ name: "walker", path, at: [-2, 0], does: [{ clip: path, to: [0, 0.1] }] }, { name: "standing", path, at: [0, 0] }] }),
    /^Error: walker, act 1: it cannot go to 0, 0\.1: standing is there\. Give it a place beside, or move what is there$/,
  );
});

test("LIVE: a figure that plays no clip stands with its arms down, no lower than its body lets them, and a hand in a head is said", live, async (t) => {
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
  assert.deepEqual([lean.through, broad.through], [[], []]);
  // In metres here: the forearm a tenth of a metre into the head around the middle of the reach, the shot's second.
  assert.equal(reaching.through.length, 1);
  const through = reaching.through[0]!;
  assert.deepEqual(through.parts, ["left hand", "head"]);
  near(through.depth, 0.096, 0.012, "how deep");
  near(through.at, 1, 1 / 12, "deepest when");
  assert.ok(through.from > 0.5 && through.from < 1, `from ${through.from}`);

  // A skeleton whose names say nothing stands as it is, and that is said.
  let n = 0;
  const names = new Map<string, string>();
  const thing = join(root, "thing.glb");
  await writeFile(thing, stickFigure({ walk: false, names: (name) => names.get(name) ?? (names.set(name, `b${n++}`), names.get(name)!) }));
  const odd = await stageShot({ outputDir: join(root, "odd"), ...small, seconds: 0.25, players: [{ name: "thing", path: thing }] });
  assert.deepEqual([odd.report.players[0]!.standing, odd.report.players[0]!.through], [null, []]);
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
  // Half a metre is no step for a figure of one and a half: the platform is in the way of whoever would walk onto it.
  await assert.rejects(
    stageShot({ outputDir: join(root, "climbed"), set, ...small, camera: { view: "front", framing: "wide", follow: false }, players: [{ name: "up", path, at: [1, 0], does: [{ clip: path, to: "platform" }] }] }),
    /^Error: up, act 1: there is no way to platform round platform \(looked for within 4 m\)\./,
  );
});

test("LIVE: in a yard, a walk goes round a post and steps onto a pavement, a wall right across is no way, and a body in a thing of the set is said", live, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "stage-yard-live-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "figure.glb");
  await writeFile(path, stickFigure());
  const set = (await runBlender({ mode: "create", scriptPath: fileURLToPath(new URL("./fixtures/stage-yard.py", import.meta.url)), outputDir: join(root, "set"), trustedInput: true, settings: { fps: 12 } })).blendPath;

  const { report } = await stageShot({
    outputDir: join(root, "shot"), set, camera: "set", width: 128, height: 72, samples: 1,
    players: [{ name: "walker", path, at: [-2, 0], does: [{ clip: path, to: [2, 0] }, { clip: path, to: [0, 5] }] }, { name: "stuck", path, at: [0.15, 0.1] }],
  });
  const [walker, stuck] = report.players as [typeof report.players[0], typeof report.players[0]];
  const [round, onto] = walker.does as [typeof walker.does[0], typeof walker.does[0]];
  // Round the post, and the one who stands in it.
  assert.deepEqual(round.round, ["post", "stuck"]);
  assert.ok(round.metres! > 4.03 && round.metres! < 4.4, `the way round: ${round.metres}`);
  // The pavement is 0.2 high, under the 0.27 this figure steps: the straight way is taken, and it ends up on it.
  assert.deepEqual([onto.round, onto.to], [undefined, [0, 5, 0.2]]);
  near(onto.metres!, Math.hypot(2, 5), 0.001, "straight onto the pavement");
  // The figure's clip moves its legs alone: its arms stay out, and one goes through the post as it passes.
  assert.deepEqual(walker.inSet!.map((inside) => inside.thing), ["post"]);
  assert.ok(walker.inSet![0]!.depth > 0.03 && walker.inSet![0]!.depth < 0.3 && walker.inSet![0]!.seconds < 1, JSON.stringify(walker.inSet));
  // One stood in the post is in it for the whole shot.
  assert.deepEqual([stuck.inSet![0]!.thing, stuck.inSet![0]!.from], ["post", 0]);
  near(stuck.inSet![0]!.seconds, report.seconds, 1 / 12, "for as long as the shot");
  assert.ok(stuck.inSet![0]!.depth > 0.2, JSON.stringify(stuck.inSet));

  await assert.rejects(
    stageShot({ outputDir: join(root, "wall"), set, camera: "set", ...small, players: [{ name: "walker", path, at: [0, -2], does: [{ clip: path, to: [0, -4] }] }] }),
    /^Error: walker, act 1: there is no way to 0, -4 round wall \(looked for within 4 m\)\. Give it a place to go by first, one act for each, or move what is in the way$/,
  );
});
