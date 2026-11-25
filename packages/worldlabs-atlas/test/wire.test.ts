// ---------------------------------------------------------------------------
// The documented shapes, read and written
// ---------------------------------------------------------------------------
// The examples here are the documentation's own (docs.atlas.worldlabs.ai,
// 2026-11-25): the operation envelope of the Operations page, the failed
// operation of Errors and retries, the completed outputs of the task guides.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  AtlasContractError, cameraForward, cameraPosition, collectFiles, frameCamera, lookAt, posedFrame, readCamera, readMesh, readOperation, readPosedFrames, readSplat,
  wireAsset, wireCamera,
} from "../src/index.js";
import { cancelBody, createAssetBody, createUploadUrlBody, readAsset, readOperationList, readReadUrl, readUploadTicket, waitBody } from "../src/wire.js";

const near = (a: readonly number[], b: readonly number[], digits = 9) => {
  expect(a).toHaveLength(b.length);
  a.forEach((value, index) => expect(value).toBeCloseTo(b[index]!, digits));
};

describe("an operation", () => {
  const envelope = {
    id: "op_01jexample000000000000000000",
    name: "accounts/acct_example/projects/project_example/operations/op_01jexample000000000000000000",
    ownerId: "acct_example", metadata: { task: "atlasGenerate" }, done: false, response: null, error: null,
    createdAtSecs: 1789412264, expiresAtSecs: 1789415864,
  };

  it("is running until `done`, whatever its metadata says", () => {
    expect(readOperation(envelope)).toMatchObject({ id: envelope.id, done: false, state: "running", task: "atlasGenerate", response: null, error: null, createdAtSecs: 1789412264, expiresAtSecs: 1789415864 });
    // A phase or a percentage is for showing: it never ends an operation.
    expect(readOperation({ ...envelope, metadata: { task: "atlasGenerate", phase: "refining", progress: 100 } })).toMatchObject({ done: false, state: "running", phase: "refining", progress: 1 });
  });

  it("succeeded when done with a response, and failed when done with an error, by its reason", () => {
    expect(readOperation({ ...envelope, done: true, response: { frames: [] } })).toMatchObject({ done: true, state: "succeeded", response: { frames: [] }, error: null });
    const failed = readOperation({
      id: "op_example", done: true,
      error: { code: 13, message: "The task failed during execution.", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "EXECUTION_FAILED", domain: "api.worldlabs.ai" }] },
    });
    expect(failed).toMatchObject({ state: "failed", response: null, error: { code: 13, reason: "EXECUTION_FAILED", message: "The task failed during execution." } });
    expect(readOperation({ id: "op_t", done: true, error: { code: 4, message: "deadline", details: [{ reason: "EXECUTION_TIMEOUT" }] } }).error).toMatchObject({ code: 4, reason: "EXECUTION_TIMEOUT" });
    expect(readOperation({ id: "op_c", done: true, error: { code: 1, message: "cancelled", details: [] } })).toMatchObject({ state: "cancelled" });
  });

  it("is refused, naming the file to correct, when it is not an operation", () => {
    expect(() => readOperation({ done: true })).toThrow(AtlasContractError);
    expect(() => readOperation({ id: "op_x" })).toThrow(/wire\.ts/);
    expect(() => readOperation("accepted")).toThrow(AtlasContractError);
    const page = readOperationList({ operations: [{ id: "op_a", done: false }, { id: "op_b", done: true }], nextPageToken: "next" });
    expect(page).toMatchObject({ operations: [{ id: "op_a" }, { id: "op_b", state: "succeeded" }], nextPageToken: "next" });
    expect(() => readOperationList({ items: [] })).toThrow(AtlasContractError);
  });

  it("is waited for and cancelled with the bodies the reference gives", () => {
    expect(waitBody(30)).toEqual({ timeoutSecs: 30 });
    // Capped there at 30 seconds: asking for more is asking for 30.
    expect(waitBody(600)).toEqual({ timeoutSecs: 30 });
    expect(cancelBody("cancel-capture-job-4831", "The input set was replaced.")).toEqual({ requestId: "cancel-capture-job-4831", reason: "The input set was replaced." });
    expect((cancelBody("x".repeat(50))["requestId"] as string)).toHaveLength(36);
  });
});

