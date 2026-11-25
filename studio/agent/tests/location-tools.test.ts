// ---------------------------------------------------------------------------
// A location's 3D set: the tools, the film's ledger, and what is kept
// ---------------------------------------------------------------------------
// The real tools against FakeAtlas, an Atlas in memory behind the package's
// own client: nothing leaves the machine, nothing is spent and nothing waits.
// The fake is written from Atlas's documentation and is as strict as it says
// the service is (ADR-0057): a request the documented schema would refuse is
// refused here. These tests fix what the tools do with money, files and
// jobs; they do not show that the live service agrees.
//
// Every price is computed from @av/worldlabs-atlas or from the operator's
// file written here: the tools hold none of their own.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtlasClient, FAKE_API_ROOT, FakeAtlas, NoopSleeper, WIRE, estimate, type FakeAtlasOptions } from "@av/worldlabs-atlas";
import { createHash } from "node:crypto";
import { reserveSpend, toMicros } from "@studio/contracts/src/budget.mjs";
import { parseJournal, JOURNAL_RELATIVE_PATH } from "@studio/contracts/src/journal.mjs";
import {
  ATLAS_SETTINGS_RELATIVE, LOCATION_MESH_TOOL, LOCATION_SETS_TOOL, LOCATION_SET_TOOL, LOCATION_SPLAT_TOOL, LOCATION_VIEWS_TOOL,
  licenceOf, locationSetsStatus, pictureSize, readAtlasSettings, registerLocationTools,
} from "../src/location-tools.js";

const FILM = "night-shift";
const WHERE = { film: FILM, location: "yard", set: "a" };
const OWN_CREDITS = { images2PosedRGBD: 100, splats2Mesh: 1000, "atlasGenerate.perView": 50 };

interface Tool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
}

/** A PNG's first 24 bytes, saying this size, and then anything. */
function png(width: number, height: number, label: string): Buffer {
  const head = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12);
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.from(label)]);
}

describe("what is read before anything is asked", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "pva-atlas-settings-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const settingsFile = (value: unknown) => {
    mkdirSync(join(root, ".render"), { recursive: true });
    writeFileSync(join(root, ATLAS_SETTINGS_RELATIVE), typeof value === "string" ? value : JSON.stringify(value));
  };

  it("reads a picture's size from a PNG's or a JPEG's first bytes", () => {
    expect(pictureSize(png(1280, 720, "x"))).toEqual({ width: 1280, height: 720 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03, 0x01, 0x22, 0x00]);
    expect(pictureSize(jpeg)).toEqual({ width: 1280, height: 720 });
    expect(pictureSize(Buffer.from("RIFF....WEBPVP8 "))).toBeNull();
    expect(pictureSize(Buffer.alloc(0))).toBeNull();
  });

  it("knows nothing of the account until the operator writes it down", () => {
    expect(readAtlasSettings(root)).toEqual({ plan: null, credits: {}, maxWaitMinutes: 45, problems: [] });
    settingsFile({ plan: "paid", credits: OWN_CREDITS, maxWaitMinutes: 30 });
    expect(readAtlasSettings(root)).toEqual({ plan: "paid", credits: OWN_CREDITS, maxWaitMinutes: 30, problems: [] });
  });

  it("says what in the operator's file it could not use, and uses the rest", () => {
    settingsFile({ plan: "pro", credits: { splats2Mesh: "cheap", "atlasGenerate.perView": 50, everything: 1 }, maxWaitMinutes: 0 });
    const settings = readAtlasSettings(root);
    expect(settings).toMatchObject({ plan: null, credits: { "atlasGenerate.perView": 50 }, maxWaitMinutes: 45 });
    expect(settings.problems).toEqual([
      'plan is "paid" or "free", not "pro"',
      'credits.splats2Mesh is a number of credits, not "cheap"',
      expect.stringContaining("credits.everything is not a price this studio knows"),
      "maxWaitMinutes is from 1 to 180",
    ]);
    settingsFile("{ not json");
    expect(readAtlasSettings(root).problems[0]).toMatch(/worldlabs-atlas\.json could not be read/);
  });

  it("marks a set for commercial use only under access stated as paid, by the Terms' own sections", () => {
    const base = { credits: {}, maxWaitMinutes: 45, problems: [] };
    expect(licenceOf({ ...base, plan: "paid" })).toMatchObject({ plan: "paid", access: "Eligible Paid Access", commercialUse: true, termsDated: "11.10.26", statedBy: expect.stringContaining("the operator"), basis: expect.stringContaining("2.3(b)") });
    expect(licenceOf({ ...base, plan: "free" })).toMatchObject({ plan: "free", access: "Low-Tier Access", commercialUse: false, basis: expect.stringContaining("Non-Commercial Use") });
    // What was made under free access stays so after an upgrade: the record says it.
    expect(licenceOf({ ...base, plan: "free" }).basis).toContain("even after an upgrade");
    expect(licenceOf({ ...base, plan: null })).toMatchObject({ plan: "unstated", commercialUse: false, statedBy: null, basis: expect.stringContaining("treated as Low-Tier Access") });
    expect(licenceOf({ ...base, plan: "free" }).inputs).toContain("no opt-out");
  });

  it("is reported by the capability status: wired and unverified, with what has no price", () => {
    expect(locationSetsStatus(false, readAtlasSettings(root))["location-sets"]).toEqual({ available: false, detail: "WLT_API_KEY not set" });
    const bare = locationSetsStatus(true, readAtlasSettings(root))["location-sets"];
    expect(bare.available).toBe(true);
    expect(bare.detail).toContain("no price for images2PosedRGBD, splats2Mesh, atlasGenerate.perView");
    expect(bare.detail).toContain("sets are marked for non-commercial use only");
    expect(bare.detail).toContain("720p at most");
    expect(bare.detail).toContain("the key needs tasks.create, operations.read, assets.create, assets.read");
    expect(bare.detail).toContain(WIRE.verifiedLive ? "verified against the live API" : "written from the documentation, not yet run against the live API");
    settingsFile({ plan: "paid", credits: OWN_CREDITS });
    const priced = locationSetsStatus(true, readAtlasSettings(root))["location-sets"].detail;
    expect(priced).not.toContain("no price for");
    expect(priced).toContain("plan paid");
  });
});

