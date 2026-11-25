// ---------------------------------------------------------------------------
// The client against the fake Atlas: nothing leaves the machine, nothing waits
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  AtlasCancelledError, AtlasClient, AtlasHttpError, AtlasOperationError, AtlasTimeoutError, AtlasUnavailableError, AUTH_HEADER, FAKE_HOST, FakeAtlas,
  ManualClock, NoopSleeper, createAtlasClient, orbit, frameCamera, readGeneratedFrames, readPosedFrames, resolveConfig,
  type AtlasEvent, type FakeAtlasOptions, type HttpRequest,
} from "../src/index.js";

const KEY = "wl-test-key-0000";
const picture = (name: string) => ({ bytes: new Uint8Array(Buffer.from(`a picture: ${name}`)), fileName: name, contentType: "image/png" });

function setup(options: FakeAtlasOptions = {}) {
  const fake = new FakeAtlas({ apiKey: KEY, ...options });
  const clock = new ManualClock(1_000_000);
  const sleeper = new NoopSleeper(clock);
  const events: AtlasEvent[] = [];
  const sent: HttpRequest[] = [];
  const client = new AtlasClient({
    config: { apiKey: KEY, baseUrl: FAKE_HOST, maxRetries: 3 },
    transport: { request: (req, signal) => { sent.push(req); return fake.transport.request(req, signal); } },
    fetchBytes: fake.fetchBytes, clock, sleeper, onEvent: (event) => events.push(event),
  });
  return { fake, client, clock, sleeper, events, sent };
}

describe("configuration", () => {
  it("has no client without a key, and says which variable is missing", () => {
    expect(() => createAtlasClient({ env: {} })).toThrow(AtlasUnavailableError);
    expect(() => createAtlasClient({ env: {} })).toThrow(/WORLDLABS_API_KEY is not set/);
    expect(resolveConfig({ WORLDLABS_API_KEY: " k ", WORLDLABS_ATLAS_BASE_URL: "https://example.test/" })).toMatchObject({ apiKey: "k", baseUrl: "https://example.test" });
    expect(resolveConfig({ WORLDLABS_API_KEY: "k", WORLDLABS_ATLAS_BASE_URL: "https://example.test/api/v2" })).toBeInstanceOf(AtlasUnavailableError);
    expect(resolveConfig({ WORLDLABS_API_KEY: "k", WORLDLABS_ATLAS_BASE_URL: "http://example.test" })).toBeInstanceOf(AtlasUnavailableError);
  });

  it("asks the health check without a key", async () => {
    const { client, sent } = setup();
    expect(await client.health()).toMatchObject({ ok: true, status: 200 });
    expect(Object.keys(sent[0]!.headers).map((name) => name.toLowerCase())).not.toContain(AUTH_HEADER.toLowerCase());
  });
});

describe("assets", () => {
  it("uploads in three steps, and sends the key to the API only", async () => {
    const { client, fake, sent } = setup();
    const asset = await client.uploadFile(picture("door.png"));
    expect(asset).toMatchObject({ id: "asset-0001", fileName: "door.png", contentType: "image/png" });
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /api/v2/assets:createUploadUrl", "PUT /upload/asset-0001", "POST /api/v2/assets/asset-0001:completeUpload",
    ]);
    expect(fake.requests[0]!.body).toEqual({ fileName: "door.png", contentType: "image/png", sizeBytes: asset.bytes });
    // The bucket's URL is its own authorization: the key does not go there.
    const put = sent.find((req) => req.method === "PUT")!;
    expect(put.headers).toEqual({ "content-type": "image/png", "x-fake-upload": "1" });
    expect(sent.filter((req) => req.method !== "PUT").every((req) => req.headers[AUTH_HEADER] === KEY)).toBe(true);
    expect(sent.some((req) => req.url.includes(KEY))).toBe(false);
    expect(Buffer.from(fake.assets.get("asset-0001")!.bytes!).toString()).toBe("a picture: door.png");
  });

  it("refuses an empty file before asking for anything", async () => {
    const { client, fake } = setup();
    await expect(client.uploadFile({ bytes: new Uint8Array(), fileName: "empty.png", contentType: "image/png" })).rejects.toThrow(/empty/);
    expect(fake.requests).toEqual([]);
  });

  it("is refused with the wrong key", async () => {
    const fake = new FakeAtlas({ apiKey: KEY });
    const client = new AtlasClient({ config: { apiKey: "another", baseUrl: FAKE_HOST, maxRetries: 0 }, transport: fake.transport });
    const failure = await client.getOperation("op-1").catch((e) => e);
    expect(failure).toBeInstanceOf(AtlasHttpError);
    expect(failure).toMatchObject({ status: 401, refused: true, retryable: false });
  });
});

