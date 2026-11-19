// ---------------------------------------------------------------------------
// pva_stage_shot: characters on a set, and what the tool keeps and says
// ---------------------------------------------------------------------------
// The real tool against a Blender and an FFmpeg that are scripts: they write
// what the real ones write, so who is brought in from which file, the film
// kept in assets/video and the words are tested without a 3D program. The
// script that stages is tested with the real ones in packages/blender
// (test:live).
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StageShotReport } from "@av/blender/stage-shot";
import { castRole, createCharacter, releaseForm, updateCharacter } from "@studio/cast";
import { describeStageShot, placeOf, registerStageShotTools } from "../src/stage-shot-tools.js";

const REF = { channel: "sample-channel", series: "sample-series", episode: "ep" };

interface Tool {
  name: string;
  description: string;
  execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
}

// It says back what it was given: who stands where, and each act with a length it makes up.
const FAKE_BLENDER = `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
if (process.argv.includes('--version')) { console.log('Blender 5.2.1 LTS'); process.exit(0); }
const cfg = JSON.parse(readFileSync(process.argv.at(-1), 'utf8'));
const fps = cfg.fps ?? 24;
let longest = 0;
const players = cfg.players.map((player) => {
  if (readFileSync(player.path, 'utf8').includes('NO BODY')) { console.log('RuntimeError: ' + player.name + "'s file holds no body: there is nothing to film"); process.exit(1); }
  let from = 0;
  const does = player.does.map((act) => {
    const seconds = act.seconds ?? (act.clip ? act.loops || 1 : 0.4);
    const told = { from, seconds, ...(act.clip ? { clip: basename(act.clip), action: readFileSync(act.clip, 'utf8'), clipSeconds: 1 } : {}),
      ...(act.to ? { to: typeof act.to === 'string' ? [3, 1, 0.15] : [...act.to, 0], metres: 2, speed: 2 / seconds, ...(act.clip ? { pace: 1 } : {}) } : {}) };
    from += seconds;
    return told;
  });
  longest = Math.max(longest, from);
  return { name: player.name, skeleton: true, at: typeof player.at === 'string' ? [-4, 1, 0] : [...(player.at ?? [0, 0]), 0], turn: player.turn ?? 0, tall: 1.2, does, ends: from, travel: 0, inFrame: 1, hidden: 0 };
});
const frames = Math.round((cfg.seconds ?? (longest || 2)) * fps);
mkdirSync(join(cfg.outputDir, 'frames'));
for (const frame of [1, frames]) writeFileSync(join(cfg.outputDir, 'frames', String(frame).padStart(6, '0') + '.png'), 'png');
writeFileSync(join(cfg.outputDir, 'shot.json'), JSON.stringify({ frames, fps, seconds: frames / fps, width: cfg.width, height: cfg.height, set: !!cfg.set, marks: cfg.set ? ['door', 'lamp'] : [],
  camera: cfg.camera, players, tooClose: [], notes: [], engine: 'BLENDER_EEVEE', blender: '5.2.1 LTS' }));
`;
const FAKE_FFMPEG = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv.at(-1), 'a film of ' + process.argv[process.argv.indexOf('-frames:v') + 1] + ' frames');
`;

describe("pva_stage_shot", () => {
  let root: string;
  let dir: string;
  let tool: Tool;
  const saved = { library: process.env.AVG_LIBRARY_ROOT, blender: process.env.BLENDER_BIN, ffmpeg: process.env.FFMPEG_BIN };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pva-stage-shot-"));
    dir = join(root, REF.channel, "series", REF.series, "episodes", REF.episode);
    mkdirSync(join(dir, "assets", "models"), { recursive: true });
    mkdirSync(join(dir, "assets", "blender", "street"), { recursive: true });
    writeFileSync(join(dir, "assets", "blender", "street", "scene.blend"), "a street");
    // A rig still in the episode, with a clip beside it.
    writeFileSync(join(dir, "assets", "models", "child.glb"), "the child, at rest");
    writeFileSync(join(dir, "assets", "models", "child.clip.running.glb"), "running");
    // A character released as pva_release_model leaves one, and cast.
    createCharacter(root, [REF.channel], { id: "guide", name: "The Guide" });
    const released = join(root, REF.channel, "characters", "guide", "forms", "rig", "v1");
    mkdirSync(join(released, "clips"), { recursive: true });
    writeFileSync(join(released, "rig.glb"), "the released rig");
    writeFileSync(join(released, "clips", "walking.glb"), "walking");
    writeFileSync(join(released, "clips", "wave.glb"), "wave");
    writeFileSync(join(released, "form.json"), JSON.stringify({ version: 1, entry: "rig.glb", clips: [{ name: "walking", file: "clips/walking.glb" }, { name: "wave", file: "clips/wave.glb" }] }));
    updateCharacter(root, [REF.channel], "guide", { form: { id: "rig", medium: "rig-3d", can: { actions: ["walking", "wave"] } } });
    releaseForm(root, [REF.channel], "guide", { form: "rig", release: "v1", entry: "rig.glb" });
    castRole(root, { channel: REF.channel, series: REF.series }, { role: "host", character: "guide" });
    for (const [name, body] of [["blender.mjs", FAKE_BLENDER], ["ffmpeg.mjs", FAKE_FFMPEG]] as const) {
      writeFileSync(join(root, name), body);
      chmodSync(join(root, name), 0o755);
    }
    process.env.AVG_LIBRARY_ROOT = root;
    process.env.BLENDER_BIN = join(root, "blender.mjs");
    process.env.FFMPEG_BIN = join(root, "ffmpeg.mjs");
    const tools: Tool[] = [];
    registerStageShotTools({ registerTool: (one: Tool) => tools.push(one) } as never);
    tool = tools[0]!;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of [["AVG_LIBRARY_ROOT", saved.library], ["BLENDER_BIN", saved.blender], ["FFMPEG_BIN", saved.ffmpeg]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  const SET = "assets/blender/street/scene.blend";
  const host = { role: "host", at: "door", does: [{ clip: "walking", to: "lamp" }, { towards: "child" }, { clip: "wave" }] };
  const child = { rigPath: "assets/models/child.glb", at: "1.5, 2", towards: "host", does: [{ seconds: 2 }, { clip: "running", to: "0.5, 2", seconds: 1 }] };
  const stage = (params: Record<string, unknown> = {}) => tool.execute("call", { ...REF, shotId: "meeting", set: SET, setCamera: true, players: [host, child], ...params }, undefined, undefined);
  const video = (name: string) => join(dir, "assets", "video", name);

  it("is one tool, and says it is local and free", () => {
    expect(tool.name).toBe("pva_stage_shot");
    expect(tool.description).toContain("Local (Blender and FFmpeg), free");
  });

  it("stages a role of the cast and a rig of the episode on a set, and says what each did", async () => {
    const result = await stage();
    expect(readdirSync(join(dir, "assets", "video")).sort()).toEqual(["meeting.mp4", "meeting.provenance.json"]);
    expect(readFileSync(video("meeting.mp4"), "utf8")).toBe("a film of 72 frames");
    expect(result.content[0]!.text.split("\n")).toEqual([
      "✅ assets/video/meeting.mp4 — 3s, 1280×720 at 24 fps, 0.0MB, no sound",
      "   on the set assets/blender/street/scene.blend (marks: door, lamp); the set's own camera",
      '   host (the role host: guide as "rig" v1), 1.2 m tall, at door: goes to lamp playing walking, 2 m in 1s; then turns to child (0.4s); then plays wave for 1s',
      "   child (assets/models/child.glb), 1.2 m tall, at 1.5, 2: waits 2s; then goes to 0.5, 2 playing running, 2 m in 1s",
      "   ⚠️ host is moved at 2 m/s on its way to lamp and its clip walks at 1: its feet will slide. Leave `seconds` out of that act and it goes at its clip's pace",
      "   ⚠️ child is moved at 2 m/s on its way to 0.5, 2 and its clip walks at 1: its feet will slide. Leave `seconds` out of that act and it goes at its clip's pace",
      "   look at it before it is used (pva_inspect_media): what is measured is where each body's chest is, and whether a part of a body passes into another of it. A hand through a wall or someone else, a look that misses the other's face, a light that flatters nobody are seen, not measured",
    ]);
    const provenance = JSON.parse(readFileSync(video("meeting.provenance.json"), "utf8"));
    expect(provenance).toMatchObject({
      version: 1, tool: "pva_stage_shot", file: "meeting.mp4", set: { file: SET }, camera: { kind: "set" }, frames: 72,
      staged: [
        { name: "host", cast: { role: "host", character: "guide", form: "rig", release: "v1" }, rig: "sample-channel/characters/guide/forms/rig/v1/rig.glb",
          clips: { walking: { file: "sample-channel/characters/guide/forms/rig/v1/clips/walking.glb" }, wave: { file: "sample-channel/characters/guide/forms/rig/v1/clips/wave.glb" } } },
        { name: "child", rig: "assets/models/child.glb", clips: { running: { file: "assets/models/child.clip.running.glb" } } },
      ],
    });
    for (const value of [provenance.sha256, provenance.set.sha256, provenance.staged[0].rigSha256, provenance.staged[0].clips.wave.sha256]) expect(value).toMatch(/^[0-9a-f]{64}$/);
    // The script was given each body and each clip by its file: the report names the motion each file holds.
    expect(provenance.players[0].does.map((act: { action?: string }) => act.action)).toEqual(["walking", undefined, "wave"]);
    expect(provenance.players[1]).toMatchObject({ name: "child", at: [1.5, 2, 0], does: [{ seconds: 2 }, { action: "running", to: [0.5, 2, 0] }] });
  });

  it("films an empty stage with a camera asked for in words, and names a player after its role or its file", async () => {
    const result = await stage({ set: undefined, setCamera: undefined, view: "front", framing: "medium", on: ["host"], follow: false, players: [{ role: "host" }, { rigPath: "assets/models/child.glb", name: "kid", faces: "+x" }] });
    const lines = result.content[0]!.text.split("\n");
    expect(lines[1]).toBe("   on an empty stage; camera front, medium, on host, staying where it is");
    expect(lines[2]).toBe('   host (the role host: guide as "rig" v1), 1.2 m tall, at 0, 0: stands');
    expect(lines[3]).toBe("   kid (assets/models/child.glb), 1.2 m tall, at 0, 0: stands");
    expect(JSON.parse(readFileSync(video("meeting.provenance.json"), "utf8")).set).toBeNull();
  });

  it("refuses what it cannot stage before Blender is started, and films over nothing unless told to", async () => {
    await stage();
    await expect(stage()).rejects.toThrow("assets/video/meeting.mp4 already exists: pick another shotId, or pass overwrite: true");
    const fresh = (params: Record<string, unknown>) => stage({ shotId: "b", ...params });
    await expect(fresh({ shotId: "bad name" })).rejects.toThrow("shotId must contain only letters");
    await expect(fresh({ set: "assets/blender/none.blend" })).rejects.toThrow("Set not found: assets/blender/none.blend");
    await expect(fresh({ set: "assets/models/child.glb" })).rejects.toThrow("a set is a .blend file: assets/models/child.glb. Make one with pva_blender_create_scene");
    await expect(fresh({ view: "front" })).rejects.toThrow("the set's own camera is not asked for in words");
    await expect(fresh({ set: undefined })).rejects.toThrow("the set's own camera was asked for, and there is no set");
    await expect(fresh({ players: [{ role: "host", rigPath: "assets/models/child.glb" }] })).rejects.toThrow("say which character is filmed: a rig of the episode (rigPath) or a role of the series' cast (role), one or the other");
    await expect(fresh({ players: [{ role: "villain" }] })).rejects.toThrow('sample-channel/sample-series has no role "villain" in its cast');
    await expect(fresh({ players: [{ role: "host", does: [{ clip: "bow" }] }] })).rejects.toThrow('the role "host" has no action named bow: its form can walking, wave');
    await expect(fresh({ players: [{ rigPath: "assets/models/child.glb", does: [{ clip: "walking" }] }] })).rejects.toThrow("the rig has no clip named walking: assets/models/child.clip.walking.glb is not there");
    await expect(fresh({ players: [{ role: "host" }, { role: "host" }] })).rejects.toThrow("two players are named host");
    await expect(fresh({ players: [{ role: "host", faces: "+x" }] })).rejects.toThrow("host: a released rig faces +z: leave `faces` out");
    await expect(fresh({ players: [{ role: "host", towards: "nobody" }] })).rejects.toThrow("host: there is no player named nobody to turn towards");
    await expect(fresh({ players: [{ role: "host", does: [{ clip: "walking", loops: 0 }, { seconds: 1 }] }] })).rejects.toThrow("host, act 1: loops 0 goes on for as long as the shot lasts, so it is the last thing a player does");
    writeFileSync(join(dir, "assets", "models", "child.glb"), "NO BODY");
    await expect(fresh({ players: [{ rigPath: "assets/models/child.glb" }] })).rejects.toThrow("child's file holds no body: there is nothing to film");
    expect(existsSync(video("b.mp4"))).toBe(false);
  });

  it("reads a place as a mark's name or as metres", () => {
    expect(placeOf("door")).toBe("door");
    expect(placeOf(" 1.5, -2 ")).toEqual([1.5, -2]);
    expect(placeOf("-3,0.25")).toEqual([-3, 0.25]);
    expect(placeOf("mark.2")).toBe("mark.2");
  });

  it("says what a look at one frame does not show: out of the picture, hidden, two in one place, feet that slide, a hand in a head", () => {
    const report: StageShotReport = {
      frames: 96, fps: 24, seconds: 4, width: 1280, height: 720, set: true, marks: [],
      camera: { kind: "words", view: "three-quarter", framing: "wide", follow: true },
      players: [
        { name: "host", skeleton: true, at: [-4, 1, 0], turn: 90, tall: 1.7, ends: 4, travel: 4, inFrame: 0.75, hidden: 0.11,
          does: [{ from: 0, seconds: 4, clip: "walking.glb", action: "walking", clipSeconds: 1, to: [0, 1, 0], metres: 4, speed: 1, pace: 0.92 }],
          standing: { left: -60, right: -65 },
          through: [
            { parts: ["right hand", "head"], depth: 0.107, from: 1.5, seconds: 2.25, at: 2 },
            { parts: ["left hand", "body"], depth: 0.032, from: 0.5, seconds: 0.29, at: 0.63 },
          ] },
        { name: "statue", skeleton: false, at: [0, 1.2, 0], turn: 0, tall: 2, ends: 0, travel: 0, inFrame: 0, hidden: 0, does: [], standing: null, through: [] },
      ],
      tooClose: [{ players: ["host", "statue"], from: 3.5 }],
      notes: ["the set has no light of its own: a sun was added from beside the camera"],
      engine: "BLENDER_EEVEE", blender: "5.2.1 LTS",
    };
    const lines = describeStageShot(report, [{ name: "host", at: "left", does: [{ clip: "walking", to: "0, 1" }], who: "the role host" }, { name: "statue", does: [], who: "the role statue" }], "assets/video/a.mp4", 1.24, "sets/hall.blend");
    expect(lines).toEqual([
      "✅ assets/video/a.mp4 — 4s, 1280×720 at 24 fps, 1.2MB, no sound",
      "   on the set sets/hall.blend (it has no marks); camera three-quarter, wide, on everyone, going with them",
      // Within fifteen parts in a hundred of its clip's pace, a walk is not said to slide.
      "   host (the role host), 1.7 m tall, at left: goes to 0, 1 playing walking, 4 m in 4s at its clip's pace (0.92 m/s)",
      // A body wider than the arms clear stands with them less low; a hand that brushes the body by under 5% of its height is said, not marked.
      "   host stands with its arms at -60° and -65° below the horizontal when it plays nothing: lower, a hand would pass into its body",
      "   host: its left hand brushes its body (3 cm) from 0.5s for 0.29s, deepest at 0.63s",
      "   statue (the role statue), 2 m tall, at 0, 1.2: stands (it has no skeleton)",
      "   ⚠️ host is in the picture for 75% of the shot",
      "   ⚠️ host is behind something of the set for 11% of the shot",
      "   ⚠️ host: its right hand goes into its head (11 cm) from 1.5s for 2.25s, deepest at 2s",
      "   ⚠️ statue is never in the picture",
      "   ⚠️ host and statue stand in the same place from 3.5s: one passes through the other",
      "   the set has no light of its own: a sun was added from beside the camera",
      "   look at it before it is used (pva_inspect_media): what is measured is where each body's chest is, and whether a part of a body passes into another of it. A hand through a wall or someone else, a look that misses the other's face, a light that flatters nobody are seen, not measured",
    ]);
  });
});
