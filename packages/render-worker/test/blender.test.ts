// Blender jobs on an engine (blender-job.ts, blender-engine.ts,
// blender-remote.ts) end to end, with the engine in this process
// (helpers.ts) and a fake Blender that writes known frames.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { Git } from "../src/code-sync.js";
import type { BlenderRunner, BlendPathsLister } from "../src/blender-engine.js";
import { prepareBlenderJob, unmirrorPath } from "../src/blender-job.js";
import { runBlenderRemote } from "../src/blender-remote.js";
import { mirrorPath } from "../src/protocol.js";
import type { Exec } from "../src/ssh.js";
import { fakeEngine, sha256, tempDir } from "./helpers.js";

const SHA = "c".repeat(40);
const cleanGit: Git = (args) => (args[0] === "rev-parse" ? { code: 0, stdout: `${SHA}\n`, stderr: "" } : { code: 0, stdout: "", stderr: "" });
const target = { name: "gpu-box", destination: "gpu-box", repo: "~/sergio" };
const BIN = "~/opt/blender/blender";

/** A shot's inputs: a set .blend with a texture beside it, a body, a clip. */
function shotFiles() {
  const root = tempDir("rw-blender-lib-");
  const unit = path.join(root, "film", "scenes", "s1", "shots", "sh1");
  mkdirSync(path.join(unit, "set"), { recursive: true });
  mkdirSync(path.join(unit, "cast"), { recursive: true });
  writeFileSync(path.join(unit, "set", "room.blend"), "BLENDER-v502 the room");
  writeFileSync(path.join(unit, "set", "wall.png"), "wall texture");
  writeFileSync(path.join(unit, "cast", "nell.glb"), "glTF nell");
  writeFileSync(path.join(unit, "cast", "walk.glb"), "glTF walk");
  const request = {
    outputDir: path.join(unit, "work", "shot"),
    set: path.join(unit, "set", "room.blend"),
    players: [{ name: "nell", path: path.join(unit, "cast", "nell.glb"), does: [{ clip: path.join(unit, "cast", "walk.glb"), to: [1, 0] }] }],
  };
  return { root, unit, request };
}

/** A Blender that checks it reads the engine's copies, and writes a shot as stageShot does. */
function fakeStage(seen: Record<string, unknown>[]): BlenderRunner {
  return async (kind, request, options) => {
    seen.push({ kind, request, options });
    const out = request.outputDir as string;
    mkdirSync(path.join(out, "frames"), { recursive: true });
    const players = request.players as { path: string; does: { clip: string }[] }[];
    assert.equal(readFileSync(players[0]!.path, "utf-8"), "glTF nell");
    assert.equal(readFileSync(players[0]!.does[0]!.clip, "utf-8"), "glTF walk");
    writeFileSync(path.join(out, "frames", "000001.png"), "frame one");
    writeFileSync(path.join(out, "shot.mp4"), "the shot's video");
    writeFileSync(path.join(out, "shot.json"), JSON.stringify({ frames: 1 }));
    return { outputDir: out, mediaPath: path.join(out, "shot.mp4"), report: { frames: 1, set: true } };
  };
}

/** The lock's session on the engine: answers "locked", holds until stdin ends; records each command. */
function fakeLock(commands: string[]): Exec {
  return async (_destination, command, input = {}) => {
    commands.push(command);
    input.stdout?.write("locked\n");
    for await (const _ of (input.stdin ?? []) as AsyncIterable<Buffer>) { /* held */ }
    commands.push("released");
    input.stdout?.end();
    return { code: 0, stdout: "", stderr: "" };
  };
}

test("a request's files are mirrored and named under files/, and a mirror goes back to its path", async () => {
  const { request } = shotFiles();
  const prepared = await prepareBlenderJob("stage-shot", request);
  assert.equal(prepared.request.outputDir, undefined);
  const players = prepared.request.players as { path: string; does: { clip: string }[] }[];
  assert.equal(players[0]!.path, mirrorPath(request.players[0]!.path));
  assert.equal(players[0]!.does[0]!.clip, mirrorPath(request.players[0]!.does[0]!.clip));
  assert.deepEqual(prepared.blends, [mirrorPath(request.set)]);
  assert.equal(prepared.files.length, 3);
  if (process.platform !== "win32") assert.equal(unmirrorPath(mirrorPath(request.set)), request.set);
  await assert.rejects(prepareBlenderJob("render", { mode: "create", scriptPath: request.set, outputDir: "x" }), /a scene is created here/);
  await assert.rejects(prepareBlenderJob("rig-shot", { path: "/no/such.glb", outputDir: "x" }), /is not a file/);
});

