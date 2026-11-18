import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rigShot, shotSettings, type RigShotRequest } from "../src/rig-shot.js";

// A Blender that writes what rig-shot.py writes, and an FFmpeg that writes a file where it is told to.
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "rig shot "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const blender = join(root, "fake blender.mjs");
  await writeFile(blender, `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv.includes('--version')) { console.log('Blender 5.2.1 LTS'); process.exit(0); }
if (!process.argv.includes('--disable-autoexec') || !process.argv.includes('--factory-startup')) process.exit(8);
if (!process.argv[process.argv.indexOf('--python') + 1].endsWith('rig-shot.py')) process.exit(9);
const cfg = JSON.parse(readFileSync(process.argv.at(-1), 'utf8'));
if (readFileSync(cfg.path, 'utf8').includes('NO SKELETON')) { console.log('RuntimeError: the file has no skeleton: there is no character to film'); process.exit(1); }
const frames = Math.round((cfg.seconds ?? cfg.loops) * cfg.fps);
mkdirSync(join(cfg.outputDir, 'frames'));
for (const frame of [1, frames]) writeFileSync(join(cfg.outputDir, 'frames', String(frame).padStart(6, '0') + '.png'), 'png');
writeFileSync(join(cfg.outputDir, 'shot.json'), JSON.stringify({ frames, fps: cfg.fps, seconds: frames / cfg.fps, width: cfg.width, height: cfg.height,
  action: 'walk', clipSeconds: 1, camera: cfg.camera, framing: cfg.framing, follow: cfg.follow, travel: 0, body: { tall: 1, wide: 0.6 }, engine: 'BLENDER_EEVEE', blender: '5.2.1 LTS' }));
`);
  await chmod(blender, 0o755);
  const ffmpeg = join(root, "fake ffmpeg.mjs");
  await writeFile(ffmpeg, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv.at(-1), 'mp4 ' + process.argv.slice(2).join(' '));
`);
  await chmod(ffmpeg, 0o755);
  const path = join(root, "figure.clip.walk.glb");
  await writeFile(path, "glTF fake");
  return { root, path, options: { blenderPath: blender, ffmpegPath: ffmpeg } };
}

test("a request has its defaults, and is refused before Blender is started when it cannot be made", () => {
  const base: RigShotRequest = { path: "figure.glb", outputDir: "out" };
  assert.deepEqual(shotSettings(base), { faces: "+z", camera: "three-quarter", framing: "full", follow: true, loops: 1, width: 1280, height: 720, fps: 24, background: "#d9dadc", ground: true, samples: 16 });
  assert.equal(shotSettings({ ...base, seconds: 3.5, width: 1080, height: 1920 }).seconds, 3.5);
  for (const [request, message] of [
    [{ ...base, path: "figure.fbx" }, /filmed from a binary glTF/],
    [{ ...base, camera: "above" as never }, /camera is one of front, three-quarter, side, back/],
    [{ ...base, framing: "wide" as never }, /framing is one of full, medium, close/],
    [{ ...base, faces: "up" as never }, /faces is one of/],
    [{ ...base, width: 1281 }, /width is an even number of pixels/],
    [{ ...base, height: 32 }, /height is an even number of pixels from 64/],
    [{ ...base, fps: 120 }, /fps is a whole number from 6 to 60/],
    [{ ...base, loops: 0 }, /loops is a whole number from 1 to 20/],
    [{ ...base, seconds: 61 }, /seconds is more than 0 and at most 60/],
    [{ ...base, samples: 0 }, /samples is a whole number/],
    [{ ...base, background: "grey" }, /background is a colour as #rrggbb/],
  ] as const) {
    assert.throws(() => shotSettings(request), message);
  }
});

test("the frames the script renders are joined into one file with no sound", async (t) => {
  const f = await fixture(t);
  const { report, mediaPath, outputDir } = await rigShot({ path: f.path, outputDir: join(f.root, "shot"), camera: "side", framing: "medium", seconds: 2, fps: 12, width: 640, height: 360 }, f.options);
  assert.deepEqual({ frames: report.frames, seconds: report.seconds, camera: report.camera, framing: report.framing }, { frames: 24, seconds: 2, camera: "side", framing: "medium" });
  assert.equal(mediaPath, join(outputDir, "shot.mp4"));
  const encoded = await readFile(mediaPath, "utf8");
  assert.match(encoded, /-framerate 12 /);
  assert.match(encoded, /-frames:v 24 -an -c:v libx264 /);
  assert.match(encoded, /-pix_fmt yuv420p/);
  const sent = JSON.parse(await readFile(join(outputDir, "request.json"), "utf8"));
  assert.deepEqual({ path: sent.path, maxFrames: sent.maxFrames, ground: sent.ground }, { path: f.path, maxFrames: 1800, ground: true });
});

test("an attempt is never written over, and what the script found wrong is what the caller is told", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "taken"));
  await assert.rejects(rigShot({ path: f.path, outputDir: join(f.root, "taken") }, f.options), /EEXIST/);
  await assert.rejects(rigShot({ path: join(f.root, "none.glb"), outputDir: join(f.root, "a") }, f.options), /Missing or empty output/);
  await writeFile(f.path, "NO SKELETON");
  await assert.rejects(rigShot({ path: f.path, outputDir: join(f.root, "b") }, f.options), /^Error: the file has no skeleton: there is no character to film$/);
});
