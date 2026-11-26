import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageSettings, stageShot, type StageShotRequest } from "../src/stage-shot.js";

// A Blender that writes what stage-shot.py writes, and an FFmpeg that writes a file where it is told to.
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "stage shot "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const blender = join(root, "fake blender.mjs");
  await writeFile(blender, `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv.includes('--version')) { console.log('Blender 5.2.1 LTS'); process.exit(0); }
if (!process.argv.includes('--disable-autoexec') || !process.argv.includes('--factory-startup')) process.exit(8);
if (!process.argv[process.argv.indexOf('--python') + 1].endsWith('stage-shot.py')) process.exit(9);
const cfg = JSON.parse(readFileSync(process.argv.at(-1), 'utf8'));
for (const player of cfg.players) for (const act of player.does) {
  if (typeof act.to === 'string' && act.to !== 'door') { console.log('RuntimeError: the set has no mark named ' + act.to + ' for ' + player.name + ' (act 1, to): its marks are door. A mark is an object named mark.<name>'); process.exit(1); }
}
const fps = cfg.fps ?? 24, frames = Math.round((cfg.seconds ?? 2) * fps);
mkdirSync(join(cfg.outputDir, 'frames'));
for (const frame of [1, frames]) writeFileSync(join(cfg.outputDir, 'frames', String(frame).padStart(6, '0') + '.png'), 'png');
writeFileSync(join(cfg.outputDir, 'shot.json'), JSON.stringify({ frames, fps, seconds: frames / fps, width: cfg.width, height: cfg.height, set: !!cfg.set, marks: cfg.set ? ['door'] : [],
  camera: cfg.camera, players: cfg.players.map(p => ({ name: p.name, skeleton: true, at: [0, 0, 0], turn: 0, tall: 1, does: [], ends: 0, travel: 0, inFrame: 1, hidden: 0 })),
  tooClose: [], notes: [], engine: 'BLENDER_EEVEE', blender: '5.2.1 LTS' }));
`);
  await chmod(blender, 0o755);
  const ffmpeg = join(root, "fake ffmpeg.mjs");
  await writeFile(ffmpeg, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv.at(-1), 'mp4 ' + process.argv.slice(2).join(' '));
