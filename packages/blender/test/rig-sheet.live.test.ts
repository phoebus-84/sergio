import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rigSheet } from "../src/rig-sheet.js";
import { sampleClip } from "../src/clip-sample.js";
import { rigShot } from "../src/rig-shot.js";
import { spawnSync } from "node:child_process";
import { stickFigure } from "./fixtures/stick-figure.js";

const live = { skip: process.env.BLENDER_LIVE !== "1", timeout: 300_000 };
const size = async (file: string) => {
  const bytes = await readFile(file);
  assert.equal(bytes.subarray(1, 4).toString(), "PNG");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
};

test("LIVE: a two-legged figure is put in seven poses, its walk played, and the surface measured", live, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rig-sheet-live-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rigPath = join(root, "figure.glb");
  await writeFile(rigPath, stickFigure());
  const { report, outputDir } = await rigSheet({ rigPath, outputDir: join(root, "sheet"), actions: ["walk"], tile: 128 });

  assert.equal(report.rig.skeleton, "biped");
  assert.equal(report.rig.bones, 11);
  assert.deepEqual(report.rig.roles, {
    "upperArm.left": "LeftArm", "upperArm.right": "RightArm", "foreArm.left": "LeftForeArm", "foreArm.right": "RightForeArm",
    "thigh.left": "LeftUpLeg", "thigh.right": "RightUpLeg", "shin.left": "LeftLeg", "shin.right": "RightLeg", head: "Head", spine: "Spine",
  });
  assert.deepEqual(report.poses.list.map((pose) => pose.name), ["rest", "arms up", "arms down", "reach", "step", "wide", "head turn", "bow"]);
  assert.deepEqual(report.views, ["front", "three-quarter", "side"]);
  assert.deepEqual(await size(join(outputDir, "poses.png")), [8 * 128, 3 * 128]);
  // The arms are level at rest, so "arms up" is fifty degrees: the left about the front, the right the other way.
  assert.deepEqual(report.poses.list[1]!.turns, [{ bone: "LeftArm", about: "front", degrees: 50 }, { bone: "RightArm", about: "front", degrees: -50 }]);
  // Each solid follows one bone whole: nothing is pulled out of shape, and no part goes into another.
  for (const pose of report.poses.list) assert.deepEqual([pose.strained, pose.torn, pose.through], [0, 0, []], pose.name);
  assert.deepEqual(report.rig.parts, ["body", "head", "left hand", "left leg", "left upper arm", "right hand", "right leg", "right upper arm"]);

  assert.deepEqual(report.actionsInside, ["walk"]);
  assert.equal(report.clips.length, 1);
  assert.deepEqual({ name: report.clips[0]!.name, from: report.clips[0]!.from, seconds: report.clips[0]!.seconds, travel: report.clips[0]!.travel }, { name: "walk", from: "rig", seconds: 1, travel: 0 });
  assert.deepEqual(await size(join(outputDir, "clip.walk.png")), [6 * 128, 2 * 128]);
});

test("LIVE: a hand that goes into a big head is found in a pose, and through a clip with when", live, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rig-sheet-live-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rigPath = join(root, "figure.glb");
  await writeFile(rigPath, stickFigure({ boxes: { Head: 0.15 }, walk: false, reach: true }));
  const { report } = await rigSheet({
    rigPath, outputDir: join(root, "sheet"), tile: 128, actions: ["reach"],
    poses: [{ name: "hand on head", turns: [{ bone: "LeftArm", about: "front", degrees: 135 }] }, { name: "arm up", turns: [{ bone: "LeftArm", about: "front", degrees: 60 }] }],
  });
  // Turned up and over, the left forearm ends in the head: its solid, 0.06 across, is a tenth of a metre inside the
  // box at its deepest, of a body 1.65 tall. Raised less, it is clear of it.
  assert.deepEqual(report.poses.list.map((pose) => [pose.name, pose.through]), [["rest", []], ["hand on head", [{ parts: ["left hand", "head"], depth: 0.058 }]], ["arm up", []]]);
  // The clip turns it there in a second and back in another: it is in the head around the middle, and deepest there.
  const [through, ...others] = report.clips[0]!.through;
  assert.deepEqual(others, []);
  assert.deepEqual(through!.parts, ["left hand", "head"]);
  assert.ok(Math.abs(through!.depth - 0.058) <= 0.005, `depth ${through!.depth}`);
  assert.ok(through!.from > 0.5 && through!.from < 1, `from ${through!.from}`);
  assert.ok(Math.abs(through!.at - 1) <= 0.05, `at ${through!.at}`);
  assert.ok(through!.seconds > 0.2 && through!.seconds < 1, `seconds ${through!.seconds}`);
});