test("a staged shot runs on the engine with its Blender and GPU lock, sends each file once, and comes back whole", async () => {
  const { unit, request } = shotFiles();
  const seen: Record<string, unknown>[] = [];
  const locks: string[] = [];
  // The set names its texture relatively: the engine's Blender misses it until it is sent.
  const texture = mirrorPath(path.join(unit, "set", "wall.png"));
  const lister: BlendPathsLister = async (_bin, blend) => {
    const jobDir = blend.slice(0, blend.indexOf(`${path.sep}files${path.sep}`));
    const there = path.join(jobDir, ...texture.split("/"));
    return existsSync(there) ? [] : [there];
  };
  const engine = fakeEngine({ blender: fakeStage(seen), blendPaths: lister, blenderLockExec: fakeLock(locks) });
  const logs: string[] = [];
  const result = await runBlenderRemote<{ outputDir: string; mediaPath: string; report: { frames: number } }>("stage-shot", request, {
    target, key: "film/s1/sh1", bin: BIN, gpuLock: "~/ai/generation.lock", lockWaitSeconds: 1200,
    allowedRoots: [unit], exec: engine.exec, git: cleanGit, attempt: "a1", onLog: (l) => logs.push(l),
  });

  assert.equal(result.outputDir, request.outputDir);
  assert.equal(result.mediaPath, path.join(request.outputDir, "shot.mp4"));
  assert.deepEqual(result.report, { frames: 1, set: true });
  assert.equal(readFileSync(path.join(request.outputDir, "shot.mp4"), "utf-8"), "the shot's video");
  assert.equal(readFileSync(path.join(request.outputDir, "frames", "000001.png"), "utf-8"), "frame one");
  assert.deepEqual({ ...result.machine, paths: undefined }, {
    name: "gpu-box", ssh: "gpu-box", commit: SHA, blender: "Blender 5.2.1 LTS", gpuLock: "~/ai/generation.lock",
    sentFiles: 4, sentBytes: "BLENDER-v502 the room".length + "glTF nell".length + "glTF walk".length + "wall texture".length, paths: undefined,
  });
  assert.match(result.machine.paths.outputDir, /film[\\/]s1[\\/]sh1[\\/]blender[\\/]a1[\\/]out$/);

  // Blender ran with the machine's binary, on the engine's copies, into the attempt.
  assert.equal(seen.length, 1);
  assert.match((seen[0]!.options as { blenderPath: string }).blenderPath, /opt[\\/]blender[\\/]blender$/);
  assert.ok(!(seen[0]!.options as { blenderPath: string }).blenderPath.startsWith("~"));
  assert.ok(((seen[0]!.request as { set: string }).set).startsWith(engine.cache));
  // The lock was taken around it, waited for as long as asked, and released.
  assert.equal(locks.length, 2);
  assert.match(locks[0]!, /flock -x -w 1200 .*ai\/generation\.lock/);
  assert.equal(locks[1], "released");
  // The engine got this commit, as for a render.
  assert.ok(engine.calls.some((c) => c.command.includes(`git checkout --quiet --force -B engine ${SHA}`)));

  // Again: nothing travels a second time.
  const again = await runBlenderRemote<{ outputDir: string }>("stage-shot", { ...request, outputDir: path.join(unit, "work", "shot-2") }, {
    target, key: "film/s1/sh1", bin: BIN, allowedRoots: [unit], exec: engine.exec, git: cleanGit, attempt: "a2",
  });
  assert.equal(again.machine.sentFiles, 0);
  assert.equal(again.machine.sentBytes, 0);
  assert.ok(existsSync(path.join(unit, "work", "shot-2", "shot.mp4")));
});

test("a file the .blend names outside the unit is refused, with its path, before Blender runs", async () => {
  const { unit, request } = shotFiles();
  const seen: Record<string, unknown>[] = [];
  const outside = path.join(tempDir("rw-elsewhere-"), "sky.hdr");
  writeFileSync(outside, "sky");
  const lister: BlendPathsLister = async (_bin, blend) => {
    const jobDir = blend.slice(0, blend.indexOf(`${path.sep}files${path.sep}`));
    return [path.join(jobDir, ...mirrorPath(outside).split("/"))];
  };
  const engine = fakeEngine({ blender: fakeStage(seen), blendPaths: lister });
  await assert.rejects(
    runBlenderRemote("stage-shot", request, { target, key: "film/s1/sh1", bin: BIN, allowedRoots: [unit], exec: engine.exec, git: cleanGit, attempt: "a1" }),
    (e: Error & { code?: string }) => e.code === "missing-file" && e.message.includes("sky.hdr") && e.message.includes("Make Paths Relative"),
  );
  assert.equal(seen.length, 0);
  assert.ok(!existsSync(request.outputDir));
});

