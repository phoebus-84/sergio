// ---------------------------------------------------------------------------
// pva_rig_shot: a rigged character filmed, and what the tool keeps and says
// ---------------------------------------------------------------------------
// The real tool against a Blender and an FFmpeg that are scripts: they write
// what the real ones write, so the paths, the clip chosen, the file kept in
// assets/video and the words are tested without a 3D program. The script
// that films is tested with the real ones in packages/blender (test:live).
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRigShotTools } from "../src/rig-shot-tools.js";

const REF = { channel: "sample-channel", series: "sample-series", episode: "ep" };

interface Tool {
  name: string;
  description: string;
  execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
}

// The file it is given says what it holds: a clip of some length, that travels or not.
const FAKE_BLENDER = `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv.includes('--version')) { console.log('Blender 5.2.1 LTS'); process.exit(0); }
const cfg = JSON.parse(readFileSync(process.argv.at(-1), 'utf8'));
const held = readFileSync(cfg.path, 'utf8');
if (held.includes('NO SKELETON')) { console.log('RuntimeError: the file has no skeleton: there is no character to film'); process.exit(1); }
const clip = held.startsWith('clip') ? { seconds: 1, travel: held.includes('travels') ? 2.5 : 0 } : null;
const seconds = cfg.seconds ?? (clip ? clip.seconds * cfg.loops : 2);
const frames = Math.round(seconds * cfg.fps);
mkdirSync(join(cfg.outputDir, 'frames'));
for (const frame of [1, frames]) writeFileSync(join(cfg.outputDir, 'frames', String(frame).padStart(6, '0') + '.png'), 'png');
writeFileSync(join(cfg.outputDir, 'shot.json'), JSON.stringify({ frames, fps: cfg.fps, seconds, width: cfg.width, height: cfg.height,
  action: clip ? 'Armature|walk' : null, clipSeconds: clip ? clip.seconds : 0, camera: cfg.camera, framing: cfg.framing, follow: cfg.follow,
  travel: clip ? clip.travel : 0, body: { tall: 1, wide: 0.6 }, engine: 'BLENDER_EEVEE', blender: '5.2.1 LTS' }));
`;
const FAKE_FFMPEG = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv.at(-1), 'a film of ' + process.argv[process.argv.indexOf('-frames:v') + 1] + ' frames');
`;

describe("pva_rig_shot", () => {
  let root: string;
  let dir: string;
  let tool: Tool;
  const saved = { library: process.env.AVG_LIBRARY_ROOT, blender: process.env.BLENDER_BIN, ffmpeg: process.env.FFMPEG_BIN };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pva-rig-shot-"));
    dir = join(root, REF.channel, "series", REF.series, "episodes", REF.episode);
    mkdirSync(join(dir, "assets", "models"), { recursive: true });
    writeFileSync(join(dir, "assets", "models", "guide.glb"), "the rig, at rest");
    writeFileSync(join(dir, "assets", "models", "guide.clip.walking.glb"), "clip: a walk on the spot");
    writeFileSync(join(dir, "assets", "models", "guide.clip.big-jump.glb"), "clip: a jump that travels");
    for (const [name, body] of [["blender.mjs", FAKE_BLENDER], ["ffmpeg.mjs", FAKE_FFMPEG]] as const) {
      writeFileSync(join(root, name), body);
      chmodSync(join(root, name), 0o755);
    }
    process.env.AVG_LIBRARY_ROOT = root;
    process.env.BLENDER_BIN = join(root, "blender.mjs");
    process.env.FFMPEG_BIN = join(root, "ffmpeg.mjs");
    const tools: Tool[] = [];
    registerRigShotTools({ registerTool: (one: Tool) => tools.push(one) } as never);
    tool = tools[0]!;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of [["AVG_LIBRARY_ROOT", saved.library], ["BLENDER_BIN", saved.blender], ["FFMPEG_BIN", saved.ffmpeg]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  const film = (params: Record<string, unknown> = {}) => tool.execute("call", { ...REF, shotId: "guide-walks", rigPath: "assets/models/guide.glb", ...params }, undefined, undefined);
  const video = (name: string) => join(dir, "assets", "video", name);

  it("is one tool, and says it is local and free", () => {
    expect(tool.name).toBe("pva_rig_shot");
    expect(tool.description).toContain("Local (Blender and FFmpeg), free");
  });

  it("films one of the rig's clips and keeps the film where generated clips are kept", async () => {
    const result = await film({ clip: "walking", loops: 3 });
    expect(readdirSync(join(dir, "assets", "video")).sort()).toEqual(["guide-walks.mp4", "guide-walks.provenance.json"]);
    expect(readFileSync(video("guide-walks.mp4"), "utf8")).toBe("a film of 72 frames");
    expect(result.content[0]!.text.split("\n")).toEqual([
      "✅ assets/video/guide-walks.mp4 — 3s, 1280×720 at 24 fps, 0.0MB, no sound",
      "   three-quarter, full; the clip walking (1s) played on the spot",
      "   look at it before it is used (pva_inspect_media): a body that leaves the frame, a hand through the head, a floor it sinks into are seen, not measured",
    ]);
    const provenance = JSON.parse(readFileSync(video("guide-walks.provenance.json"), "utf8"));
    expect(provenance).toMatchObject({
      version: 1, tool: "pva_rig_shot", file: "guide-walks.mp4", rig: "assets/models/guide.glb", clip: "walking", clipFile: "assets/models/guide.clip.walking.glb",
      settings: { camera: "three-quarter", framing: "full", loops: 3, width: 1280, height: 720, fps: 24, ground: true }, frames: 72, seconds: 3,
    });
    for (const key of ["sha256", "rigSha256", "clipSha256"]) expect(provenance[key]).toMatch(/^[0-9a-f]{64}$/);
    expect(result.details).toMatchObject({ outputPath: video("guide-walks.mp4") });
  });

  it("films the character at rest when no clip is named, in the frame asked for", async () => {
    const result = await film({ camera: "front", framing: "close", width: 1080, height: 1920, fps: 30, background: "#f2e9d8", ground: false });
    const lines = result.content[0]!.text.split("\n");
    expect(lines[0]).toBe("✅ assets/video/guide-walks.mp4 — 2s, 1080×1920 at 30 fps, 0.0MB, no sound");
    expect(lines[1]).toBe("   front, close; the character at rest: name a `clip` to see it move");
    expect(JSON.parse(readFileSync(video("guide-walks.provenance.json"), "utf8"))).not.toHaveProperty("clip");
  });

  it("says when a clip that travels is played more than once, and whether the camera went with it", async () => {
    const once = (await film({ clip: "big-jump" })).content[0]!.text.split("\n");
    expect(once[1]).toBe("   three-quarter, full; the clip big-jump (1s) played travelling 2.5 of its height, the camera with it");
    expect(once).toHaveLength(3);
    const twice = (await film({ clip: "big-jump", loops: 2, follow: false, overwrite: true })).content[0]!.text.split("\n");
    expect(twice[1]).toBe("   three-quarter, full; the clip big-jump (1s) played travelling 2.5 of its height, past a camera that stays");
    expect(twice[2]).toBe("   ⚠️ the clip travels and is played more than once: the body jumps back each time it repeats");
  });

  it("does not film over a shot unless told to, and refuses what it cannot film before Blender is started", async () => {
    await film({ clip: "walking" });
    await expect(film({ clip: "walking" })).rejects.toThrow("assets/video/guide-walks.mp4 already exists: pick another shotId, or pass overwrite: true");
    await expect(film({ shotId: "bad name" })).rejects.toThrow("shotId must contain only letters");
    await expect(film({ shotId: "b", rigPath: "assets/models/none.glb" })).rejects.toThrow("Rig not found: assets/models/none.glb");
    await expect(film({ shotId: "b", clip: "running" })).rejects.toThrow("the rig has no clip named running: assets/models/guide.clip.running.glb is not there");
    await expect(film({ shotId: "b", clip: "../x" })).rejects.toThrow("clip is the name of one of the rig's clips");
    await expect(film({ shotId: "b", width: 1281 })).rejects.toThrow("width is an even number of pixels");
    await expect(film({ shotId: "b", background: "beige" })).rejects.toThrow("background is a colour as #rrggbb");
    writeFileSync(join(dir, "assets", "models", "guide.glb"), "NO SKELETON");
    await expect(film({ shotId: "b" })).rejects.toThrow("the file has no skeleton: there is no character to film");
    expect(existsSync(video("b.mp4"))).toBe(false);
    expect(readdirSync(join(dir, "assets", "video")).sort()).toEqual(["guide-walks.mp4", "guide-walks.provenance.json"]);
  });
});
