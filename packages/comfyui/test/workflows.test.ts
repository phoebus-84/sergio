// Declared workflows against a faked fetch standing in for a ComfyUI server:
// what a declaration must say, what the probe reads from /object_info, and a
// run from values to downloaded files. Nothing leaves the machine.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUILT_IN, checkWorkflow, ComfyUiError, createComfyUiClient, describeProbe, executionSecondsOf, listWorkflows, probeWorkflow,
  readWorkflowFile, requiredNodes, resolveValues, runWorkflow, type ComfyUiClient, type ComfyUiPrompt, type DeclaredWorkflow,
} from "../src/index.js";

const BASE = "http://comfy.test:8188";

interface Fake {
  fetch: typeof fetch;
  calls: { method: string; path: string; body?: unknown; form?: FormData }[];
  queued: ComfyUiPrompt[];
  missing: Set<string>;
  /** Model files each loader class lists, by its input. */
  models: Record<string, Record<string, string[]>>;
  /** Newer ComfyUI describes a COMBO as ["COMBO", { options }]. */
  comboStyle: "old" | "new";
  neverFinishes: boolean;
  timestamps: boolean;
}

function fake(): Fake {
  const f: Fake = {
    calls: [], queued: [], missing: new Set(), comboStyle: "new", neverFinishes: false, timestamps: true, fetch: undefined as unknown as typeof fetch,
    models: {
      UNETLoader: { unet_name: ["z_image_turbo_bf16.safetensors", "wan2.2_ti2v_5B_fp16.safetensors"] },
      CLIPLoader: { clip_name: ["qwen_3_4b.safetensors", "umt5_xxl_fp8_e4m3fn_scaled.safetensors"] },
      VAELoader: { vae_name: ["ae.safetensors", "wan2.2_vae.safetensors"] },
    },
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  f.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname;
    const call: Fake["calls"][number] = { method, path: path + url.search };
    if (typeof init?.body === "string") call.body = JSON.parse(init.body);
    if (init?.body instanceof FormData) call.form = init.body;
    f.calls.push(call);
    if (path === "/system_stats") return json({ system: { comfyui_version: "9.9.9" }, devices: [{ name: "cuda:0 Test GPU" }] });
    if (path.startsWith("/object_info/")) {
      const cls = decodeURIComponent(path.slice("/object_info/".length));
      if (f.missing.has(cls)) return json({});
      const required = Object.fromEntries(Object.entries(f.models[cls] ?? {}).map(([input, files]) => [input, f.comboStyle === "old" ? [files, {}] : ["COMBO", { options: files }]]));
      return json({ [cls]: { input: { required } } });
    }
    if (path === "/prompt") {
      f.queued.push((call.body as { prompt: ComfyUiPrompt }).prompt);
      return json({ prompt_id: `p${f.queued.length}`, number: 1, node_errors: {} });
    }
    if (path.startsWith("/history/")) {
      const id = path.slice("/history/".length);
      if (f.neverFinishes) return json({});
      const prompt = f.queued[Number(id.slice(1)) - 1]!;
      const outputs: Record<string, unknown> = {};
      for (const [nodeId, node] of Object.entries(prompt)) {
        const prefix = String(node.inputs.filename_prefix ?? "");
        const cut = prefix.lastIndexOf("/");
        const file = (ext: string) => ({ filename: `${prefix.slice(cut + 1)}_00001_.${ext}`, subfolder: prefix.slice(0, cut), type: "output" });
        if (node.class_type === "SaveImage") outputs[nodeId] = { images: [file("png"), { ...file("png"), filename: `${prefix.slice(cut + 1)}_00002_.png` }] };
        if (node.class_type === "SaveVideo") outputs[nodeId] = { images: [file("mp4")], animated: [true] };
        if (node.class_type === "SaveAudio") outputs[nodeId] = { audio: [file("flac")] };
      }
      const messages = f.timestamps
        ? [["execution_start", { prompt_id: id, timestamp: 1_700_000_000_000 }], ["execution_cached", { nodes: [] }], ["execution_success", { prompt_id: id, timestamp: 1_700_000_012_345 }]]
        : [["execution_start", { prompt_id: id }]];
      return json({ [id]: { status: { status_str: "success", completed: true, messages }, outputs } });
    }
    if (path === "/upload/image") {
      const form = init!.body as FormData;
      const file = form.get("image") as File;
      return json({ name: file.name, subfolder: String(form.get("subfolder") ?? ""), type: "input" });
    }
    if (path === "/view") return new Response(Buffer.from(`bytes of ${url.searchParams.get("filename")}`), { status: 200 });
    if (path === "/queue") return json({});
    return json({ error: "no such route" }, 404);
  }) as typeof fetch;
  return f;
}

