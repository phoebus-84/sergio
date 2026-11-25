import { describe, expect, it } from "vitest";
import {
  ATLAS_TARGET_SIZES, FAILED_RUNS_FREE, PUBLISHED_CREDITS, WIRE, cameraForward, cameraPosition, describePrices, estimate, fovYDegrees, invertRigid, isTargetSize, lookAt,
  matrixOf, orbit, pinhole, placed, provenanceOf, push, quaternionOf, redactKey, sceneFocus, withoutSignatures, type AtlasOperation, type TaskRun,
} from "../src/index.js";

const near = (a: readonly number[], b: readonly number[], digits = 9) => {
  expect(a).toHaveLength(b.length);
  a.forEach((value, index) => expect(value).toBeCloseTo(b[index]!, digits));
};

describe("cameras", () => {
  it("look where they are told, in OpenGL's convention: -z ahead, +y up", () => {
    const camera = placed([0, 1, 5], [0, 1, 0], 1280, 720);
    near(cameraPosition(camera), [0, 1, 5]);
    near(cameraForward(camera), [0, 0, -1]);
    near(camera.cameraToWorld.slice(0, 3), [1, 0, 0]);
    near([camera.cameraToWorld[1]!, camera.cameraToWorld[5]!, camera.cameraToWorld[9]!], [0, 1, 0]);
    near(invertRigid(invertRigid(lookAt([3, 2, 1], [0, 0, 0]))), lookAt([3, 2, 1], [0, 0, 0]));
    expect(() => lookAt([0, 0, 0], [0, 0, 0])).toThrow(/cannot look at the place it stands on/);
    expect(() => lookAt([0, 0, 0], [0, 5, 0])).toThrow();
  });

  it("are turned as a quaternion says, and say their turn as one", () => {
    // No rotation is the identity; a quarter turn about +Y sends the camera's -Z to the world's -X.
    near(matrixOf([1, 2, 3], [0, 0, 0, 1]), [1, 0, 0, 1, 0, 1, 0, 2, 0, 0, 1, 3, 0, 0, 0, 1]);
    const quarter = matrixOf([0, 0, 0], [0, Math.SQRT1_2, 0, Math.SQRT1_2]);
    near(cameraForward({ cameraToWorld: quarter }), [-1, 0, 0]);
    near(quaternionOf(quarter), [0, Math.SQRT1_2, 0, Math.SQRT1_2]);
    // A quaternion that is not of length 1 is taken for the turn it points at; w is given at or above 0.
    near(matrixOf([0, 0, 0], [0, 2, 0, 2]), quarter);
    near(quaternionOf(matrixOf([0, 0, 0], [0, -Math.SQRT1_2, 0, -Math.SQRT1_2])), [0, Math.SQRT1_2, 0, Math.SQRT1_2]);
    // Half a turn, where w is 0 and the largest diagonal entry has to be found.
    for (const q of [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0.5, 0.5, 0.5, 0.5]] as const) near(quaternionOf(matrixOf([0, 0, 0], q)), q);
    expect(() => matrixOf([0, 0, 0], [0, 0, 0, 0])).toThrow(/length 0/);
  });

  it("have a lens from a field of view, and give it back", () => {
    const lens = pinhole(1280, 720, 50);
    expect(lens).toMatchObject({ width: 1280, height: 720, cx: 640, cy: 360 });
    expect(fovYDegrees(lens)).toBeCloseTo(50, 9);
    expect(() => pinhole(1280, 720, 0)).toThrow(/field of view/);
  });

  it("go round a point at the height and distance they start from, each looking at it", () => {
    const from = placed([0, 1.6, 4], [0, 1, 0], 1280, 720, 40);
    const path = orbit({ from, centre: [0, 1, 0], sweepDegrees: 90, count: 3, width: 960, height: 720 });
    expect(path).toHaveLength(3);
    near(cameraPosition(path[0]!), [0, 1.6, 4]);
    near(cameraPosition(path[2]!), [4, 1.6, 0]);
    for (const camera of path) {
      expect(Math.hypot(cameraPosition(camera)[0], cameraPosition(camera)[2])).toBeCloseTo(4, 9);
      expect(camera).toMatchObject({ width: 960, height: 720 });
      expect(fovYDegrees(camera)).toBeCloseTo(40, 9);
      // Looking at the centre: the way to it and the way it looks are one.
      const to = [0 - cameraPosition(camera)[0], 1 - cameraPosition(camera)[1], 0 - cameraPosition(camera)[2]];
      const length = Math.hypot(...to);
      near(cameraForward(camera), to.map((v) => v / length));
    }
    // A full turn does not end where it began.
    const round = orbit({ from, centre: [0, 1, 0], sweepDegrees: 360, count: 4, width: 1280, height: 720 });
    near(cameraPosition(round[3]!), [-4, 1.6, 0]);
    expect(() => orbit({ from, centre: [0, 1, 0], sweepDegrees: 400, count: 2, width: 1280, height: 720 })).toThrow(/at most 360/);
  });

  it("push straight along their line of sight without turning", () => {
    const from = placed([0, 1, 5], [0, 1, 0], 1280, 720);
    const path = push({ from, distance: 2, count: 3, width: 1280, height: 720 });
    near(path.map((camera) => cameraPosition(camera)[2]), [5, 4, 3]);
    for (const camera of path) near(cameraForward(camera), [0, 0, -1]);
    // One view alone is taken from where the push ends, not from where a picture already stands.
    near(cameraPosition(push({ from, distance: 2, count: 1, width: 1280, height: 720 })[0]!), [0, 1, 3]);
  });

  it("find what a set of cameras is looking at, and say when that is a guess", () => {
    const round = [[4, 1, 0], [0, 1, 4], [-4, 1, 0]].map((at) => placed(at as [number, number, number], [0, 1, 0], 1280, 720));
    const focus = sceneFocus(round);
    near(focus.centre, [0, 1, 0], 6);
    expect(focus.radius).toBeCloseTo(4, 6);
    expect(focus.guessed).toBe(false);
    // Side by side, all looking the same way: no point is shared.
    const row = [-1, 0, 1].map((x) => placed([x, 1, 5], [x, 1, 0], 1280, 720));
    expect(sceneFocus(row)).toMatchObject({ guessed: true, radius: 2 });
    near(sceneFocus(row).centre, [0, 1, 3]);
    expect(() => sceneFocus([])).toThrow();
  });

  it("know the sizes a target camera may have: none above 720p", () => {
    expect(ATLAS_TARGET_SIZES.every(([w, h]) => Math.min(w, h) <= 720)).toBe(true);
    expect(isTargetSize(1280, 720)).toBe(true);
    expect(isTargetSize(1920, 1080)).toBe(false);
  });
});

