// ---------------------------------------------------------------------------
// pva_comfyui_workflows and pva_comfyui_run
// ---------------------------------------------------------------------------
// The real tools against a stubbed `fetch` standing in for a ComfyUI server:
// nothing leaves the machine. The music it "makes" is a real FLAC, made here
// with FFmpeg, so that its length can be read back.
// ---------------------------------------------------------------------------

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comfyUiWorkflowsStatus, listGeneratedMusic } from "../src/comfyui-workflows.js";

const REF = { channel: "sample-channel", series: "sample-series", episode: "ep" };
const URL_BASE = "http://comfy.test:8188";

type Tool = { name: string; description: string; parameters: unknown; execute: (...a: unknown[]) => Promise<any> };
let root: string;
let dir: string;
let flac: Buffer;
let queued: Record<string, { class_type: string; inputs: Record<string, unknown> }>[];
let uploads: { name: string; subfolder: string; bytes: Buffer }[];
let paths: string[];
let missing: Set<string>;
let models: Record<string, Record<string, string[]>>;
const saved: Record<string, string | undefined> = {};
const ENV = ["AVG_LIBRARY_ROOT", "AVG_COMFYUI_URL", "AVG_COMFYUI_CONFIG"];

beforeAll(async () => {
  const work = mkdtempSync(join(tmpdir(), "pva-comfy-wf-flac-"));
  const out = join(work, "two-seconds.flac");
  const made = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=2", "-ac", "2", out], { windowsHide: true });
  if (made.status !== 0) throw new Error("these tests need ffmpeg on PATH");
  flac = readFileSync(out);
  rmSync(work, { recursive: true, force: true });
  await import("../src/comfyui-workflows.js");
  await import("../src/music-tools.js");
}, 60_000);

async function tools(): Promise<Map<string, Tool>> {
  const { registerComfyUiWorkflowTools } = await import("../src/comfyui-workflows.js");
  const { registerMusicTools } = await import("../src/music-tools.js");
  const map = new Map<string, Tool>();
  const pi = { registerTool: (t: Tool) => map.set(t.name, t) } as never;
  registerComfyUiWorkflowTools(pi);
  registerMusicTools(pi);
  return map;
}
/** A tool's answer, or its error: the tools throw, as Pi expects. */
async function call(name: string, params: Record<string, unknown>): Promise<{ text: string; details?: any; error?: boolean }> {
  try {
    const r = await (await tools()).get(name)!.execute("call-1", params, undefined, undefined, undefined);
    return { text: r.content[0].text, details: r.details, error: Boolean(r.isError) };
  } catch (e) {
    return { text: e instanceof Error ? e.message : String(e), error: true };
  }
}
const runIn = (params: Record<string, unknown>) => call("pva_comfyui_run", { ...REF, ...params });
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const json = (path: string) => JSON.parse(readFileSync(path, "utf-8"));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pva-comfy-wf-"));
  dir = join(root, REF.channel, "series", REF.series, "episodes", REF.episode);
  mkdirSync(join(dir, "journal"), { recursive: true });
  for (const name of ENV) saved[name] = process.env[name];
  process.env.AVG_LIBRARY_ROOT = root;
  process.env.AVG_COMFYUI_URL = URL_BASE;
  delete process.env.AVG_COMFYUI_CONFIG;
  queued = [];
  uploads = [];
  paths = [];
  missing = new Set();
  models = {
    UNETLoader: { unet_name: ["z_image_turbo_bf16.safetensors", "wan2.2_ti2v_5B_fp16.safetensors"] },
    CLIPLoader: { clip_name: ["qwen_3_4b.safetensors", "umt5_xxl_fp16.safetensors"] },
    VAELoader: { vae_name: ["z_image_ae.safetensors", "wan2.2_vae.safetensors"] },
    CheckpointLoaderSimple: { ckpt_name: ["ace_step_v1_3.5b.safetensors"] },
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== URL_BASE) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const path = url.pathname;
    paths.push(path);
    if (path === "/system_stats") return Response.json({ system: { comfyui_version: "9.9.9" }, devices: [{ name: "cuda:0 Test GPU" }] });
    if (path.startsWith("/object_info/")) {
      const cls = decodeURIComponent(path.slice("/object_info/".length));
      if (missing.has(cls)) return Response.json({});
      const required = Object.fromEntries(Object.entries(models[cls] ?? {}).map(([k, files]) => [k, ["COMBO", { options: files }]]));
      return Response.json({ [cls]: { input: { required } } });
    }
    if (path === "/upload/image") {
      const form = init!.body as FormData;
      const file = form.get("image") as File;
      const subfolder = String(form.get("subfolder") ?? "");
      uploads.push({ name: file.name, subfolder, bytes: Buffer.from(await file.arrayBuffer()) });
      return Response.json({ name: file.name, subfolder, type: "input" });
    }
    if (path === "/prompt") {
      queued.push((JSON.parse(String(init!.body)) as { prompt: typeof queued[number] }).prompt);
      return Response.json({ prompt_id: `p${queued.length}` });
    }
    if (path.startsWith("/history/")) {
      const id = path.slice("/history/".length);
      const outputs: Record<string, unknown> = {};
      for (const [nodeId, node] of Object.entries(queued[Number(id.slice(1)) - 1]!)) {
        const prefix = String(node.inputs.filename_prefix ?? "");
        const cut = prefix.lastIndexOf("/");
        const file = (ext: string) => ({ filename: `${prefix.slice(cut + 1)}_00001_.${ext}`, subfolder: prefix.slice(0, cut), type: "output" });
        if (node.class_type === "SaveImage") outputs[nodeId] = { images: [file("png")] };
        if (node.class_type === "SaveVideo") outputs[nodeId] = { images: [file("mp4")], animated: [true] };
        if (node.class_type === "SaveAudio") outputs[nodeId] = { audio: [file("flac")] };
      }
      const messages = [["execution_start", { prompt_id: id, timestamp: 1_700_000_000_000 }], ["execution_success", { prompt_id: id, timestamp: 1_700_000_042_500 }]];
      return Response.json({ [id]: { status: { status_str: "success", completed: true, messages }, outputs } });
    }
    if (path === "/view") {
      const name = url.searchParams.get("filename")!;
      return new Response(name.endsWith(".flac") ? flac : Buffer.from(`pixels of ${name}`));
    }
    if (path === "/queue") return Response.json({});
    return Response.json({}, { status: 404 });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

