import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRigSheetRequest, rigSheet, type RigSheetRequest } from "../src/rig-sheet.js";

// A Blender that does what rig-sheet.py does to the output directory, or fails as it would.
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "rig sheet "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "fake blender.mjs");
  await writeFile(binary, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv.includes('--version')) { console.log('Blender 4.5.1'); process.exit(0); }
if (!process.argv.includes('--disable-autoexec') || !process.argv.includes('--factory-startup')) process.exit(8);
if (!process.argv[process.argv.indexOf('--python') + 1].endsWith('rig-sheet.py')) process.exit(9);
const cfg = JSON.parse(readFileSync(process.argv.at(-1), 'utf8'));
if (readFileSync(cfg.rigPath, 'utf8').includes('NO SKELETON')) {
  console.log('Traceback (most recent call last):\\nRuntimeError: the file has no skeleton: there is nothing to pose');
  process.exit(1);
}
const layout = { columns: 1, rows: 3, width: cfg.tile, height: cfg.tile * 3 };
const clips = [...cfg.actions.map((name) => ({ name, from: 'rig' })), ...cfg.clips.map((clip) => ({ name: clip.name, from: 'file' }))]
  .map((clip) => ({ ...clip, action: clip.name, seconds: 1, travel: 0, strained: 0, torn: 0, sheet: 'clip.' + clip.name + '.png', ...layout }));
writeFileSync(join(cfg.outputDir, 'poses.png'), 'png');
for (const clip of clips) if (clip.name !== 'lost') writeFileSync(join(cfg.outputDir, clip.sheet), 'png');
writeFileSync(join(cfg.outputDir, 'sheet.json'), JSON.stringify({
  rig: { bones: 2, vertices: 8, edges: 12, size: [1, 2, 1], skeleton: 'unknown', roles: {} }, bones: [], views: ['front', 'three-quarter', 'side'],
  poses: { sheet: 'poses.png', ...layout, list: [{ name: 'rest', turns: [], strained: 0, torn: 0 }, ...cfg.poses.map((pose) => ({ ...pose, strained: 0.01, torn: 2 }))] },
  clips, actionsInside: [], notes: ['faces ' + cfg.faces],
}));
`);
  await chmod(binary, 0o755);
  const rigPath = join(root, "figure.glb");
  await writeFile(rigPath, "glTF fake");
  return { root, rigPath, options: { blenderPath: binary } };
}

test("a request is refused before Blender is started", () => {
  const base: RigSheetRequest = { rigPath: "figure.glb", outputDir: "out" };
  const turn = { bone: "Arm", about: "front" as const, degrees: 30 };
  checkRigSheetRequest(base);
  checkRigSheetRequest({ ...base, faces: "+x", tile: 256, poses: [{ name: "arm up", turns: [turn] }], actions: ["Walk"], clips: [{ name: "run", path: "run.glb" }] });
  for (const [request, message] of [
    [{ ...base, rigPath: "figure.fbx" }, /must be a binary glTF/],
    [{ ...base, faces: "up" as never }, /faces is one of/],
    [{ ...base, tile: 100 }, /tile is an even number of pixels from 128 to 512/],
    [{ ...base, tile: 301 }, /tile is an even number/],
    [{ ...base, poses: Array.from({ length: 13 }, (_, i) => ({ name: `p${i}`, turns: [turn] })) }, /at most 12 poses/],
    [{ ...base, poses: [{ name: "../up", turns: [turn] }] }, /a pose's name is/],
    [{ ...base, poses: [{ name: "up", turns: [] }] }, /one to 16 turns/],
    [{ ...base, poses: [{ name: "up", turns: [{ ...turn, about: "x" as never }] }] }, /about is one of front, up, side/],
    [{ ...base, poses: [{ name: "up", turns: [{ ...turn, degrees: Infinity }] }] }, /degrees is a number/],
    [{ ...base, actions: Array.from({ length: 9 }, (_, i) => `a${i}`) }, /at most 8 clips/],
    [{ ...base, actions: ["Walk"], clips: [{ name: "walk", path: "walk.glb" }] }, /two clips would be written to one sheet/],
    [{ ...base, clips: [{ name: "walk", path: "walk.fbx" }] }, /a clip is a binary glTF/],
  ] as const) {
    assert.throws(() => checkRigSheetRequest(request), message);
  }
});

test("the script is given the request and its sheets are checked", async (t) => {
  const f = await fixture(t);
  const clipPath = join(f.root, "run.glb");
  await writeFile(clipPath, "glTF fake");
  const pose = { name: "arm up", turns: [{ bone: "Arm", about: "front" as const, degrees: 30 }] };
  const result = await rigSheet({ rigPath: f.rigPath, outputDir: join(f.root, "sheet"), faces: "+x", poses: [pose], actions: ["Walk"], clips: [{ name: "run", path: clipPath }] }, f.options);
  assert.equal(result.reportPath, join(result.outputDir, "sheet.json"));
  assert.deepEqual(result.report.poses.list.map((one) => one.name), ["rest", "arm up"]);
  assert.deepEqual(result.report.clips.map((clip) => [clip.name, clip.from, clip.sheet]), [["Walk", "rig", "clip.Walk.png"], ["run", "file", "clip.run.png"]]);
  assert.deepEqual(result.report.notes, ["faces +x"]);
  const sent = JSON.parse(await readFile(join(result.outputDir, "request.json"), "utf8"));
  assert.deepEqual({ tile: sent.tile, clipFrames: sent.clipFrames, clips: sent.clips }, { tile: 288, clipFrames: 6, clips: [{ name: "run", path: clipPath }] });
});

test("an attempt is never written over, and what is missing is refused", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "taken"));
  await assert.rejects(rigSheet({ rigPath: f.rigPath, outputDir: join(f.root, "taken") }, f.options), /EEXIST/);
  await assert.rejects(rigSheet({ rigPath: join(f.root, "none.glb"), outputDir: join(f.root, "a") }, f.options), /Missing or empty output/);
  await assert.rejects(rigSheet({ rigPath: f.rigPath, outputDir: join(f.root, "b"), clips: [{ name: "run", path: join(f.root, "none.glb") }] }, f.options), /Missing or empty output/);
  await assert.rejects(rigSheet({ rigPath: f.rigPath, outputDir: join(f.root, "c"), actions: ["lost"] }, f.options), /Missing or empty output: .*clip\.lost\.png/);
});

test("what the script found wrong is what the caller is told", async (t) => {
  const f = await fixture(t);
  await writeFile(f.rigPath, "NO SKELETON");
  await assert.rejects(rigSheet({ rigPath: f.rigPath, outputDir: join(f.root, "sheet") }, f.options), /^Error: the file has no skeleton: there is nothing to pose$/);
});

test("a Blender that is not there is said so", async (t) => {
  const f = await fixture(t);
  await assert.rejects(rigSheet({ rigPath: f.rigPath, outputDir: join(f.root, "sheet") }, { blenderPath: join(f.root, "absent") }), /ENOENT|Requires Blender/);
});