describe("prices", () => {
  it("say a failed run is free only where the documentation says so", () => {
    expect(FAILED_RUNS_FREE).toEqual(["posedImages2Splats"]);
  });

  it("are the published ones for a splat, by quality", () => {
    expect(estimate("posedImages2Splats", { refine: false })).toEqual({ key: "posedImages2Splats.draft", units: 1, credits: 500, usd: 0.5, priced: true, basis: "published" });
    expect(estimate("posedImages2Splats", { refine: true })).toMatchObject({ credits: 5000, usd: 5 });
    // Not saying is asking for the refined one: the dearer price is the one estimated.
    expect(estimate("posedImages2Splats")).toMatchObject({ key: "posedImages2Splats.refined", credits: 5000 });
  });

  it("are unknown, never guessed, for what was not published", () => {
    for (const task of ["images2PosedRGBD", "splats2Mesh", "atlasGenerate", "atlasChisel", "atlasTextToImage"] as const) {
      expect(estimate(task)).toMatchObject({ priced: false, basis: "unknown", credits: 0 });
    }
    expect(Object.keys(PUBLISHED_CREDITS)).toEqual(["posedImages2Splats.draft", "posedImages2Splats.refined"]);
  });

  it("are the operator's when the operator gives them, per view for a render", () => {
    const own = { splats2Mesh: 1500, "atlasGenerate.perView": 40, "posedImages2Splats.draft": 450 };
    expect(estimate("splats2Mesh", {}, own)).toMatchObject({ credits: 1500, usd: 1.5, priced: true, basis: "operator" });
    expect(estimate("atlasGenerate", { views: 12 }, own)).toMatchObject({ key: "atlasGenerate.perView", units: 12, credits: 480, usd: 0.48 });
    expect(estimate("posedImages2Splats", { refine: false }, own)).toMatchObject({ credits: 450, basis: "operator" });
    expect(estimate("splats2Mesh", {}, { splats2Mesh: -1 })).toMatchObject({ priced: false });
    expect(describePrices(own)).toContain("splats2Mesh: 1500 credits ($1.5), the operator's");
    expect(describePrices()).toContain("images2PosedRGBD: not known");
  });
});