/** A workflow of the operator's: one text input, one saved image, the z-image models. */
const operatorWorkflow = (description: string) => ({
  description,
  kind: "image",
  inputs: { prompt: { type: "text" }, seed: { type: "seed" } },
  outputs: { "9": "image" },
  requires: { models: [{ node: "1", input: "unet_name", folder: "diffusion_models" }] },
  prompt: {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "z_image_turbo_bf16.safetensors", weight_dtype: "default" } },
    "3": { class_type: "KSampler", inputs: { model: ["1", 0], seed: "{{seed}}", text: "{{prompt}}" } },
    "9": { class_type: "SaveImage", inputs: { images: ["3", 0], filename_prefix: "{{outputPrefix}}" } },
  },
});

describe("pva_comfyui_workflows", () => {
  it("lists the built-in workflows with whether the server has their nodes and models", async () => {
    missing.add("Wan22ImageToVideoLatent");
    const r = await call("pva_comfyui_workflows", {});
    expect(r.error).toBe(false);
    expect(r.text).toContain("server: ComfyUI 9.9.9 (cuda:0 Test GPU)");
    expect(r.text).toMatch(/- z-image-turbo \(image, built-in\): .*server: ✅ runnable/);
    expect(r.text).toMatch(/- wan22-ti2v-5b \(video, built-in\): .*❌ missing nodes Wan22ImageToVideoLatent/);
    expect(r.text).toMatch(/- flux2-klein-edit .*missing models flux-2-klein-4b\.safetensors \(models\/diffusion_models; input unetModel; the loader has z_image_turbo_bf16\.safetensors, wan2\.2_ti2v_5B_fp16\.safetensors\)/);
    expect(r.text).toMatch(/- wan22-ti2v-5b .*never run on a real server yet/);
    expect(r.text).not.toMatch(/- z-image-turbo .*never run/);
    expect(r.text).not.toContain(URL_BASE);
    expect(queued).toHaveLength(0);
    expect(r.details.workflows.map((w: { name: string }) => w.name)).toEqual(["ace-step-v1-music", "flux2-klein-edit", "wan22-ti2v-5b", "z-image-turbo"]);
  });

  it("adds the operator's and a channel's own, a later one hiding an earlier one, and shows one in full", async () => {
    mkdirSync(join(root, ".render", "comfyui", "workflows"), { recursive: true });
    mkdirSync(join(root, REF.channel, "comfyui", "workflows"), { recursive: true });
    writeFileSync(join(root, ".render", "comfyui", "workflows", "portrait.json"), JSON.stringify(operatorWorkflow("The operator's portrait.")));
    writeFileSync(join(root, REF.channel, "comfyui", "workflows", "portrait.json"), JSON.stringify(operatorWorkflow("The channel's portrait.")));
    writeFileSync(join(root, ".render", "comfyui", "workflows", "ui-export.json"), JSON.stringify({ nodes: [], links: [] }));
    const library = await call("pva_comfyui_workflows", { probe: false });
    expect(library.text).toContain("- portrait (image, library): The operator's portrait.");
    expect(library.text).toMatch(/- ui-export \(library\): ❌ unusable — .*description/);
    const channel = await call("pva_comfyui_workflows", { channel: REF.channel, workflow: "portrait" });
    expect(channel.text).toContain(`- portrait (image, ${REF.channel}, hides library's): The channel's portrait.`);
    expect(channel.text).toContain("    - prompt: text");
    expect(channel.text).toContain("    - z_image_turbo_bf16.safetensors (models/diffusion_models)");
    expect(channel.text).toContain("node 1 names its file in the graph");
    expect((await call("pva_comfyui_workflows", { workflow: "nothing" })).text).toContain('there is no workflow "nothing"');
  });

  it("says why the server was not asked", async () => {
    delete process.env.AVG_COMFYUI_URL;
    const r = await call("pva_comfyui_workflows", {});
    expect(r.text).toContain("server: not asked: AVG_COMFYUI_URL is not set");
    expect(r.text).toContain("- z-image-turbo (image, built-in)");
  });
});

