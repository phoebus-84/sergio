// ---------------------------------------------------------------------------
// A location's 3D set: the tools, the film's ledger, and what is kept
// ---------------------------------------------------------------------------
// The real tools against FakeAtlas, an Atlas in memory behind the package's
// own client: nothing leaves the machine, nothing is spent and nothing waits.
// The fake speaks the request shapes this studio guessed (ADR-0057), so these
// tests fix what the tools do with money, files and jobs, not what the real
// service answers.
//
// Every price is computed from @av/worldlabs-atlas or from the operator's
// file written here: the tools hold none of their own.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtlasClient, FAKE_HOST, FakeAtlas, NoopSleeper, WIRE, estimate, type FakeAtlasOptions } from "@av/worldlabs-atlas";
import { toMicros } from "@studio/contracts/src/budget.mjs";
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

  it("marks a set for commercial use only under a plan stated as paid", () => {
    const base = { credits: {}, maxWaitMinutes: 45, problems: [] };
    expect(licenceOf({ ...base, plan: "paid" })).toMatchObject({ plan: "paid", commercialUse: true, termsReadByStudio: false, statedBy: expect.stringContaining("the operator") });
    expect(licenceOf({ ...base, plan: "free" })).toMatchObject({ plan: "free", commercialUse: false, basis: expect.stringContaining("non-commercial") });
    expect(licenceOf({ ...base, plan: null })).toMatchObject({ plan: "unstated", commercialUse: false, statedBy: null, basis: expect.stringContaining("treated as a free account's") });
  });

  it("is reported by the capability status: wired and unverified, with what has no price", () => {
    expect(locationSetsStatus(false, readAtlasSettings(root))["location-sets"]).toEqual({ available: false, detail: "WORLDLABS_API_KEY not set" });
    const bare = locationSetsStatus(true, readAtlasSettings(root))["location-sets"];
    expect(bare.available).toBe(true);
    expect(bare.detail).toContain("no price for images2PosedRGBD, splats2Mesh, atlasGenerate.perView");
    expect(bare.detail).toContain("sets are marked not for commercial use");
    expect(bare.detail).toContain("720p at most");
    expect(bare.detail).toContain(WIRE.verifiedLive ? "verified against the live API" : "wired, not yet verified against the live API");
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
        config: { apiKey: "wl-test-key", baseUrl: FAKE_HOST, maxRetries: 0 }, transport: fake.transport, fetchBytes: fake.fetchBytes, sleeper: new NoopSleeper(), ...(onEvent ? { onEvent } : {}),
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
    writeFileSync(join(root, "ffmpeg.mjs"), "#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nif (!process.argv.includes('-version')) writeFileSync(process.argv.at(-1), 'a plate at ' + process.argv[process.argv.indexOf('-framerate') + 1] + ' fps');\n");
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

  it("is five tools that say what they cost, what comes first and what 720p is for", () => {
    expect(Object.keys(tools).sort()).toEqual([LOCATION_MESH_TOOL, LOCATION_SET_TOOL, LOCATION_SETS_TOOL, LOCATION_SPLAT_TOOL, LOCATION_VIEWS_TOOL].sort());
    const splat = tools[LOCATION_SPLAT_TOOL]!.description;
    expect(splat).toContain(`"draft" ($${estimate("posedImages2Splats", { refine: false }).usd}, published`);
    expect(splat).toContain(`"refined" ($${estimate("posedImages2Splats", { refine: true }).usd}, published`);
    expect(splat).toContain("only when the operator has said so");
    expect(splat).toContain("Never decide it yourself");
    expect(tools[LOCATION_VIEWS_TOOL]!.description).toContain("never a film's final picture");
    expect(JSON.stringify(tools[LOCATION_VIEWS_TOOL]!.parameters)).toContain('"1280x720"');
    expect(JSON.stringify(tools[LOCATION_VIEWS_TOOL]!.parameters)).not.toContain("1920");
    expect(tools[LOCATION_SET_TOOL]!.description).toContain("world.reconstruct");
    expect(tools[LOCATION_MESH_TOOL]!.description).toContain("world.mesh");
  });

  it("belongs to a film, and reads its pictures from inside it", async () => {
    await expect(run(LOCATION_SET_TOOL, { film: "sample-channel", pictures: PICTURES })).rejects.toThrow("sample-channel is not a film: a location's set belongs to a film");
    await expect(pose({ set: "A set" })).rejects.toThrow('set is a slug');
    await expect(pose({ pictures: ["../sample-channel/secret.png"] })).rejects.toThrow();
    await expect(pose({ pictures: ["locations/yard/photos/none.png"] })).rejects.toThrow("Picture not found in the film: locations/yard/photos/none.png");
    await expect(pose({ pictures: ["locations/yard/photos/notes.txt"] })).rejects.toThrow("Unsupported picture type");
    await expect(pose({ pictures: [PICTURES[0], PICTURES[0]] })).rejects.toThrow("a picture is named twice");
    expect(fake.requests).toEqual([]);
    expect(existsSync(setDir)).toBe(false);
  });

  it("refuses a step nobody priced when the film has a budget, and says where the price goes", async () => {
    budget(20);
    const failure = await failed(pose());
    expect(failure.message).toContain("No price is known for worldlabs-atlas/images2PosedRGBD");
    expect(failure.message).toContain(`library/${ATLAS_SETTINGS_RELATIVE} as { "credits": { "images2PosedRGBD": <credits> } }`);
    expect(fake.requests).toEqual([]);
    expect(ledger()).toEqual([]);
    // A set that was never reserved was never begun.
    expect(existsSync(setDir)).toBe(false);
  });

  it("poses the pictures at the operator's price, and keeps the frames, the depth maps, the licence and how it was made", async () => {
    budget(20);
    account();
    const updates: string[] = [];
    const result = await pose({}, (u) => updates.push((u as { content: { text: string }[] }).content[0]!.text));

    expect(fake.requests.filter((r) => r.path.endsWith(":createUploadUrl")).map((r) => (r.body as { fileName: string }).fileName)).toEqual(["picture-001.png", "picture-002.png", "picture-003.png"]);
    expect(fake.submitted("images2PosedRGBD")[0]!.body).toEqual({ images: [{ assetId: "asset-0001" }, { assetId: "asset-0002" }, { assetId: "asset-0003" }] });
    expect(updates[0]).toBe("Uploading locations/yard/photos/gate.png (1/3)…");
    expect(updates).toContain("Submitting location yard, set a: pose 3 pictures to Atlas (tasks:images2PosedRGBD, ~$0.1 (100 credits, the operator's price))…");

    expect(reserved()).toEqual([expect.objectContaining({ capability: "world.reconstruct", provider: "worldlabs-atlas", profile: "worldlabs-atlas/images2PosedRGBD", purpose: "location yard, set a: pose 3 pictures", estimate: { currency: "USD", micros: toMicros(0.1) } })]);
    // The fake says nothing of what posing was charged: the estimate stands, and the ledger says so.
    expect(settled()).toEqual([expect.objectContaining({ cost: { currency: "USD", micros: toMicros(0.1) }, basis: "estimate", providerRequestId: "op-0004" })]);

    expect(readdirSync(setDir).sort()).toEqual(["licence.json", "posed", "posed.json", "provenance", "set.json"]);
    expect(readdirSync(join(setDir, "posed")).sort()).toEqual(["depth-001.exr", "depth-002.exr", "depth-003.exr"]);
    expect(JSON.parse(readFileSync(join(setDir, "posed.json"), "utf-8")).frames).toHaveLength(3);
    expect(record()).toMatchObject({
      version: 1, film: FILM, location: "yard", set: "a", provider: "worldlabs-atlas",
      pictures: [{ file: PICTURES[0], width: 1280, height: 720 }, { file: PICTURES[1] }, { file: PICTURES[2] }],
      posed: { operationId: "op-0004", frames: 3, camerasRead: 3, costUsd: 0.1, costBasis: "estimate (operator)" },
      views: {}, splats: {}, meshes: {},
    });
    expect(JSON.parse(readFileSync(join(setDir, "licence.json"), "utf-8"))).toMatchObject({ plan: "paid", commercialUse: true });
    const provenance = JSON.parse(readFileSync(join(setDir, "provenance", "op-0004.json"), "utf-8"));
    expect(provenance).toMatchObject({
      tool: LOCATION_SET_TOOL, film: FILM, set: "locations/yard/sets/a", step: "pose", capability: "world.reconstruct", provider: "worldlabs-atlas",
      task: "images2PosedRGBD", operationId: "op-0004", wire: { verifiedLive: WIRE.verifiedLive }, estimate: { credits: 100, basis: "operator" }, cost: null, licence: { plan: "paid" },
    });
    expect(provenance.trace).toMatchObject({ task: "images2PosedRGBD" });
    expect(JSON.stringify(provenance)).not.toContain("wl-test-key");
    expect(JSON.stringify(provenance)).not.toContain("signature=");

    const text = said(result);
    expect(text).toContain("✅ locations/yard/sets/a — 3 posed frames from 3 pictures, ~$0.1 (estimate (operator))");
    expect(text).toContain("licence: paid plan, as the operator states it");
    expect(text).toContain(`next: ${LOCATION_VIEWS_TOOL}`);
    if (!WIRE.verifiedLive) expect(text).toContain("has not been confirmed by a real run");
    expect(existsSync(join(setDir, "jobs", "pose.json"))).toBe(false);
  });

  it("records an unpriced step as unpriced when the film has no budget, and marks an unstated plan as not for commercial use", async () => {
    const result = await pose();
    expect(reserved()[0]).toMatchObject({ priced: false, estimate: { micros: 0 } });
    expect(record().posed).toMatchObject({ costUsd: null, costBasis: "unknown" });
    expect(said(result)).toContain("cost not known");
    expect(said(result)).toContain("⚠️ licence: no plan stated in .render/worldlabs-atlas.json — not for commercial use");
    expect(JSON.parse(readFileSync(join(setDir, "licence.json"), "utf-8"))).toMatchObject({ plan: "unstated", commercialUse: false });
  });

  it("is posed once: other pictures are another set, and pictures of several sizes are said", async () => {
    writeFileSync(join(filmDir, "locations", "yard", "photos", "tall.png"), png(720, 1280, "tall"));
    const result = await pose({ pictures: [PICTURES[0], "locations/yard/photos/tall.png"] });
    expect(said(result)).toContain("⚠️ the pictures are of 2 sizes (1280×720, 720×1280)");
    await expect(pose()).rejects.toThrow("locations/yard/sets/a already has its posed frames");
  });

  describe("once posed", () => {
    beforeEach(async () => {
      account();
      await pose();
    });

    it("makes a draft first, charged what Atlas says, and the refined one only after it and on the operator's word", async () => {
      await expect(run(LOCATION_SPLAT_TOOL, { quality: "refined", approvedBy: "the operator, in chat" })).rejects.toThrow("a refined splat is made after a draft of the same set");
      expect(fake.submitted("posedImages2Splats")).toEqual([]);

      const draft = await run(LOCATION_SPLAT_TOOL);
      expect(fake.submitted("posedImages2Splats")[0]!.body).toMatchObject({ refine: false });
      expect((fake.submitted("posedImages2Splats")[0]!.body as { posedFrames: unknown[] }).posedFrames).toHaveLength(3);
      expect(readFileSync(join(setDir, "draft.spz"), "utf-8")).toBe("a draft splat");
      expect(reserved().at(-1)).toMatchObject({ capability: "world.reconstruct", profile: "worldlabs-atlas/posedImages2Splats.draft", estimate: { micros: toMicros(0.5) } });
      expect(settled().at(-1)).toMatchObject({ cost: { micros: toMicros(0.5) }, basis: "provider" });
      expect(record().splats.draft).toMatchObject({ file: "draft.spz", frames: 3, withViews: [], costUsd: 0.5, costBasis: "provider", assetId: expect.stringMatching(/^asset-/) });
      expect(said(draft)).toContain("✅ locations/yard/sets/a/draft.spz — a draft splat from 3 frames");
      expect(said(draft)).toContain('ask the operator before pva_location_splat { quality: "refined", approvedBy } (~$5 (5000 credits, published))');

      await expect(run(LOCATION_SPLAT_TOOL)).rejects.toThrow("draft.spz already exists: a draft splat is made once");
      await expect(run(LOCATION_SPLAT_TOOL, { quality: "refined" })).rejects.toThrow("a refined splat needs the operator's go-ahead");
      await expect(run(LOCATION_SPLAT_TOOL, { quality: "refined", approvedBy: " " })).rejects.toThrow("Do not approve it yourself");
      expect(fake.submitted("posedImages2Splats")).toHaveLength(1);

      const refined = await run(LOCATION_SPLAT_TOOL, { quality: "refined", approvedBy: "the operator, in chat, after the draft's views" });
      expect(fake.submitted("posedImages2Splats")[1]!.body).toMatchObject({ refine: true });
      expect(settled().at(-1)).toMatchObject({ cost: { micros: toMicros(5) }, basis: "provider" });
      expect(record().splats.refined).toMatchObject({ file: "refined.spz", approvedBy: "the operator, in chat, after the draft's views", costUsd: 5 });
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

    it("renders an orbit of views priced per view, keeps the stills and their frames, and joins a plate when asked", async () => {
      const result = await run(LOCATION_VIEWS_TOOL, { viewsId: "around", path: "orbit", count: 4, sweepDegrees: 90, size: "960x720", prompt: "night, sodium light", plate: true, fps: 25 });
      const body = fake.submitted("atlasGenerate")[0]!.body as { contextFrames: unknown[]; targetCameras: { width: number; height: number }[]; prompt: string };
      expect(body.contextFrames).toHaveLength(3);
      expect(body.targetCameras).toHaveLength(4);
      expect(body.targetCameras[0]).toMatchObject({ width: 960, height: 720 });
      expect(body.prompt).toBe("night, sodium light");
      expect(reserved().at(-1)).toMatchObject({ capability: "world.render", profile: "worldlabs-atlas/atlasGenerate.perView", estimate: { micros: toMicros(0.2) } });

      const viewsDir = join(setDir, "views", "around");
      expect(readdirSync(viewsDir).sort()).toEqual(["000001.png", "000002.png", "000003.png", "000004.png", "plate.mp4", "views.json"]);
      expect(readFileSync(join(viewsDir, "plate.mp4"), "utf-8")).toBe("a plate at 25 fps");
      const views = JSON.parse(readFileSync(join(viewsDir, "views.json"), "utf-8"));
      expect(views).toMatchObject({ viewsId: "around", path: "orbit", width: 960, height: 720, prompt: "night, sodium light" });
      expect(views.frames).toHaveLength(4);
      expect(views.cameras).toHaveLength(4);
      expect(record().views.around).toMatchObject({ dir: "views/around", frames: 4, width: 960, height: 720, plate: "plate.mp4", path: "an orbit of 90° in 4 views from frame 1" });
      const text = said(result);
      expect(text).toContain("✅ locations/yard/sets/a/views/around/ — 4 stills at 960×720");
      expect(text).toContain("720p: a reference to hold a shot to");
      expect(text).toContain("Atlas invents what no picture showed");

      await expect(run(LOCATION_VIEWS_TOOL, { viewsId: "around", path: "orbit" })).rejects.toThrow("views are made once, pick another viewsId");
      expect(fake.submitted("atlasGenerate")).toHaveLength(1);
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
      await expect(run(LOCATION_VIEWS_TOOL, { viewsId: "Bad Id", path: "orbit" })).rejects.toThrow("viewsId is lower-case");
      process.env.FFMPEG_BIN = join(root, "no-such-ffmpeg");
      await expect(run(LOCATION_VIEWS_TOOL, { viewsId: "x", path: "orbit", plate: true })).rejects.toThrow("a plate is joined with FFmpeg, and it was not found");
      expect(fake.requests.length).toBe(before);
    });

    it("adds the frames of views to a splat's when told to", async () => {
      await run(LOCATION_VIEWS_TOOL, { viewsId: "around", path: "orbit", count: 5 });
      await expect(run(LOCATION_SPLAT_TOOL, { withViews: ["behind"] })).rejects.toThrow("the set has no views named behind: its views are around");
      await run(LOCATION_SPLAT_TOOL, { withViews: ["around"] });
      expect((fake.submitted("posedImages2Splats")[0]!.body as { posedFrames: unknown[] }).posedFrames).toHaveLength(8);
      expect(record().splats.draft).toMatchObject({ frames: 8, withViews: ["around"] });
    });

    it("makes a mesh from the splat Atlas kept, reads what it holds, and says how to stage in it", async () => {
      await expect(run(LOCATION_MESH_TOOL)).rejects.toThrow("locations/yard/sets/a has no draft splat");
      await run(LOCATION_SPLAT_TOOL);
      const uploadsBefore = fake.requests.filter((r) => r.path.endsWith(":createUploadUrl")).length;
      const result = await run(LOCATION_MESH_TOOL, { texture: "textured", targetFaces: 40_000 });
      expect(fake.submitted("splats2Mesh")[0]!.body).toEqual({ splat: { assetId: record().splats.draft.assetId }, textureMode: "textured", targetFaces: 40_000 });
      // Named, not sent again.
      expect(fake.requests.filter((r) => r.path.endsWith(":createUploadUrl")).length).toBe(uploadsBefore);
      expect(readFileSync(join(setDir, "draft.glb")).subarray(0, 4).toString()).toBe("glTF");
      expect(reserved().at(-1)).toMatchObject({ capability: "world.mesh", profile: "worldlabs-atlas/splats2Mesh", estimate: { micros: toMicros(1) } });
      expect(record().meshes.draft).toMatchObject({ file: "draft.glb", from: "draft", texture: "textured", targetFaces: 40_000, holds: { format: "glb", meshes: 1, triangles: 1, joints: 0 } });
      const text = said(result);
      expect(text).toContain("✅ locations/yard/sets/a/draft.glb");
      expect(text).toContain("1 triangle, 1 mesh");
      expect(text).toContain('locationSet: { location: "yard", set: "a", mesh: "draft" }');
      expect(text).toContain("give that ratio as setScale");

      await expect(run(LOCATION_MESH_TOOL)).rejects.toThrow("draft.glb already exists: a mesh is made once, pick another meshId");
      await run(LOCATION_MESH_TOOL, { meshId: "light", reupload: true });
      expect(fake.requests.filter((r) => r.path.endsWith(":createUploadUrl")).length).toBe(uploadsBefore + 1);
      expect(Object.keys(record().meshes).sort()).toEqual(["draft", "light"]);
    });

    it("leaves a job that outlasts the wait written in the set, and takes it up again without paying twice", async () => {
      account({ plan: "paid", credits: OWN_CREDITS, maxWaitMinutes: 1 });
      atlas({ looksUntilDone: 8 });
      // The posed frames of the fake before are in posed.json: the new fake only has to accept them.
      const failure = await failed(run(LOCATION_SPLAT_TOOL));
      expect(failure.message).toMatch(/Atlas operation op-0001 did not finish within 60s: it is still running there, and may be charged/);
      expect(failure.message).toContain("The job is written in locations/yard/sets/a/jobs/splat-draft.json: call this tool again with the same arguments to wait for it without paying twice");
      const job = JSON.parse(readFileSync(join(setDir, "jobs", "splat-draft.json"), "utf-8"));
      expect(job).toMatchObject({ step: "splat-draft", task: "posedImages2Splats", operationId: "op-0001", price: { credits: 500 }, request: { refine: false } });
      // It left, and may be charged: the reservation was settled at the estimate, not released.
      expect(ledger().slice(-2)).toEqual(["spend-reserved", "spend-settled"]);
      expect(settled().at(-1)).toMatchObject({ cost: { micros: toMicros(0.5) }, basis: "estimate" });
      expect(existsSync(join(setDir, "draft.spz"))).toBe(false);

      const listed = said(await run(LOCATION_SETS_TOOL));
      expect(listed).toContain("⏳ job splat-draft: Atlas operation op-0001");
      expect(listed).toContain(": running at Atlas");

      const events = ledger().length;
      const updates: string[] = [];
      const result = await run(LOCATION_SPLAT_TOOL, {}, (u) => updates.push((u as { content: { text: string }[] }).content[0]!.text));
      expect(updates[0]).toMatch(/^Taking up Atlas operation op-0001 again \(splat-draft, submitted .*\): nothing is submitted, nothing more is reserved$/);
      expect(said(result)).toContain("(a job taken up again)");
      expect(readFileSync(join(setDir, "draft.spz"), "utf-8")).toBe("a draft splat");
      expect(fake.submitted("posedImages2Splats")).toHaveLength(1);
      expect(ledger().length).toBe(events);
      expect(existsSync(join(setDir, "jobs", "splat-draft.json"))).toBe(false);
      expect(JSON.parse(readFileSync(join(setDir, "provenance", "op-0001.json"), "utf-8"))).toMatchObject({ resumed: true, request: { refine: false } });
    });

    it("keeps a job that finished until what it made is on this machine: a download that fails is a second call, not a second payment", async () => {
      const fetchBytes = fake.fetchBytes;
      let broken = true;
      Object.defineProperty(fake, "fetchBytes", { get: () => (async (url: string) => { if (broken) throw new Error("the connection dropped"); return fetchBytes(url); }) });
      atlasWith(fake);
      await expect(run(LOCATION_SPLAT_TOOL)).rejects.toThrow("the connection dropped");
      expect(existsSync(join(setDir, "jobs", "splat-draft.json"))).toBe(true);
      expect(record().splats).toEqual({});
      // The job itself finished and said what it cost: that is settled, whatever became of the download.
      expect(settled().at(-1)).toMatchObject({ cost: { micros: toMicros(0.5) }, basis: "provider" });
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
      expect(failure.message).toContain("stopped waiting for Atlas operation op-0001: it is still running there, and may be charged");
      expect(failure.message).toContain("call this tool again with the same arguments");
      expect(fake.operations.get("op-0001")!.state).toBe("running");
      expect(fake.requests.some((r) => r.path.endsWith(":cancel"))).toBe(false);
      expect(existsSync(join(setDir, "jobs", "splat-draft.json"))).toBe(true);
    });

    it("does not hand a running job to a call that asks for something else", async () => {
      account({ plan: "paid", credits: OWN_CREDITS, maxWaitMinutes: 1 });
      atlas({ looksUntilDone: 50 });
      await run(LOCATION_VIEWS_TOOL, { viewsId: "around", path: "orbit", count: 3 }).catch(() => undefined);
      expect(existsSync(join(setDir, "jobs", "views-around.json"))).toBe(true);
      const failure = await failed(run(LOCATION_VIEWS_TOOL, { viewsId: "around", path: "orbit", count: 5 }));
      expect(failure.message).toContain("already has a job for this step (views-around, Atlas operation op-0001");
      expect(failure.message).toContain("it was asked for something else");
      expect(fake.submitted("atlasGenerate")).toHaveLength(1);
    });

    it("stops a job at Atlas when told to, and forgets it", async () => {
      account({ plan: "paid", credits: OWN_CREDITS, maxWaitMinutes: 1 });
      atlas({ looksUntilDone: 50 });
      await run(LOCATION_SPLAT_TOOL).catch(() => undefined);
      await expect(run(LOCATION_SETS_TOOL, { cancel: { location: "yard", set: "a", step: "mesh-draft" } })).rejects.toThrow("has no job named mesh-draft: its jobs are splat-draft");
      const text = said(await run(LOCATION_SETS_TOOL, { cancel: { location: "yard", set: "a", step: "splat-draft" } }));
      expect(text).toContain("🛑 asked Atlas to stop op-0001 (locations/yard/sets/a, splat-draft): it is now cancelled");
      expect(fake.operations.get("op-0001")!.state).toBe("cancelled");
      expect(existsSync(join(setDir, "jobs", "splat-draft.json"))).toBe(false);
      expect(text).not.toContain("⏳");
    });

    it("releases the reservation when Atlas refuses the request, and keeps it when a run fails there with no charge stated", async () => {
      atlas({ refusing: { posedImages2Splats: 422 } });
      await expect(run(LOCATION_SPLAT_TOOL)).rejects.toThrow(/HTTP 422/);
      expect(ledger().slice(-2)).toEqual(["spend-reserved", "spend-released"]);
      expect(existsSync(join(setDir, "jobs", "splat-draft.json"))).toBe(false);

      atlas({ failing: { posedImages2Splats: { code: "INVALID_FRAMES", message: "the frames do not overlap" } } });
      await expect(run(LOCATION_SPLAT_TOOL)).rejects.toThrow("Atlas operation op-0001 failed: the frames do not overlap");
      // Reported free, not known to be: the budget keeps counting it until someone looks at the account.
      expect(ledger().slice(-2)).toEqual(["spend-reserved", "spend-settled"]);
      expect(settled().at(-1)).toMatchObject({ basis: "estimate" });
      // It ended there: there is nothing to take up, and the step can be asked for again.
      expect(existsSync(join(setDir, "jobs", "splat-draft.json"))).toBe(false);
      expect(record().splats).toEqual({});
    });

    it("lists what a film's sets hold, what they cost, their licence, and what each step is priced at", async () => {
      await run(LOCATION_SPLAT_TOOL);
      await run(LOCATION_MESH_TOOL);
      const text = said(await run(LOCATION_SETS_TOOL));
      expect(text).toContain("locations/yard/sets/a — 3 pictures; 3 posed frames; about $1.6 so far");
      expect(text).toContain("draft.spz: draft splat");
      expect(text).toContain("draft.glb: mesh draft from the draft splat, 1 triangle");
      expect(text).toContain("licence: plan paid, reported to allow commercial use");
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

  it("cannot make a splat of one frame, and says to render views first", async () => {
    await pose({ pictures: [PICTURES[0]] });
    await expect(run(LOCATION_SPLAT_TOOL)).rejects.toThrow(`a splat needs at least two frames, and the set has 1: render views first (${LOCATION_VIEWS_TOOL}) and name them in withViews`);
    await run(LOCATION_VIEWS_TOOL, { viewsId: "around", path: "orbit", count: 6 });
    await run(LOCATION_SPLAT_TOOL, { withViews: ["around"] });
    expect(record().splats.draft.frames).toBe(7);
  });
});
