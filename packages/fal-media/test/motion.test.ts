// A motion from words: the profile's numbers, what is sent, and how the answer is read.
import { describe, expect, it } from "vitest";
import { MotionProfileContract } from "../src/contracts/v1.js";
import { FalContractError, FalValidationError } from "../src/errors.js";
import { HUNYUAN_MOTION, HYPER3D_CLIP_CATEGORIES, HYPER3D_CLIPS_ENDPOINT, getProfile, hunyuanMotion, readStockClips, requireValidParameters } from "../src/profiles.js";
import { FREE_LOOKUPS, createFalClient } from "../src/client.js";

const contract = new MotionProfileContract(hunyuanMotion);
const input = { idempotencyKey: "k", binding: { endpointId: hunyuanMotion.endpointId, contractVersion: "v1", baseUrl: "" }, parameters: {}, timeoutMs: 1000 };
const answer = (result: Record<string, unknown>) => contract.parseResponse(input, { request_id: "req-1", status: "COMPLETED", result });

describe("stock clips", () => {
  it("are read from the catalogue's answer, and one with no id is left out", () => {
    expect(readStockClips({ animations: [
      { animation_id: "human_000089", category: "human", display_name: "walking", content_description: "Walking", duration_seconds: 1.0333, loop: { kind: "in_place" } },
      { animation_id: "human_000002", category: "human", display_name: "", duration_seconds: 2.3667, loop: { kind: "none" } },
      { display_name: "no id" }, null,
    ] })).toEqual([
      { id: "human_000089", category: "human", name: "walking", description: "Walking", seconds: 1.03, loops: true },
      { id: "human_000002", category: "human", name: "human_000002", description: "", seconds: 2.37, loops: false },
    ]);
    expect(readStockClips({})).toEqual([]);
    expect(HYPER3D_CLIP_CATEGORIES).toContain("canine");
  });

  it("are asked of the one endpoint that costs nothing: a lookup is no way to an endpoint that is paid", async () => {
    expect(FREE_LOOKUPS).toEqual([HYPER3D_CLIPS_ENDPOINT]);
    await expect(createFalClient("key").lookup(hunyuanMotion.endpointId, { prompt: "A person waves." })).rejects.toThrow(FalValidationError);
  });
});

describe("Hunyuan Motion", () => {
  it("is registered, priced by the motion, and asks for a sentence", () => {
    expect(getProfile(hunyuanMotion.profileId)).toBe(hunyuanMotion);
    expect(hunyuanMotion).toMatchObject({ endpointId: "fal-ai/hunyuan-motion", operation: "text-to-motion" });
    expect(hunyuanMotion.pricing).toMatchObject({ estimatedUnitCost: HUNYUAN_MOTION.priceUsd, currency: "USD" });
    expect(HUNYUAN_MOTION).toMatchObject({ priceUsd: 0.08, seconds: { min: 0.5, max: 12, default: 5 } });
    expect(hunyuanMotion.parameterSchema.filter((p) => p.required).map((p) => p.name)).toEqual(["prompt"]);
  });

  it("refuses a length it does not make, before anything is sent", () => {
    expect(requireValidParameters(hunyuanMotion, { prompt: "A person waves." })).toEqual({ prompt: "A person waves.", duration: 5, guidance_scale: 5, output_format: "fbx" });
    expect(() => requireValidParameters(hunyuanMotion, { prompt: "A person waves.", duration: 13 })).toThrow(FalValidationError);
    expect(() => requireValidParameters(hunyuanMotion, { prompt: "A person waves.", duration: 0.2 })).toThrow(FalValidationError);
    expect(() => requireValidParameters(hunyuanMotion, {})).toThrow(FalValidationError);
  });

  it("gives the motion file and the seed that made it", () => {
    const result = answer({ fbx_file: { url: "https://cdn/m.fbx", file_name: "m.fbx", file_size: 9 }, motion_json: null, seed: 42 });
    expect(result.outputs).toEqual([{ url: "https://cdn/m.fbx", contentType: "application/octet-stream", contentLength: 9, sha256: null, role: "motion", fileName: "m.fbx" }]);
    expect(result.details).toEqual({ seed: "42" });
  });

  it("refuses an answer with no motion in it", () => {
    expect(() => answer({ fbx_file: null, motion_json: { url: "https://cdn/m.json" }, seed: 1 })).toThrow(FalContractError);
  });
});
