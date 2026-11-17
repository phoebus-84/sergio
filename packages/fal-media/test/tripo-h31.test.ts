import { describe, it, expect } from "vitest";
import { getProfile, requireValidParameters, tripoH31ImageTo3d, TRIPO_H31, tripoH31PriceUsd } from "../src/profiles.js";
import { createFalClient } from "../src/client.js";
import { ModelProfileContract } from "../src/contracts/v1.js";
import { FalContractError, FalValidationError } from "../src/errors.js";

/**
 * Tripo H3.1: one picture in, a 3D model out, with a preview render and the
 * task it was made by. Priced per model, by what is asked of it.
 */
describe("Tripo H3.1 image to 3D", () => {
  const input = { idempotencyKey: "k", binding: { endpointId: tripoH31ImageTo3d.endpointId, contractVersion: "v1", baseUrl: "" }, parameters: {}, timeoutMs: 1000 };
  const answer = (result: Record<string, unknown>) => new ModelProfileContract(tripoH31ImageTo3d).parseResponse(input, { request_id: "r1", status: "COMPLETED", result });

  describe("profile", () => {
    it("is registered, with the endpoint's schema and defaults", () => {
      expect(getProfile("tripo3d/h3.1/image-to-3d@v1")).toBe(tripoH31ImageTo3d);
      expect(requireValidParameters(tripoH31ImageTo3d, { image_url: "https://x/i.png" })).toEqual({
        image_url: "https://x/i.png", texture: true, pbr: true, texture_quality: "standard", geometry_quality: "standard",
        texture_alignment: "original_image", auto_size: false, orientation: "default", quad: false, enable_safety_checker: true,
      });
    });

    it("refuses what the endpoint does not take, before any request", () => {
      expect(() => requireValidParameters(tripoH31ImageTo3d, {})).toThrow(FalValidationError);
      expect(() => requireValidParameters(tripoH31ImageTo3d, { image_url: "i", texture_quality: "ultra" })).toThrow(FalValidationError);
      expect(() => requireValidParameters(tripoH31ImageTo3d, { image_url: "i", face_limit: TRIPO_H31.faceLimit.min - 1 })).toThrow(FalValidationError);
      expect(() => requireValidParameters(tripoH31ImageTo3d, { image_url: "i", prompt: "a deer" })).toThrow(FalValidationError);
    });

    it("is given the contract that reads a model, by the client", () => {
      const client = createFalClient("key-for-tests") as unknown as { contracts: Map<string, unknown> };
      expect(client.contracts.get(`${tripoH31ImageTo3d.endpointId}@v1`)).toBeInstanceOf(ModelProfileContract);
    });
  });

  describe("answer", () => {
    it("is the model first, its preview after, and the task it was made by", () => {
      const result = answer({
        model_mesh: { url: "https://cdn/m.glb", content_type: "image/png", file_name: "z9.glb", file_size: 4404019 },
        rendered_image: { url: "https://cdn/p.webp", content_type: "image/webp", file_name: "p.webp" },
        model_urls: {},
        task_id: "task-123",
      });
      expect(result.outputs).toEqual([
        { url: "https://cdn/m.glb", contentType: "image/png", contentLength: 4404019, sha256: null, role: "model", fileName: "z9.glb" },
        { url: "https://cdn/p.webp", contentType: "image/webp", contentLength: null, sha256: null, role: "preview", fileName: "p.webp" },
      ]);
      expect(result.details).toEqual({ taskId: "task-123" });
      expect(result.profileId).toBe("tripo3d/h3.1/image-to-3d@v1");
    });

    it("holds with only a model, and says nothing it was not told", () => {
      const result = answer({ model_mesh: { url: "https://cdn/m.glb" } });
      expect(result.outputs).toEqual([{ url: "https://cdn/m.glb", contentType: "model/gltf-binary", contentLength: null, sha256: null, role: "model" }]);
      expect(result).not.toHaveProperty("details");
    });

    it("is refused without a model", () => {
      expect(() => answer({ rendered_image: { url: "https://cdn/p.webp" } })).toThrow(FalContractError);
    });
  });

  describe("price", () => {
    it("is per model, by its textures", () => {
      expect(tripoH31PriceUsd()).toBe(0.3);
      expect(tripoH31PriceUsd({ texture: "none" })).toBe(0.2);
      expect(tripoH31PriceUsd({ texture: "standard" })).toBe(0.3);
      expect(tripoH31PriceUsd({ texture: "detailed" })).toBe(0.4);
    });

    it("adds for detailed geometry and for a quad mesh", () => {
      expect(tripoH31PriceUsd({ texture: "none", detailedGeometry: true })).toBe(0.4);
      expect(tripoH31PriceUsd({ texture: "standard", quad: true })).toBe(0.35);
      expect(tripoH31PriceUsd({ texture: "detailed", detailedGeometry: true, quad: true })).toBe(0.65);
    });

    it("is the profile's estimate for the default request", () => {
      expect(tripoH31ImageTo3d.pricing.estimatedUnitCost).toBe(tripoH31PriceUsd());
    });
  });
});