describe("provenance", () => {
  const operation: AtlasOperation = {
    id: "op_9", done: true, state: "succeeded", task: "posedImages2Splats", phase: null, progress: null, error: null, createdAtSecs: 1, expiresAtSecs: null,
    response: { refinedSplats: {}, draftSplat: { assetId: "asset_draft", url: "https://cdn.example/a/draft.spz?X-Signature=secret&Expires=1" } }, raw: {},
  };
  const run: TaskRun = {
    task: "posedImages2Splats", operation, startedAtMs: 0, finishedAtMs: 61_240,
    files: [{ path: "draftSplat", kind: "splat", assetId: "asset_draft", url: "https://cdn.example/a/draft.spz?X-Signature=secret&Expires=1" }],
    trace: { operationId: "op_9", taskName: "posedImages2Splats", request: { posedFrames: [{ imageAsset: { url: "https://cdn.example/in.png?token=t" } }] } },
  };

  it("keeps what was asked, what came back and what it was priced at, and no URL that still opens anything", () => {
    const request = { posedFrames: [{ imageAsset: { assetId: "a" } }, { imageAsset: { assetId: "b" } }], refine: false };
    const record = provenanceOf(run, request, estimate("posedImages2Splats", { refine: false }));
    expect(record).toMatchObject({
      version: 1, provider: "worldlabs-atlas", task: "posedImages2Splats", operationId: "op_9", state: "succeeded", request,
      wire: WIRE, estimate: { credits: 500, basis: "published" },
      startedAt: "1970-01-01T00:00:00.000Z", seconds: 61.2,
    });
    // An operation does not say what it was charged, so the record does not pretend to know.
    expect(record).not.toHaveProperty("cost");
    expect(record.requestSha256).toMatch(/^[0-9a-f]{64}$/);
    const text = JSON.stringify(record);
    expect(text).not.toMatch(/secret|token=|Expires/);
    expect(text).toContain("https://cdn.example/a/draft.spz");
    // The record says which documentation the shapes came from, and that they never ran against the real service.
    expect(record.wire).toMatchObject({ documentation: expect.stringContaining("docs.atlas.worldlabs.ai"), verifiedLive: null });
  });

  it("cuts a signature off a URL and leaves everything else as it is", () => {
    expect(withoutSignatures({ a: "https://x/y.png?sig=1", b: ["plain", 3, null, "https://x/z#frag"], c: "not a url ? really" }))
      .toEqual({ a: "https://x/y.png", b: ["plain", 3, null, "https://x/z"], c: "not a url ? really" });
    expect(redactKey("wl_live_0123456789abcdef")).toBe("…cdef");
    expect(redactKey("short")).toBe("****");
  });
});
