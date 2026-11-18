// ---------------------------------------------------------------------------
// pva_rig_model: a rigging service on fal, through the spend ledger
// ---------------------------------------------------------------------------
// The real tool against a stubbed `fetch`: fal's storage, its queue and the
// CDN are fakes, so nothing leaves the machine and nothing is spent. The
// rigs that "come back" are real binary glTFs (tests/fixtures/rig-glb.ts),
// because the tool examines what it was given.
//
// Every price and every skeleton's name is read from the profiles in
// @av/fal-media: the tool holds none of its own, and neither does this test.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HYPER3D_RIG, MESHY_RIG, hyper3dRigging, meshyRigging } from "@av/fal-media";
import { toMicros } from "@studio/contracts/src/budget.mjs";
import { parseJournal, JOURNAL_RELATIVE_PATH } from "@studio/contracts/src/journal.mjs";
import { rigCreationStatus } from "../src/capability-status.js";
import { readGlb } from "../src/glb.js";
import { RIG_ENGINES, RIG_ENGINE_TERMS, registerRigTools, rigRequestBody, rigTerms } from "../src/rig-tools.js";
import { BIPED, rigGlb } from "./fixtures/rig-glb.js";

const CHANNEL = "sample-channel";
const SERIES = "sample-series";
const EPISODE = "ep";
const FBX = Buffer.concat([Buffer.from("Kaydara FBX Binary  \0\x1a\0", "latin1"), Buffer.alloc(32)]);
const RIG = rigGlb(BIPED);
const WALK = rigGlb({ ...BIPED, clips: [{ name: "Walking", seconds: 1.07, moves: [0, 7, 8, 9, 10] }] });
const BROKEN = rigGlb({ ...BIPED, vertices: BIPED.joints.map((_, index) => ({ joints: [index], weights: [index < 4 ? 0 : 1] })) });

interface Tool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
}

describe("what the tool says", () => {
  it("states each engine's price and what it rigs, from the profiles", () => {
    const terms = rigTerms();
    expect(terms).toContain(`hyper3d $${HYPER3D_RIG.priceUsd} a rig`);
    expect(terms).toContain(`meshy $${MESHY_RIG.priceUsd} a rig`);
    expect(RIG_ENGINE_TERMS.hyper3d.takes).toEqual([".glb", ".fbx"]);
    expect(RIG_ENGINE_TERMS.meshy.takes).toEqual([".glb"]);
    expect(rigCreationStatus(true)["rig-creation"]).toMatchObject({ available: true });
    expect(rigCreationStatus(true)["rig-creation"].detail).toContain("pva_rig_model");
    expect(rigCreationStatus(false)["rig-creation"]).toEqual({ available: false, detail: "FAL_KEY not set" });
  });

  it("maps its parameters onto each endpoint's schema", () => {
    expect(rigRequestBody({ engine: "hyper3d", modelUrl: "https://f/m.glb" })).toEqual({ model_url: "https://f/m.glb", bone_template: "auto", skinning_method: "core", geometry_file_format: "glb" });
    expect(rigRequestBody({ engine: "hyper3d", modelUrl: "m", skeleton: "custom", skeletonDescription: "six legs", skinning: "core", imageUrl: "https://f/i.png" })).toEqual({
      model_url: "m", bone_template: "custom", skeleton_description: "six legs", skinning_method: "core", image_url: "https://f/i.png", geometry_file_format: "glb",
    });
    expect(rigRequestBody({ engine: "hyper3d", modelUrl: "m", skinning: "shell" })).toMatchObject({ skinning_method: "shell" });
    expect(rigRequestBody({ engine: "meshy", modelUrl: "m" })).toEqual({ model_url: "m", enable_safety_checker: true });
    expect(rigRequestBody({ engine: "meshy", modelUrl: "m", skeleton: "mixamo", fingers: true, heightMeters: 0.9 })).toEqual({
      model_url: "m", skeleton_template: "mixamo", include_fingers: true, height_meters: 0.9, enable_safety_checker: true,
    });
  });
});

