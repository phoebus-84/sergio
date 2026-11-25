// ---------------------------------------------------------------------------
// The client against the fake Atlas: nothing leaves the machine, nothing waits
// ---------------------------------------------------------------------------
// The fake is written from the provider's documentation and is as strict as
// it says the service is, so these tests hold the client to the documented
// requests. They do not show that the live service agrees.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  AtlasCancelledError, AtlasClient, AtlasHttpError, AtlasOperationError, AtlasTimeoutError, AtlasUnavailableError, AUTH_HEADER, FAKE_API_ROOT, FakeAtlas,
  ManualClock, NoopSleeper, createAtlasClient, frameCamera, orbit, posedFrame, readGeneratedFrames, readMesh, readPosedFrames, readSplat, resolveConfig,
  type AtlasEvent, type FakeAtlasOptions, type HttpRequest, type PosedFrame,
} from "../src/index.js";

const KEY = "wl_live_test_key_0000";
const picture = (name: string) => ({ bytes: new Uint8Array(Buffer.from(`a picture: ${name}`)), fileName: name, contentType: "image/png" });

function setup(options: FakeAtlasOptions = {}) {
  const fake = new FakeAtlas({ apiKey: KEY, ...options });
  const clock = new ManualClock(1_000_000);
  const sleeper = new NoopSleeper(clock);
  const events: AtlasEvent[] = [];
  const sent: HttpRequest[] = [];
  const client = new AtlasClient({
    config: { apiKey: KEY, baseUrl: FAKE_API_ROOT, maxRetries: 3 },
    transport: { request: (req, signal) => { sent.push(req); return fake.transport.request(req, signal); } },
    // No spread in the pauses: what a test counts is what was asked.
    fetchBytes: fake.fetchBytes, clock, sleeper, random: () => 0.5, onEvent: (event) => events.push(event),
  });
  /** Three pictures uploaded and posed: the frames the other tasks take. */
  const posed = async (count = 3, targetResolution?: readonly [number, number]): Promise<PosedFrame[]> => {
    const images = [];
    for (let index = 0; index < count; index++) images.push(await client.uploadFile(picture(`p${index}.png`)));
    const run = await client.poseImages({ images, ...(targetResolution ? { targetResolution } : {}) });
    return readPosedFrames(run.operation.response).map((frame) => posedFrame(frame)!);
  };
  return { fake, client, clock, sleeper, events, sent, posed };
}

describe("configuration", () => {
  it("has no client without a key, and reads the provider's own variables", () => {
    expect(() => createAtlasClient({ env: {} })).toThrow(AtlasUnavailableError);
    expect(() => createAtlasClient({ env: {} })).toThrow(/WLT_API_KEY is not set/);
    expect(resolveConfig({ WLT_API_KEY: " k " })).toMatchObject({ apiKey: "k", baseUrl: "https://api.atlas.worldlabs.ai/api/v2" });
    expect(resolveConfig({ WLT_API_KEY: "k", WLT_API_BASE_URL: "https://example.test/api/v2/" })).toMatchObject({ baseUrl: "https://example.test/api/v2" });
    // The key travels to this address in a header: plain http only to this machine.
    expect(resolveConfig({ WLT_API_KEY: "k", WLT_API_BASE_URL: "http://example.test/api/v2" })).toBeInstanceOf(AtlasUnavailableError);
    expect(resolveConfig({ WLT_API_KEY: "k", WLT_API_BASE_URL: "http://127.0.0.1:8080/api/v2" })).toMatchObject({ baseUrl: "http://127.0.0.1:8080/api/v2" });
  });

  it("asks the health check without a key", async () => {
    const { client, sent } = setup();
    expect(await client.health()).toMatchObject({ ok: true, status: 200 });
    expect(sent[0]!.url).toBe(`${FAKE_API_ROOT}/health`);
    expect(Object.keys(sent[0]!.headers).map((name) => name.toLowerCase())).not.toContain(AUTH_HEADER.toLowerCase());
  });
});

