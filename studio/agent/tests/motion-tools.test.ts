// ---------------------------------------------------------------------------
// pva_retarget_clip and pva_generate_motion
// ---------------------------------------------------------------------------
// The real tools against two stand-ins: a Blender that is a script (it
// "plays" a file by handing back the clip written inside it) and a stubbed
// `fetch` for fal. The arithmetic that carries a clip is real and is tested
// on its own (retarget.test.ts); the sampler is tested in a real Blender in
// packages/blender (test:live).
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HUNYUAN_MOTION, hunyuanMotion } from "@av/fal-media";
import { toMicros } from "@studio/contracts/src/budget.mjs";
import { parseJournal, JOURNAL_RELATIVE_PATH } from "@studio/contracts/src/journal.mjs";
import { motionGenerationStatus } from "../src/capability-status.js";
import { readGlb } from "../src/glb.js";
import { registerMotionTools } from "../src/motion-tools.js";
import { SMPL, about, clipOn, walkerGlb } from "./fixtures/walker.js";

const REF = { channel: "sample-channel", series: "sample-series", episode: "ep" };

interface Tool {
  name: string;
  description: string;
  execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown>; isError?: boolean }>;
}

// It hands back the clip a "motion file" holds as text, as clip-sample.py would after playing one.
const FAKE_BLENDER = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv.includes('--version')) { console.log('Blender 4.5.1'); process.exit(0); }
if (!process.argv[process.argv.indexOf('--python') + 1].endsWith('clip-sample.py')) process.exit(9);
const cfg = JSON.parse(readFileSync(process.argv.at(-1), 'utf8'));
const held = readFileSync(cfg.path, 'utf8');
if (!held.startsWith('{')) { console.log('RuntimeError: the file holds no motion: only a pose, or nothing'); process.exit(1); }
const clip = JSON.parse(held);
if (cfg.action && !clip.actions.includes(cfg.action)) { console.log('RuntimeError: the file holds no clip named ' + cfg.action + ': it holds ' + clip.actions.join(', ')); process.exit(1); }
writeFileSync(join(cfg.outputDir, 'clip.json'), JSON.stringify({ ...clip, action: cfg.action ?? clip.action }));
`;

const WAVE = { ...clipOn(SMPL, 31, { R_Shoulder: Array.from({ length: 31 }, (_, f) => about("z", -f * 3)) }), action: "Wave", actions: ["Wave", "Idle"] };

describe("motion for a rig", () => {
  let root: string;
  let dir: string;
  let tools: Tool[];
  let submitted: Record<string, unknown> | undefined;
  let answer: Record<string, unknown>;
  let asked: Record<string, unknown> | undefined;
  const saved = { library: process.env.AVG_LIBRARY_ROOT, blender: process.env.BLENDER_BIN, fal: process.env.FAL_KEY };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pva-motion-"));
    dir = join(root, REF.channel, "series", REF.series, "episodes", REF.episode);
    mkdirSync(join(dir, "journal"), { recursive: true });
    mkdirSync(join(dir, "assets", "models"), { recursive: true });
    mkdirSync(join(dir, "assets", "motion"), { recursive: true });
    writeFileSync(join(dir, "assets", "models", "guide.glb"), walkerGlb());
    writeFileSync(join(dir, "assets", "motion", "library-wave.fbx"), JSON.stringify(WAVE));
    writeFileSync(join(dir, "assets", "motion", "pose.glb"), "glTF with a pose and no motion");
    const blender = join(root, "blender.mjs");
    writeFileSync(blender, FAKE_BLENDER);
    chmodSync(blender, 0o755);
    process.env.AVG_LIBRARY_ROOT = root;
    process.env.BLENDER_BIN = blender;
    process.env.FAL_KEY = "fal-key-for-tests";
    submitted = undefined;
    answer = { fbx_file: { url: "https://cdn.example/made.fbx", file_name: "made.fbx" }, seed: 41 };
    const queue = `https://queue.fal.run/${hunyuanMotion.endpointId}`;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: unknown }) => {
      if (url === "https://fal.run/hyper3d/rigging/animations" && init?.method === "POST") {
        asked = JSON.parse(init.body as string);
        return Response.json({ animations: [
          { animation_id: "human_000089", category: "human", display_name: "walking", content_description: "Walking", duration_seconds: 1.0333, loop: { kind: "in_place" } },
          { animation_id: "human_000002", category: "human", display_name: "big jump", content_description: "Big running jump into a flip", duration_seconds: 2.3667, loop: { kind: "none" } },
          { animation_id: "canine_000004", category: "canine", display_name: "walking", content_description: "A dog walks", duration_seconds: 0.9, loop: { kind: "in_place" } },
          { display_name: "a clip with no id" },
        ] });
      }
      if (url === queue && init?.method === "POST") {
        submitted = JSON.parse(init.body as string);
        return Response.json({ request_id: "req-5", status_url: `${queue}/requests/req-5/status`, response_url: `${queue}/requests/req-5` });
      }
      if (url === `${queue}/requests/req-5/status`) return Response.json({ status: "COMPLETED" });
      if (url === `${queue}/requests/req-5`) return Response.json(answer);
      if (url === "https://cdn.example/made.fbx") return new Response(JSON.stringify(WAVE), { status: 200 });
      if (url === "https://cdn.example/empty.fbx") return new Response("an FBX with no motion in it", { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    }));
    tools = [];
    registerMotionTools({ registerTool: (tool: Tool) => tools.push(tool) } as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of [["AVG_LIBRARY_ROOT", saved.library], ["BLENDER_BIN", saved.blender], ["FAL_KEY", saved.fal]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  const run = (name: string, params: Record<string, unknown>) => tools.find((tool) => tool.name === name)!.execute("call", { ...REF, ...params }, undefined, undefined, {});
  const carry = (params: Record<string, unknown> = {}) => run("pva_retarget_clip", { rigPath: "assets/models/guide.glb", sourcePath: "assets/motion/library-wave.fbx", name: "wave", ...params });
  const generate = (params: Record<string, unknown> = {}) => run("pva_generate_motion", { rigPath: "assets/models/guide.glb", name: "greet", prompt: "A person waves hello.", ...params });
  const budget = (limitMicros: number) => writeFileSync(join(root, REF.channel, "series", REF.series, "settings.yaml"), `budget:\n  currency: USD\n  limitMicros: ${limitMicros}\n`);
  const journal = () => (existsSync(join(dir, JOURNAL_RELATIVE_PATH)) ? parseJournal(readFileSync(join(dir, JOURNAL_RELATIVE_PATH), "utf-8")) : []);
  const models = () => readdirSync(join(dir, "assets", "models")).sort();

  it("are three tools, and say which one costs", () => {
    expect(tools.map((tool) => tool.name)).toEqual(["pva_stock_clips", "pva_retarget_clip", "pva_generate_motion"]);
    expect(tools[0]!.description).toContain("free");
    expect(tools[1]!.description).toContain("Local (Blender reads the clip), free");
    expect(tools[2]!.description).toContain(`$${HUNYUAN_MOTION.priceUsd} a motion`);
    expect(motionGenerationStatus(true)["motion-generation"]).toMatchObject({ available: true });
    expect(motionGenerationStatus(false)["motion-generation"].detail).toContain("pva_retarget_clip needs no key");
  });

  describe("pva_stock_clips", () => {
    it("lists what the catalogue holds, by id, and narrows it by words", async () => {
      const all = await run("pva_stock_clips", {});
      expect(asked).toEqual({});
      expect(all.content[0]!.text.split("\n").slice(0, 4)).toEqual([
        "3 stock clips: id — what it is, seconds, ↻ when it can be repeated",
        "human_000089 — walking, 1.03s ↻",
        "human_000002 — big jump: Big running jump into a flip, 2.37s",
        "canine_000004 — walking: A dog walks, 0.9s ↻",
      ]);
      const some = await run("pva_stock_clips", { category: "human", search: "Jump flip" });
      expect(asked).toEqual({ category: "human" });
      expect(some.content[0]!.text.split("\n").slice(0, 2)).toEqual([
        '1 stock clip for a human body matching "Jump flip" (of 3): id — what it is, seconds, ↻ when it can be repeated',
        "human_000002 — big jump: Big running jump into a flip, 2.37s",
      ]);
      expect(journal()).toEqual([]);
    });
  });

  describe("pva_retarget_clip", () => {
    it("writes the rig's body with the one motion beside the rig, and says what it carried", async () => {
      const result = await carry();
      expect(models()).toEqual(["guide.clip.wave.glb", "guide.clip.wave.provenance.json", "guide.glb"]);
      const clip = readGlb(readFileSync(join(dir, "assets", "models", "guide.clip.wave.glb")))!;
      expect(clip.json.animations!.map((animation) => animation.name)).toEqual(["wave"]);
      expect(result.content[0]!.text.split("\n")).toEqual([
        "✅ assets/models/guide.clip.wave.glb — 1s, 31 frames, 21 bones carried, played on the spot",
        "   from Wave (the file also holds Idle: name one with `action`)",
        "   the clip's skeleton names its bones for the joint they start at; the rig's legs are 0.5 of the clip's, and the hips travel by as much",
        '   a motion is judged by eye: pva_rig_sheet { channel, series, episode, rigPath: "assets/models/guide.glb" } plays it over six moments. Feet that slide, a hand through the body and a limb bent the wrong way are not measured',
      ]);
      const provenance = JSON.parse(readFileSync(join(dir, "assets", "models", "guide.clip.wave.provenance.json"), "utf8"));
      expect(provenance).toMatchObject({ version: 1, tool: "pva_retarget_clip", clip: "guide.clip.wave.glb", rig: "guide.glb", source: "library-wave.fbx", action: "Wave", faces: "+z", sourceFaces: "+z", report: { frames: 31 } });
      for (const key of ["clipSha256", "rigSha256", "sourceSha256"]) expect(provenance[key]).toMatch(/^[0-9a-f]{64}$/);
      expect(journal()).toEqual([]);
    });

    it("takes a clip by name, a body that stays where it stands, and a map", async () => {
      const result = await carry({ action: "Idle", inPlace: true, map: { Head: "Head" } });
      expect(result.content[0]!.text).toContain("from Idle (the file also holds Wave");
      expect(JSON.parse(readFileSync(join(dir, "assets", "models", "guide.clip.wave.provenance.json"), "utf8"))).toMatchObject({ action: "Idle", inPlace: true, map: { Head: "Head" } });
    });

    it("does not write over a clip unless told to, and refuses what it cannot carry", async () => {
      await carry();
      await expect(carry()).rejects.toThrow("the rig already has a clip named wave: pick another name, or pass overwrite: true");
      await carry({ overwrite: true });
      await expect(carry({ name: "../x" })).rejects.toThrow("name must contain only letters");
      await expect(carry({ name: "b", sourcePath: "assets/motion/none.fbx" })).rejects.toThrow("Source not found: assets/motion/none.fbx");
      await expect(carry({ name: "b", rigPath: "assets/motion/library-wave.fbx" })).rejects.toThrow("Rig must be a binary glTF (.glb)");
      await expect(carry({ name: "b", sourcePath: "assets/motion/pose.glb" })).rejects.toThrow("the file holds no motion: only a pose, or nothing");
      await expect(carry({ name: "b", action: "Run" })).rejects.toThrow("the file holds no clip named Run: it holds Wave, Idle");
      expect(models()).toEqual(["guide.clip.wave.glb", "guide.clip.wave.provenance.json", "guide.glb"]);
    });
  });

  describe("pva_generate_motion", () => {
    it("asks for the motion on the episode's budget, keeps it, and puts it on the rig", async () => {
      budget(1_000_000);
      const result = await generate({ seconds: 4, seed: 41, guidance: 6 });
      expect(submitted).toEqual({ prompt: "A person waves hello.", duration: 4, seed: 41, guidance_scale: 6, output_format: "fbx" });
      expect(readdirSync(join(dir, "assets", "motion")).sort()).toEqual(["greet.fbx", "greet.provenance.json", "library-wave.fbx", "pose.glb"]);
      expect(models()).toEqual(["guide.clip.greet.glb", "guide.clip.greet.provenance.json", "guide.glb"]);
      const lines = result.content[0]!.text.split("\n");
      expect(lines[0]).toBe("✅ assets/models/guide.clip.greet.glb — 1s, 31 frames, 21 bones carried, played on the spot");
      expect(lines.at(-1)).toBe(`   the motion as it came: assets/motion/greet.fbx — 0.0MB, Hunyuan Motion, seed 41, ~$${HUNYUAN_MOTION.priceUsd}`);
      expect(JSON.parse(readFileSync(join(dir, "assets", "motion", "greet.provenance.json"), "utf8"))).toMatchObject({
        file: "greet.fbx", provider: "fal.ai", endpointId: hunyuanMotion.endpointId, providerRequestId: "req-5", prompt: "A person waves hello.", seconds: 4, seed: 41, guidance: 6,
        estimatedCost: { amount: HUNYUAN_MOTION.priceUsd, currency: "USD" },
      });
      expect(JSON.parse(readFileSync(join(dir, "assets", "models", "guide.clip.greet.provenance.json"), "utf8"))).toMatchObject({ tool: "pva_generate_motion", generation: { prompt: "A person waves hello.", seed: 41 } });
      expect(journal().map((event) => event.type)).toEqual(["spend-reserved", "spend-settled"]);
      expect(journal()[0]!.data).toMatchObject({ capability: "motion.generate", provider: "fal", profile: hunyuanMotion.profileId, purpose: "motion greet", estimate: { currency: "USD", micros: toMicros(HUNYUAN_MOTION.priceUsd) } });
    });

    it("keeps a motion it paid for and could not carry, and says how to carry it later", async () => {
      budget(1_000_000);
      answer = { fbx_file: { url: "https://cdn.example/empty.fbx" }, seed: 3 };
      const result = await generate();
      expect(result.isError).toBe(true);
      const lines = result.content[0]!.text.split("\n");
      expect(lines[0]).toBe(`⚠️ assets/motion/greet.fbx — 0.0MB, Hunyuan Motion, seed 3, ~$${HUNYUAN_MOTION.priceUsd}`);
      expect(lines[1]).toBe("   it was made and paid for, and could not be put on the rig: the file holds no motion: only a pose, or nothing");
      expect(lines[2]).toContain('pva_retarget_clip { channel, series, episode, rigPath: "assets/models/guide.glb", sourcePath: "assets/motion/greet.fbx", name: "greet" }');
      expect(existsSync(join(dir, "assets", "motion", "greet.fbx"))).toBe(true);
      expect(journal().map((event) => event.type)).toEqual(["spend-reserved", "spend-settled"]);
    });

    it("spends nothing on what it would refuse, or cannot afford", async () => {
      await expect(generate({ rigPath: "assets/models/none.glb" })).rejects.toThrow("Rig not found");
      await expect(generate({ name: "bad name" })).rejects.toThrow("name must contain only letters");
      writeFileSync(join(dir, "assets", "motion", "greet.fbx"), "an earlier take");
      await expect(generate()).rejects.toThrow("assets/motion/greet.fbx already exists");
      expect(submitted).toBeUndefined();
      expect(journal()).toEqual([]);
      budget(10_000);
      await expect(generate({ name: "second" })).rejects.toThrow();
      expect(submitted).toBeUndefined();
    });
  });
});
