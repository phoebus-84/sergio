// ---------------------------------------------------------------------------
// Reading answers in the spellings the service may use
// ---------------------------------------------------------------------------
// The real shapes were not known when the readers were written. These tests
// fix what each reader accepts, and that it says so when it finds nothing.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { AtlasContractError, cameraPosition, collectFiles, kindOf, lookAt, readCamera, readOperation, wireCamera } from "../src/index.js";
import { readAsset, readOperationList, readReadUrl, readUploadTicket } from "../src/wire.js";

describe("an operation", () => {
  it("is read from a Google-style answer", () => {
    expect(readOperation({ name: "operations/abc", done: false, metadata: { progress: 0.25 } })).toMatchObject({ id: "abc", done: false, state: "running", progress: 0.25, response: null, error: null, credits: null });
    expect(readOperation({ name: "operations/abc", done: true, response: { splat: {} }, cost: { credits: 500 } })).toMatchObject({ id: "abc", done: true, state: "succeeded", response: { splat: {} }, credits: 500 });
    expect(readOperation({ name: "operations/abc", done: true, error: { code: 3, message: "bad frames" } })).toMatchObject({ state: "failed", error: { code: "3", message: "bad frames" }, response: null });
  });

  it("is read from a snake-case answer with a status", () => {
    expect(readOperation({ operation_id: "o1", status: "IN_PROGRESS", metadata: { progress: { percent: 40 } } })).toMatchObject({ id: "o1", done: false, state: "running", progress: 0.4 });
    expect(readOperation({ id: "o1", status: "completed", result: { mesh: {} }, usage: { credits_charged: 1200 } })).toMatchObject({ done: true, state: "succeeded", response: { mesh: {} }, credits: 1200 });
    expect(readOperation({ id: "o1", status: "canceled" })).toMatchObject({ done: true, state: "cancelled", error: { message: "cancelled" } });
    expect(readOperation({ operation: { id: "o2", state: "QUEUED" } })).toMatchObject({ id: "o2", state: "pending", done: false });
  });

  it("takes a charge only from a field that says credits", () => {
    expect(readOperation({ id: "o", done: true, cost: 5 }).credits).toBeNull();
    expect(readOperation({ id: "o", done: true, cost: { amount: 5, currency: "USD" } }).credits).toBeNull();
    expect(readOperation({ id: "o", done: true, creditsCharged: 0 }).credits).toBe(0);
  });

  it("is refused, naming the file to correct, when it has no id", () => {
    expect(() => readOperation({ done: true })).toThrow(AtlasContractError);
    expect(() => readOperation("accepted")).toThrow(/wire\.ts/);
    expect(readOperationList({ operations: [{ id: "a" }, { name: "operations/b", done: true }] }).map((o) => o.id)).toEqual(["a", "b"]);
    expect(() => readOperationList({ nothing: true })).toThrow(AtlasContractError);
  });
});

describe("an asset", () => {
  it("has its upload URL read from a flat answer or a nested one", () => {
    expect(readUploadTicket({ assetId: "a1", uploadUrl: "https://b/u" })).toEqual({ assetId: "a1", uploadUrl: "https://b/u", method: "PUT", headers: {} });
    expect(readUploadTicket({ asset: { name: "assets/a2" }, upload_info: { upload_url: "https://b/u2", upload_method: "post", required_headers: { "x-goog-content-length-range": "0,10" } } }))
      .toEqual({ assetId: "a2", uploadUrl: "https://b/u2", method: "POST", headers: { "x-goog-content-length-range": "0,10" } });
    expect(() => readUploadTicket({ assetId: "a1" })).toThrow(AtlasContractError);
  });

  it("is read with what the answer says of it, or just its id", () => {
    expect(readAsset({ asset: { id: "a", file_name: "p.png", mime_type: "image/png", size_bytes: 9 } })).toEqual({ id: "a", fileName: "p.png", contentType: "image/png", bytes: 9 });
    expect(readAsset({}, "known")).toEqual({ id: "known" });
    expect(readReadUrl({ readUrl: "https://s/x?sig=1" })).toBe("https://s/x?sig=1");
    expect(readReadUrl({ asset: { download_url: "https://s/y" } })).toBe("https://s/y");
    expect(() => readReadUrl({ url: "gs://bucket/x" })).toThrow(AtlasContractError);
  });
});