describe("pva_comfyui_run", () => {
  it("makes an episode's picture under assets/images/ with its receipt, and logs the GPU time", async () => {
    const r = await runIn({ workflow: "z-image-turbo", name: "s1", inputs: { prompt: "a lighthouse at dusk", seed: 42, width: 1280 } });
    expect(r.error, r.text).toBe(false);
    expect(r.text).toContain("✅ z-image-turbo on ComfyUI 9.9.9, seed 42, 42.5 s on the server, $0");
    expect(r.text).toContain("assets/images/s1.png");
    expect(queued[0]!["13"]!.inputs).toMatchObject({ width: 1280, height: 1024 });
    const image = readFileSync(join(dir, "assets/images/s1.png"));
    const receipt = json(join(dir, "assets/images/s1.png.comfyui.json"));
    expect(receipt).toMatchObject({
      provider: "comfyui",
      workflow: { name: "z-image-turbo", kind: "image", origin: "built-in", file: "built-in:z-image-turbo", graphSha256: sha(JSON.stringify(queued[0])), verifiedOn: "ComfyUI 0.45.0, RX 7900 XTX (ROCm), 2026-11-20" },
      promptId: "p1",
      server: { version: "9.9.9", devices: ["cuda:0 Test GPU"] },
      inputs: { prompt: "a lighthouse at dusk", seed: 42, width: 1280, height: 1024, steps: 9 },
      seeds: { seed: 42 },
      runtimeVerified: false,
      cost: { amount: 0, currency: "USD" },
      gpu: { executionSeconds: 42.5 },
      output: { node: "9", role: "image", path: "assets/images/s1.png", sha256: sha(image), bytes: image.length },
    });
    expect(receipt.workflow.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.models.map((m: { file: string }) => m.file)).toEqual(["z_image_turbo_bf16.safetensors", "qwen_3_4b.safetensors", "z_image_ae.safetensors"]);
    expect(receipt.inputs).toMatchObject({ vae: "z_image_ae.safetensors", unetModel: "z_image_turbo_bf16.safetensors" });
    expect(receipt.libraryDefaults).toBeUndefined();
    expect(JSON.stringify(receipt)).not.toContain("comfy.test");
    const journal = readFileSync(join(dir, "journal", "events.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(journal.at(-1)).toMatchObject({ type: "artifact-written", data: { provider: "comfyui", workflow: "z-image-turbo", paths: ["assets/images/s1.png"], gpuSeconds: 42.5, cost: { amount: 0 } } });
  });

  it("takes the library's defaults for its server, so a model named otherwise needs no copy of the workflow", async () => {
    models.VAELoader!.vae_name = ["ae.safetensors", "sdxl_vae_fp16_fix.safetensors"];
    const before = await call("pva_comfyui_workflows", { workflow: "z-image-turbo" });
    expect(before.text).toContain("missing models z_image_ae.safetensors (models/vae; input vae; the loader has ae.safetensors, sdxl_vae_fp16_fix.safetensors)");
    expect(before.text).toMatch(/    - vae = z_image_ae\.safetensors \(models\/vae\) from .*; the server's VAELoader has ae\.safetensors, sdxl_vae_fp16_fix\.safetensors/);
    mkdirSync(join(root, ".render"), { recursive: true });
    writeFileSync(join(root, ".render", "comfyui.json"), JSON.stringify({ workflowDefaults: { "z-image-turbo": { vae: "ae.safetensors" } } }));
    const after = await call("pva_comfyui_workflows", { workflow: "z-image-turbo" });
    expect(after.text).toContain("server: ✅ runnable");
    expect(after.text).toContain("defaults from the library's .render/comfyui.json: vae");
    const r = await runIn({ workflow: "z-image-turbo", name: "s1", inputs: { prompt: "x" } });
    expect(r.error, r.text).toBe(false);
    expect(queued[0]!["17"]!.inputs.vae_name).toBe("ae.safetensors");
    expect(json(join(dir, "assets/images/s1.png.comfyui.json"))).toMatchObject({ inputs: { vae: "ae.safetensors" }, libraryDefaults: ["vae"] });
    // a default that does not fit its input makes the workflow unusable, and says why
    writeFileSync(join(root, ".render", "comfyui.json"), JSON.stringify({ workflowDefaults: { "z-image-turbo": { steps: 500 } } }));
    expect((await call("pva_comfyui_workflows", { probe: false })).text).toMatch(/- z-image-turbo \(built-in\): ❌ unusable — .*workflowDefaults: steps: at most 50/);
  });

  it("clears what a crashed run half-wrote, rather than refuse the name", async () => {
    mkdirSync(join(dir, "assets/images"), { recursive: true });
    writeFileSync(join(dir, "assets/images/s1.png.tmp"), "half a picture");
    const r = await runIn({ workflow: "z-image-turbo", name: "s1", inputs: { prompt: "x" } });
    expect(r.error, r.text).toBe(false);
    expect(existsSync(join(dir, "assets/images/s1.png.tmp"))).toBe(false);
    expect(readFileSync(join(dir, "assets/images/s1.png"), "utf-8")).toContain("pixels of");
  });

  it("never writes over a file, and says so before the server is asked", async () => {
    mkdirSync(join(dir, "assets/images"), { recursive: true });
    writeFileSync(join(dir, "assets/images/s1.png"), "an earlier picture");
    const r = await runIn({ workflow: "z-image-turbo", name: "s1", inputs: { prompt: "x" } });
    expect(r.text).toContain("assets/images/s1.png already exists");
    expect(paths).toEqual([]);
  });

  it("refuses before uploading or queueing when the server lacks a model, and checks the values first", async () => {
    models.UNETLoader!.unet_name = [];
    expect((await runIn({ workflow: "z-image-turbo", name: "s1", inputs: { prompt: "x" } })).text).toContain("missing models z_image_turbo_bf16.safetensors (models/diffusion_models; input unetModel; the loader has none)");
    expect((await runIn({ workflow: "z-image-turbo", name: "s1", inputs: { prompt: "x", steps: 500 } })).text).toContain("steps: at most 50");
    expect((await runIn({ workflow: "z-image-turbo", name: "s1", inputs: { promt: "x" } })).text).toContain("takes no promt");
    expect((await runIn({ workflow: "z-image-turbo", name: "../s1", inputs: { prompt: "x" } })).text).toContain('name "../s1"');
    expect(paths.filter((p) => p === "/prompt" || p === "/upload/image")).toEqual([]);
  });

  it("animates a shot's still with Wan 2.2, uploading the workspace file under its hash, into the shot's assets", async () => {
    const { registerFilmTools } = await import("../src/film-tools.js");
    const film = new Map<string, any>();
    registerFilmTools({ registerTool: (tool: { name: string }) => film.set(tool.name, tool) } as never);
    const make = (name: string, params: Record<string, unknown>) => film.get(name).execute("create", params);
    await make("pva_create_film", { slug: "sample-film", title: "A sample film", format: "hd-24" });
    await make("pva_create_scene", { film: "sample-film", slug: "010-scene", title: "A scene" });
    await make("pva_create_shot", { film: "sample-film", scene: "010-scene", slug: "010-shot", title: "A shot", source: "generated", durationSeconds: 5 });
    const shot = join(root, "sample-film", "scenes", "010-scene", "shots", "010-shot");
    const still = Buffer.from("the shot's first frame");
    mkdirSync(join(shot, "assets/images"), { recursive: true });
    writeFileSync(join(shot, "assets/images/Their Still.png"), still);
    const where = { channel: "sample-film", series: "010-scene", episode: "010-shot" };
    const r = await call("pva_comfyui_run", { ...where, workflow: "wan22-ti2v-5b", name: "take-1", inputs: { prompt: "the tide comes in", image: "assets/images/Their Still.png", length: 49 } });
    expect(r.error, r.text).toBe(false);
    expect(uploads).toEqual([{ name: `${sha(still).slice(0, 32)}.png`, subfolder: "studio-workflows", bytes: still }]);
    expect(queued[0]!["56"]!.inputs.image).toBe(`studio-workflows/${sha(still).slice(0, 32)}.png`);
    expect(JSON.stringify(queued[0])).not.toContain("Their Still");
    expect(existsSync(join(shot, "assets/video/comfyui/take-1.mp4"))).toBe(true);
    const receipt = json(join(shot, "assets/video/comfyui/take-1.mp4.comfyui.json"));
    expect(receipt.files).toEqual({ image: { path: "assets/images/Their Still.png", sha256: sha(still), uploadedAs: `studio-workflows/${sha(still).slice(0, 32)}.png` } });
    expect(receipt.inputs).not.toHaveProperty("image");
    expect(Object.keys(receipt.seeds)).toEqual(["seed"]);
    expect(r.text).toContain("pva_edit_cut");
    // a file outside the workspace is refused
    expect((await call("pva_comfyui_run", { ...where, workflow: "wan22-ti2v-5b", name: "take-2", inputs: { prompt: "x", image: "../../../outside.png" } })).error).toBe(true);
  });

  it("generates music into music/, which pva_music lists beside the pieces written as code", async () => {
    const r = await runIn({ workflow: "ace-step-v1-music", name: "theme", inputs: { tags: "solo cello, slow, 60 bpm", seconds: 2, seed: 9 } });
    expect(r.error, r.text).toBe(false);
    expect(readFileSync(join(dir, "music/theme.flac"))).toEqual(flac);
    const receipt = json(join(dir, "music/theme.flac.comfyui.json"));
    expect(receipt.workflow.kind).toBe("music");
    expect(receipt.inputs).toMatchObject({ tags: "solo cello, slow, 60 bpm", lyrics: "[inst]", seconds: 2 });
    expect(receipt.output.durationSeconds).toBeCloseTo(2, 1);
    expect(r.text).toContain("music track");
    const listed = await call("pva_music", REF);
    expect(listed.text).toContain("- generated (ComfyUI):");
    expect(listed.text).toMatch(/music\/theme\.flac: ace-step-v1-music, seed 9, 2(\.\d+)? s → music\/theme\.flac\.comfyui\.json/);
    writeFileSync(join(dir, "music/theme.flac"), "replaced");
    expect(listGeneratedMusic(dir)[0]!.missing).toBe(true);
  });

  it("runs an operator's workflow, and the receipt says where its file is", async () => {
    mkdirSync(join(root, REF.channel, "comfyui", "workflows"), { recursive: true });
    writeFileSync(join(root, REF.channel, "comfyui", "workflows", "portrait.json"), JSON.stringify(operatorWorkflow("A portrait.")));
    const r = await runIn({ workflow: "portrait", name: "p1", inputs: { prompt: "a face" } });
    expect(r.error, r.text).toBe(false);
    expect(json(join(dir, "assets/images/p1.png.comfyui.json")).workflow).toMatchObject({ name: "portrait", origin: REF.channel, file: `${REF.channel}/comfyui/workflows/portrait.json` });
  });

  it("says the tunnel may be closed when nothing answers", async () => {
    process.env.AVG_COMFYUI_URL = "http://127.0.0.1:9";
    const r = await runIn({ workflow: "z-image-turbo", name: "s1", inputs: { prompt: "x" } });
    expect(r.text).toContain("no answer from ComfyUI at http://127.0.0.1:9");
    expect(r.text).toContain("tunnel");
  });
});

describe("the ComfyUI workflows in pva_capability_status", () => {
  it("say which the server can run", async () => {
    missing.add("TextEncodeAceStepAudio");
    const status = await comfyUiWorkflowsStatus(root);
    expect(status.available).toBe(true);
    expect(status.detail).toContain("ComfyUI 9.9.9 at http://comfy.test:8188: pva_comfyui_run, $0; runnable wan22-ti2v-5b, z-image-turbo");
    expect(status.detail).toContain("ace-step-v1-music (missing nodes TextEncodeAceStepAudio)");
    delete process.env.AVG_COMFYUI_URL;
    expect((await comfyUiWorkflowsStatus(root)).available).toBe(false);
  });
});
