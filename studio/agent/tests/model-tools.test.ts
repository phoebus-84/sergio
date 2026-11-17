// ---------------------------------------------------------------------------
// pva_generate_model: Tripo H3.1 on fal, through the spend ledger
// ---------------------------------------------------------------------------
// The real tool against a stubbed `fetch`: fal's storage, its queue and the
// CDN are fakes, so nothing leaves the machine and nothing is spent. The
// model that "comes back" is a real binary glTF built here, because the tool
// reads what it was given.
//
// Every expected number is computed from the profile in @av/fal-media: the
// tool holds no price or limit of its own, and neither does this test.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRIPO_H31, tripoH31ImageTo3d, tripoH31PriceUsd } from "@av/fal-media";
import { toMicros } from "@studio/contracts/src/budget.mjs";
import { parseJournal, JOURNAL_RELATIVE_PATH } from "@studio/contracts/src/journal.mjs";
import { modelGenerationStatus } from "../src/capability-status.js";
import { HEAVY_TRIANGLES, MODEL_TEXTURES, describeModel, modelRequestBody, modelTerms, pictureExtension, registerModelTools, summarizeModel, weightWarning } from "../src/model-tools.js";

const CHANNEL = "sample-channel";
const SERIES = "sample-series";
const EPISODE = "ep";
const SOURCE = "character-sheets";
const QUEUE = `https://queue.fal.run/${tripoH31ImageTo3d.endpointId}`;

/** A binary glTF with this JSON and no binary chunk: enough for what the tool reads. */
function glb(json: Record<string, unknown>): Buffer {
  let text = JSON.stringify(json);
  while (text.length % 4 !== 0) text += " ";
  const body = Buffer.from(text, "utf-8");
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + body.length, 8);
  header.writeUInt32LE(body.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, body]);
}

/** A deer as a generator returns it: one mesh, two materials, three textures, no skeleton. */
const DEER = glb({
  asset: { version: "2.0" },
  accessors: [{ count: 36_000 }, { count: 12_000 }, { count: 900 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 1 }, indices: 0 }, { attributes: { POSITION: 1 }, indices: 2 }] }],
  materials: [{}, {}],
  images: [{}, {}, {}],
});
/**
 * A figure as the real service returned one on 2026-11-17: a single node with a small turn
 * about y, a unit tall, its origin at its middle, far more triangles than a rig wants.
 */
const FIGURE = glb({
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, matrix: [0.99956, 0, 0.02972, 0, 0, 1, 0, 0, -0.02972, 0, 0.99956, 0, 0, 0, 0, 1] }],
  accessors: [{ count: 4_304_874 }, { count: 738_007, min: [-0.268, -0.5, -0.286], max: [0.268, 0.5, 0.286] }],
  meshes: [{ primitives: [{ attributes: { POSITION: 1 }, indices: 0 }] }],
  materials: [{}],
  images: [{}, {}, {}],
});
/** The same box under a parent that lifts it onto the ground and doubles it, given as translation and scale. */
const STANDING = glb({
  scenes: [{ nodes: [0] }],
  nodes: [{ children: [1], translation: [0, 1, 0], scale: [2, 2, 2] }, { mesh: 0 }],
  accessors: [{ count: 300, min: [-0.25, -0.5, -0.25], max: [0.25, 0.5, 0.25] }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
});
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(16)]);
const RIGGED = glb({ accessors: [{ count: 300 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], skins: [{ joints: [1, 2, 3] }, { joints: [3, 4] }], animations: [{}, {}] });
const FBX = Buffer.concat([Buffer.from("Kaydara FBX Binary  \0\x1a\0", "latin1"), Buffer.alloc(32)]);

interface Tool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
}