describe("a place, from pictures to a mesh", () => {
  it("poses the pictures, makes a draft splat from the frames as they came, and a mesh from the splat", async () => {
    const { client, fake } = setup();
    const images = [await client.uploadFile(picture("a.png")), await client.uploadFile(picture("b.png")), await client.uploadFile(picture("c.png"))];

    const posed = await client.poseImages({ images });
    const frames = readPosedFrames(posed.operation.response);
    expect(frames).toHaveLength(3);
    expect(posed.files.map((file) => file.kind)).toEqual(["image", "depth", "image", "depth", "image", "depth"]);
    expect(frameCamera(frames[0]!)).toMatchObject({ width: 1280, height: 720, fx: 900 });

    const splat = await client.splatsFromPosedImages({ posedFrames: frames, refine: false });
    expect(fake.submitted("posedImages2Splats")[0]!.body).toEqual({ posedFrames: frames, refine: false });
    expect(splat.files).toEqual([expect.objectContaining({ path: "splat", kind: "splat", fileName: "draftSplats.spz" })]);
    expect(splat.cost).toEqual({ credits: 500, usd: 0.5, basis: "provider" });
    expect(Buffer.from(await client.download(splat.files[0]!)).toString()).toBe("a draft splat");

    const mesh = await client.meshFromSplats({ splat: splat.files[0]!.assetId!, texture: "textured", targetFaces: 50_000 });
    expect(fake.submitted("splats2Mesh")[0]!.body).toEqual({ splat: { assetId: splat.files[0]!.assetId }, textureMode: "textured", targetFaces: 50_000 });
    expect(mesh.files[0]).toMatchObject({ kind: "mesh", fileName: "mesh.glb" });
    expect(Buffer.from(await client.download(mesh.files[0]!)).subarray(0, 4).toString()).toBe("glTF");
    // A mesh's price is not said by the fake, as it is not public: no cost is invented.
    expect(mesh.cost).toBeNull();
    expect(client.creditsCharged).toBe(500);
    expect(client.tasksSubmitted).toBe(3);
  });

  it("asks for the refined splat only when told to, and reports its price", async () => {
    const { client } = setup();
    const frames = readPosedFrames((await client.poseImages({ images: ["x", "y"] })).operation.response);
    const refined = await client.splatsFromPosedImages({ posedFrames: frames, refine: true });
    expect(refined.files[0]).toMatchObject({ fileName: "refinedSplats_2000000.spz" });
    expect(refined.cost).toEqual({ credits: 5000, usd: 5, basis: "provider" });
  });

  it("renders the scene from a path of cameras, in their order", async () => {
    const { client, fake } = setup();
    const frames = readPosedFrames((await client.poseImages({ images: ["x", "y"] })).operation.response);
    const from = frameCamera(frames[0]!)!;
    const cameras = orbit({ from, centre: [0, 1.5, 0], sweepDegrees: 60, count: 4, width: 960, height: 720 });
    const views = await client.generateViews({ contextFrames: frames, targetCameras: cameras, prompt: "dusk" });
    const body = fake.submitted("atlasGenerate")[0]!.body as { targetCameras: { width: number; convention: string }[]; prompt: string };
    expect(body.targetCameras).toHaveLength(4);
    expect(body.targetCameras[0]).toMatchObject({ width: 960, height: 720, convention: "opengl" });
    expect(body.prompt).toBe("dusk");
    expect(readGeneratedFrames(views.operation.response)).toHaveLength(4);
    expect(views.files.map((file) => file.fileName)).toEqual(["view-0.png", "view-1.png", "view-2.png", "view-3.png"]);
  });

  it("keeps the provider's trace, and does without it when there is none", async () => {
    const withTrace = setup();
    const run = await withTrace.client.poseImages({ images: ["x"] });
    expect(run.trace).toMatchObject({ task: "images2PosedRGBD", request: { images: [{ assetId: "x" }] } });
    const without = setup({ traces: false });
    expect((await without.client.poseImages({ images: ["x"] })).trace).toBeNull();
  });

  it("merges `extra` last, so a field this package has wrong can be put right by a caller", async () => {
    const { client, fake } = setup();
    await client.poseImages({ images: ["x"], extra: { images: [{ uri: "asset://x" }], model: "atlas-1" } });
    expect(fake.submitted("images2PosedRGBD")[0]!.body).toEqual({ images: [{ uri: "asset://x" }], model: "atlas-1" });
  });
});