describe("pva_rig_model", () => {
  let root: string;
  let dir: string;
  let previous: { root: string | undefined; fal: string | undefined };
  let fetchMock: ReturnType<typeof vi.fn>;
  let tool: Tool;
  let submitted: { endpoint: string; body: Record<string, unknown> } | undefined;
  let uploads: { name: string; type: string; bytes: Buffer }[];
  /** What the fake endpoints answer with; a test may change it before it calls. */
  let answer: Record<string, unknown>;
  let files: Record<string, Buffer>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pva-rig-"));
    dir = join(root, CHANNEL, "series", SERIES, "episodes", EPISODE);
    mkdirSync(join(dir, "journal"), { recursive: true });
    mkdirSync(join(dir, "assets", "models"), { recursive: true });
    mkdirSync(join(dir, "assets", "images"), { recursive: true });
    // The model to rig: a body with no skeleton is all the tool needs it to be, and any .glb will do.
    writeFileSync(join(dir, "assets", "models", "figure.glb"), RIG);
    writeFileSync(join(dir, "assets", "models", "figure.provenance.json"), "{}");
    writeFileSync(join(dir, "assets", "models", "figure-quad.fbx"), FBX);
    writeFileSync(join(dir, "assets", "models", "notes.txt"), "not a model");
    writeFileSync(join(dir, "assets", "images", "figure.png"), "a picture of the figure");
    previous = { root: process.env.AVG_LIBRARY_ROOT, fal: process.env.FAL_KEY };
    process.env.AVG_LIBRARY_ROOT = root;
    process.env.FAL_KEY = "fal-key-for-tests";
    submitted = undefined;
    uploads = [];
    files = { "https://cdn.example/rig.glb": RIG };
    answer = { model_mesh: { url: "https://cdn.example/rig.glb", content_type: "image/png", file_name: "rig.glb" } };

    fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => {
      if (url.includes("/storage/upload/initiate") && init?.method === "POST") {
        const asked = JSON.parse(init.body as string) as { file_name: string };
        return Response.json({ upload_url: `https://bucket.example/put/${asked.file_name}`, file_url: `https://files.example/${asked.file_name}` });
      }
      if (url.startsWith("https://bucket.example/put/") && init?.method === "PUT") {
        uploads.push({ name: url.split("/").pop()!, type: init.headers!["content-type"]!, bytes: Buffer.from(init.body as Uint8Array) });
        return new Response("", { status: 200 });
      }
      for (const profile of [hyper3dRigging, meshyRigging]) {
        const queue = `https://queue.fal.run/${profile.endpointId}`;
        if (url === queue && init?.method === "POST") {
          submitted = { endpoint: profile.endpointId, body: JSON.parse(init.body as string) };
          return Response.json({ request_id: "req-9", status_url: `${queue}/requests/req-9/status`, response_url: `${queue}/requests/req-9` });
        }
        if (url === `${queue}/requests/req-9/status`) return Response.json({ status: "COMPLETED" });
        if (url === `${queue}/requests/req-9`) return Response.json(answer);
      }
      if (files[url]) return new Response(files[url], { status: 200 });
      if (url.startsWith("https://cdn.example/")) return new Response("gone", { status: 404 });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const tools: Tool[] = [];
    registerRigTools({ registerTool: (t: Tool) => tools.push(t) } as never);
    tool = tools.find((t) => t.name === "pva_rig_model")!;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previous.root === undefined) delete process.env.AVG_LIBRARY_ROOT; else process.env.AVG_LIBRARY_ROOT = previous.root;
    if (previous.fal === undefined) delete process.env.FAL_KEY; else process.env.FAL_KEY = previous.fal;
    rmSync(root, { recursive: true, force: true });
  });

  const budget = (limitMicros: number) => writeFileSync(join(root, CHANNEL, "series", SERIES, "settings.yaml"), `budget:\n  currency: USD\n  limitMicros: ${limitMicros}\n`);
  const journal = () => (existsSync(join(dir, JOURNAL_RELATIVE_PATH)) ? parseJournal(readFileSync(join(dir, JOURNAL_RELATIVE_PATH), "utf-8")) : []);
  const rig = (extra: Record<string, unknown> = {}, onUpdate?: (u: unknown) => void) => tool.execute("call-1", {
    channel: CHANNEL, series: SERIES, episode: EPISODE, rigId: "figure-rig", modelPath: "assets/models/figure.glb", ...extra,
  }, undefined, onUpdate, {});
  const models = (name: string) => join(dir, "assets", "models", name);
  const provenance = (id = "figure-rig") => JSON.parse(readFileSync(models(`${id}.provenance.json`), "utf-8")) as Record<string, unknown>;
  const mine = () => readdirSync(join(dir, "assets", "models")).filter((name) => name.startsWith("figure-rig")).sort();

  it("names its engines and every skeleton they have", () => {
    expect(tool.description).toContain(rigTerms());
    for (const engine of RIG_ENGINES) expect(JSON.stringify(tool.parameters)).toContain(`"${engine}"`);
    for (const skeleton of [...HYPER3D_RIG.templates, ...MESHY_RIG.templates]) expect(JSON.stringify(tool.parameters)).toContain(`"${skeleton}"`);
  });

  it("sends the model to Hyper3D, keeps the rig with how it was made, and examines it", async () => {
    budget(100_000_000);
    // No skinning is named: the studio asks for core, and the provenance says so.
    const result = await rig({ skeleton: "human" });
    expect(uploads.map((u) => `${u.name} ${u.type}`)).toEqual(["model.glb model/gltf-binary"]);
    expect(uploads[0]!.bytes.equals(RIG)).toBe(true);
    expect(submitted).toEqual({
      endpoint: hyper3dRigging.endpointId,
      body: { model_url: "https://files.example/model.glb", bone_template: "human", skinning_method: "core", in_place: false, geometry_file_format: "glb" },
    });

    expect(readFileSync(models("figure-rig.glb")).equals(RIG)).toBe(true);
    expect(provenance()).toMatchObject({
      provider: "fal.ai", endpointId: hyper3dRigging.endpointId, providerRequestId: "req-9", rigId: "figure-rig",
      modelPath: "assets/models/figure.glb", engine: "hyper3d", skeleton: "human", skinning: "core", faces: "+z", output: "figure-rig.glb",
      estimatedCost: { amount: HYPER3D_RIG.priceUsd, currency: "USD" },
      exam: { format: "glb", ok: true, joints: 11, grounded: 2 },
    });
    expect(provenance().modelSha256).toMatch(/^[0-9a-f]{64}$/);
    expect((provenance().files as { role: string; file: string }[]).map((f) => `${f.role} ${f.file}`)).toEqual(["rig figure-rig.glb"]);

    const said = result.content[0]!.text;
    expect(said).toContain("✅ assets/models/figure-rig.glb");
    expect(said).toContain("11 joints, 4 deep; 11 vertices bound; 2 joints near the ground");
    expect(said).toContain("exam: nothing wrong found at rest. That is not yet a good rig: pose it and look");
    expect(said).toContain('pose it and look before anything else: pva_rig_sheet { channel, series, episode, rigPath: "assets/models/figure-rig.glb" }');
    expect(said).toContain('medium: "rig-3d"');
    expect(said).toContain(`model: "${hyper3dRigging.endpointId}"`);
    expect(result.details).toMatchObject({ exam: { ok: true }, estimatedCostUsd: HYPER3D_RIG.priceUsd });
  });

  it("reserves the engine's price on the episode's ledger, and settles it", async () => {
    budget(100_000_000);
    await rig();
    const events = journal();
    expect(events.map((e) => e.type)).toEqual(["spend-reserved", "spend-settled"]);
    expect(events[0]!.data).toMatchObject({ capability: "rig.create", provider: "fal", profile: hyper3dRigging.profileId, purpose: "rig figure-rig" });
    expect((events[0]!.data as { estimate: { micros: number } }).estimate.micros).toBe(toMicros(HYPER3D_RIG.priceUsd));
  });

  it("turns a model that faces another way before it is sent, and leaves the file on disk as it was", async () => {
    budget(100_000_000);
    await rig({ faces: "+x" });
    const sent = readGlb(uploads[0]!.bytes)!.json;
    expect(sent.nodes!.at(-1)).toMatchObject({ name: "turned-to-face-z" });
    expect(readFileSync(models("figure.glb")).equals(RIG)).toBe(true);
    expect(provenance()).toMatchObject({ faces: "+x" });
    await expect(rig({ rigId: "b", modelPath: "assets/models/figure-quad.fbx", faces: "+x" })).rejects.toThrow(/a \.fbx cannot be turned here/);
  });

  it("takes an FBX and a picture of the character, with Hyper3D", async () => {
    budget(100_000_000);
    await rig({ modelPath: "assets/models/figure-quad.fbx", imagePath: "assets/images/figure.png", skeleton: "custom", skeletonDescription: "a round body, two short legs, no neck" });
    expect(uploads.map((u) => `${u.name} ${u.type}`)).toEqual(["model.fbx application/octet-stream", "image.png image/png"]);
    expect(submitted!.body).toMatchObject({
      model_url: "https://files.example/model.fbx", image_url: "https://files.example/image.png", bone_template: "custom",
      skeleton_description: "a round body, two short legs, no neck",
    });
  });

  it("with Meshy, keeps the walk and the run that come with the rig, each read", async () => {
    budget(100_000_000);
    files["https://cdn.example/walk.glb"] = WALK;
    files["https://cdn.example/run.glb"] = RIG;
    files["https://cdn.example/rig.fbx"] = FBX;
    answer = {
      rigged_character_glb: { url: "https://cdn.example/rig.glb" },
      rigged_character_fbx: { url: "https://cdn.example/rig.fbx" },
      basic_animations: { walking_glb: { url: "https://cdn.example/walk.glb" }, running_glb: { url: "https://cdn.example/run.glb" }, walking_fbx: { url: "https://cdn.example/walk.fbx" } },
      rig_task_id: "meshy-task-1",
    };
    const result = await rig({ engine: "meshy", skeleton: "mixamo", fingers: true, heightMeters: 0.9 });
    expect(submitted).toEqual({
      endpoint: meshyRigging.endpointId,
      body: { model_url: "https://files.example/model.glb", skeleton_template: "mixamo", include_fingers: true, height_meters: 0.9, enable_animation: false, enable_safety_checker: true },
    });
    expect(mine()).toEqual(["figure-rig.clip.running.glb", "figure-rig.clip.walking.glb", "figure-rig.fbx", "figure-rig.glb", "figure-rig.provenance.json"]);
    expect(provenance()).toMatchObject({ engine: "meshy", providerTaskId: "meshy-task-1", estimatedCost: { amount: MESHY_RIG.priceUsd } });
    expect((provenance().clips as { name: string; clips: unknown[] }[]).map((c) => `${c.name} ${c.clips.length}`)).toEqual(["walking 1", "running 0"]);

    const said = result.content[0]!.text;
    expect(said).toContain("clip walking: assets/models/figure-rig.clip.walking.glb — 1.07s, moves 5 joints");
    expect(said).toContain("clip running: assets/models/figure-rig.clip.running.glb — ⚠️ no animation inside");
    expect(said).toContain('can: { actions: ["walking", "running"] }');
    expect(journal()[0]!.data).toMatchObject({ profile: meshyRigging.profileId });
  });

  it("keeps a rig that fails the exam, says so, and tells no one to release it", async () => {
    budget(100_000_000);
    files["https://cdn.example/rig.glb"] = BROKEN;
    const result = await rig();
    const said = result.content[0]!.text;
    expect(said).toContain("❌ assets/models/figure-rig.glb");
    expect(said).toContain("4 vertices follow no bone");
    expect(said).toContain("exam: failed. Do not release this rig: make another attempt");
    expect(said).toContain("must not be released");
    expect(said).not.toContain("pva_update_character");
    expect(existsSync(models("figure-rig.glb"))).toBe(true);
    expect(provenance()).toMatchObject({ exam: { ok: false, unweighted: 4 } });
    // It was made and paid for: the ledger says so.
    expect(journal().map((e) => e.type)).toEqual(["spend-reserved", "spend-settled"]);
  });

  it("says what it could not download, and still keeps the rig", async () => {
    budget(100_000_000);
    answer = { rigged_character_glb: { url: "https://cdn.example/rig.glb" }, basic_animations: { walking_glb: { url: "https://cdn.example/missing.glb" } } };
    const result = await rig({ engine: "meshy" });
    expect(result.content[0]!.text).toContain("⚠️ not downloaded: clip:walking");
    expect(mine()).toEqual(["figure-rig.glb", "figure-rig.provenance.json"]);
  });

  it("refuses over budget without calling fal, writing anything or saying it submitted", async () => {
    budget(toMicros(HYPER3D_RIG.priceUsd) - 10_000);
    const updates: unknown[] = [];
    await expect(rig({}, (u) => updates.push(u))).rejects.toThrow(/budget/);
    expect(updates).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(journal()).toEqual([]);
    expect(mine()).toEqual([]);
  });

  it("releases the reservation when the upload fails", async () => {
    budget(100_000_000);
    fetchMock.mockImplementationOnce(async () => Response.json({ detail: "no storage" }, { status: 403 }));
    await expect(rig()).rejects.toThrow();
    expect(journal().map((e) => e.type)).toEqual(["spend-reserved", "spend-released"]);
    expect(mine()).toEqual([]);
  });

  it("refuses before spending what an engine does not take", async () => {
    budget(100_000_000);
    await expect(rig({ rigId: "a rig" })).rejects.toThrow(/rigId must contain only/);
    await expect(rig({ modelPath: "../../../../etc/hosts" })).rejects.toThrow();
    await expect(rig({ modelPath: "assets/models/none.glb" })).rejects.toThrow(/Model not found/);
    await expect(rig({ modelPath: "assets/models/notes.txt" })).rejects.toThrow(/neither a binary glTF nor a binary FBX/);
    await expect(rig({ engine: "meshy", modelPath: "assets/models/figure-quad.fbx" })).rejects.toThrow(/Meshy Rigging takes \.glb/);
    await expect(rig({ engine: "meshy", skeleton: "quadruped" })).rejects.toThrow(/Meshy Rigging has no skeleton "quadruped"/);
    await expect(rig({ skeleton: "mixamo" })).rejects.toThrow(/Hyper3D Rigging has no skeleton "mixamo"/);
    await expect(rig({ skeleton: "custom" })).rejects.toThrow(/skeleton custom needs skeletonDescription/);
    await expect(rig({ skeletonDescription: "six legs" })).rejects.toThrow(/only for skeleton custom/);
    await expect(rig({ fingers: true })).rejects.toThrow(/for engine meshy/);
    await expect(rig({ engine: "meshy", skinning: "core" })).rejects.toThrow(/for engine hyper3d/);
    await expect(rig({ imagePath: "assets/images/none.png" })).rejects.toThrow(/Image not found/);
    delete process.env.FAL_KEY;
    await expect(rig()).rejects.toThrow(/FAL_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(journal()).toEqual([]);
  });

  it("never takes the name of the model it is made from, and replaces a rig only when told to", async () => {
    budget(100_000_000);
    await expect(rig({ rigId: "figure", overwrite: true })).rejects.toThrow(/is the name of the model it is made from/);
    expect(readFileSync(models("figure.glb")).equals(RIG)).toBe(true);

    files["https://cdn.example/walk.glb"] = WALK;
    answer = { rigged_character_glb: { url: "https://cdn.example/rig.glb" }, basic_animations: { walking_glb: { url: "https://cdn.example/walk.glb" } } };
    await rig({ engine: "meshy" });
    await expect(rig()).rejects.toThrow(/already exists: pick another rigId, or pass overwrite: true/);
    expect(provenance().engine).toBe("meshy");

    // A second attempt comes back with other files: nothing of the first stays.
    answer = { model_mesh: { url: "https://cdn.example/rig.glb" } };
    await rig({ overwrite: true });
    expect(mine()).toEqual(["figure-rig.glb", "figure-rig.provenance.json"]);
    expect(provenance().engine).toBe("hyper3d");
    expect(existsSync(models("figure.glb"))).toBe(true);
  });
});