describe("what the tool says and reads", () => {
  it("states its prices from the profile", () => {
    const terms = modelTerms();
    for (const texture of MODEL_TEXTURES) expect(terms).toContain(`$${TRIPO_H31.pricesUsd[texture]}`);
    expect(terms).toContain(`+$${TRIPO_H31.detailedGeometryUsd} for detailed geometry`);
    expect(terms).toContain(`+$${TRIPO_H31.quadUsd} for a quad mesh`);
  });

  it("maps its parameters onto fal's schema", () => {
    expect(modelRequestBody({ imageUrl: "https://f/i.png", texture: "standard", seed: 4 })).toEqual({
      image_url: "https://f/i.png", texture: true, pbr: true, model_seed: 4, texture_seed: 4, enable_safety_checker: true,
    });
    expect(modelRequestBody({ imageUrl: "i", texture: "none", seed: 1 })).toMatchObject({ texture: false, pbr: false });
    expect(modelRequestBody({ imageUrl: "i", texture: "detailed", seed: 1, detailedGeometry: true, quad: true, faceLimit: 20_000, alignToImage: true })).toMatchObject({
      texture: true, texture_quality: "detailed", geometry_quality: "detailed", quad: true, face_limit: 20_000, orientation: "align_image",
    });
  });

  it("reads what a model holds from its bytes", () => {
    expect(summarizeModel(DEER)).toEqual({ format: "glb", meshes: 1, triangles: 12_300, materials: 2, textures: 3, joints: 0, animations: 0 });
    expect(describeModel(summarizeModel(DEER))).toBe("12,300 triangles, 1 mesh, 2 materials, 3 textures, no skeleton: it can be placed, turned and lit, not posed");
    expect(summarizeModel(RIGGED)).toMatchObject({ format: "glb", triangles: 100, joints: 4, animations: 2 });
    expect(describeModel(summarizeModel(RIGGED))).toContain("4 joints, 2 clips");
    expect(summarizeModel(FBX)).toEqual({ format: "fbx" });
    expect(summarizeModel(Buffer.from("not a model"))).toEqual({ format: "unknown" });
    expect(summarizeModel(DEER.subarray(0, 40))).toEqual({ format: "unknown" });
    expect(describeModel({ format: "unknown" })).toContain("open it before using it");
  });

  it("reads how big a model is and where its origin lies, as its scene places it", () => {
    expect(summarizeModel(DEER)).not.toHaveProperty("bounds");
    const figure = summarizeModel(FIGURE);
    expect(figure.triangles).toBe(1_434_958);
    expect(figure.bounds).toEqual({ min: [-0.276, -0.5, -0.294], max: [0.276, 0.5, 0.294] });
    expect(describeModel(figure)).toContain("0.55 wide × 1 tall × 0.59 deep in its own units (y up); its origin is at its middle, not under its feet");
    expect(summarizeModel(STANDING).bounds).toEqual({ min: [-0.5, 0, -0.5], max: [0.5, 2, 0.5] });
    expect(describeModel(summarizeModel(STANDING))).toContain("1 wide × 2 tall × 1 deep in its own units (y up); it stands on its origin");
  });

  it("warns of a model too heavy to rig, and not of one that is not", () => {
    expect(weightWarning(summarizeModel(FIGURE))).toMatch(/^⚠️ heavy: 1,434,958 triangles.*faceLimit/);
    expect(weightWarning({ format: "glb", triangles: HEAVY_TRIANGLES })).toBeNull();
    expect(weightWarning(summarizeModel(DEER))).toBeNull();
    expect(weightWarning({ format: "fbx" })).toBeNull();
  });

  it("knows a picture by its bytes", () => {
    expect(pictureExtension(WEBP)).toBe(".webp");
    expect(pictureExtension(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toBe(".png");
    expect(pictureExtension(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(".jpg");
    expect(pictureExtension(Buffer.from("a preview render"))).toBeNull();
    expect(pictureExtension(Buffer.alloc(0))).toBeNull();
  });

  it("is reported by the capability status, ready only with FAL_KEY", () => {
    expect(modelGenerationStatus(true)["model-generation"]).toMatchObject({ available: true, detail: expect.stringContaining("pva_generate_model") });
    expect(modelGenerationStatus(false)["model-generation"]).toEqual({ available: false, detail: "FAL_KEY not set" });
  });
});

describe("pva_generate_model", () => {
  let root: string;
  let dir: string;
  let previous: { root?: string; fal?: string };
  let fetchMock: ReturnType<typeof vi.fn>;
  let tool: Tool;
  let submitted: Record<string, unknown> | undefined;
  let uploads: { name: string; type: string; bytes: number }[];
  /** What the fake endpoint answers with; a test may change it before it calls. */
  let answer: { mesh: Buffer; fileName: string; preview: boolean; taskId?: string; previewBytes?: Buffer; previewNamed?: { type: string; name: string } };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pva-model-"));
    dir = join(root, CHANNEL, "series", SERIES, "episodes", EPISODE);
    mkdirSync(join(dir, "journal"), { recursive: true });
    mkdirSync(join(dir, "assets", "images"), { recursive: true });
    mkdirSync(join(root, CHANNEL, "sources", SOURCE), { recursive: true });
    writeFileSync(join(dir, "assets", "images", "deer.png"), "a picture of a deer");
    writeFileSync(join(dir, "assets", "images", "deer.gif"), "a picture of a deer, moving");
    writeFileSync(join(root, CHANNEL, "sources", SOURCE, "fox.webp"), "a picture of a fox");
    previous = { root: process.env.AVG_LIBRARY_ROOT, fal: process.env.FAL_KEY };
    process.env.AVG_LIBRARY_ROOT = root;
    process.env.FAL_KEY = "fal-key-for-tests";
    submitted = undefined;
    uploads = [];
    answer = { mesh: DEER, fileName: "z9RV14.glb", preview: true, taskId: "task-abc" };

    fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => {
      if (url.includes("/storage/upload/initiate") && init?.method === "POST") {
        const asked = JSON.parse(init.body as string) as { file_name: string };
        return Response.json({ upload_url: `https://bucket.example/put/${asked.file_name}`, file_url: `https://files.example/${asked.file_name}` });
      }
      if (url.startsWith("https://bucket.example/put/") && init?.method === "PUT") {
        uploads.push({ name: url.split("/").pop()!, type: init.headers!["content-type"]!, bytes: (init.body as Uint8Array).byteLength });
        return new Response("", { status: 200 });
      }
      if (url === QUEUE && init?.method === "POST") {
        submitted = JSON.parse(init.body as string);
        return Response.json({ request_id: "req-123", status_url: `${QUEUE}/requests/req-123/status`, response_url: `${QUEUE}/requests/req-123` });
      }
      if (url.endsWith("/requests/req-123/status")) return Response.json({ status: "COMPLETED" });
      if (url.endsWith("/requests/req-123")) {
        return Response.json({
          // fal's own example gives a mesh the content type of a picture: the tool must not believe it.
          model_mesh: { url: "https://cdn.example/model.bin", content_type: "image/png", file_name: answer.fileName, file_size: answer.mesh.length },
          ...(answer.preview ? { rendered_image: { url: "https://cdn.example/preview.webp", content_type: answer.previewNamed?.type ?? "image/webp", file_name: answer.previewNamed?.name ?? "preview.webp" } } : {}),
          model_urls: {},
          ...(answer.taskId ? { task_id: answer.taskId } : {}),
        });
      }
      if (url === "https://cdn.example/model.bin") return new Response(answer.mesh, { status: 200 });
      if (url === "https://cdn.example/preview.webp") return new Response(answer.previewBytes ?? Buffer.from("a preview render"), { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const tools: Tool[] = [];
    registerModelTools({ registerTool: (t: Tool) => tools.push(t) } as never);
    tool = tools.find((t) => t.name === "pva_generate_model")!;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previous.root === undefined) delete process.env.AVG_LIBRARY_ROOT; else process.env.AVG_LIBRARY_ROOT = previous.root;
    if (previous.fal === undefined) delete process.env.FAL_KEY; else process.env.FAL_KEY = previous.fal;
    rmSync(root, { recursive: true, force: true });
  });

  const budget = (limitMicros: number) => writeFileSync(join(root, CHANNEL, "series", SERIES, "settings.yaml"), `budget:\n  currency: USD\n  limitMicros: ${limitMicros}\n`);
  const journal = () => (existsSync(join(dir, JOURNAL_RELATIVE_PATH)) ? parseJournal(readFileSync(join(dir, JOURNAL_RELATIVE_PATH), "utf-8")) : []);
  const generate = (extra: Record<string, unknown> = {}, onUpdate?: (u: unknown) => void) => tool.execute("call-1", {
    channel: CHANNEL, series: SERIES, episode: EPISODE, modelId: "deer", imagePath: "assets/images/deer.png", ...extra,
  }, undefined, onUpdate, {});
  const models = (name: string) => join(dir, "assets", "models", name);
  const provenance = (id = "deer") => JSON.parse(readFileSync(models(`${id}.provenance.json`), "utf-8")) as Record<string, unknown>;

  it("builds its description and texture choices from the profile", () => {
    expect(tool.description).toContain(modelTerms());
    expect(tool.description).toContain("no skeleton");
    for (const texture of MODEL_TEXTURES) expect(JSON.stringify(tool.parameters)).toContain(`"${texture}"`);
  });

  it("uploads the picture, asks for the model, and keeps it with its preview and how it was made", async () => {
    budget(100_000_000);
    const updates: unknown[] = [];
    const result = await generate({ seed: 11 }, (u) => updates.push(u));
    expect(uploads).toEqual([{ name: "image.png", type: "image/png", bytes: "a picture of a deer".length }]);
    expect(submitted).toMatchObject({ image_url: "https://files.example/image.png", texture: true, pbr: true, model_seed: 11, texture_seed: 11, quad: false, enable_safety_checker: true });
    expect(updates.length).toBeGreaterThan(0);

    expect(readFileSync(models("deer.glb")).equals(DEER)).toBe(true);
    expect(readFileSync(models("deer.preview.webp"), "utf-8")).toBe("a preview render");
    expect(provenance()).toMatchObject({
      provider: "fal.ai", endpointId: tripoH31ImageTo3d.endpointId, providerRequestId: "req-123", providerTaskId: "task-abc",
      modelId: "deer", imagePath: "assets/images/deer.png", texture: "standard", seed: 11, output: "deer.glb", preview: "deer.preview.webp",
      estimatedCost: { amount: tripoH31PriceUsd(), currency: "USD" },
      holds: { format: "glb", meshes: 1, triangles: 12_300, materials: 2, textures: 3, joints: 0 },
    });
    expect(provenance().outputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance().imageSha256).toMatch(/^[0-9a-f]{64}$/);

    const said = result.content[0]!.text;
    expect(said).toContain("✅ assets/models/deer.glb");
    expect(said).toContain("12,300 triangles, 1 mesh, 2 materials, 3 textures, no skeleton");
    expect(said).toContain("preview: assets/models/deer.preview.webp");
    expect(said).toContain("it faces +x in its own file");
    expect(said).toContain('pva_update_character { release: { form, release, entry: "deer.glb"');
    expect(result.details).toMatchObject({ providerTaskId: "task-abc", seed: 11, estimatedCostUsd: tripoH31PriceUsd() });
  });

  it("reserves the price of what is asked on the episode's ledger, and settles it", async () => {
    budget(100_000_000);
    await generate();
    const events = journal();
    expect(events.map((e) => e.type)).toEqual(["spend-reserved", "spend-settled"]);
    expect(events[0]!.data).toMatchObject({ capability: "model.generate", provider: "fal", profile: tripoH31ImageTo3d.profileId, purpose: "model deer" });
    expect((events[0]!.data as { estimate: { micros: number } }).estimate.micros).toBe(toMicros(tripoH31PriceUsd()));

    await generate({ modelId: "deer-fine", texture: "detailed", detailedGeometry: true, quad: true });
    const fine = journal().filter((e) => e.type === "spend-reserved")[1]!;
    expect((fine.data as { estimate: { micros: number } }).estimate.micros).toBe(toMicros(tripoH31PriceUsd({ texture: "detailed", detailedGeometry: true, quad: true })));
    expect(submitted).toMatchObject({ texture_quality: "detailed", geometry_quality: "detailed", quad: true });

    await generate({ modelId: "deer-bare", texture: "none" });
    expect(submitted).toMatchObject({ texture: false, pbr: false });
    expect((journal().filter((e) => e.type === "spend-reserved")[2]!.data as { estimate: { micros: number } }).estimate.micros).toBe(toMicros(tripoH31PriceUsd({ texture: "none" })));
  });

  it("keeps a quad mesh that comes back as FBX as what it is, and a model with no preview as a model", async () => {
    budget(100_000_000);
    answer = { mesh: FBX, fileName: "quad.fbx", preview: false };
    const result = await generate({ modelId: "deer-quad", quad: true });
    expect(existsSync(models("deer-quad.fbx"))).toBe(true);
    expect(existsSync(models("deer-quad.glb"))).toBe(false);
    expect(provenance("deer-quad")).toMatchObject({ output: "deer-quad.fbx", holds: { format: "fbx" } });
    expect(provenance("deer-quad")).not.toHaveProperty("preview");
    expect(provenance("deer-quad")).not.toHaveProperty("providerTaskId");
    expect(result.content[0]!.text).toContain("an FBX");
  });

  it("names the preview by what it is, not by what the service calls it", async () => {
    budget(100_000_000);
    // The real service names its preview .png, types it image/png, and sends a WebP.
    answer = { mesh: DEER, fileName: "model.glb", preview: true, previewBytes: WEBP, previewNamed: { type: "image/png", name: "rendered_image.png" } };
    const result = await generate();
    expect(readFileSync(models("deer.preview.webp")).equals(WEBP)).toBe(true);
    expect(existsSync(models("deer.preview.png"))).toBe(false);
    expect(provenance()).toMatchObject({ preview: "deer.preview.webp" });
    expect(result.content[0]!.text).toContain("preview: assets/models/deer.preview.webp");
  });

  it("says when what came back is too heavy to rig, with its size and where its origin is", async () => {
    budget(100_000_000);
    answer = { mesh: FIGURE, fileName: "model.glb", preview: false };
    const said = (await generate()).content[0]!.text;
    expect(said).toContain("⚠️ heavy: 1,434,958 triangles");
    expect(said).toContain("its origin is at its middle, not under its feet");
    expect(provenance()).toMatchObject({ holds: { bounds: { min: [-0.276, -0.5, -0.294], max: [0.276, 0.5, 0.294] } } });

    answer = { mesh: DEER, fileName: "model.glb", preview: false };
    expect((await generate({ modelId: "light" })).content[0]!.text).not.toContain("heavy");
  });

  it("reads the picture from a channel source when imageSource names one", async () => {
    budget(100_000_000);
    await generate({ modelId: "fox", imageSource: SOURCE, imagePath: "fox.webp" });
    expect(uploads).toEqual([{ name: "image.webp", type: "image/webp", bytes: "a picture of a fox".length }]);
    expect(provenance("fox")).toMatchObject({ imageSource: SOURCE, imagePath: "fox.webp" });
    await expect(generate({ modelId: "b", imageSource: "no-such-source", imagePath: "fox.webp" })).rejects.toThrow(/no source/);
    await expect(generate({ modelId: "c", imageSource: SOURCE, imagePath: "../../../secret.png" })).rejects.toThrow();
  });

  it("refuses over budget without calling fal, writing anything or saying it submitted", async () => {
    budget(toMicros(tripoH31PriceUsd()) - 10_000);
    const updates: unknown[] = [];
    await expect(generate({}, (u) => updates.push(u))).rejects.toThrow(/budget/);
    expect(updates).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(journal()).toEqual([]);
    expect(existsSync(models("deer.glb"))).toBe(false);
  });

  it("releases the reservation when the upload fails or fal refuses the request", async () => {
    budget(100_000_000);
    fetchMock.mockImplementationOnce(async () => Response.json({ detail: "no storage" }, { status: 403 }));
    await expect(generate()).rejects.toThrow();
    expect(journal().map((e) => e.type)).toEqual(["spend-reserved", "spend-released"]);
    expect(existsSync(models("deer.provenance.json"))).toBe(false);
  });

  it("refuses before spending: a bad name, a path outside, a wrong file type, a missing picture, a face limit off the profile, no FAL_KEY", async () => {
    budget(100_000_000);
    await expect(generate({ modelId: "a deer" })).rejects.toThrow(/modelId must contain only/);
    await expect(generate({ imagePath: "../../../../etc/hosts" })).rejects.toThrow();
    await expect(generate({ imagePath: "assets/images/deer.gif" })).rejects.toThrow(/Unsupported image type: \.gif/);
    await expect(generate({ imagePath: "assets/images/none.png" })).rejects.toThrow(/Image not found/);
    await expect(generate({ faceLimit: TRIPO_H31.faceLimit.min - 1 })).rejects.toThrow(/faceLimit is/);
    delete process.env.FAL_KEY;
    await expect(generate()).rejects.toThrow(/FAL_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(journal()).toEqual([]);
  });

  it("replaces a model only when told to", async () => {
    budget(100_000_000);
    await generate({ seed: 1 });
    await expect(generate({ seed: 2 })).rejects.toThrow(/already exists: pick another modelId, or pass overwrite: true/);
    expect(provenance().seed).toBe(1);
    await generate({ seed: 2, overwrite: true });
    expect(provenance().seed).toBe(2);
  });

  it("leaves nothing of the model it replaces when the new one is another kind of file", async () => {
    budget(100_000_000);
    await generate();
    expect(readdirSync(join(dir, "assets", "models")).sort()).toEqual(["deer.glb", "deer.preview.webp", "deer.provenance.json"]);
    await generate({ modelId: "deer-2" });
    answer = { mesh: FBX, fileName: "quad.fbx", preview: false };
    await generate({ quad: true, overwrite: true });
    expect(readdirSync(join(dir, "assets", "models")).sort()).toEqual(["deer-2.glb", "deer-2.preview.webp", "deer-2.provenance.json", "deer.fbx", "deer.provenance.json"]);
  });
});