describe("waiting", () => {
  it("looks with growing pauses and never past the longest", async () => {
    const { client, sleeper, events } = setup({ looksUntilDone: 7 });
    await client.poseImages({ images: ["x"] }, { pollMs: 2_000, maxPollMs: 8_000 });
    expect(sleeper.slept).toEqual([2_000, 3_000, 4_500, 6_750, 8_000, 8_000]);
    expect(events.filter((event) => event.kind === "waiting").at(-1)).toMatchObject({ state: "running", progress: expect.any(Number) });
    expect(events.at(-1)).toMatchObject({ kind: "done", state: "succeeded" });
  });

  it("gives up after the wait it was allowed, names the job it leaves running, and can take it up again", async () => {
    const { client, fake } = setup({ looksUntilDone: 6 });
    let written: string | undefined;
    const failure = await client.splatsFromPosedImages({ posedFrames: [{ a: 1 }, { b: 2 }], refine: false }, { maxWaitMs: 12_000, pollMs: 5_000, onSubmitted: (operation) => { written = operation.id; } }).catch((e) => e);
    expect(failure).toBeInstanceOf(AtlasTimeoutError);
    expect(failure.message).toMatch(/op-0001 did not finish within 1\ds: it is still running there, and may be charged/);
    // The id was handed over at submission, before any waiting: it is what a caller writes down.
    expect(written).toBe("op-0001");
    expect(failure.operationId).toBe("op-0001");
    expect(fake.operations.get("op-0001")!.state).toBe("running");

    const resumed = await client.resume("posedImages2Splats", "op-0001");
    expect(resumed.files[0]).toMatchObject({ kind: "splat" });
    // Taken up, not asked for again.
    expect(fake.submitted("posedImages2Splats")).toHaveLength(1);
    expect(client.tasksSubmitted).toBe(1);
  });

  it("stops when the caller gives up: the job is left running, or cancelled there when asked", async () => {
    for (const cancelOnAbort of [false, true]) {
      const { client, fake, sleeper } = setup({ looksUntilDone: 50 });
      const controller = new AbortController();
      const sleep = sleeper.sleep.bind(sleeper);
      sleeper.sleep = async (ms, signal) => { await sleep(ms, signal); if (sleeper.slept.length === 2) controller.abort(); };
      const failure = await client.poseImages({ images: ["x"] }, { signal: controller.signal, cancelOnAbort }).catch((e) => e);
      expect(failure).toBeInstanceOf(AtlasCancelledError);
      expect(failure.details).toEqual({ operationId: "op-0001" });
      expect(fake.operations.get("op-0001")!.state).toBe(cancelOnAbort ? "cancelled" : "running");
      expect(failure).toMatchObject({ operationId: "op-0001", cancelledThere: cancelOnAbort });
      expect(failure.message).toMatch(cancelOnAbort ? /asked Atlas to cancel it/ : /still running there, and may be charged/);
    }
  });

  it("does not submit when the caller has already given up", async () => {
    const { client, fake } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(client.poseImages({ images: ["x"] }, { signal: controller.signal })).rejects.toBeInstanceOf(AtlasCancelledError);
    expect(fake.requests).toEqual([]);
  });

  it("reports a job that failed there, with the provider's reason", async () => {
    const { client } = setup({ failing: { posedImages2Splats: { code: "INVALID_FRAMES", message: "the frames do not overlap" } } });
    const failure = await client.splatsFromPosedImages({ posedFrames: [{}, {}], refine: false }).catch((e) => e);
    expect(failure).toBeInstanceOf(AtlasOperationError);
    expect(failure.message).toBe("Atlas operation op-0001 failed: the frames do not overlap");
    expect(failure.details).toMatchObject({ operationId: "op-0001", providerCode: "INVALID_FRAMES" });
    // The fake says nothing of a failed run's charge, so neither does the error.
    expect(failure.credits).toBeNull();
  });

  it("can let the server hold the connection", async () => {
    const { client, fake } = setup({ looksUntilDone: 2 });
    await client.poseImages({ images: ["x"] }, { serverWaitSeconds: 60 });
    const waits = fake.requests.filter((r) => r.path.endsWith(":wait"));
    expect(waits).toHaveLength(2);
    expect(waits[0]!.body).toEqual({ timeoutSeconds: 60 });
  });
});