describe("an asset", () => {
  it("is created, given an upload URL and read back as the reference says", () => {
    expect(createAssetBody("room.png")).toEqual({ asset: { displayName: "room.png" } });
    expect(createUploadUrlBody({ contentType: "image/png", bytes: 248901 })).toEqual({ contentType: "image/png", contentLength: 248901 });
    expect(readUploadTicket({ uploadUrl: "https://storage.example/u", method: "put", headers: { "x-goog-content-length-range": "0,10" }, expiresAt: "2026-11-25T12:30:00Z" }))
      .toEqual({ uploadUrl: "https://storage.example/u", method: "PUT", headers: { "x-goog-content-length-range": "0,10" } });
    expect(() => readUploadTicket({ method: "PUT" })).toThrow(AtlasContractError);
    // A size comes as a string.
    expect(readAsset({ id: "asset_01", displayName: "room.png", mimeType: "image/png", state: "READY", sizeBytes: "248901", width: 1280, height: 720 }))
      .toEqual({ id: "asset_01", state: "READY", fileName: "room.png", contentType: "image/png", bytes: 248901, width: 1280, height: 720 });
    expect(() => readAsset({ displayName: "nameless" })).toThrow(AtlasContractError);
    expect(readReadUrl({ readUrl: "https://storage.example/r?sig=1", expiresAt: "2026-11-25T12:15:00Z" })).toBe("https://storage.example/r?sig=1");
    expect(() => readReadUrl({ url: "https://storage.example/unsigned" })).toThrow(AtlasContractError);
  });

  it("is named in a request by its id alone when it has one", () => {
    expect(wireAsset("asset_01")).toEqual({ assetId: "asset_01" });
    expect(wireAsset({ id: "asset_01", fileName: "room.png" })).toEqual({ assetId: "asset_01" });
    // A result's pair goes back as its id: the url would be fetched and stored again as a new asset.
    expect(wireAsset({ assetId: "asset_generated_view", url: "https://example.com/generated-view.png" })).toEqual({ assetId: "asset_generated_view" });
    expect(wireAsset({ url: "https://example.com/room.jpg" })).toEqual({ url: "https://example.com/room.jpg" });
  });
});

describe("a camera", () => {
  it("goes out as a position, an XYZW quaternion and intrinsics, in the convention it says", () => {
    const camera = { width: 1280, height: 720, fx: 900, fy: 880, cx: 640, cy: 360, cameraToWorld: lookAt([0, 1.6, 4], [0, 1.6, 0]) };
    expect(wireCamera(camera)).toEqual({
      extrinsics: { position: [0, 1.6, 4], quaternion: [0, 0, 0, 1], coordinateSystem: "rub" },
      intrinsics: { fx: 900, fy: 880, cx: 640, cy: 360, width: 1280, height: 720 },
    });
  });

  it("turns to its right by a negative rotation about +Y, as the documentation's own example does", () => {
    // "A camera with no rotation that turns 30° to the right has the quaternion [0, -0.2588, 0, 0.9659]."
    const turned = readCamera({ extrinsics: { position: [0, 0, 0], quaternion: [0, -0.2588, 0, 0.9659], coordinateSystem: "rub" }, intrinsics: { fx: 762, fy: 762, cx: 640, cy: 360, width: 1280, height: 720 } })!;
    near(cameraForward(turned), [0.5, 0, -0.866], 3);
    // And the same camera, made here by looking 30° to the right, is written with that quaternion.
    const made = wireCamera({ ...turned, cameraToWorld: lookAt([0, 0, 0], [0.5, 0, -0.8660254]) });
    near(made.extrinsics.quaternion, [0, -0.2588, 0, 0.9659], 4);
  });

  it("comes back the same from what it was written as, wherever it stands and looks", () => {
    for (const [eye, target] of [[[3, 1.5, 4], [0, 1, 0]], [[-2, 0.4, -6], [1, 2, 0]], [[0, 5, 0.001], [0, 0, 0]], [[0, 1, -3], [0, 1, 0]]] as const) {
      const camera = { width: 960, height: 720, fx: 700, fy: 700, cx: 480, cy: 360, cameraToWorld: lookAt(eye, target) };
      const back = readCamera(wireCamera(camera))!;
      near(back.cameraToWorld, camera.cameraToWorld, 9);
      expect(back).toMatchObject({ width: 960, height: 720, fx: 700, cx: 480 });
    }
  });

  it("is read from OpenCV's axes too, standing in the same place and looking the same way", () => {
    // An "rdf" camera with no rotation looks along +Z, with +Y down.
    const rdf = readCamera({ extrinsics: { position: [1, 2, 3], quaternion: [0, 0, 0, 1], coordinate_system: "rdf" }, intrinsics: { fx: 1200, fy: 1200, cx: 960, cy: 540, width: 1920, height: 1080 } })!;
    near(cameraPosition(rdf), [1, 2, 3]);
    near(cameraForward(rdf), [0, 0, 1]);
    // Its up, in the world, is -Y of its own "down".
    near([rdf.cameraToWorld[1]!, rdf.cameraToWorld[5]!, rdf.cameraToWorld[9]!], [0, -1, 0]);
  });

  it("is null, not a guess, when it is not a camera", () => {
    expect(readCamera({ cameraToWorld: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] })).toBeNull();
    expect(readCamera({ extrinsics: { position: [0, 0, 0], quaternion: [0, 0, 0, 1] }, intrinsics: { fx: 1 } })).toBeNull();
    expect(readCamera({ extrinsics: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], coordinateSystem: "enu" }, intrinsics: { fx: 1, fy: 1, cx: 1, cy: 1, width: 2, height: 2 } })).toBeNull();
    expect(readCamera("camera")).toBeNull();
  });
});