describe("a location's set", () => {
  let root: string;
  let filmDir: string;
  let setDir: string;
  let fake: FakeAtlas;
  let tools: Record<string, Tool>;
  const saved = { library: process.env.AVG_LIBRARY_ROOT, ffmpeg: process.env.FFMPEG_BIN };

  /** The tools on a fresh fake; the library stays. */
  function atlas(options: FakeAtlasOptions = {}): FakeAtlas {
    return atlasWith(new FakeAtlas(options));
  }

  function atlasWith(provider: FakeAtlas): FakeAtlas {
    fake = provider;
    const registered: Tool[] = [];
    registerLocationTools({ registerTool: (tool: Tool) => registered.push(tool) } as never, {
      client: ({ onEvent }) => new AtlasClient({
        config: { apiKey: "wl_live_test_key", baseUrl: FAKE_API_ROOT, maxRetries: 0 }, transport: fake.transport, fetchBytes: fake.fetchBytes, sleeper: new NoopSleeper(), random: () => 0.5, ...(onEvent ? { onEvent } : {}),
      }),
    });
    tools = Object.fromEntries(registered.map((tool) => [tool.name, tool]));
    return fake;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pva-location-"));
    filmDir = join(root, FILM);
    setDir = join(filmDir, "locations", "yard", "sets", "a");
    mkdirSync(join(filmDir, "journal"), { recursive: true });
    mkdirSync(join(filmDir, "locations", "yard", "photos"), { recursive: true });
    writeFileSync(join(filmDir, "film.yaml"), "title: Night Shift\n");
    for (const name of ["gate", "wall", "lamp"]) writeFileSync(join(filmDir, "locations", "yard", "photos", `${name}.png`), png(1280, 720, name));
    writeFileSync(join(filmDir, "locations", "yard", "photos", "notes.txt"), "not a picture");
    mkdirSync(join(root, "sample-channel"), { recursive: true });
    // An FFmpeg that writes the file it is asked for, where it is run.
    writeFileSync(join(root, "ffmpeg.mjs"), "#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nif (!process.argv.includes('-version')) writeFileSync(process.argv.at(-1), 'a plate at ' + process.argv[process.argv.indexOf('-framerate') + 1] + ' fps from ' + process.argv[process.argv.indexOf('-i') + 1]);\n");
    chmodSync(join(root, "ffmpeg.mjs"), 0o755);
    process.env.AVG_LIBRARY_ROOT = root;
    process.env.FFMPEG_BIN = join(root, "ffmpeg.mjs");
    atlas();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of [["AVG_LIBRARY_ROOT", saved.library], ["FFMPEG_BIN", saved.ffmpeg]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  const PICTURES = ["locations/yard/photos/gate.png", "locations/yard/photos/wall.png", "locations/yard/photos/lamp.png"];
  const budget = (limitUsd: number) => writeFileSync(join(filmDir, "settings.yaml"), `budget:\n  currency: USD\n  limitMicros: ${toMicros(limitUsd)}\n`);
  const account = (value: Record<string, unknown> = { plan: "paid", credits: OWN_CREDITS }) => {
    mkdirSync(join(root, ".render"), { recursive: true });
    writeFileSync(join(root, ATLAS_SETTINGS_RELATIVE), JSON.stringify(value));
  };
  const journal = () => (existsSync(join(filmDir, JOURNAL_RELATIVE_PATH)) ? parseJournal(readFileSync(join(filmDir, JOURNAL_RELATIVE_PATH), "utf-8")) : []);
  const ledger = () => journal().map((event) => event.type);
  const reserved = () => journal().filter((event) => event.type === "spend-reserved").map((event) => event.data as { capability: string; provider: string; profile: string; purpose: string; estimate: { micros: number }; priced?: boolean });
  const settled = () => journal().filter((event) => event.type === "spend-settled").map((event) => event.data as { cost: { micros: number }; basis: string; providerRequestId?: string });
  const record = () => JSON.parse(readFileSync(join(setDir, "set.json"), "utf-8"));
  const said = (result: { content: Array<{ text: string }> }) => result.content[0]!.text;
  /** The error a call ends in. */
  const failed = (call: Promise<unknown>): Promise<Error> => call.then(() => { throw new Error("it did not fail"); }, (e) => e as Error);
  const run = (tool: string, params: Record<string, unknown> = {}, onUpdate?: (u: unknown) => void) => tools[tool]!.execute("call", { ...WHERE, ...params }, undefined, onUpdate, {});
  const pose = (params: Record<string, unknown> = {}, onUpdate?: (u: unknown) => void) => run(LOCATION_SET_TOOL, { pictures: PICTURES, ...params }, onUpdate);
  const submissions = () => fake.requests.filter((r) => r.path.includes("/tasks:"));
  const only = (task: "images2PosedRGBD" | "posedImages2Splats" | "splats2Mesh" | "atlasGenerate") => { const all = fake.submitted(task); expect(all).toHaveLength(1); return all[0]!; };

  it("is five tools that say what they cost, what comes first and what 720p is for", () => {
    expect(Object.keys(tools).sort()).toEqual([LOCATION_MESH_TOOL, LOCATION_SET_TOOL, LOCATION_SETS_TOOL, LOCATION_SPLAT_TOOL, LOCATION_VIEWS_TOOL].sort());
    const splat = tools[LOCATION_SPLAT_TOOL]!.description;
    expect(splat).toContain(`"draft" ($${estimate("posedImages2Splats", { refine: false }).usd}, published`);
    expect(splat).toContain(`"refined" ($${estimate("posedImages2Splats", { refine: true }).usd}, published`);
    expect(splat).toContain("only when the operator has said so");
    expect(splat).toContain("Never decide it yourself");
    expect(splat).toContain("A run that fails is free");
    expect(tools[LOCATION_VIEWS_TOOL]!.description).toContain("never a film's final picture");
    expect(JSON.stringify(tools[LOCATION_VIEWS_TOOL]!.parameters)).toContain('"1280x720"');
    expect(JSON.stringify(tools[LOCATION_VIEWS_TOOL]!.parameters)).not.toContain("1920");
    expect(JSON.stringify(tools[LOCATION_MESH_TOOL]!.parameters)).toContain('"image_texture"');
    expect(tools[LOCATION_SET_TOOL]!.description).toContain("world.reconstruct");
    expect(tools[LOCATION_MESH_TOOL]!.description).toContain("world.mesh");
  });

  it("belongs to a film, and reads its pictures from inside it", async () => {
    await expect(run(LOCATION_SET_TOOL, { film: "sample-channel", pictures: PICTURES })).rejects.toThrow("sample-channel is not a film: a location's set belongs to a film");
    await expect(pose({ set: "A set" })).rejects.toThrow("set is a slug");
    await expect(pose({ pictures: ["../sample-channel/secret.png"] })).rejects.toThrow();
    await expect(pose({ pictures: ["locations/yard/photos/none.png"] })).rejects.toThrow("Picture not found in the film: locations/yard/photos/none.png");
    await expect(pose({ pictures: ["locations/yard/photos/notes.txt"] })).rejects.toThrow("Unsupported picture type");
    await expect(pose({ pictures: [PICTURES[0], PICTURES[0]] })).rejects.toThrow("a picture is named twice");
    await expect(pose({ size: "1920x1080" })).rejects.toThrow("size is one of 1280x720, 960x720, 528x704, 720x1280");
    await expect(pose({ pictures: [PICTURES[0]], refinePoses: true })).rejects.toThrow("it needs two or more pictures");
    expect(fake.requests).toEqual([]);
    expect(existsSync(setDir)).toBe(false);
  });

  it("refuses a step nobody priced when the film has a budget, and says where the price goes", async () => {
    budget(20);
    const failure = await failed(pose());
    expect(failure.message).toContain("No price is known for worldlabs-atlas/images2PosedRGBD");
    expect(failure.message).toContain("read it on the account's rate card");
    expect(failure.message).toContain(`library/${ATLAS_SETTINGS_RELATIVE} as { "credits": { "images2PosedRGBD": <credits> } }`);
    expect(fake.requests).toEqual([]);
    expect(ledger()).toEqual([]);
    // A set that was never reserved was never begun.
    expect(existsSync(setDir)).toBe(false);
  });

  it("poses the pictures on one grid at the operator's price, and keeps the frames, the depth maps, the licence and how it was made", async () => {
    budget(20);
    account();
    const updates: string[] = [];
    const result = await pose({}, (u) => updates.push((u as { content: { text: string }[] }).content[0]!.text));

    expect(fake.requests.filter((r) => r.method === "POST" && r.path === "/api/v2/assets").map((r) => (r.body as { asset: { displayName: string } }).asset.displayName)).toEqual(["picture-001.png", "picture-002.png", "picture-003.png"]);
    const posing = only("images2PosedRGBD");
    // Images alone, by their assets, and the grid everything after is on.
    expect(posing.body).toEqual({ frames: [{ imageAsset: { assetId: "asset_0001" } }, { imageAsset: { assetId: "asset_0002" } }, { imageAsset: { assetId: "asset_0003" } }], targetResolution: [1280, 720] });
    // One name for this work, the same on every attempt at it.
    expect(submissions()[0]!.headers["idempotency-key"]).toMatch(/^sergio-[0-9a-f]{40}$/);
    expect(updates[0]).toBe("Uploading locations/yard/photos/gate.png (1/3)…");
    expect(updates).toContain("Submitting location yard, set a: pose 3 pictures to Atlas (tasks:images2PosedRGBD, ~$0.1 (100 credits, the operator's price))…");

    expect(reserved()).toEqual([expect.objectContaining({ capability: "world.reconstruct", provider: "worldlabs-atlas", profile: "worldlabs-atlas/images2PosedRGBD", purpose: "location yard, set a: pose 3 pictures", estimate: { currency: "USD", micros: toMicros(0.1) } })]);
    // An operation does not say what it was charged: the price it was asked at stands, and the ledger says that is what it is.
    expect(settled()).toEqual([expect.objectContaining({ cost: { currency: "USD", micros: toMicros(0.1) }, basis: "estimate", providerRequestId: posing.id })]);

    expect(readdirSync(setDir).sort()).toEqual(["licence.json", "posed", "posed.json", "provenance", "set.json"]);
    expect(readdirSync(join(setDir, "posed")).sort()).toEqual(["confidence-001.png", "confidence-002.png", "confidence-003.png", "depth-001.exr", "depth-002.exr", "depth-003.exr"]);
    const frames = JSON.parse(readFileSync(join(setDir, "posed.json"), "utf-8")).frames;
    expect(frames).toHaveLength(3);
    expect(frames[0]).toMatchObject({ imageAsset: { assetId: "asset_0001" }, camera: { extrinsics: { coordinateSystem: "rub" }, intrinsics: { width: 1280, height: 720 } }, centroidWorld: [0, 0, 0] });
    expect(record()).toMatchObject({
      version: 1, film: FILM, location: "yard", set: "a", provider: "worldlabs-atlas", size: "1280x720",
      pictures: [{ file: PICTURES[0], width: 1280, height: 720 }, { file: PICTURES[1] }, { file: PICTURES[2] }],
      posed: { operationId: posing.id, frames: 3, costUsd: 0.1, costBasis: "estimate (operator)" },
      views: {}, splats: {}, meshes: {},
    });
    expect(JSON.parse(readFileSync(join(setDir, "licence.json"), "utf-8"))).toMatchObject({ plan: "paid", access: "Eligible Paid Access", commercialUse: true });
    const provenance = JSON.parse(readFileSync(join(setDir, "provenance", `${posing.id}.json`), "utf-8"));
    expect(provenance).toMatchObject({
      tool: LOCATION_SET_TOOL, film: FILM, set: "locations/yard/sets/a", step: "pose", capability: "world.reconstruct", provider: "worldlabs-atlas",
      task: "images2PosedRGBD", operationId: posing.id, wire: { verifiedLive: WIRE.verifiedLive }, estimate: { credits: 100, basis: "operator" }, licence: { plan: "paid" },
    });
    expect(provenance.trace).toMatchObject({ taskName: "images2PosedRGBD" });
    // No key, and no URL that still opens a file.
    expect(JSON.stringify(provenance)).not.toContain("wl_live_test_key");
    expect(JSON.stringify(provenance)).not.toContain("X-Signature");
    expect(JSON.stringify(record())).not.toContain("X-Signature");

    const text = said(result);
    expect(text).toContain("✅ locations/yard/sets/a — 3 posed frames at 1280×720 from 3 pictures, ~$0.1 (estimate (operator))");
    expect(text).toContain("licence: paid access, as the operator states it");
    expect(text).toContain(`next: ${LOCATION_VIEWS_TOOL}`);
    if (!WIRE.verifiedLive) expect(text).toContain("have not yet run against the service");
    expect(existsSync(join(setDir, "jobs"))).toBe(false);
  });

  it("records an unpriced step as unpriced when the film has no budget, and marks an unstated plan as not for commercial use", async () => {
    const result = await pose();
    expect(reserved()[0]).toMatchObject({ priced: false, estimate: { micros: 0 } });
    expect(record().posed).toMatchObject({ costUsd: null, costBasis: "unknown" });
    expect(said(result)).toContain("cost not known: see the account's Usage page");
    expect(said(result)).toContain("⚠️ licence: no plan stated in .render/worldlabs-atlas.json — personal, non-commercial use only");
    expect(JSON.parse(readFileSync(join(setDir, "licence.json"), "utf-8"))).toMatchObject({ plan: "unstated", access: "Low-Tier Access", commercialUse: false });
  });

  it("is posed once on the grid it is given, says which pictures that crops, and asks for refined cameras when told to", async () => {
    writeFileSync(join(filmDir, "locations", "yard", "photos", "tall.png"), png(720, 1280, "tall"));
    const result = await pose({ pictures: [PICTURES[0], "locations/yard/photos/tall.png"], size: "960x720", refinePoses: true });
    expect(only("images2PosedRGBD").body).toMatchObject({ targetResolution: [960, 720], refinePoses: true });
    expect(record()).toMatchObject({ size: "960x720", posed: { poseRefinementAccepted: true } });
    expect(said(result)).toContain("2 posed frames at 960×720");
    expect(said(result)).toContain("⚠️ not 960×720 in shape, so cropped to it: locations/yard/photos/gate.png, locations/yard/photos/tall.png");
    await expect(pose()).rejects.toThrow("locations/yard/sets/a already has its posed frames");
  });

  describe("once posed", () => {
    beforeEach(async () => {
      account();
      await pose();
    });

    it("makes a draft first, and the refined one only after it and on the operator's word", async () => {
      await expect(run(LOCATION_SPLAT_TOOL, { quality: "refined", approvedBy: "the operator, in chat" })).rejects.toThrow("a refined splat is made after a draft of the same set");
      expect(fake.submitted("posedImages2Splats")).toEqual([]);

      const draft = await run(LOCATION_SPLAT_TOOL);
      const body = only("posedImages2Splats").body as { posedFrames: Record<string, unknown>[]; refine: boolean };
      expect(body.refine).toBe(false);
      expect(body.posedFrames).toHaveLength(3);
      // Each frame as the task takes it: image, camera and depth by their assets' ids, and nothing the schema refuses.
      expect(Object.keys(body.posedFrames[0]!).sort()).toEqual(["camera", "depth", "imageAsset"]);
      expect(body.posedFrames[0]).toMatchObject({ imageAsset: { assetId: "asset_0001" }, depth: { depthAsset: { assetId: expect.stringMatching(/^asset_/) } } });
      expect(JSON.stringify(body)).not.toContain("X-Signature");
      expect(readFileSync(join(setDir, "draft.spz"), "utf-8")).toBe("a draft splat");
      expect(reserved().at(-1)).toMatchObject({ capability: "world.reconstruct", profile: "worldlabs-atlas/posedImages2Splats.draft", estimate: { micros: toMicros(0.5) } });
      expect(settled().at(-1)).toMatchObject({ cost: { micros: toMicros(0.5) }, basis: "estimate" });
      expect(record().splats.draft).toMatchObject({ file: "draft.spz", frames: 3, splats: null, withViews: [], costUsd: 0.5, costBasis: "estimate (published)", assetId: expect.stringMatching(/^asset_/) });
      expect(said(draft)).toContain("✅ locations/yard/sets/a/draft.spz — a draft splat from 3 frames");
      expect(said(draft)).toContain("3 frames is few for a room");
      expect(said(draft)).toContain('ask the operator before pva_location_splat { quality: "refined", approvedBy } (~$5 (5000 credits, published), 15–21 minutes)');

      await expect(run(LOCATION_SPLAT_TOOL)).rejects.toThrow("draft.spz already exists: a draft splat is made once");
      await expect(run(LOCATION_SPLAT_TOOL, { quality: "refined" })).rejects.toThrow("a refined splat needs the operator's go-ahead");
      await expect(run(LOCATION_SPLAT_TOOL, { quality: "refined", approvedBy: " " })).rejects.toThrow("Do not approve it yourself");
      expect(fake.submitted("posedImages2Splats")).toHaveLength(1);

      const refined = await run(LOCATION_SPLAT_TOOL, { quality: "refined", approvedBy: "the operator, in chat, after the draft's views" });
      expect(fake.submitted("posedImages2Splats")[1]!.body).toMatchObject({ refine: true });
      expect(settled().at(-1)).toMatchObject({ cost: { micros: toMicros(5) }, basis: "estimate" });
      expect(readFileSync(join(setDir, "refined.spz"), "utf-8")).toBe("a refined splat");
      expect(record().splats.refined).toMatchObject({ file: "refined.spz", splats: 2_000_000, approvedBy: "the operator, in chat, after the draft's views", costUsd: 5 });
      expect(said(refined)).toContain("2,000,000 splats");
      expect(said(refined)).toContain("approved by: the operator, in chat, after the draft's views");
      // The draft is still there: nothing was written over.
      expect(readFileSync(join(setDir, "draft.spz"), "utf-8")).toBe("a draft splat");
    });

    it("stops at the film's budget before a splat is asked for", async () => {
      budget(0.3);
      await expect(run(LOCATION_SPLAT_TOOL)).rejects.toThrow(/budget/);
      expect(fake.submitted("posedImages2Splats")).toEqual([]);
      expect(existsSync(join(setDir, "draft.spz"))).toBe(false);
    });

    it("renders views all round the place with depth, priced per view, and keeps the stills and their frames", async () => {
      const result = await run(LOCATION_VIEWS_TOOL, { viewsId: "around", path: "orbit", count: 7, prompt: "a yard at night, sodium light" });
      const body = only("atlasGenerate").body as { contextFrames: Record<string, unknown>[]; targetCameras: { extrinsics: { position: number[]; quaternion: number[]; coordinateSystem: string }; intrinsics: { width: number; height: number } }[]; prompt: string; returnDepth: boolean; enhancePrompt?: boolean };
      expect(body.contextFrames).toHaveLength(3);
      expect(Object.keys(body.contextFrames[0]!).sort()).toEqual(["camera", "depth", "imageAsset"]);
      // Seven views every 45° round what the first frame looks at, at its own height: the frame's own position is not paid for again.
      expect(body.targetCameras).toHaveLength(7);
      expect(body.targetCameras[0]!.intrinsics).toMatchObject({ width: 1280, height: 720 });
      expect(body.targetCameras[0]!.extrinsics.coordinateSystem).toBe("rub");
      for (const camera of body.targetCameras) {
        expect(Math.hypot(camera.extrinsics.position[0]!, camera.extrinsics.position[2]!)).toBeCloseTo(3, 6);
        expect(camera.extrinsics.position[1]).toBeCloseTo(1.5, 6);
      }
      expect(body.targetCameras[0]!.extrinsics.position[0]).toBeCloseTo(3 * Math.sin(Math.PI / 4), 6);
      expect(body).toMatchObject({ prompt: "a yard at night, sodium light", returnDepth: true });
      expect(body).not.toHaveProperty("enhancePrompt");
      expect(reserved().at(-1)).toMatchObject({ capability: "world.render", profile: "worldlabs-atlas/atlasGenerate.perView", estimate: { micros: toMicros(0.35) } });

      const viewsDir = join(setDir, "views", "around");
      // Frames are JPEG, whatever they are asked as: the name follows the bytes.
      expect(readdirSync(viewsDir).sort()).toEqual(["000001.jpg", "000002.jpg", "000003.jpg", "000004.jpg", "000005.jpg", "000006.jpg", "000007.jpg", "views.json"]);
      const views = JSON.parse(readFileSync(join(viewsDir, "views.json"), "utf-8"));
      expect(views).toMatchObject({ viewsId: "around", path: "orbit", width: 1280, height: 720, depth: true, promptUsed: "enhanced: a yard at night, sodium light" });
      expect(views.frames).toHaveLength(7);
      expect(views.frames[0]).toHaveProperty("depth.depthAsset.assetId");
      expect(record().views.around).toMatchObject({ dir: "views/around", frames: 7, width: 1280, height: 720, depth: true, path: "an orbit of 360° in 7 views from frame 1" });
      // The scene in Atlas's words is kept, to be given back.
      expect(record().prompt).toBe("enhanced: a yard at night, sodium light");
      const text = said(result);
      expect(text).toContain("✅ locations/yard/sets/a/views/around/ — 7 stills at 1280×720, with depth");
      expect(text).toContain("720p: a reference to hold a shot to");
      expect(text).toContain("Atlas invents what no picture showed");
      expect(text).toContain('pva_location_splat { withViews: ["around"] }');

      await expect(run(LOCATION_VIEWS_TOOL, { viewsId: "around", path: "orbit" })).rejects.toThrow("views are made once, pick another viewsId");
      expect(fake.submitted("atlasGenerate")).toHaveLength(1);

      // Later views are shown the earlier ones, and told the scene in the words already found: no second captioning.
      await run(LOCATION_VIEWS_TOOL, { viewsId: "gap", path: "push", distance: 1, count: 2, contextViews: ["around"] });
      expect(fake.submitted("atlasGenerate")[1]!.body).toMatchObject({ prompt: "enhanced: a yard at night, sodium light", enhancePrompt: false });
      expect((fake.submitted("atlasGenerate")[1]!.body as { contextFrames: unknown[] }).contextFrames).toHaveLength(10);
    });

    it("joins a camera path into a plate, without depth, at the size asked", async () => {
      const result = await run(LOCATION_VIEWS_TOOL, { viewsId: "move", path: "orbit", count: 4, size: "960x720", plate: true, fps: 25 });
      const body = only("atlasGenerate").body as { targetCameras: { intrinsics: { width: number } }[]; returnDepth: boolean };
      expect(body.returnDepth).toBe(false);
      expect(body.targetCameras).toHaveLength(4);
      expect(body.targetCameras[0]!.intrinsics.width).toBe(960);
      const viewsDir = join(setDir, "views", "move");
      expect(readdirSync(viewsDir).sort()).toEqual(["000001.jpg", "000002.jpg", "000003.jpg", "000004.jpg", "plate.mp4", "views.json"]);
      expect(readFileSync(join(viewsDir, "plate.mp4"), "utf-8")).toBe("a plate at 25 fps from %06d.jpg");
      expect(record().views.move).toMatchObject({ frames: 4, width: 960, height: 720, depth: false, plate: "plate.mp4", path: "an orbit of 60° in 4 views from frame 1" });
      expect(said(result)).toContain("made without depth: for looking at and for a plate, not for a splat");
      // A plate's frames have no depth: they are not a splat's, and not context.
      await expect(run(LOCATION_SPLAT_TOOL, { withViews: ["move"] })).rejects.toThrow("views move were made without depth (a plate): a splat's frames need depth");
      await expect(run(LOCATION_VIEWS_TOOL, { viewsId: "x", path: "orbit", contextViews: ["move"] })).rejects.toThrow("views move were made without depth, so they cannot be context");
      expect(fake.submitted("posedImages2Splats")).toEqual([]);
    });

    it("takes a push or cameras given in full, and refuses a path it cannot build before anything is paid", async () => {
      await run(LOCATION_VIEWS_TOOL, { viewsId: "in", path: "push", from: 2, distance: 1.5, count: 3 });
      expect((fake.submitted("atlasGenerate")[0]!.body as { targetCameras: unknown[] }).targetCameras).toHaveLength(3);
      expect(record().views.in.path).toBe("a push of 1.5 in 3 views from frame 2");
      await run(LOCATION_VIEWS_TOOL, { viewsId: "two", path: "cameras", cameras: [{ at: [0, 1.6, 4], lookAt: [0, 1, 0] }, { at: [4, 1.6, 0], lookAt: [0, 1, 0], fov: 35 }] });
      expect(record().views.two).toMatchObject({ frames: 2, width: 1280, height: 720, path: "2 cameras given in full" });

      const before = fake.requests.length;
      await expect(run(LOCATION_VIEWS_TOOL, { viewsId: "x", path: "push" })).rejects.toThrow('path "push" needs `distance`');
      await expect(run(LOCATION_VIEWS_TOOL, { viewsId: "x", path: "orbit", from: 9 })).rejects.toThrow("from is 9, and the set has 3 posed frames");
      await expect(run(LOCATION_VIEWS_TOOL, { viewsId: "x", path: "cameras" })).rejects.toThrow('path "cameras" needs `cameras`');
      await expect(run(LOCATION_VIEWS_TOOL, { viewsId: "x", path: "orbit", contextViews: ["none"] })).rejects.toThrow("the set has no views named none: its views are in, two");
      await expect(run(LOCATION_VIEWS_TOOL, { viewsId: "Bad Id", path: "orbit" })).rejects.toThrow("viewsId is lower-case");
      process.env.FFMPEG_BIN = join(root, "no-such-ffmpeg");
      await expect(run(LOCATION_VIEWS_TOOL, { viewsId: "x", path: "orbit", plate: true })).rejects.toThrow("a plate is joined with FFmpeg, and it was not found");
      expect(fake.requests.length).toBe(before);
    });

    it("adds to a splat the frames of views that have depth and the set's size, and no others", async () => {
      await run(LOCATION_VIEWS_TOOL, { viewsId: "around", path: "orbit", count: 5 });
      await run(LOCATION_VIEWS_TOOL, { viewsId: "wide", path: "orbit", count: 2, size: "960x720" });
      await expect(run(LOCATION_SPLAT_TOOL, { withViews: ["behind"] })).rejects.toThrow("the set has no views named behind: its views are around, wide");
      await expect(run(LOCATION_SPLAT_TOOL, { withViews: ["wide"] })).rejects.toThrow("views wide are 960×720 and the set is 1280×720: every frame of a splat is on one grid");
      await run(LOCATION_SPLAT_TOOL, { withViews: ["around"] });
      const body = only("posedImages2Splats").body as { posedFrames: Record<string, unknown>[]; prompt?: string; enhancePrompt?: boolean };
      expect(body.posedFrames).toHaveLength(8);
      expect(body.posedFrames.every((frame) => Object.keys(frame).sort().join() === "camera,depth,imageAsset")).toBe(true);
      // The scene, already described by the render, is not captioned again.
      expect(body).toMatchObject({ prompt: "enhanced: the place in the pictures", enhancePrompt: false });
      expect(record().splats.draft).toMatchObject({ frames: 8, withViews: ["around"] });
    });

    it("holds a draft to the 32 frames a draft takes", async () => {
      await run(LOCATION_VIEWS_TOOL, { viewsId: "many", path: "orbit", count: 30 });
      await expect(run(LOCATION_SPLAT_TOOL, { withViews: ["many"] })).rejects.toThrow("a draft splat takes at most 32 frames, and this would be 33: name fewer views");
      expect(fake.submitted("posedImages2Splats")).toEqual([]);
    });

    it("makes a mesh from the splat by its asset, reads what it holds, and says how to stage in it", async () => {
      await expect(run(LOCATION_MESH_TOOL)).rejects.toThrow("locations/yard/sets/a has no draft splat");
      await run(LOCATION_SPLAT_TOOL);
      const uploads = () => fake.requests.filter((r) => r.path.endsWith(":createUploadUrl")).length;
      const before = uploads();
      const result = await run(LOCATION_MESH_TOOL, { texture: "vertex_color", targetFaces: 40_000 });
      expect(only("splats2Mesh").body).toEqual({ splatAsset: { assetId: record().splats.draft.assetId }, textureMode: "vertex_color", targetFaces: 40_000 });
      // Named, not sent again: the splat is in the project.
      expect(uploads()).toBe(before);
      expect(readFileSync(join(setDir, "draft.glb")).subarray(0, 4).toString()).toBe("glTF");
      expect(reserved().at(-1)).toMatchObject({ capability: "world.mesh", profile: "worldlabs-atlas/splats2Mesh", estimate: { micros: toMicros(1) } });
      expect(record().meshes.draft).toMatchObject({ file: "draft.glb", from: "draft", texture: "vertex_color", targetFaces: 40_000, assetId: expect.stringMatching(/^asset_/), holds: { format: "glb", meshes: 1, triangles: 1, joints: 0 } });
      const text = said(result);
      expect(text).toContain("✅ locations/yard/sets/a/draft.glb");
      expect(text).toContain("1 triangle, 1 mesh");
      expect(text).toContain('locationSet: { location: "yard", set: "a", mesh: "draft" }');
      expect(text).toContain("its size is Atlas's estimate of metres");

      await expect(run(LOCATION_MESH_TOOL)).rejects.toThrow("draft.glb already exists: a mesh is made once, pick another meshId");
      await run(LOCATION_MESH_TOOL, { meshId: "object", cameras: "exterior_sphere", texture: "image_texture", textureSize: 2048 });
      expect(fake.submitted("splats2Mesh")[1]!.body).toMatchObject({ cameras: { strategy: "exterior_sphere" }, textureMode: "image_texture", textureSize: 2048 });
      expect(Object.keys(record().meshes).sort()).toEqual(["draft", "object"]);
    });

    it("leaves a job that outlasts the wait written in the set, and takes it up again without paying twice", async () => {
      account({ plan: "paid", credits: OWN_CREDITS, maxWaitMinutes: 1 });
      atlas({ looksUntilDone: 8 });
      // The posed frames of the fake before are in posed.json: the new fake only has to accept them.
      const failure = await failed(run(LOCATION_SPLAT_TOOL));
      const operationId = only("posedImages2Splats").id;
      expect(failure.message).toContain(`Atlas operation ${operationId} did not finish within 60s: it is still running there, and may be charged`);
      expect(failure.message).toContain("The job is written in locations/yard/sets/a/jobs/splat-draft.json: call this tool again with the same arguments to wait for it without paying twice");
      const job = JSON.parse(readFileSync(join(setDir, "jobs", "splat-draft.json"), "utf-8"));
      expect(job).toMatchObject({ step: "splat-draft", task: "posedImages2Splats", operationId, price: { credits: 500 }, request: { refine: false }, reserveId: expect.any(String) });
      // It left, and may be charged: the reservation was settled at the estimate, not released.
      expect(ledger().slice(-2)).toEqual(["spend-reserved", "spend-settled"]);
      expect(settled().at(-1)).toMatchObject({ cost: { micros: toMicros(0.5) }, basis: "estimate" });
      expect(existsSync(join(setDir, "draft.spz"))).toBe(false);

      const listed = said(await run(LOCATION_SETS_TOOL));
      expect(listed).toContain(`⏳ job splat-draft: Atlas operation ${operationId}`);
      expect(listed).toContain(": running at Atlas");

      const events = ledger().length;
      const updates: string[] = [];
      const result = await run(LOCATION_SPLAT_TOOL, {}, (u) => updates.push((u as { content: { text: string }[] }).content[0]!.text));
      expect(updates[0]).toContain(`Taking up Atlas operation ${operationId} again (splat-draft, submitted `);
      expect(updates[0]).toContain("nothing is submitted, nothing more is reserved");
      expect(said(result)).toContain("(a job taken up again)");
      expect(readFileSync(join(setDir, "draft.spz"), "utf-8")).toBe("a draft splat");
      expect(fake.submitted("posedImages2Splats")).toHaveLength(1);
      expect(ledger().length).toBe(events);
      expect(existsSync(join(setDir, "jobs"))).toBe(false);
      expect(JSON.parse(readFileSync(join(setDir, "provenance", `${operationId}.json`), "utf-8"))).toMatchObject({ resumed: true, request: { refine: false } });
    });

    it("gets the same job back from Atlas when its note here was lost: the same work has the same name", async () => {
      account({ plan: "paid", credits: OWN_CREDITS, maxWaitMinutes: 1 });
      atlas({ looksUntilDone: 8 });
      await run(LOCATION_SPLAT_TOOL).catch(() => undefined);
      const first = only("posedImages2Splats").id;
      // A session that died before it could write the job down, or a set restored from a copy without it.
      rmSync(join(setDir, "jobs"), { recursive: true, force: true });
      const result = await run(LOCATION_SPLAT_TOOL);
      expect(said(result)).toContain("✅ locations/yard/sets/a/draft.spz");
      // Asked again, under the same key: Atlas answered with the operation it already had.
      expect(submissions().map((r) => r.headers["idempotency-key"])).toEqual([expect.stringMatching(/^sergio-/), submissions()[0]!.headers["idempotency-key"]]);
      expect(fake.submitted("posedImages2Splats")).toHaveLength(1);
      expect(record().splats.draft.operationId).toBe(first);
    });

    it("keeps a job that finished until what it made is on this machine: a download that fails is a second call, not a second payment", async () => {
      const fetchBytes = fake.fetchBytes;
      let broken = true;
      Object.defineProperty(fake, "fetchBytes", { get: () => (async (url: string) => { if (broken) throw new Error("the connection dropped"); return fetchBytes(url); }) });
      atlasWith(fake);
      await expect(run(LOCATION_SPLAT_TOOL)).rejects.toThrow("the connection dropped");
      expect(existsSync(join(setDir, "jobs", "splat-draft.json"))).toBe(true);
      expect(record().splats).toEqual({});
      // The job itself finished: it is settled, whatever became of the download.
      expect(settled().at(-1)).toMatchObject({ cost: { micros: toMicros(0.5) }, basis: "estimate" });
      const events = ledger().length;

      broken = false;
      const result = await run(LOCATION_SPLAT_TOOL);
      expect(said(result)).toContain("(a job taken up again)");
      expect(readFileSync(join(setDir, "draft.spz"), "utf-8")).toBe("a draft splat");
      expect(fake.submitted("posedImages2Splats")).toHaveLength(1);
      expect(ledger().length).toBe(events);
      expect(existsSync(join(setDir, "jobs"))).toBe(false);
    });

    it("leaves a job running when the call is interrupted, and does not stop it unasked", async () => {
      atlas({ looksUntilDone: 50 });
      const controller = new AbortController();
      const waiting = tools[LOCATION_SPLAT_TOOL]!.execute("call", WHERE, controller.signal, (u: unknown) => {
        if ((u as { content: { text: string }[] }).content[0]!.text.startsWith("Atlas operation")) controller.abort();
      }, {});
      const failure = await failed(waiting);
      const operation = only("posedImages2Splats");
      expect(failure.message).toContain(`stopped waiting for Atlas operation ${operation.id}: it is still running there, and may be charged`);
      expect(failure.message).toContain("call this tool again with the same arguments");
      expect(operation.done).toBe(false);
      expect(fake.requests.some((r) => r.path.endsWith(":cancel"))).toBe(false);
      expect(existsSync(join(setDir, "jobs", "splat-draft.json"))).toBe(true);
    });

    it("does not hand a running job to a call that asks for something else", async () => {
      account({ plan: "paid", credits: OWN_CREDITS, maxWaitMinutes: 1 });
      atlas({ looksUntilDone: 50 });
      await run(LOCATION_VIEWS_TOOL, { viewsId: "around", path: "orbit", count: 3 }).catch(() => undefined);
      expect(existsSync(join(setDir, "jobs", "views-around.json"))).toBe(true);
      const failure = await failed(run(LOCATION_VIEWS_TOOL, { viewsId: "around", path: "orbit", count: 5 }));
      expect(failure.message).toContain(`already has a job for this step (views-around, Atlas operation ${only("atlasGenerate").id}`);
      expect(failure.message).toContain("it was asked for something else");
      expect(fake.submitted("atlasGenerate")).toHaveLength(1);
    });

    it("closes the reservation of a job whose session ended while it waited, when the job is collected", async () => {
      // What a session that died mid-wait leaves: a reservation nobody closed, and the job's note with its id.
      atlas({ looksUntilDone: 3 });
      const ref = { channel: FILM, series: "_", episode: "_" };
      const open = await reserveSpend(filmDir, { episode: ref, capability: "world.reconstruct", provider: "worldlabs-atlas", profile: "worldlabs-atlas/posedImages2Splats.draft", purpose: "a draft, by a session that ended", estimate: { currency: "USD", micros: toMicros(0.5) } });
      if (!open.ok) throw new Error(open.reason);
      const request = { posedFrames: JSON.parse(readFileSync(join(setDir, "posed.json"), "utf-8")).frames.map(({ centroidWorld: _centroid, ...frame }: Record<string, unknown>) => frame), refine: false };
      const operation = await new AtlasClient({ config: { apiKey: "k", baseUrl: FAKE_API_ROOT, maxRetries: 0 }, transport: fake.transport }).submit("posedImages2Splats", request);
      mkdirSync(join(setDir, "jobs"), { recursive: true });
      writeFileSync(join(setDir, "jobs", "splat-draft.json"), JSON.stringify({
        step: "splat-draft", task: "posedImages2Splats", operationId: operation.id, reserveId: open.reserveId, submittedAt: "2026-11-25T10:00:00.000Z",
        asked: createHash("sha256").update(JSON.stringify({ quality: "draft", withViews: [] })).digest("hex"),
        price: estimate("posedImages2Splats", { refine: false }), request,
      }));
      expect(ledger().at(-1)).toBe("spend-reserved");

      await run(LOCATION_SPLAT_TOOL);
      expect(ledger().slice(-2)).toEqual(["spend-reserved", "spend-settled"]);
      expect(settled().at(-1)).toMatchObject({ cost: { micros: toMicros(0.5) }, basis: "estimate", providerRequestId: operation.id });
      expect(readFileSync(join(setDir, "draft.spz"), "utf-8")).toBe("a draft splat");
      expect(fake.submitted("posedImages2Splats")).toHaveLength(1);
    });

    it("writes its own step into the set's record as the record is by then, not as it was when the step began", async () => {
      // While the views are being made, another step finishes and writes its result.
      const original = fake.fetchBytes;
      let once = true;
      Object.defineProperty(fake, "fetchBytes", { get: () => (async (url: string) => {
        if (once) {
          once = false;
          const now = record();
          now.splats.draft = { file: "draft.spz", written: "by another step, meanwhile" };
          writeFileSync(join(setDir, "set.json"), JSON.stringify(now));
        }
        return original(url);
      }) });
      atlasWith(fake);
      await run(LOCATION_VIEWS_TOOL, { viewsId: "around", path: "orbit", count: 2 });
      expect(record().views.around).toMatchObject({ frames: 2 });
      expect(record().splats.draft).toEqual({ file: "draft.spz", written: "by another step, meanwhile" });
    });

    it("spends nothing on what Atlas turns away — too many requests, no credits, a wrong request — or on a call interrupted before it left", async () => {
      for (const [refusal, said_] of [[429, /HTTP 429/], [{ status: 402, code: "SPEND_LIMIT_EXCEEDED" }, /out of credits or at a spend limit \(SPEND_LIMIT_EXCEEDED\)/], [422, /HTTP 422/]] as const) {
        atlas({ refusing: { posedImages2Splats: refusal } });
        await expect(run(LOCATION_SPLAT_TOOL)).rejects.toThrow(said_);
        expect(ledger().slice(-2)).toEqual(["spend-reserved", "spend-released"]);
        expect(existsSync(join(setDir, "jobs"))).toBe(false);
      }

      atlas();
      const controller = new AbortController();
      controller.abort();
      await expect(tools[LOCATION_SPLAT_TOOL]!.execute("call", WHERE, controller.signal, undefined, {})).rejects.toThrow("interrupted before anything was sent to Atlas: nothing was submitted or spent");
      expect(ledger().slice(-2)).toEqual(["spend-reserved", "spend-released"]);
      expect(fake.requests).toEqual([]);
    });

    it("releases what was reserved for a splat that failed, which Atlas says is free; and keeps it for a failure Atlas says nothing about", async () => {
      atlas({ failing: { posedImages2Splats: { reason: "EXECUTION_FAILED", message: "The task failed during execution." } } });
      await expect(run(LOCATION_SPLAT_TOOL)).rejects.toThrow(/failed \(EXECUTION_FAILED\): The task failed during execution\./);
      expect(ledger().slice(-2)).toEqual(["spend-reserved", "spend-released"]);
      // It ended there: there is nothing to take up, and the step can be asked for again.
      expect(existsSync(join(setDir, "jobs"))).toBe(false);
      expect(record().splats).toEqual({});

      atlas({ failing: { atlasGenerate: { reason: "THROTTLED", message: "No capacity." } } });
      await expect(run(LOCATION_VIEWS_TOOL, { viewsId: "v", path: "orbit", count: 2 })).rejects.toThrow(/failed \(THROTTLED\)/);
      // Nothing says a failed render is free: the budget keeps counting it until someone looks at the account.
      expect(ledger().slice(-2)).toEqual(["spend-reserved", "spend-settled"]);
      expect(settled().at(-1)).toMatchObject({ basis: "estimate" });
      expect(existsSync(join(setDir, "jobs"))).toBe(false);
    });

    it("stops a job at Atlas when told to, and forgets it", async () => {
      account({ plan: "paid", credits: OWN_CREDITS, maxWaitMinutes: 1 });
      atlas({ looksUntilDone: 50 });
      await run(LOCATION_SPLAT_TOOL).catch(() => undefined);
      const operation = only("posedImages2Splats");
      await expect(run(LOCATION_SETS_TOOL, { cancel: { location: "yard", set: "a", step: "mesh-draft" } })).rejects.toThrow("has no job named mesh-draft: its jobs are splat-draft");
      const text = said(await run(LOCATION_SETS_TOOL, { cancel: { location: "yard", set: "a", step: "splat-draft" } }));
      expect(text).toContain(`🛑 asked Atlas to stop ${operation.id} (locations/yard/sets/a, splat-draft): it is now cancelled`);
      expect(fake.requests.find((r) => r.path.endsWith(":cancel"))!.body).toMatchObject({ requestId: expect.stringMatching(/^cancel-op_/), reason: "stopped from the studio" });
      expect(operation.cancelled).toBe(true);
      expect(existsSync(join(setDir, "jobs"))).toBe(false);
      expect(text).not.toContain("⏳");
    });

    it("drops the note of a job Atlas will not stop, so the step is not stuck behind it", async () => {
      account({ plan: "paid", credits: OWN_CREDITS, maxWaitMinutes: 1 });
      atlas({ looksUntilDone: 50 });
      await run(LOCATION_SPLAT_TOOL).catch(() => undefined);
      fake.interruptions.push({ status: 403, code: "FORBIDDEN" });
      const text = said(await run(LOCATION_SETS_TOOL, { cancel: { location: "yard", set: "a", step: "splat-draft" } }));
      expect(text).toContain(`🛑 Atlas would not stop ${only("posedImages2Splats").id} (HTTP 403: the key lacks operations.cancel). Its note is dropped`);
      expect(existsSync(join(setDir, "jobs"))).toBe(false);
    });

    it("lists what a film's sets hold, what they are taken to have cost, their licence, and what each step is priced at", async () => {
      await run(LOCATION_SPLAT_TOOL);
      await run(LOCATION_MESH_TOOL);
      const text = said(await run(LOCATION_SETS_TOOL));
      expect(text).toContain("locations/yard/sets/a — 3 pictures at 1280×720; 3 posed frames; about $1.6 at the prices known");
      expect(text).toContain("draft.spz: draft splat from 3 frames");
      expect(text).toContain("draft.glb: mesh draft from the draft splat, 1 triangle");
      expect(text).toContain("licence: plan paid, yours to use, commercially too");
      expect(text).toContain("posedImages2Splats.refined: 5000 credits ($5), published");
      expect(text).toContain("splats2Mesh: 1000 credits ($1), the operator's");
      expect(text).toContain("atlasChisel: not known");
      expect(said(await run(LOCATION_SETS_TOOL, { location: "harbour" }))).toContain("night-shift has no location sets for harbour");
      await expect(run(LOCATION_SETS_TOOL, { film: "sample-channel" })).rejects.toThrow("sample-channel is not a film");
    });
  });

  it("needs a set to be posed before anything else is asked of it", async () => {
    for (const [tool, params] of [[LOCATION_SPLAT_TOOL, {}], [LOCATION_MESH_TOOL, {}], [LOCATION_VIEWS_TOOL, { viewsId: "v", path: "orbit" }]] as const) {
      await expect(run(tool, params)).rejects.toThrow(`locations/yard/sets/a has no posed frames yet: start it with ${LOCATION_SET_TOOL}`);
    }
    expect(fake.requests).toEqual([]);
  });

  it("starts from one picture as Atlas's own guide does: pose it, render views round it, and make the splat of both", async () => {
    const posed = await pose({ pictures: [PICTURES[0]] });
    expect(said(posed)).toContain("one picture: about half its field of view to either side");
    await expect(run(LOCATION_SPLAT_TOOL)).rejects.toThrow(`a splat needs at least 2 frames, and the set has 1: render views first (${LOCATION_VIEWS_TOOL}) and name them in withViews`);
    await run(LOCATION_VIEWS_TOOL, { viewsId: "around", path: "orbit", count: 7 });
    await run(LOCATION_SPLAT_TOOL, { withViews: ["around"] });
    expect(record().splats.draft.frames).toBe(8);
  });
});