test("uncommitted Blender code stops the job; uncommitted render code does not", async () => {
  const { request } = shotFiles();
  const engine = fakeEngine({ blender: fakeStage([]), blendPaths: async () => [] });
  const dirty = (file: string): Git => (args) => {
    if (args[0] === "rev-parse") return { code: 0, stdout: `${SHA}\n`, stderr: "" };
    if (args[0] === "status") return { code: 0, stdout: args.includes(file.split("/").slice(0, 2).join("/")) ? ` M ${file}\n` : "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(
    runBlenderRemote("stage-shot", request, { target, key: "film/s1/sh1", bin: BIN, exec: engine.exec, git: dirty("packages/blender/python/stage-shot.py"), attempt: "a1" }),
    (e: Error & { code?: string }) => e.code === "dirty-code" && e.message.includes("packages/blender/python/stage-shot.py"),
  );
  const ran = await runBlenderRemote<{ outputDir: string }>("stage-shot", request, {
    target, key: "film/s1/sh1", bin: BIN, exec: engine.exec, git: dirty("packages/remotion-composer/src/x.ts"), attempt: "a2",
  });
  assert.equal(ran.outputDir, request.outputDir);
});

test("an output changed on the way back is refused, and nothing is left in its place", async () => {
  const { unit, request } = shotFiles();
  const engine = fakeEngine({ blender: fakeStage([]), blendPaths: async () => [] });
  const tampering: Exec = async (destination, command, input) => {
    if (command.includes("fetch-blender")) writeFileSync(path.join(engine.cache, "film", "s1", "sh1", "blender", "a1", "out", "shot.mp4"), "not the shot");
    return engine.exec(destination, command, input);
  };
  await assert.rejects(
    runBlenderRemote("stage-shot", request, { target, key: "film/s1/sh1", bin: BIN, allowedRoots: [unit], exec: tampering, git: cleanGit, attempt: "a1" }),
    (e: Error & { code?: string }) => e.code === "transfer-failed",
  );
  assert.ok(!existsSync(request.outputDir));
});

test("the lock is released when Blender fails, and the failure is the engine's", async () => {
  const { unit, request } = shotFiles();
  const locks: string[] = [];
  const engine = fakeEngine({
    blender: async () => { throw new Error("the walk clip has no armature"); },
    blendPaths: async () => [],
    blenderLockExec: fakeLock(locks),
  });
  await assert.rejects(
    runBlenderRemote("stage-shot", request, { target, key: "film/s1/sh1", bin: BIN, gpuLock: "~/ai/generation.lock", allowedRoots: [unit], exec: engine.exec, git: cleanGit, attempt: "a1" }),
    /gpu-box: the walk clip has no armature/,
  );
  assert.deepEqual(locks.slice(1), ["released"]);
});

test("a rendered .blend's manifest names this machine's files, and the engine's under machine.paths", async () => {
  const root = tempDir("rw-blender-render-");
  const blend = path.join(root, "ep", "scene.blend");
  mkdirSync(path.dirname(blend), { recursive: true });
  writeFileSync(blend, "BLENDER-v502 scene");
  const outputDir = path.join(root, "ep", "attempt");
  const engine = fakeEngine({
    blendPaths: async () => [],
    blender: async (kind, request) => {
      assert.equal(kind, "render");
      const out = request.outputDir as string;
      mkdirSync(out, { recursive: true });
      writeFileSync(path.join(out, "preview.png"), "a picture");
      writeFileSync(path.join(out, "scene.blend"), "packed");
      const result = { outputDir: out, manifestPath: path.join(out, "manifest.json"), blendPath: path.join(out, "scene.blend"), mediaPath: path.join(out, "preview.png"), frameCount: 1 };
      writeFileSync(path.join(out, "manifest.json"), JSON.stringify({ status: "completed", inputBlend: request.blendPath, result }));
      return result;
    },
  });
  const result = await runBlenderRemote<{ mediaPath: string; manifestPath: string }>("render", { mode: "preview", trustedInput: true, blendPath: blend, outputDir }, {
    target, key: "ch/series/ep", bin: BIN, exec: engine.exec, git: cleanGit, attempt: "r1",
  });
  assert.equal(result.mediaPath, path.join(outputDir, "preview.png"));
  const manifest = JSON.parse(readFileSync(result.manifestPath, "utf-8"));
  assert.equal(manifest.inputBlend, blend);
  assert.equal(manifest.result.mediaPath, path.join(outputDir, "preview.png"));
  assert.equal(manifest.machine.name, "gpu-box");
  assert.ok(manifest.machine.paths.inputBlend.startsWith(engine.cache));
  assert.ok(manifest.machine.paths.outputDir.startsWith(engine.cache));
  assert.equal(sha256(readFileSync(path.join(outputDir, "preview.png"))), sha256("a picture"));
});
