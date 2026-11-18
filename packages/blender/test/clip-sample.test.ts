import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sampleClip } from "../src/clip-sample.js";

// A Blender that does what clip-sample.py does to the output directory, or fails as it would.
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "clip sample "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "fake blender.mjs");
  await writeFile(binary, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv.includes('--version')) { console.log('Blender 5.2.1 LTS'); process.exit(0); }
if (!process.argv.includes('--disable-autoexec') || !process.argv.includes('--factory-startup')) process.exit(8);
if (!process.argv[process.argv.indexOf('--python') + 1].endsWith('clip-sample.py')) process.exit(9);
const cfg = JSON.parse(readFileSync(process.argv.at(-1), 'utf8'));
if (readFileSync(cfg.path, 'utf8').includes('STILL')) { console.log('RuntimeError: the file holds no motion: only a pose, or nothing'); process.exit(1); }
writeFileSync(join(cfg.outputDir, 'clip.json'), JSON.stringify({
  action: cfg.action ?? 'Walk', actions: ['Walk', 'Run'], fps: 30, seconds: 1 / 30, times: [0, 1 / 30],
  bones: [{ name: 'Hips', parent: null, rest: [0, 1, 0] }],
  rotations: { Hips: [[0, 0, 0, 1], [0, 0.1, 0, 0.995]] }, positions: { Hips: [[0, 1, 0], [0, 1, 0.1]] }, maxFrames: cfg.maxFrames,
}));
`);
  await chmod(binary, 0o755);
  const path = join(root, "walk.fbx");
  await writeFile(path, "a motion");
  return { root, path, options: { blenderPath: binary } };
}

test("a clip is played by the script and what every bone did comes back", async (t) => {
  const f = await fixture(t);
  const clip = await sampleClip({ path: f.path, outputDir: join(f.root, "sample"), action: "Run" }, f.options);
  assert.deepEqual({ action: clip.action, actions: clip.actions, fps: clip.fps, frames: clip.times.length }, { action: "Run", actions: ["Walk", "Run"], fps: 30, frames: 2 });
  assert.deepEqual(clip.rotations["Hips"]![1], [0, 0.1, 0, 0.995]);
  assert.deepEqual(clip.positions["Hips"]![1], [0, 1, 0.1]);
  const sent = JSON.parse(await readFile(join(f.root, "sample", "request.json"), "utf8"));
  assert.deepEqual({ path: sent.path, action: sent.action, maxFrames: sent.maxFrames }, { path: f.path, action: "Run", maxFrames: 720 });
});

test("what cannot be read is refused, and what the script found wrong is what the caller is told", async (t) => {
  const f = await fixture(t);
  await assert.rejects(sampleClip({ path: join(f.root, "walk.obj"), outputDir: join(f.root, "a") }, f.options), /a clip is read from a \.glb or an \.fbx/);
  await assert.rejects(sampleClip({ path: join(f.root, "none.glb"), outputDir: join(f.root, "b") }, f.options), /Missing or empty file/);
  await assert.rejects(sampleClip({ path: f.path, outputDir: join(f.root, "c"), maxFrames: 1 }, f.options), /maxFrames is a whole number from 2 to 7200/);
  await mkdir(join(f.root, "taken"));
  await assert.rejects(sampleClip({ path: f.path, outputDir: join(f.root, "taken") }, f.options), /EEXIST/);
  await writeFile(f.path, "STILL");
  await assert.rejects(sampleClip({ path: f.path, outputDir: join(f.root, "d") }, f.options), /^Error: the file holds no motion: only a pose, or nothing$/);
});