describe("the results of the tasks, as their guides show them", () => {
  const posing = {
    frames: [{
      imageAsset: { assetId: "asset_room_01", url: "https://example.com/room-01.png" },
      camera: { extrinsics: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], coordinateSystem: "rub" }, intrinsics: { width: 1280, height: 720, fx: 900, fy: 900, cx: 640, cy: 360 } },
      depth: { depthAsset: { assetId: "asset_depth_0", url: "https://example.com/depth-0.exr" }, confidenceAsset: { assetId: "asset_confidence_0", url: "https://example.com/confidence-0.png" } },
      centroidWorld: [0.2, 0, -3.1],
    }],
  };

  it("a posing gives frames that are handed on by their assets' ids", () => {
    const frames = readPosedFrames(posing);
    expect(frameCamera(frames[0]!)).toMatchObject({ width: 1280, height: 720, fx: 900 });
    expect(posedFrame(frames[0]!)).toEqual({
      imageAsset: { assetId: "asset_room_01" },
      camera: { extrinsics: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], coordinateSystem: "rub" }, intrinsics: { fx: 900, fy: 900, cx: 640, cy: 360, width: 1280, height: 720 } },
      depth: { depthAsset: { assetId: "asset_depth_0" }, confidenceAsset: { assetId: "asset_confidence_0" } },
    });
    expect(() => readPosedFrames({ frames: [] })).toThrow(AtlasContractError);
    expect(() => readPosedFrames({ posedFrames: posing.frames })).toThrow(AtlasContractError);
  });

  it("a log-depth buffer keeps its range when it is handed on", () => {
    const frame = posedFrame({ ...posing.frames[0]!, depth: { logDepthAsset: { assetId: "asset_log" }, zMin: 0.5, zMax: 40 } })!;
    expect(frame.depth).toEqual({ logDepthAsset: { assetId: "asset_log" }, zMin: 0.5, zMax: 40 });
    expect(posedFrame({ ...posing.frames[0]!, depth: { logDepthAsset: { assetId: "asset_log" } } })).toBeNull();
  });

  it("a reconstruction gives its draft, or its refined splat with the most splats", () => {
    expect(readSplat({ refinedSplats: {}, draftSplat: { assetId: "asset_draft_01", url: "https://example.com/draft.spz" } })).toEqual({ asset: { assetId: "asset_draft_01", url: "https://example.com/draft.spz" }, quality: "draft", splats: null });
    expect(readSplat({ refinedSplats: { "500000": { assetId: "small" }, "2000000": { assetId: "asset_splat_01", url: "https://example.com/refined.spz" } } }))
      .toEqual({ asset: { assetId: "asset_splat_01", url: "https://example.com/refined.spz" }, quality: "refined", splats: 2_000_000 });
    expect(() => readSplat({ refinedSplats: {} })).toThrow(AtlasContractError);
  });

  it("a conversion gives its mesh, and its collider boxes when they were asked for", () => {
    expect(readMesh({ mesh: { assetId: "asset_mesh", url: "https://example.com/mesh.glb" }, colliderBoxes: null, anchorPositions: null, metadata: {} })).toEqual({ mesh: { assetId: "asset_mesh", url: "https://example.com/mesh.glb" }, colliderBoxes: null });
    expect(readMesh({ mesh: { assetId: "m" }, colliderBoxes: { assetId: "c" } }).colliderBoxes).toEqual({ assetId: "c" });
    expect(() => readMesh({ glb: { assetId: "m" } })).toThrow(AtlasContractError);
  });

  it("every file of a result is found, with what it is by the place it holds", () => {
    expect(collectFiles(posing)).toEqual([
      { path: "frames[0].imageAsset", kind: "image", assetId: "asset_room_01", url: "https://example.com/room-01.png" },
      { path: "frames[0].depth.depthAsset", kind: "depth", assetId: "asset_depth_0", url: "https://example.com/depth-0.exr" },
      { path: "frames[0].depth.confidenceAsset", kind: "confidence", assetId: "asset_confidence_0", url: "https://example.com/confidence-0.png" },
    ]);
    expect(collectFiles({ refinedSplats: { "2000000": { assetId: "s" } }, draftSplat: { assetId: "d" }, mesh: { assetId: "m" }, colliderBoxes: { assetId: "c" }, promptUsed: "https://not-a-file.example" }).map((file) => [file.path, file.kind]))
      .toEqual([["refinedSplats.2000000", "splat"], ["draftSplat", "splat"], ["mesh", "mesh"], ["colliderBoxes", "collider"]]);
    expect(collectFiles(null)).toEqual([]);
  });
});