describe("assets", () => {
  it("uploads in four requests, and sends the key to the API only", async () => {
    const { client, fake, sent } = setup();
    const asset = await client.uploadFile(picture("door.png"));
    expect(asset).toMatchObject({ id: "asset_0001", state: "READY", fileName: "door.png", contentType: "image/png", bytes: 19 });
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /api/v2/assets", "POST /api/v2/assets/asset_0001:createUploadUrl", "PUT /upload/asset_0001", "POST /api/v2/assets/asset_0001:completeUpload",
    ]);
    expect(fake.requests[0]!.body).toEqual({ asset: { displayName: "door.png" } });
    expect(fake.requests[1]!.body).toEqual({ contentType: "image/png", contentLength: 19 });
    expect(fake.requests[3]!.body).toEqual({});
    // The upload URL is its own authorization: the key does not go there, and its headers do.
    const put = sent.find((req) => req.method === "PUT")!;
    expect(put.headers).toEqual({ "content-type": "image/png", "x-fake-upload": "1" });
    expect(sent.filter((req) => req.method !== "PUT").every((req) => req.headers[AUTH_HEADER] === KEY)).toBe(true);
    expect(sent.some((req) => req.url.includes(KEY))).toBe(false);
    expect(Buffer.from(fake.assets.get("asset_0001")!.bytes!).toString()).toBe("a picture: door.png");
  });

  it("refuses an empty file before asking for anything", async () => {
    const { client, fake } = setup();
    await expect(client.uploadFile({ bytes: new Uint8Array(), fileName: "empty.png", contentType: "image/png" })).rejects.toThrow(/empty/);
    expect(fake.requests).toEqual([]);
  });

  it("reads a result's file through its asset, not through the url that expires in a day", async () => {
    const { client, fake, posed } = setup();
    const splat = readSplat((await client.splatsFromPosedImages({ posedFrames: await posed(), refine: false })).operation.response);
    const before = fake.requests.length;
    expect(Buffer.from(await client.download(splat.asset)).toString()).toBe("a draft splat");
    expect(fake.requests.slice(before).map((r) => r.path)).toEqual([`/api/v2/assets/${splat.asset.assetId}:createReadUrl`]);
    // A file with only a url is read from it.
    expect(Buffer.from(await client.download({ url: splat.asset.url! })).toString()).toBe("a draft splat");
  });

  it("is refused with the wrong key, and says what the provider calls it", async () => {
    const fake = new FakeAtlas({ apiKey: KEY });
    const client = new AtlasClient({ config: { apiKey: "another", baseUrl: FAKE_API_ROOT, maxRetries: 0 }, transport: fake.transport });
    const failure = await client.getOperation("op_1").catch((e) => e);
    expect(failure).toBeInstanceOf(AtlasHttpError);
    expect(failure).toMatchObject({ status: 401, refused: true, retryable: false, providerCode: "UNAUTHENTICATED" });
  });
});