describe("failures on the way", () => {
  it("submits a task once: an answer lost is not a reason to pay twice", async () => {
    const { client, fake } = setup();
    fake.interruptions.push({ status: 503 });
    const failure = await client.poseImages({ images: ["x"] }).catch((e) => e);
    expect(failure).toMatchObject({ status: 503, retryable: true });
    expect(fake.requests.filter((r) => r.path.includes("tasks:"))).toHaveLength(1);
    expect(client.tasksSubmitted).toBe(0);
  });

  it("asks again when a look is turned away, waiting as long as it is told to", async () => {
    const { client, fake, sleeper, events } = setup({ looksUntilDone: 1 });
    const operation = await client.submit("images2PosedRGBD", { images: [] });
    fake.interruptions.push({ status: 429, headers: { "retry-after": "7" } }, { status: 502 });
    expect((await client.getOperation(operation.id)).state).toBe("succeeded");
    expect(sleeper.slept).toEqual([7_000, 2_000]);
    expect(events.filter((event) => event.kind === "retrying")).toHaveLength(2);
  });

  it("does not sleep for as long as it is told when that is longer than anyone would wait", async () => {
    const { client, fake, sleeper } = setup();
    fake.interruptions.push({ status: 429, headers: { "retry-after": "86400" } });
    await expect(client.getOperation("op-x")).rejects.toMatchObject({ status: 429, retryAfterSeconds: 86400, notAccepted: true, refused: false });
    expect(sleeper.slept).toEqual([]);
  });

  it("sees a submission through once it has left, whoever gives up meanwhile", async () => {
    const { fake } = setup({ looksUntilDone: 50 });
    const controller = new AbortController();
    const request = fake.transport.request.bind(fake.transport);
    // The caller gives up while the task's request is on its way.
    Object.defineProperty(fake, "transport", { value: { request: async (req: HttpRequest, signal?: AbortSignal) => { if (req.url.includes("tasks:")) controller.abort(); return request(req, signal); } } });
    const leaving = new AtlasClient({ config: { apiKey: KEY, baseUrl: FAKE_HOST, maxRetries: 0 }, transport: fake.transport, sleeper: new NoopSleeper() });
    let named: string | undefined;
    const failure = await leaving.poseImages({ images: ["x"] }, { signal: controller.signal, onSubmitted: (operation) => { named = operation.id; } }).catch((e) => e);
    // The job was accepted and is named, to the caller and in the error: it can be taken up or stopped.
    expect(named).toBe("op-0001");
    expect(failure).toBeInstanceOf(AtlasCancelledError);
    expect(failure.operationId).toBe("op-0001");
  });

  it("stops asking after its retries, and never repeats a refusal", async () => {
    const { client, fake } = setup();
    fake.interruptions.push({ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 });
    await expect(client.getOperation("op-x")).rejects.toMatchObject({ status: 503 });
    expect(fake.requests).toHaveLength(4);
    const refusing = setup({ refusing: { splats2Mesh: 422 } });
    const refusal = await refusing.client.meshFromSplats({ splat: "s" }).catch((e) => e);
    expect(refusal).toMatchObject({ status: 422, refused: true, retryable: false });
    expect(refusing.fake.requests).toHaveLength(1);
  });

  it("refuses a request that cannot be right before sending anything", async () => {
    const { client, fake } = setup();
    await expect(client.splatsFromPosedImages({ posedFrames: [{}], refine: false })).rejects.toThrow(/at least two posed frames/);
    await expect(client.poseImages({ images: [] })).rejects.toThrow(/at least one picture/);
    await expect(client.generateViews({ contextFrames: [], targetCameras: [] })).rejects.toThrow(/at least one target camera/);
    await expect(client.meshFromSplats({ splat: "s", targetFaces: 3 })).rejects.toThrow(/targetFaces/);
    expect(fake.requests).toEqual([]);
  });
});