describe("the files of a result", () => {
  it("are found wherever they are, with what they are", () => {
    const files = collectFiles({
      splat: { url: "https://cdn/x/refinedSplats_2000000.spz?sig=abc", sizeBytes: 9 },
      frames: [{ image: { assetId: "i0" }, depth: { asset_id: "d0", content_type: "image/x-exr" }, camera: { width: 10 } }],
      preview: "https://cdn/x/preview.webp",
      mesh: { asset: { id: "m0", fileName: "set.glb" } },
      note: "https://docs.example/readme",
    });
    expect(files).toEqual([
      { path: "splat", kind: "splat", url: "https://cdn/x/refinedSplats_2000000.spz?sig=abc" },
      { path: "frames[0].image", kind: "image", assetId: "i0" },
      { path: "frames[0].depth", kind: "depth", assetId: "d0", contentType: "image/x-exr" },
      { path: "preview", kind: "image", url: "https://cdn/x/preview.webp" },
      { path: "mesh", kind: "mesh", assetId: "m0", fileName: "set.glb" },
    ]);
    expect(collectFiles(null)).toEqual([]);
  });

  it("are named by extension first, then type, then place", () => {
    expect(kindOf({ path: "out", fileName: "a.PLY" })).toBe("splat");
    expect(kindOf({ path: "out", contentType: "model/gltf-binary" })).toBe("mesh");
    expect(kindOf({ path: "frames[3].rgb" })).toBe("image");
    expect(kindOf({ path: "result.video", url: "https://x/y" })).toBe("video");
    expect(kindOf({ path: "thing" })).toBe("other");
    // A depth map stored as a picture is still the depth map.
    expect(kindOf({ path: "frames[0].depth", fileName: "d.png" })).toBe("depth");
    expect(kindOf({ path: "frames[0].depth", contentType: "image/png" })).toBe("depth");
    expect(kindOf({ path: "frames[0].image", fileName: "depth-of-field.png" })).toBe("image");
  });
});

describe("a camera", () => {
  const c2w = lookAt([3, 1.5, 4], [0, 1, 0]);
  const camera = { width: 1280, height: 720, fx: 900, fy: 880, cx: 640, cy: 360, cameraToWorld: c2w };

  it("goes out as intrinsics and a camera-to-world matrix, and comes back the same", () => {
    const wire = wireCamera(camera);
    expect(wire).toMatchObject({ width: 1280, height: 720, intrinsics: { fx: 900, fy: 880, cx: 640, cy: 360 }, convention: "opengl" });
    expect((wire["cameraToWorld"] as number[][])[3]).toEqual([0, 0, 0, 1]);
    expect(readCamera(wire)).toEqual(camera);
  });

  it("is read from a world-to-camera matrix, a K matrix, a column-major list and OpenCV's axes", () => {
    const near = (a: readonly number[], b: readonly number[]) => a.forEach((value, index) => expect(value).toBeCloseTo(b[index]!, 9));
    const rows = [0, 1, 2, 3].map((r) => c2w.slice(r * 4, r * 4 + 4));
    const columnMajor = [0, 1, 2, 3].flatMap((c) => [0, 1, 2, 3].map((r) => c2w[r * 4 + c]!));
    near(readCamera({ c2w: columnMajor, fx: 900, fy: 880, width: 1280, height: 720 })!.cameraToWorld, c2w);

    // world-to-camera: R^T and -R^T t
    const t = [c2w[3]!, c2w[7]!, c2w[11]!];
    const w2c = [0, 1, 2].map((r) => [c2w[r]!, c2w[4 + r]!, c2w[8 + r]!, -(c2w[r]! * t[0]! + c2w[4 + r]! * t[1]! + c2w[8 + r]! * t[2]!)]);
    const fromK = readCamera({ extrinsics: w2c, K: [[900, 0, 640], [0, 880, 360], [0, 0, 1]] })!;
    near(fromK.cameraToWorld, c2w);
    expect(fromK).toMatchObject({ fx: 900, fy: 880, cx: 640, cy: 360, width: 1280, height: 720 });

    // The same camera written in OpenCV's axes stands in the same place and looks the same way.
    const opencv = rows.map((row, r) => (r < 3 ? [row[0]!, -row[1]!, -row[2]!, row[3]!] : row));
    const converted = readCamera({ cameraToWorld: opencv, convention: "OpenCV", intrinsics: { fx: 900, fy: 880 }, width: 1280, height: 720 })!;
    near(converted.cameraToWorld, c2w);
    near(cameraPosition(converted), [3, 1.5, 4]);
  });

  it("is null, not a guess, when it cannot be read", () => {
    expect(readCamera({ position: [0, 0, 0], rotation: [0, 0, 0, 1] })).toBeNull();
    expect(readCamera({ cameraToWorld: [[1, 0], [0, 1]] })).toBeNull();
    expect(readCamera({ cameraToWorld: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] })).toBeNull();
    expect(readCamera("camera")).toBeNull();
  });
});