test("LIVE: a clip is read as turns from the rest pose, in the world and in glTF's axes", live, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "clip-sample-live-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "figure.glb");
  await writeFile(path, stickFigure());
  const clip = await sampleClip({ path, outputDir: join(root, "sample") });

  assert.deepEqual({ action: clip.action, actions: clip.actions, seconds: clip.seconds }, { action: "walk", actions: ["walk"], seconds: 1 });
  assert.equal(clip.bones.length, 11);
  // Where the file puts its joints, y up: Blender's own axes are not what comes back.
  const at = (name: string) => clip.bones.find((bone) => bone.name === name)!.rest.map((v) => Math.round(v * 1000) / 1000 + 0);
  assert.deepEqual(at("Hips"), [0, 1, 0]);
  assert.deepEqual(at("LeftUpLeg"), [0.12, 0.95, 0]);
  assert.deepEqual(at("Head"), [0, 1.7, 0]);
  // The walk swings the left thigh an eighth of a turn about x, one way then the other; the right one opposite.
  const turn = (name: string, frame: number) => clip.rotations[name]![frame]!.map((v) => Math.round(v * 1000) / 1000 + 0);
  const eighth = [Math.round(Math.sin(Math.PI / 8) * 1000) / 1000, 0, 0, Math.round(Math.cos(Math.PI / 8) * 1000) / 1000];
  assert.deepEqual(turn("LeftUpLeg", 0), eighth);
  assert.deepEqual(turn("RightUpLeg", 0), [-eighth[0]!, 0, 0, eighth[3]!]);
  assert.deepEqual(turn("LeftUpLeg", clip.times.length - 1), eighth);
  // A bone the clip does not move turns with what carries it: the shin with its thigh, the head not at all.
  assert.deepEqual(turn("LeftLeg", 0), eighth);
  assert.deepEqual(turn("Head", 0).map(Math.abs), [0, 0, 0, 1]);
  assert.deepEqual(clip.positions["Hips"]![0]!.map((v) => Math.round(v * 1000) / 1000 + 0), [0, 1, 0]);
});

test("LIVE: a figure is filmed playing its clip, and the frames become a file a player opens", live, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rig-shot-live-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "figure.glb");
  await writeFile(path, stickFigure());
  const { report, mediaPath } = await rigShot({ path, outputDir: join(root, "shot"), width: 128, height: 72, fps: 12, loops: 2, samples: 1 });
  // The walk is a second long: played twice at twelve frames a second.
  assert.deepEqual({ frames: report.frames, seconds: report.seconds, action: report.action, clipSeconds: report.clipSeconds, travel: report.travel }, { frames: 24, seconds: 2, action: "walk", clipSeconds: 1, travel: 0 });
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height,nb_frames", "-of", "json", mediaPath], { encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout).streams, [{ codec_name: "h264", width: 128, height: 72, nb_frames: "24" }]);

  // With no clip in the file the body stands for two seconds; a shot too long is refused before a frame is rendered.
  const still = join(root, "still.glb");
  await writeFile(still, stickFigure({ walk: false }));
  const stood = await rigShot({ path: still, outputDir: join(root, "still"), width: 64, height: 64, fps: 6, samples: 1, camera: "front", framing: "close", ground: false });
  assert.deepEqual({ frames: stood.report.frames, action: stood.report.action }, { frames: 12, action: null });
  await assert.rejects(rigShot({ path, outputDir: join(root, "long"), fps: 60, seconds: 60 }), /the shot would be 3600 frames .*: at most 1800/);
});

test("LIVE: a body whose bones' names say nothing has its limbs swung, and takes poses of its own", live, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rig-sheet-live-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rigPath = join(root, "thing.glb");
  let n = 0;
  const names = new Map<string, string>();
  await writeFile(rigPath, stickFigure({ walk: false, names: (name) => names.get(name) ?? (names.set(name, `b${n++}`), names.get(name)!) }));

  const swung = await rigSheet({ rigPath, outputDir: join(root, "swung"), tile: 128 });
  assert.equal(swung.report.rig.skeleton, "unknown");
  // Where the skeleton branches and goes on: the spine, two arms, two legs.
  assert.deepEqual(swung.report.poses.list.map((pose) => pose.name), ["rest", "swing b1", "swing b3", "swing b5", "swing b7", "swing b9"]);
  assert.match(swung.report.notes.join(" "), /not a two-legged body's: each of its 5 largest limbs is swung/);

  const own = await rigSheet({ rigPath, outputDir: join(root, "own"), tile: 128, poses: [{ name: "lean", turns: [{ bone: "b1", about: "side", degrees: 20 }] }] });
  assert.deepEqual(own.report.poses.list.map((pose) => pose.name), ["rest", "lean"]);

  await assert.rejects(
    rigSheet({ rigPath, outputDir: join(root, "wrong"), tile: 128, poses: [{ name: "lean", turns: [{ bone: "Spine", about: "side", degrees: 20 }] }] }),
    /no bone is named Spine: the skeleton's bones are b0, b1/,
  );
  await assert.rejects(rigSheet({ rigPath, outputDir: join(root, "clip"), tile: 128, actions: ["walk"] }), /the rig holds no clip named walk: it holds none/);
});