let f: Fake;
let client: ComfyUiClient;
beforeEach(() => {
  f = fake();
  client = createComfyUiClient({ baseUrl: BASE, fetch: f.fetch, sleep: async () => undefined });
});
const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error("expected a failure"); }, (e: unknown) => e as ComfyUiError);
const builtIn = (name: string) => listWorkflows([]).find((e) => e.name === name)!.workflow!;

/** A small declared workflow: a prompt, an optional start image, one saved image. */
const tiny = (): DeclaredWorkflow => ({
  description: "a test graph",
  kind: "image",
  inputs: {
    prompt: { type: "text" },
    steps: { type: "integer", default: 4, min: 1, max: 10 },
    seed: { type: "seed" },
    start: { type: "image", optional: true },
  },
  outputs: { "9": "image" },
  optionalNodes: { start: "2" },
  requires: { models: [{ node: "1", input: "unet_name", folder: "diffusion_models" }] },
  prompt: {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "z_image_turbo_bf16.safetensors", weight_dtype: "default" } },
    "2": { class_type: "LoadImage", inputs: { image: "{{start}}" } },
    "3": { class_type: "KSampler", inputs: { model: ["1", 0], seed: "{{seed}}", steps: "{{steps}}", text: "{{prompt}}", image: ["2", 0] } },
    "9": { class_type: "SaveImage", inputs: { images: ["3", 0], filename_prefix: "{{outputPrefix}}" } },
  },
});

describe("a declaration", () => {
  it("is checked: placeholders and inputs match, outputs and models name nodes the graph has", () => {
    expect(checkWorkflow(tiny())).toEqual([]);
    const w = tiny();
    w.inputs.extra = { type: "string" };
    delete (w.inputs as Record<string, unknown>).steps;
    w.outputs["99"] = "video";
    w.requires!.models!.push({ node: "1", input: "ckpt_name" });
    const messages = checkWorkflow(w).map((p) => p.message);
    expect(messages).toEqual(expect.arrayContaining([
      "the graph's {{steps}} is not declared under inputs",
      "inputs.extra is declared, and no {{extra}} in the graph reads it",
      "outputs.99: the graph has no node 99",
      "requires.models[1]: node 1 (UNETLoader) has no input ckpt_name",
    ]));
  });

  it("refuses the UI format, a file with a default and an optional input nothing leaves out", () => {
    expect(checkWorkflow({ description: "x", kind: "image", nodes: [], links: [] })[0]!.message).toMatch(/API format/);
    const w = tiny();
    w.inputs.start = { type: "image", default: "a.png" };
    w.inputs.steps = { type: "integer", optional: true };
    const messages = checkWorkflow(w).map((p) => p.message);
    expect(messages).toContain("inputs.start: a image has no default");
    expect(messages).toContain("inputs.steps: optional, but no optionalNodes or bypassNodes entry is named after it");
  });

  it("warns when an output node does not save under the runner's prefix", () => {
    const w = tiny();
    w.prompt["9"]!.inputs.filename_prefix = "ComfyUI";
    expect(checkWorkflow(w)).toEqual([{ level: "warning", message: "outputs.9: its filename_prefix is not {{outputPrefix}}, so runs share file names on the server" }]);
  });
});

