import { describe, it, expect } from "vitest";
import {
  getProfile, requireValidParameters, hyper3dRigging, meshyRigging, HYPER3D_RIG, MESHY_RIG, meshyRigPriceUsd,
} from "../src/profiles.js";
import { createFalClient } from "../src/client.js";
import { RigProfileContract } from "../src/contracts/v1.js";
import { FalContractError, FalValidationError } from "../src/errors.js";

/**
 * Rigging: a model goes in with no skeleton and comes back with one, and
 * sometimes with clips that move it. Two providers, two shapes of answer,
 * one set of roles a caller relies on.
 */
describe("rigging a model", () => {
  const input = (endpointId: string) => ({ idempotencyKey: "k", binding: { endpointId, contractVersion: "v1", baseUrl: "" }, parameters: {}, timeoutMs: 1000 });
  const hyper = (result: Record<string, unknown>) =>
    new RigProfileContract(hyper3dRigging).parseResponse(input(hyper3dRigging.endpointId), { request_id: "r1", status: "COMPLETED", result });
  const meshy = (result: Record<string, unknown>) =>
    new RigProfileContract(meshyRigging).parseResponse(input(meshyRigging.endpointId), { request_id: "r2", status: "COMPLETED", result });
  const roles = (outputs: readonly { role?: string; url: string }[]) => outputs.map((o) => `${o.role} ${o.url}`);

  describe("profiles", () => {
    it("are registered, with each endpoint's schema and defaults", () => {
      expect(getProfile("hyper3d/rigging@v1")).toBe(hyper3dRigging);
      expect(getProfile("meshy/rigging@v1")).toBe(meshyRigging);
      expect(requireValidParameters(hyper3dRigging, { model_url: "https://x/m.glb" })).toEqual({
        model_url: "https://x/m.glb", bone_template: "auto", skinning_method: "shell", in_place: false, geometry_file_format: "fbx",
      });
      expect(requireValidParameters(meshyRigging, { model_url: "https://x/m.glb" })).toEqual({
        model_url: "https://x/m.glb", height_meters: MESHY_RIG.defaultHeightMeters, include_fingers: false, enable_animation: false, enable_safety_checker: true,
      });
    });

    it("refuse what the endpoints do not take, before any request", () => {
      expect(() => requireValidParameters(hyper3dRigging, {})).toThrow(FalValidationError);
      expect(() => requireValidParameters(hyper3dRigging, { model_url: "m", bone_template: "fish" })).toThrow(FalValidationError);
      expect(() => requireValidParameters(hyper3dRigging, { model_url: "m", animation_presets: Array.from({ length: HYPER3D_RIG.maxClips + 1 }, (_, i) => `a${i}`) })).toThrow(FalValidationError);
      expect(() => requireValidParameters(hyper3dRigging, { model_url: "m", height_meters: 1.7 })).toThrow(FalValidationError);
      expect(() => requireValidParameters(meshyRigging, { model_url: "m", skeleton_template: "human" })).toThrow(FalValidationError);
      expect(() => requireValidParameters(meshyRigging, { model_url: "m", animation_action_id: MESHY_RIG.actionIds.max + 1 })).toThrow(FalValidationError);
      expect(() => requireValidParameters(meshyRigging, { model_url: "m", height_meters: 0 })).toThrow(FalValidationError);
    });

    it("are given the contract that reads a rig, by the client", () => {
      const client = createFalClient("key-for-tests") as unknown as { contracts: Map<string, unknown> };
      expect(client.contracts.get(`${hyper3dRigging.endpointId}@v1`)).toBeInstanceOf(RigProfileContract);
      expect(client.contracts.get(`${meshyRigging.endpointId}@v1`)).toBeInstanceOf(RigProfileContract);
    });

    it("price a Meshy rig by whether a preset clip is asked for", () => {
      expect(meshyRigPriceUsd()).toBe(0.2);
      expect(meshyRigPriceUsd({ animation: true })).toBe(0.32);
      expect(hyper3dRigging.pricing.estimatedUnitCost).toBe(HYPER3D_RIG.priceUsd);
    });
  });

  describe("Hyper3D's answer", () => {
    it("is the rig alone first, then the rig with its clips, the FBX, and each clip by its preset", () => {
      const result = hyper({
        model_mesh: { url: "https://cdn/all.glb", content_type: "image/png", file_name: "all.glb", file_size: 9 },
        rigged_character_glb: { url: "https://cdn/rig.glb" },
        fbx_file: { url: "https://cdn/rig.fbx", file_name: "rig.fbx" },
        animations: [
          { action_id: "walk_01", animation_glb: { url: "https://cdn/walk.glb" } },
          { action_id: "wave", animation_glb: { url: "https://cdn/wave.glb" } },
          { action_id: "../../etc", animation_glb: { url: "https://cdn/bad.glb" } },
          { animation_glb: { url: "https://cdn/nameless.glb" } },
        ],
        textures: [{ url: "https://cdn/t.png" }],
      });
      expect(roles(result.outputs)).toEqual([
        "rig https://cdn/rig.glb",
        "rig-with-clips https://cdn/all.glb",
        "rig-fbx https://cdn/rig.fbx",
        "clip:walk_01 https://cdn/walk.glb",
        "clip:wave https://cdn/wave.glb",
      ]);
      expect(result.outputs[0]).toMatchObject({ contentType: "model/gltf-binary" });
      expect(result.outputs[1]).toMatchObject({ fileName: "all.glb", contentLength: 9 });
      expect(result).not.toHaveProperty("details");
    });

    it("is the rig once when no clips were asked for and the one file comes under both names", () => {
      // What the service answered on 2026-11-17: the same URL twice, no FBX, no clips.
      const file = { url: "https://cdn/source.glb", content_type: "model/gltf-binary", file_name: "source.glb", file_size: 1758968 };
      const result = hyper({ model_mesh: file, rigged_character_glb: { ...file }, animations: [], fbx_file: null, additional_files: [], textures: [] });
      expect(roles(result.outputs)).toEqual(["rig https://cdn/source.glb"]);
    });

    it("holds with only the one file, which is then the rig", () => {
      expect(roles(hyper({ model_mesh: { url: "https://cdn/all.fbx", file_name: "all.fbx" } }).outputs)).toEqual(["rig https://cdn/all.fbx"]);
    });
  });

  describe("Meshy's answer", () => {
    it("is the rig, its FBX, the walk and the run it always adds, and the task that made it", () => {
      const result = meshy({
        rigged_character_glb: { url: "https://cdn/rig.glb", file_name: "rig.glb" },
        rigged_character_fbx: { url: "https://cdn/rig.fbx" },
        basic_animations: {
          walking_glb: { url: "https://cdn/walking.glb" }, walking_fbx: { url: "https://cdn/walking.fbx" },
          walking_armature_glb: { url: "https://cdn/walking-armature.glb" }, running_glb: { url: "https://cdn/running.glb" },
        },
        animation_glb: null,
        rig_task_id: "rig-task-9",
      });
      expect(roles(result.outputs)).toEqual([
        "rig https://cdn/rig.glb",
        "rig-fbx https://cdn/rig.fbx",
        "clip:walking https://cdn/walking.glb",
        "clip:running https://cdn/running.glb",
      ]);
      expect(result.details).toEqual({ taskId: "rig-task-9" });
      expect(result.profileId).toBe("meshy/rigging@v1");
    });

    it("adds the preset clip when one was asked for", () => {
      expect(roles(meshy({ rigged_character_glb: { url: "https://cdn/rig.glb" }, animation_glb: { url: "https://cdn/act.glb" } }).outputs))
        .toEqual(["rig https://cdn/rig.glb", "clip:action https://cdn/act.glb"]);
    });
  });

  it("refuses an answer with no rigged model in it", () => {
    expect(() => meshy({ basic_animations: { walking_glb: { url: "https://cdn/walking.glb" } } })).toThrow(FalContractError);
    expect(() => hyper({ animations: [] })).toThrow(FalContractError);
  });
});