describe("a place, from pictures to a mesh", () => {
  it("poses the pictures as frames of images alone, on the grid it is asked for", async () => {
    const { client, fake } = setup();
    const images = [await client.uploadFile(picture("a.png")), await client.uploadFile(picture("b.png"))];
    const run = await client.poseImages({ images, targetResolution: [960, 720] });
    expect(fake.submitted("images2PosedRGBD")[0]!.body).toEqual({ frames: [{ imageAsset: { assetId: images[0]!.id } }, { imageAsset: { assetId: images[1]!.id } }], targetResolution: [960, 720] });
    const frames = readPosedFrames(run.operation.response);
    expect(frames).toHaveLength(2);
    expect(frames[0]!.camera.intrinsics).toMatchObject({ width: 960, height: 720 });
    expect(frames[0]!.centroidWorld).toEqual([0, 0, 0]);
    expect(frameCamera(frames[1]!)).toMatchObject({ width: 960, height: 720, fx: 900 });
    expect(run.files.map((file) => file.kind)).toEqual(["image", "depth", "confidence", "image", "depth", "confidence"]);
    expect(run.files[1]).toMatchObject({ path: "frames[0].depth.depthAsset", assetId: expect.stringMatching(/^asset_/), url: expect.stringContaining("X-Signature") });
  });

  it("hands a frame on as the next task takes it: image, camera and depth by id, and nothing the schema would refuse", async () => {
    const { client, fake, posed } = setup();
    const run = await client.poseImages({ images: [await client.uploadFile(picture("a.png")), await client.uploadFile(picture("b.png"))] });
    const returned = readPosedFrames(run.operation.response);
    const frame = posedFrame(returned[0]!)!;
    expect(Object.keys(frame).sort()).toEqual(["camera", "depth", "imageAsset"]);
    expect(frame.imageAsset).toEqual({ assetId: "asset_0001" });
    expect(frame.depth).toEqual({ depthAsset: { assetId: expect.stringMatching(/^asset_/) }, confidenceAsset: { assetId: expect.stringMatching(/^asset_/) } });
    // As it came, with `centroidWorld`, the service refuses it: this is why it is not passed on untouched.
    const refusal = await client.run("posedImages2Splats", { posedFrames: returned, refine: false }).catch((e) => e);
    expect(refusal).toMatchObject({ status: 422, refused: true });
    expect(refusal.message).toContain("extra fields not permitted: centroidWorld");
    expect(posedFrame({ imageAsset: { assetId: "a" }, camera: returned[0]!.camera })).toBeNull();
    await client.splatsFromPosedImages({ posedFrames: await posed(2), refine: false });
    expect(fake.submitted("posedImages2Splats")).toHaveLength(1);
  });

  it("asks for a draft with refine false, and reads the splat from where each quality puts it", async () => {
    const { client, fake, posed } = setup();
    const frames = await posed();
    const draft = await client.splatsFromPosedImages({ posedFrames: frames, refine: false });
    expect(fake.submitted("posedImages2Splats")[0]!.body).toEqual({ posedFrames: frames, refine: false });
    expect(readSplat(draft.operation.response)).toMatchObject({ quality: "draft", splats: null, asset: { assetId: expect.any(String) } });
    expect(draft.files).toEqual([expect.objectContaining({ path: "draftSplat", kind: "splat" })]);

    const refined = await client.splatsFromPosedImages({ posedFrames: frames, refine: true, prompt: "a yard at night", enhancePrompt: false });
    expect(fake.submitted("posedImages2Splats")[1]!.body).toMatchObject({ refine: true, prompt: "a yard at night", enhancePrompt: false });
    expect(readSplat(refined.operation.response)).toMatchObject({ quality: "refined", splats: 2_000_000 });
    expect(refined.files).toEqual([expect.objectContaining({ path: "refinedSplats.2000000", kind: "splat" })]);
    expect(Buffer.from(await client.download(readSplat(refined.operation.response).asset)).toString()).toBe("a refined splat");
  });

  it("makes a mesh from a splat by its asset, with the service's own words for its texture", async () => {
    const { client, fake, posed } = setup();
    const splat = readSplat((await client.splatsFromPosedImages({ posedFrames: await posed(), refine: false })).operation.response);
    const run = await client.meshFromSplats({ splat: splat.asset, texture: "vertex_color", targetFaces: 50_000, cameras: "auto_anchors" });
    // The id alone: with an id the url is ignored there, and it is a secret here.
    expect(fake.submitted("splats2Mesh")[0]!.body).toEqual({ splatAsset: { assetId: splat.asset.assetId }, textureMode: "vertex_color", targetFaces: 50_000, cameras: { strategy: "auto_anchors" } });
    const { mesh, colliderBoxes } = readMesh(run.operation.response);
    expect(colliderBoxes).toBeNull();
    expect(Buffer.from(await client.download(mesh)).subarray(0, 4).toString()).toBe("glTF");
    expect(run.files).toEqual([expect.objectContaining({ path: "mesh", kind: "mesh" })]);
  });

  it("renders the scene from a path of cameras, in their order, with depth when it is asked for", async () => {
    const { client, fake, posed } = setup();
    const frames = await posed(2);
    const from = frameCamera(frames[0]!)!;
    const cameras = orbit({ from, centre: [0, 1.5, 0], sweepDegrees: 60, count: 4, width: 960, height: 720 });
    const views = await client.generateViews({ contextFrames: frames, targetCameras: cameras, prompt: "a yard at dusk", returnDepth: true, seed: 7 });
    const body = fake.submitted("atlasGenerate")[0]!.body as { targetCameras: { extrinsics: { position: number[]; quaternion: number[]; coordinateSystem: string }; intrinsics: { width: number } }[]; prompt: string; returnDepth: boolean; modelParameters: unknown };
    expect(body.targetCameras).toHaveLength(4);
    expect(Object.keys(body.targetCameras[0]!).sort()).toEqual(["extrinsics", "intrinsics"]);
    expect(body.targetCameras[0]!.extrinsics.coordinateSystem).toBe("rub");
    expect(body.targetCameras[0]!.extrinsics.quaternion).toHaveLength(4);
    expect(body.targetCameras[0]!.intrinsics.width).toBe(960);
    expect(body).toMatchObject({ prompt: "a yard at dusk", returnDepth: true, modelParameters: { seed: 7 } });
    const generated = readGeneratedFrames(views.operation.response);
    expect(generated).toHaveLength(4);
    // With depth, a view is a frame like any posed one: it can be context, or a splat's.
    expect(posedFrame(generated[0]!)).not.toBeNull();
    expect(views.operation.response!["promptUsed"]).toBe("enhanced: a yard at dusk");
    const flat = await client.generateViews({ contextFrames: frames, targetCameras: cameras, returnDepth: false });
    expect(posedFrame(readGeneratedFrames(flat.operation.response)[0]!)).toBeNull();
  });

  it("keeps the provider's trace, and does without it when there is none", async () => {
    const withTrace = setup();
    const run = await withTrace.client.poseImages({ images: ["asset_x"] });
    expect(run.trace).toMatchObject({ taskName: "images2PosedRGBD", request: { frames: [{ imageAsset: { assetId: "asset_x" } }] } });
    const without = setup({ traces: false });
    expect((await without.client.poseImages({ images: ["asset_x"] })).trace).toBeNull();
  });

  it("merges `extra` last, for a field this package has no name for", async () => {
    const { client, fake } = setup();
    await client.poseImages({ images: ["asset_x"], extra: { canonicalizeToFirstFrame: true } });
    expect(fake.submitted("images2PosedRGBD")[0]!.body).toEqual({ frames: [{ imageAsset: { assetId: "asset_x" } }], canonicalizeToFirstFrame: true });
  });
});