`);
  await chmod(ffmpeg, 0o755);
  const files: Record<string, string> = {};
  for (const name of ["guide.glb", "guide.walk.glb", "child.glb", "street.blend"]) {
    files[name] = join(root, name);
    await writeFile(files[name]!, "a file");
  }
  return { root, files, options: { blenderPath: blender, ffmpegPath: ffmpeg } };
}

const guide = { name: "guide", path: "guide.glb" };
const child = { name: "child", path: "child.glb" };

test("a request has its defaults: a wide following camera on everyone, and the set's own frame rate", () => {
  const two = stageSettings({ outputDir: "out", players: [guide, child] });
  assert.deepEqual(two.camera, { kind: "words", view: "three-quarter", framing: "wide", follow: true });
  assert.deepEqual({ width: two.width, height: two.height, background: two.background, ground: two.ground, samples: two.samples }, { width: 1280, height: 720, background: "#d9dadc", ground: true, samples: 16 });
  assert.equal("fps" in two, false);
  assert.equal("seconds" in two, false);
  assert.deepEqual(two.players.map((player) => [player.name, player.faces, player.does]), [["guide", "+z", []], ["child", "+z", []]]);
  // One player alone is framed as one character is.
  assert.equal((stageSettings({ outputDir: "out", players: [guide] }).camera as { framing: string }).framing, "full");
  assert.deepEqual(stageSettings({ outputDir: "out", set: "street.blend", players: [guide], camera: "set" }).camera, { kind: "set" });
  const asked = stageSettings({
    outputDir: "out", set: "street.blend", fps: 30, seconds: 6,
    players: [{ ...guide, at: "door", turn: -90, does: [{ clip: "guide.walk.glb", to: [1.5, 2] }, { towards: "child" }, { clip: "guide.walk.glb", loops: 0 }] }, { ...child, at: [0, 0], towards: "guide", faces: "+x" }],
    camera: { view: "front", framing: "medium", on: ["guide"], follow: false },
  });
  assert.deepEqual(asked.camera, { kind: "words", view: "front", framing: "medium", on: ["guide"], follow: false });
  assert.deepEqual({ fps: asked.fps, seconds: asked.seconds }, { fps: 30, seconds: 6 });
  assert.match(asked.players[0]!.does[0]!.clip!, /guide\.walk\.glb$/);
  assert.equal(asked.players[0]!.does[0]!.clip!.startsWith("/"), true);
  assert.deepEqual(asked.players[1], { name: "child", path: asked.players[1]!.path, faces: "+x", at: [0, 0], towards: "guide", does: [] });
});

test("a request that cannot be staged is refused before Blender is started, and says which player and which act", () => {
  const base = { outputDir: "out" };
  const one = (does: unknown[], more: Record<string, unknown> = {}): StageShotRequest => ({ ...base, players: [{ ...guide, ...more, does: does as never }, child] });
  for (const [request, message] of [
    [{ ...base, players: [] }, /a shot needs at least one player/],
    [{ ...base, players: Array.from({ length: 9 }, (_, n) => ({ name: `p${n}`, path: "p.glb" })) }, /at most 8 players in one shot/],
    [{ ...base, players: [guide, guide] }, /two players are named guide/],
    [{ ...base, players: [{ name: "the guide", path: "g.glb" }] }, /a player's name is letters, digits, underscores and hyphens/],
    [{ ...base, players: [{ name: "guide", path: "guide.fbx" }] }, /guide: a player is filmed from a binary glTF/],
    [{ ...base, set: "street.glb", players: [guide] }, /a set is a \.blend file/],
    [{ ...base, players: [guide], camera: "set" as const }, /the set's own camera was asked for, and there is no set/],
    [{ ...base, players: [guide], camera: { on: ["nobody"] } }, /the camera is on nobody, and there is no player of that name/],
    [{ ...base, players: [guide], camera: { framing: "tight" as never } }, /camera framing is one of wide, full, medium, close/],
    [{ ...base, players: [guide], camera: { view: "above" as never } }, /camera view is one of front, three-quarter, side, back/],
    [{ ...base, players: [{ ...guide, towards: "guide" }] }, /guide: a player cannot turn towards itself/],
    [{ ...base, players: [{ ...guide, towards: "nobody" }] }, /guide: there is no player named nobody to turn towards/],
    [{ ...base, players: [{ ...guide, turn: 90, towards: "child" }, child] }, /guide: give turn or towards, not both/],
    [{ ...base, players: [{ ...guide, at: [1, 2, 3] as never }] }, /guide, at: a place is a mark's name or \[x, y\] in metres/],
    [{ ...base, players: [{ ...guide, at: "the door" }] }, /guide, at: a mark is named in letters/],
    [one([{}]), /guide, act 1 does nothing: give it a clip, a place to go to, a turn, something to reach for, or seconds to wait/],
    [one([{ seconds: 1 }, { clip: "walk.fbx" }]), /guide, act 2: a clip is a binary glTF/],
    [one([{ clip: "w.glb", to: [1, 1], towards: "child" }]), /guide, act 1: on the way to a place a player faces the way: turn in the next act/],
    [one([{ clip: "w.glb", loops: 0 }, { seconds: 1 }]), /guide, act 1: loops 0 goes on for as long as the shot lasts, so it is the last thing a player does/],
    [one([{ clip: "w.glb", loops: 0, to: [1, 1] }]), /guide, act 1: loops 0 goes on for as long as the shot lasts: leave seconds and to out/],
    [one([{ seconds: 2, loops: 2 }]), /guide, act 1: loops counts the playings of a clip, and the act has none/],
    [one([{ clip: "w.glb", loops: 21 }]), /guide, act 1: loops is a whole number from 0 to 20/],
    [one([{ seconds: 61 }]), /guide, act 1: seconds is more than 0 and at most 60/],
    [one(Array.from({ length: 13 }, () => ({ seconds: 1 }))), /guide: at most 12 acts/],
    [{ ...base, players: [guide], width: 1281 }, /width is an even number of pixels/],
    [{ ...base, players: [guide], fps: 120 }, /fps is a whole number from 6 to 60/],
    [{ ...base, players: [guide], seconds: 0 }, /seconds is more than 0 and at most 60/],
    [{ ...base, players: [guide], background: "grey" }, /background is a colour as #rrggbb/],
  ] as const) {
    assert.throws(() => stageSettings(request as StageShotRequest), message);
  }
});

test("a hand reaches for one thing, a thing is taken with a hand and put down on a place, and what is not one of those is refused", () => {
  const on = (does: unknown[]): StageShotRequest => ({ outputDir: "out", set: "street.blend", players: [{ ...guide, does: does as never }, child] });
  const asked = stageSettings(on([
    { reach: { with: "right hand", mark: "handle", after: 0.5, seconds: 2 } },
    { clip: "guide.walk.glb", to: "door", reach: { with: "left hand", player: "child", part: "right hand" } },
    { take: { object: "Lantern.001", with: "right hand" } },
    { put: { object: "Lantern.001", at: [1, 2] }, seconds: 2 },
    { reach: { with: "left foot", object: "ball" } },
  ]));
  // What touches goes to the script as it was asked for: an act of nothing else is long enough by the script's own count.
  assert.deepEqual(asked.players[0]!.does.map((act) => act.reach ?? act.take ?? act.put), [
    { with: "right hand", mark: "handle", after: 0.5, seconds: 2 },
    { with: "left hand", player: "child", part: "right hand" },
    { object: "Lantern.001", with: "right hand" },
    { object: "Lantern.001", at: [1, 2] },
    { with: "left foot", object: "ball" },
  ]);
  // On an empty stage there is nothing but the other players to reach for.
  const bare = (does: unknown[]): StageShotRequest => ({ outputDir: "out", players: [{ ...guide, does: does as never }, child] });
  assert.equal(stageSettings(bare([{ reach: { with: "right hand", player: "child", part: "left shoulder" } }])).players[0]!.does.length, 1);
  for (const [request, message] of [
    [on([{ reach: { with: "right hand", mark: "handle" }, take: { object: "lantern", with: "left hand" } }]), /guide, act 1: one of reach, take and put in an act: give the others an act each/],
    [on([{ reach: { with: "tail", mark: "handle" } }]), /guide, act 1, reach: with is one of left hand, right hand, left foot, right foot/],
    [on([{ reach: { with: "right hand" } }]), /guide, act 1, reach: it reaches for one thing: a mark, an object of the set, or a player and a part of it/],
    [on([{ reach: { with: "right hand", mark: "handle", object: "door" } }]), /guide, act 1, reach: it reaches for one thing/],
    [on([{ reach: { with: "right hand", mark: "the handle" } }]), /guide, act 1, reach: a mark is named in letters/],
    [on([{ reach: { with: "right hand", player: "guide", part: "head" } }]), /guide, act 1, reach: a player does not reach for itself/],
    [on([{ reach: { with: "right hand", player: "nobody", part: "head" } }]), /guide, act 1, reach: there is no player named nobody to reach for/],
    [on([{ reach: { with: "right hand", player: "child" } }]), /guide, act 1, reach: part is one of left hand, right hand, left foot, right foot, left shoulder, right shoulder, head, body/],
    [on([{ reach: { with: "right hand", mark: "handle", part: "head" } }]), /guide, act 1, reach: part is a part of a player: name the player/],
    [on([{ reach: { with: "right hand", mark: "handle", after: -1 } }]), /guide, act 1, reach: after is seconds into the act, from 0 to 60/],
    [on([{ reach: { with: "right hand", mark: "handle", seconds: 0 } }]), /guide, act 1, reach: seconds is more than 0 and at most 60/],
    [on([{ take: { object: "", with: "right hand" } }]), /guide, act 1, take: object is the name of a thing of the set/],
    [on([{ take: { object: "lantern" } }]), /guide, act 1, take: with is one of/],
    [on([{ put: { object: "lantern" } }]), /guide, act 1, put: say where it is put: a mark, or \[x, y\] on the floor/],
    [on([{ put: { object: "lantern", at: "the table" } }]), /guide, act 1, put: a mark is named in letters/],
    [bare([{ reach: { with: "right hand", mark: "handle" } }]), /guide, act 1: an empty stage has no marks and no things: only a part of another player is reached for there/],
    [bare([{ take: { object: "lantern", with: "right hand" } }]), /guide, act 1: an empty stage has no marks and no things/],
  ] as const) {
    assert.throws(() => stageSettings(request as StageShotRequest), message);
  }
});

test("the script is given the set, the players and what they do, and its frames are joined into one file", async (t) => {
  const f = await fixture(t);
  const { report, mediaPath, outputDir } = await stageShot({
    outputDir: join(f.root, "shot"), set: f.files["street.blend"], seconds: 3, fps: 12, width: 640, height: 360, camera: "set",
    players: [{ name: "guide", path: f.files["guide.glb"]!, at: "door", does: [{ clip: f.files["guide.walk.glb"]!, to: "door" }] }, { name: "child", path: f.files["child.glb"]!, towards: "guide" }],
  }, f.options);
  assert.deepEqual({ frames: report.frames, seconds: report.seconds, set: report.set, marks: report.marks, players: report.players.map((player) => player.name) }, { frames: 36, seconds: 3, set: true, marks: ["door"], players: ["guide", "child"] });
  assert.equal(mediaPath, join(outputDir, "shot.mp4"));
  assert.match(await readFile(mediaPath, "utf8"), /-framerate 12 .*-frames:v 36 -an -c:v libx264 /);
  const sent = JSON.parse(await readFile(join(outputDir, "request.json"), "utf8"));
  assert.deepEqual({ set: sent.set, camera: sent.camera, maxFrames: sent.maxFrames }, { set: f.files["street.blend"], camera: { kind: "set" }, maxFrames: 1800 });
  assert.deepEqual(sent.players[0], { name: "guide", path: f.files["guide.glb"], faces: "+z", at: "door", does: [{ clip: f.files["guide.walk.glb"], to: "door" }] });
});

test("an attempt is never written over, a missing file is named, and what the script found wrong is what the caller is told", async (t) => {
  const f = await fixture(t);
  const players = [{ name: "guide", path: f.files["guide.glb"]! }];
  await mkdir(join(f.root, "taken"));
  await assert.rejects(stageShot({ outputDir: join(f.root, "taken"), players }, f.options), /EEXIST/);
  await assert.rejects(stageShot({ outputDir: join(f.root, "a"), players: [{ name: "guide", path: join(f.root, "none.glb") }] }, f.options), /Missing or empty output: .*none\.glb/);
  await assert.rejects(stageShot({ outputDir: join(f.root, "b"), set: join(f.root, "none.blend"), players }, f.options), /Missing or empty output: .*none\.blend/);
  await assert.rejects(stageShot({ outputDir: join(f.root, "c"), players: [{ ...players[0]!, does: [{ clip: join(f.root, "none.glb") }] }] }, f.options), /Missing or empty output: .*none\.glb/);
  await assert.rejects(
    stageShot({ outputDir: join(f.root, "d"), set: f.files["street.blend"], players: [{ ...players[0]!, does: [{ seconds: 1, to: "window" }] }] }, f.options),
    /^Error: the set has no mark named window for guide \(act 1, to\): its marks are door\. A mark is an object named mark\.<name>$/,
  );
});