describe("the built-in workflows", () => {
  it("are all valid, and declare their models", () => {
    const entries = listWorkflows([]);
    expect(entries.map((e) => e.name)).toEqual(["ace-step-music", "flux2-klein-edit", "wan22-ti2v-5b", "z-image-turbo"]);
    for (const e of entries) {
      expect(e.problems).toEqual([]);
      expect(e.origin).toBe(BUILT_IN);
      expect(e.workflow!.requires!.models!.length).toBeGreaterThan(0);
      // never run against a real server from here: they say so by having no verifiedOn
      expect(e.workflow!.verifiedOn).toBeUndefined();
    }
    expect(Object.fromEntries(entries.map((e) => [e.name, e.workflow!.kind]))).toEqual({
      "ace-step-music": "music", "flux2-klein-edit": "image-edit", "wan22-ti2v-5b": "video", "z-image-turbo": "image",
    });
  });

  it("are hidden by an operator's workflow of the same name, which says what it hides", () => {
    const dir = mkdtempSync(join(tmpdir(), "comfyui-workflows-"));
    try {
      writeFileSync(join(dir, "z-image-turbo.json"), JSON.stringify(tiny()));
      writeFileSync(join(dir, "Bad Name.json"), JSON.stringify(tiny()));
      writeFileSync(join(dir, "broken.json"), "{");
      const entries = listWorkflows([{ dir, origin: "library" }]);
      const mine = entries.find((e) => e.name === "z-image-turbo")!;
      expect(mine.origin).toBe("library");
      expect(mine.shadows?.origin).toBe(BUILT_IN);
      expect(mine.sha256).toBe(createHash("sha256").update(JSON.stringify(tiny())).digest("hex"));
      expect(entries.find((e) => e.name === "broken")!.problems[0]!.message).toMatch(/not JSON/);
      expect(entries.find((e) => e.name === "Bad Name")!.workflow).toBeUndefined();
      expect(listWorkflows([{ dir: join(dir, "none"), origin: "x" }], { builtIn: false })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the probe", () => {
  it("reads the node classes and whether each loader lists the model, old and new COMBO alike", async () => {
    const probe = await probeWorkflow(client, builtIn("z-image-turbo"));
    expect(probe).toMatchObject({ runnable: true, missingNodes: [] });
    expect(probe.models.map((m) => [m.file, m.status])).toEqual([
      ["z_image_turbo_bf16.safetensors", "present"], ["qwen_3_4b.safetensors", "present"], ["ae.safetensors", "present"],
    ]);
    f.comboStyle = "old";
    f.models.VAELoader!.vae_name = ["other.safetensors"];
    const missing = await probeWorkflow(client, builtIn("z-image-turbo"));
    expect(missing.runnable).toBe(false);
    expect(describeProbe(missing)).toBe("missing models ae.safetensors (models/vae)");
    expect(f.queued).toHaveLength(0);
  });

  it("names missing nodes, as on a server started with --disable-all-custom-nodes, and asks once per class", async () => {
    f.missing.add("Wan22ImageToVideoLatent");
    const cache = new Map();
    const probe = await probeWorkflow(client, builtIn("wan22-ti2v-5b"), { cache });
    await probeWorkflow(client, builtIn("z-image-turbo"), { cache });
    expect(probe.runnable).toBe(false);
    expect(probe.missingNodes).toEqual(["Wan22ImageToVideoLatent"]);
    expect(f.calls.filter((c) => c.path === "/object_info/UNETLoader")).toHaveLength(1);
    expect(requiredNodes(builtIn("wan22-ti2v-5b"))).toContain("SaveVideo");
  });
});

describe("values", () => {
  it("take defaults, pick a seed, and refuse a wrong type, a range, an unknown name or a missing file", () => {
    const { values, seeds, files } = resolveValues(tiny(), { prompt: "a lighthouse" });
    expect(values).toMatchObject({ prompt: "a lighthouse", steps: 4 });
    expect(Number.isInteger(seeds.seed)).toBe(true);
    expect(files).toEqual({});
    expect(() => resolveValues(tiny(), { prompt: 3 })).toThrow(/prompt: a string/);
    expect(() => resolveValues(tiny(), { prompt: "x", steps: 11 })).toThrow(/steps: at most 10/);
    expect(() => resolveValues(tiny(), { prompt: "x", steeps: 2 })).toThrow(/takes no steeps/);
    expect(() => resolveValues(tiny(), { prompt: "x", start: { bytes: Buffer.from("x"), filename: "a.txt" } })).toThrow(/not a image file/);
    expect(() => resolveValues(builtIn("flux2-klein-edit"), { prompt: "x" })).toThrow(/image: a image file is needed/);
  });
});

describe("runWorkflow", () => {
  it("probes, uploads by content hash, queues the filled graph and downloads every file each output saved", async () => {
    const bytes = Buffer.from("a first frame");
    const run = await runWorkflow({
      client, workflow: builtIn("wan22-ti2v-5b"), requestId: "r1",
      values: { prompt: "waves at dusk", seed: 7, length: 49, image: { bytes, filename: "Private Name.PNG" } },
    });
    const hashed = `${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}.png`;
    const paths = f.calls.map((c) => c.path.split("?")[0]);
    // everything is read before anything is sent
    expect(paths.indexOf("/upload/image")).toBeGreaterThan(paths.lastIndexOf("/object_info/SaveVideo"));
    expect(paths.indexOf("/prompt")).toBeGreaterThan(paths.indexOf("/upload/image"));
    expect((f.calls.find((c) => c.path === "/upload/image")!.form!.get("image") as File).name).toBe(hashed);
    const g = f.queued[0]!;
    expect(g["56"]!.inputs).toEqual({ image: `studio-workflows/${hashed}` });
    expect(g["55"]!.inputs).toMatchObject({ length: 49, width: 1280, start_image: ["56", 0] });
    expect(g["3"]!.inputs).toMatchObject({ seed: 7, cfg: 5, steps: 20 });
    expect(g["58"]!.inputs.filename_prefix).toBe("studio-workflows/r1");
    expect(JSON.stringify(g)).not.toContain("Private");
    expect(run.outputs).toEqual([{ node: "58", role: "video", file: { filename: "r1_00001_.mp4", subfolder: "studio-workflows", type: "output" }, bytes: Buffer.from("bytes of r1_00001_.mp4") }]);
    expect(run).toMatchObject({ promptId: "p1", seeds: { seed: 7 }, server: { version: "9.9.9", devices: ["cuda:0 Test GPU"] }, executionSeconds: 12.345 });
    expect(run.uploads.image).toEqual({ inputName: `studio-workflows/${hashed}`, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length });
    expect(run.values).toMatchObject({ image: `studio-workflows/${hashed}`, fps: 24 });
  });

  it("leaves an optional input's node out, and the input that read it", async () => {
    f.timestamps = false;
    const run = await runWorkflow({ client, workflow: builtIn("wan22-ti2v-5b"), values: { prompt: "a field of wheat" } });
    const g = f.queued[0]!;
    expect(g["56"]).toBeUndefined();
    expect(g["55"]!.inputs).not.toHaveProperty("start_image");
    expect(f.calls.some((c) => c.path === "/upload/image")).toBe(false);
    expect(run.executionSeconds).toBeNull();
    expect(Object.keys(run.seeds)).toEqual(["seed"]);
  });

  it("keeps every image a save node wrote, in order", async () => {
    const run = await runWorkflow({ client, workflow: builtIn("z-image-turbo"), values: { prompt: "a lighthouse", seed: 1 }, requestId: "r" });
    expect(run.outputs.map((o) => o.file.filename)).toEqual(["r_00001_.png", "r_00002_.png"]);
  });

  it("refuses before uploading or queueing when the server lacks a node or a model", async () => {
    f.missing.add("ReferenceLatent");
    f.missing.add("EmptyFlux2LatentImage");
    const e = await failure(runWorkflow({ client, workflow: builtIn("flux2-klein-edit"), values: { prompt: "make it night", image: { bytes: Buffer.from("x"), filename: "a.png" } } }));
    expect(e.code).toBe("missing-node");
    expect(e.message).toMatch(/missing nodes EmptyFlux2LatentImage, ReferenceLatent; missing models flux-2-klein-4b.safetensors \(models\/diffusion_models\)/);
    f.missing.clear();
    f.models.CheckpointLoaderSimple = { ckpt_name: [] };
    const music = await failure(runWorkflow({ client, workflow: builtIn("ace-step-music"), values: { tags: "strings" } }));
    expect(music.code).toBe("missing-model");
    expect(f.calls.some((c) => c.path === "/upload/image" || c.path === "/prompt")).toBe(false);
  });

  it("takes the graph out of the queue when the wait is given up", async () => {
    f.neverFinishes = true;
    const e = await failure(runWorkflow({ client, workflow: builtIn("z-image-turbo"), values: { prompt: "x" }, timeoutMs: 0 }));
    expect(e.code).toBe("timeout");
    expect(f.calls.at(-1)).toMatchObject({ method: "POST", path: "/queue", body: { delete: ["p1"] } });
  });

  it("fails when an output node saved nothing", async () => {
    const quiet = createComfyUiClient({ baseUrl: BASE, sleep: async () => undefined, fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).pathname.startsWith("/history/")) return new Response(JSON.stringify({ p1: { status: { status_str: "success", completed: true }, outputs: {} } }));
      return f.fetch(input, init);
    }) as typeof fetch });
    const e = await failure(runWorkflow({ client: quiet, workflow: builtIn("ace-step-music"), values: { tags: "x" } }));
    expect(e.code).toBe("no-output");
    expect(e.message).toMatch(/audio node 59 \(SaveAudio\)/);
  });
});

describe("executionSecondsOf", () => {
  it("is the server's start-to-success time, or null", () => {
    expect(executionSecondsOf([["execution_start", { timestamp: 1000 }], ["execution_success", { timestamp: 3500 }]])).toBe(2.5);
    expect(executionSecondsOf([["execution_start", {}]])).toBeNull();
    expect(executionSecondsOf(undefined)).toBeNull();
  });
});

describe("readWorkflowFile", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "comfyui-file-")); mkdirSync(dir, { recursive: true }); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("names a workflow by its file and hashes its bytes", () => {
    const path = join(dir, "my-graph.json");
    writeFileSync(path, JSON.stringify(tiny()));
    const entry = readWorkflowFile(path, "channel");
    expect(entry).toMatchObject({ name: "my-graph", origin: "channel", problems: [] });
    expect(entry.workflow!.kind).toBe("image");
  });
});