describe("one task, one idempotency key", () => {
  it("sends a key with every submission, and the caller's when it names one", async () => {
    const { client, fake } = setup();
    await client.poseImages({ images: ["asset_x"] });
    expect(fake.requests.find((r) => r.path.includes("tasks:"))!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    await client.poseImages({ images: ["asset_y"] }, { idempotencyKey: "film-yard-a-pose" });
    expect(fake.requests.filter((r) => r.path.includes("tasks:"))[1]!.headers["idempotency-key"]).toBe("film-yard-a-pose");
  });

  it("asks again with the same key when the answer is lost, and gets the job that was accepted, not a second one", async () => {
    const { client, fake, sleeper } = setup();
    // The task is accepted, and the answer never arrives.
    fake.interruptions.push({ status: 504, afterAccepting: true });
    const run = await client.poseImages({ images: ["asset_x"] }, { idempotencyKey: "pose-once" });
    const submissions = fake.requests.filter((r) => r.path.includes("tasks:"));
    expect(submissions).toHaveLength(2);
    expect(submissions.map((r) => r.headers["idempotency-key"])).toEqual(["pose-once", "pose-once"]);
    expect(fake.submitted("images2PosedRGBD")).toHaveLength(1);
    expect(run.operation.id).toBe("op_0001");
    expect(sleeper.slept[0]).toBe(1_000);
    expect(client.tasksSubmitted).toBe(1);
  });

  it("gets the same operation from another client that names the same key: a crash is not a second payment", async () => {
    const first = setup({ looksUntilDone: 50 });
    const operation = await first.client.submit("images2PosedRGBD", { frames: [{ imageAsset: { assetId: "asset_x" } }] }, { idempotencyKey: "pose-once" });
    const second = new AtlasClient({ config: { apiKey: KEY, baseUrl: FAKE_API_ROOT, maxRetries: 0 }, transport: first.fake.transport });
    const again = await second.submit("images2PosedRGBD", { frames: [{ imageAsset: { assetId: "asset_x" } }] }, { idempotencyKey: "pose-once" });
    expect(again.id).toBe(operation.id);
    expect(first.fake.submitted("images2PosedRGBD")).toHaveLength(1);
    // The same key for other work is refused, not answered with the wrong job.
    await expect(second.submit("images2PosedRGBD", { frames: [{ imageAsset: { assetId: "asset_other" } }] }, { idempotencyKey: "pose-once" })).rejects.toMatchObject({ status: 409, refused: true });
  });

  it("sees a submission through once it has left, whoever gives up meanwhile", async () => {
    const { fake } = setup({ looksUntilDone: 50 });
    const controller = new AbortController();
    const request = fake.transport.request.bind(fake.transport);
    // The caller gives up while the task's request is on its way.
    const transport = { request: async (req: HttpRequest, signal?: AbortSignal) => { if (req.url.includes("tasks:")) controller.abort(); return request(req, signal); } };
    const leaving = new AtlasClient({ config: { apiKey: KEY, baseUrl: FAKE_API_ROOT, maxRetries: 0 }, transport, sleeper: new NoopSleeper() });
    let named: string | undefined;
    const failure = await leaving.poseImages({ images: ["asset_x"] }, { signal: controller.signal, onSubmitted: (operation) => { named = operation.id; } }).catch((e) => e);
    // The job was accepted and is named, to the caller and in the error: it can be taken up or stopped.
    expect(named).toBe("op_0001");
    expect(failure).toBeInstanceOf(AtlasCancelledError);
    expect(failure.operationId).toBe("op_0001");
  });
});

describe("waiting", () => {
  it("looks with growing pauses and never past the longest", async () => {
    const { client, sleeper, events } = setup({ looksUntilDone: 7 });
    await client.poseImages({ images: ["asset_x"] }, { pollMs: 2_000, maxPollMs: 8_000 });
    expect(sleeper.slept).toEqual([2_000, 3_000, 4_500, 6_750, 8_000, 8_000]);
    expect(events.filter((event) => event.kind === "waiting").at(-1)).toMatchObject({ state: "running", progress: expect.any(Number) });
    expect(events.at(-1)).toMatchObject({ kind: "done", state: "succeeded" });
  });

  it("spreads its pauses by a tenth either way, so that many waiters do not look together", async () => {
    const fake = new FakeAtlas({ looksUntilDone: 3 });
    const sleeper = new NoopSleeper();
    const draws = [0, 1];
    const client = new AtlasClient({ config: { apiKey: KEY, baseUrl: FAKE_API_ROOT, maxRetries: 0 }, transport: fake.transport, sleeper, random: () => draws.shift() ?? 0.5 });
    await client.poseImages({ images: ["asset_x"] }, { pollMs: 10_000, maxPollMs: 10_000 });
    expect(sleeper.slept).toEqual([9_000, 11_000]);
  });

  it("takes a 404 on an operation it has just been given as not readable yet, and asks again", async () => {
    const { client, events } = setup({ unreadableLooks: 2, looksUntilDone: 1 });
    const run = await client.poseImages({ images: ["asset_x"] });
    expect(run.operation.state).toBe("succeeded");
    expect(events.filter((event) => event.state === "not readable yet")).toHaveLength(2);
    // An operation nobody was given stays an error.
    await expect(client.getOperation("op_none")).rejects.toMatchObject({ status: 404 });
  });

  it("gives up after the wait it was allowed, names the job it leaves running, and can take it up again", async () => {
    const { client, fake, posed } = setup({ looksUntilDone: 6 });
    const frames = await posed(2);
    let written: string | undefined;
    const failure = await client.splatsFromPosedImages({ posedFrames: frames, refine: false }, { maxWaitMs: 12_000, pollMs: 5_000, onSubmitted: (operation) => { written = operation.id; } }).catch((e) => e);
    expect(failure).toBeInstanceOf(AtlasTimeoutError);
    expect(failure.message).toMatch(/did not finish within 1\ds: it is still running there, and may be charged/);
    // The id was handed over at submission, before any waiting: it is what a caller writes down.
    expect(written).toBe(failure.operationId);
    expect(fake.operations.get(written!)!.done).toBe(false);

    const resumed = await client.resume("posedImages2Splats", written!);
    expect(readSplat(resumed.operation.response).quality).toBe("draft");
    // Taken up, not asked for again.
    expect(fake.submitted("posedImages2Splats")).toHaveLength(1);
  });

  it("stops when the caller gives up: the job is left running, or its cancellation asked for when told to", async () => {
    for (const cancelOnAbort of [false, true]) {
      const { client, fake, sleeper } = setup({ looksUntilDone: 50 });
      const controller = new AbortController();
      const sleep = sleeper.sleep.bind(sleeper);
      sleeper.sleep = async (ms, signal) => { await sleep(ms, signal); if (sleeper.slept.length === 2) controller.abort(); };
      const failure = await client.poseImages({ images: ["asset_x"] }, { signal: controller.signal, cancelOnAbort }).catch((e) => e);
      expect(failure).toBeInstanceOf(AtlasCancelledError);
      expect(failure).toMatchObject({ operationId: "op_0001", cancelledThere: cancelOnAbort });
      expect(fake.operations.get("op_0001")!.cancelled).toBe(cancelOnAbort);
      expect(failure.message).toMatch(cancelOnAbort ? /asked Atlas to cancel it/ : /still running there, and may be charged/);
    }
  });

  it("asks for a cancellation with an id that makes a repeat of it the same request", async () => {
    const { client, fake } = setup({ looksUntilDone: 50 });
    const operation = await client.submit("images2PosedRGBD", { frames: [{ imageAsset: { assetId: "asset_x" } }] });
    const after = await client.cancelOperation(operation.id, { reason: "the pictures were replaced" });
    expect(fake.requests.at(-1)!.body).toEqual({ requestId: "cancel-op_0001", reason: "the pictures were replaced" });
    expect(after).toMatchObject({ done: true, state: "cancelled", error: { code: 1 } });
    await expect(client.waitUntilDone(operation.id)).rejects.toMatchObject({ state: "cancelled" });
  });

  it("does not submit when the caller has already given up", async () => {
    const { client, fake } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(client.poseImages({ images: ["asset_x"] }, { signal: controller.signal })).rejects.toBeInstanceOf(AtlasCancelledError);
    expect(fake.requests).toEqual([]);
  });

  it("reports a job that failed there, with the provider's reason rather than its wording", async () => {
    const { client, posed } = setup({ failing: { posedImages2Splats: { reason: "EXECUTION_FAILED", message: "The task failed during execution." } } });
    const failure = await client.splatsFromPosedImages({ posedFrames: await posed(2), refine: false }).catch((e) => e);
    expect(failure).toBeInstanceOf(AtlasOperationError);
    expect(failure).toMatchObject({ state: "failed", reason: "EXECUTION_FAILED", details: { rpcCode: 13 } });
    expect(failure.message).toMatch(/^Atlas operation op_\d+ failed \(EXECUTION_FAILED\): The task failed during execution\.$/);
  });

  it("can let the server hold each look open, for the thirty seconds it allows", async () => {
    const { client, fake } = setup({ looksUntilDone: 2 });
    await client.poseImages({ images: ["asset_x"] }, { serverWait: true });
    const waits = fake.requests.filter((r) => r.path.endsWith(":wait"));
    expect(waits).toHaveLength(2);
    expect(waits[0]!.body).toEqual({ timeoutSecs: 30 });
  });

  it("lists the project's operations by task and outcome", async () => {
    const { client } = setup({ looksUntilDone: 1 });
    await client.poseImages({ images: ["asset_x"] });
    const second = await client.submit("images2PosedRGBD", { frames: [{ imageAsset: { assetId: "asset_y" } }] });
    const running = await client.listOperations({ task: "images2PosedRGBD", status: "RUNNING" });
    expect(running.operations.map((operation) => operation.id)).toEqual([second.id]);
    // A listed operation has no result: it is read by id.
    expect(running.operations[0]!.response).toBeNull();
    expect((await client.listOperations()).operations).toHaveLength(2);
  });
});

describe("failures on the way", () => {
  it("asks again when it is turned away for a while, waiting as long as it is told to", async () => {
    const { client, fake, sleeper, events } = setup({ looksUntilDone: 1 });
    const operation = await client.submit("images2PosedRGBD", { frames: [{ imageAsset: { assetId: "asset_x" } }] });
    fake.interruptions.push({ status: 429, headers: { "retry-after": "7" }, code: "RATE_LIMIT_EXCEEDED" }, { status: 503 });
    expect((await client.getOperation(operation.id)).state).toBe("succeeded");
    expect(sleeper.slept).toEqual([7_000, 2_000]);
    expect(events.filter((event) => event.kind === "retrying")).toHaveLength(2);
  });

  it("does not sleep for as long as it is told when that is longer than anyone would wait", async () => {
    const { client, fake, sleeper } = setup();
    fake.interruptions.push({ status: 429, headers: { "retry-after": "86400" }, code: "CONCURRENCY_LIMIT_EXCEEDED" });
    await expect(client.getOperation("op_x")).rejects.toMatchObject({ status: 429, retryAfterSeconds: 86400, notAccepted: true, refused: false, providerCode: "CONCURRENCY_LIMIT_EXCEEDED" });
    expect(sleeper.slept).toEqual([]);
  });

  it("stops asking after its retries, and never repeats a refusal", async () => {
    const { client, fake } = setup();
    fake.interruptions.push({ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 });
    await expect(client.getOperation("op_x")).rejects.toMatchObject({ status: 503 });
    expect(fake.requests).toHaveLength(4);
    const refusing = setup({ refusing: { splats2Mesh: 422 } });
    const refusal = await refusing.client.meshFromSplats({ splat: "asset_s" }).catch((e) => e);
    expect(refusal).toMatchObject({ status: 422, refused: true, retryable: false });
    expect(refusing.fake.requests).toHaveLength(1);
  });

  it("knows an account that cannot pay from a request that is wrong", async () => {
    const { client, fake } = setup({ refusing: { splats2Mesh: { status: 402, code: "SPEND_LIMIT_EXCEEDED" } } });
    const failure = await client.meshFromSplats({ splat: "asset_s" }).catch((e) => e);
    expect(failure).toMatchObject({ status: 402, unpaid: true, notAccepted: true, providerCode: "SPEND_LIMIT_EXCEEDED" });
    expect(fake.requests).toHaveLength(1);
  });

  it("refuses a request that cannot be right before sending anything", async () => {
    const { client, fake, posed } = setup();
    const frames = await posed(3);
    const wide = await posed(2, [960, 720]);
    const before = fake.requests.length;
    await expect(client.splatsFromPosedImages({ posedFrames: frames.slice(0, 1), refine: false })).rejects.toThrow("a draft splat takes 2 to 32 posed frames, not 1");
    await expect(client.splatsFromPosedImages({ posedFrames: Array.from({ length: 33 }, () => frames[0]!), refine: false })).rejects.toThrow("a draft splat takes 2 to 32");
    await expect(client.splatsFromPosedImages({ posedFrames: [frames[0]!, wide[0]!], refine: true })).rejects.toThrow("every frame of a splat is on one grid, and these are on 1280x720, 960x720");
    await expect(client.poseImages({ images: [] })).rejects.toThrow("posing takes 1 to 64 pictures");
    await expect(client.generateViews({ contextFrames: frames, targetCameras: [] })).rejects.toThrow(/at least one target camera/);
    await expect(client.generateViews({ contextFrames: [], targetCameras: [frameCamera(frames[0]!)!] })).rejects.toThrow(/at least one posed frame with depth/);
    await expect(client.meshFromSplats({ splat: "asset_s", textureSize: 9000 })).rejects.toThrow("textureSize is from 1 to 8192");
    await expect(client.textToImage({ prompt: " " })).rejects.toThrow(/needs words/);
    expect(fake.requests.length).toBe(before);
  });
});
