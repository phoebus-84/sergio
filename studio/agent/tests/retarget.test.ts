// ---------------------------------------------------------------------------
// A clip carried from one skeleton to another
// ---------------------------------------------------------------------------
// The target is a real binary glTF; the clip is what the sampler writes.
// What is checked is where the target's joints end up when the written clip
// is played: the file is read back and its skeleton posed frame by frame.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { accessorReader, readGlb, transformPoint, worldMatrices } from "../src/glb.js";
import { arc, isBiped, readRoles, retargetClip } from "../src/retarget.js";
import { examineRig } from "../src/rig-exam.js";
import { SMPL, WALKER, about, clipOn, walkerGlb } from "./fixtures/walker.js";

const round = (v: number[], digits = 3) => v.map((x) => Math.round(x * 10 ** digits) / 10 ** digits + 0);

/** Play the one clip a file holds and say where a joint is in a frame. */
function played(bytes: Uint8Array, frame: number) {
  const glb = readGlb(bytes)!;
  const nodes = structuredClone(glb.json.nodes!);
  const animation = glb.json.animations![0]!;
  for (const channel of animation.channels!) {
    const value = accessorReader(glb, animation.samplers![channel.sampler]!.output)!.get(frame);
    const node = nodes[channel.target!.node!]!;
    if (channel.target!.path === "rotation") node.rotation = value;
    else node.translation = value;
  }
  const { world } = worldMatrices({ ...glb.json, nodes });
  return (name: string) => round(transformPoint(world[nodes.findIndex((node) => node.name === name)]!, [0, 0, 0]));
}
const targetBones = WALKER.joints.map((joint) => ({ name: joint.name, parent: joint.parent >= 0 ? WALKER.joints[joint.parent]!.name : null, at: joint.at }));
const sourceBones = SMPL.map((bone) => ({ name: bone.name, parent: bone.parent, at: bone.rest }));

describe("which bone plays which part", () => {
  it("reads a skeleton named for its parts", () => {
    const roles = readRoles(targetBones);
    expect(roles.naming).toBe("segments");
    expect(roles.bones).toMatchObject({
      hips: "Hips", neck: "Neck", head: "Head",
      "clavicle.left": "LeftShoulder", "upperArm.left": "LeftArm", "foreArm.left": "LeftForeArm", "hand.left": "LeftHand",
      "thigh.right": "RightUpLeg", "shin.right": "RightLeg", "foot.right": "RightFoot", "toe.right": "RightToeBase",
    });
    expect(roles.spine).toEqual(["Spine", "Spine1"]);
    expect(isBiped(roles)).toBe(true);
  });

  it("reads a skeleton named for its joints, where a shoulder is an upper arm and a knee a shin", () => {
    const roles = readRoles(sourceBones);
    expect(roles.naming).toBe("joints");
    expect(roles.bones).toMatchObject({
      hips: "Pelvis", "clavicle.left": "L_Collar", "upperArm.left": "L_Shoulder", "foreArm.left": "L_Elbow", "hand.left": "L_Wrist",
      "thigh.left": "L_Hip", "shin.left": "L_Knee", "foot.left": "L_Ankle", "toe.left": "L_Foot",
    });
    expect(roles.spine).toEqual(["Spine1", "Spine2", "Spine3"]);
  });

  it("tells left from right by where a bone is, not by what it is called", () => {
    const swapped = targetBones.map((bone) => ({ ...bone, name: bone.name.replace(/^(Left|Right)/, (side) => (side === "Left" ? "Right" : "Left")) }));
    expect(readRoles(swapped).bones["upperArm.left"]).toBe("RightArm");
    // Facing the other way, the body's left is on the other side of the file.
    expect(readRoles(targetBones, "-z").bones["upperArm.left"]).toBe("RightArm");
    expect(readRoles(targetBones.map((bone) => ({ ...bone, at: [bone.at[2], bone.at[1], -bone.at[0]] as [number, number, number] })), "+x").bones["upperArm.left"]).toBe("LeftArm");
  });

  it("does not take fingers, twist bones or tips for the parts they hang from", () => {
    const more = [...targetBones, { name: "LeftHandIndex1", parent: "LeftHand", at: [0.68, 1.02, 0] as [number, number, number] },
      { name: "LeftArmTwist", parent: "LeftArm", at: [0.3, 1.4, 0] as [number, number, number] }, { name: "Head_end", parent: "Head", at: [0, 1.8, 0] as [number, number, number] }];
    const roles = readRoles(more);
    expect([roles.bones["hand.left"], roles.bones["upperArm.left"], roles.bones.head]).toEqual(["LeftHand", "LeftArm", "Head"]);
  });

  it("says a skeleton with no legs to find is not a two-legged one", () => {
    expect(isBiped(readRoles([{ name: "Root", parent: null, at: [0, 0, 0] }, { name: "Tail", parent: "Root", at: [0, 0, 1] }]))).toBe(false);
  });
});

describe("the shortest turn between two directions", () => {
  it("takes one to the other, and half a turn when they are opposite", () => {
    expect(round(arc([1, 0, 0], [0, 1, 0]))).toEqual(round(about("z", 90)));
    expect(arc([0, 2, 0], [0, 5, 0])).toEqual([0, 0, 0, 1]);
    expect(Math.abs(arc([1, 0, 0], [-1, 0, 0])[3])).toBeLessThan(1e-9);
  });
});

describe("a clip carried to a rig", () => {
  it("leaves a body that does not move standing as the source stands: an A-pose brought to a T", () => {
    const { bytes, report } = retargetClip(walkerGlb(), clipOn(SMPL, 3), { name: "still" });
    const at = played(bytes, 1);
    // The source rests with its arms level; the rig's arms, which hang, are brought level and keep their own lengths.
    expect(at("LeftArm")).toEqual([0.2, 1.5, 0]);
    expect(at("LeftForeArm")).toEqual(round([0.2 + Math.hypot(0.2, 0.2), 1.5, 0]));
    expect(at("LeftHand")).toEqual(round([0.2 + 2 * Math.hypot(0.2, 0.2), 1.5, 0]));
    expect(at("RightHand")).toEqual(round([-0.2 - 2 * Math.hypot(0.2, 0.2), 1.5, 0]));
    // Legs that rest the same way stay where they were, and the hips at their own height.
    expect(at("Hips")).toEqual([0, 1, 0]);
    expect(at("LeftFoot")).toEqual([0.12, 0.08, 0]);
    expect(report).toMatchObject({ name: "still", frames: 3, sourceNaming: "joints", targetNaming: "segments", scale: 0.5, travel: 0, unpaired: [], notes: [] });
    expect(report.pairs).toContainEqual(["L_Shoulder", "LeftArm"]);
    expect(report.pairs).toContainEqual(["L_Knee", "LeftLeg"]);
    // Three spine bones on two: the lowest and the highest.
    expect(report.pairs.filter(([, target]) => target.startsWith("Spine"))).toEqual([["Spine1", "Spine"], ["Spine3", "Spine1"]]);
  });

  it("gives each bone the turn the source's made, in the world", () => {
    const frames = 2;
    // The left upper arm swings forward a quarter turn about the vertical; the left thigh lifts forward a quarter turn.
    const clip = clipOn(SMPL, frames, {
      L_Shoulder: [[0, 0, 0, 1], about("y", -90)], L_Elbow: [[0, 0, 0, 1], about("y", -90)], L_Wrist: [[0, 0, 0, 1], about("y", -90)],
      L_Hip: [[0, 0, 0, 1], about("x", -90)], L_Knee: [[0, 0, 0, 1], about("x", -90)], L_Ankle: [[0, 0, 0, 1], about("x", -90)], L_Foot: [[0, 0, 0, 1], about("x", -90)],
    });
    const at = played(retargetClip(walkerGlb(), clip, { name: "reach" }).bytes, 1);
    const arm = Math.hypot(0.2, 0.2);
    expect(at("LeftForeArm")).toEqual(round([0.2, 1.5, arm]));
    expect(at("LeftHand")).toEqual(round([0.2, 1.5, 2 * arm]));
    expect(at("LeftLeg")).toEqual([0.12, 0.95, 0.45]);
    expect(at("LeftFoot")).toEqual([0.12, 0.95, 0.87]);
    // What was not turned stays.
    expect(at("RightFoot")).toEqual([-0.12, 0.08, 0]);
  });

  it("moves the hips as far as the rig's legs are long, or keeps them where they stand", () => {
    // The source is twice the rig's size: it walks two units forward and dips a fifth of one.
    const hips: [number, number, number][] = [[0, 2, 0], [0, 1.8, 1], [0, 2, 2]];
    const walked = retargetClip(walkerGlb(), clipOn(SMPL, 3, {}, hips), { name: "walk" });
    expect(played(walked.bytes, 1)("Hips")).toEqual([0, 0.9, 0.5]);
    expect(played(walked.bytes, 2)("Hips")).toEqual([0, 1, 1]);
    expect(walked.report).toMatchObject({ scale: 0.5, travel: Math.round((1 / 1.65) * 100) / 100 });
    const stayed = retargetClip(walkerGlb(), clipOn(SMPL, 3, {}, hips), { name: "walk", inPlace: true });
    expect(played(stayed.bytes, 2)("Hips")).toEqual([0, 1, 0]);
    expect(played(stayed.bytes, 1)("Hips")).toEqual([0, 0.9, 0]);
    expect(stayed.report.travel).toBe(0);
  });

  it("turns a source that faces another way to face as the rig does", () => {
    // The same skeleton, facing +x in its file: its forward is the file's x.
    const turned = SMPL.map((bone) => ({ ...bone, rest: [bone.rest[2], bone.rest[1], -bone.rest[0]] as [number, number, number] }));
    const hips: [number, number, number][] = [[0, 2, 0], [2, 2, 0]];
    const { bytes } = retargetClip(walkerGlb(), clipOn(turned, 2, { L_Hip: [[0, 0, 0, 1], about("z", 90)], L_Knee: [[0, 0, 0, 1], about("z", 90)], L_Ankle: [[0, 0, 0, 1], about("z", 90)], L_Foot: [[0, 0, 0, 1], about("z", 90)] }, hips), { name: "walk", sourceFaces: "+x" });
    const at = played(bytes, 1);
    expect(at("Hips")).toEqual([0, 1, 1]);
    // In its own file the thigh lifted towards +x, its front: on the rig it lifts towards +z.
    expect(at("LeftLeg")).toEqual([0.12, 0.95, 1.45]);
  });

  it("writes one clip, by its name, that the exam reads", () => {
    const before = readGlb(walkerGlb())!;
    const { bytes } = retargetClip(walkerGlb(), clipOn(SMPL, 31), { name: "idle" });
    const after = readGlb(bytes)!;
    expect(after.json.animations).toHaveLength(1);
    expect(after.json.animations![0]!.name).toBe("idle");
    // The body is not touched: what was in the file is still there, byte for byte, before what was added.
    expect(Buffer.from(after.bin!.subarray(0, before.bin!.byteLength)).equals(Buffer.from(before.bin!))).toBe(true);
    expect(after.json.meshes).toEqual(before.json.meshes);
    expect(after.json.skins).toEqual(before.json.skins);
    const exam = examineRig(bytes);
    expect(exam.clips).toEqual([{ name: "idle", seconds: 1, joints: 21 }]);
    expect(exam.findings).toEqual([]);
  });

  it("keeps a turn's sign from one frame to the next", () => {
    // Half a turn and a little more: the same turn has two signs, and the wrong one flips the limb between frames.
    const spin = Array.from({ length: 13 }, (_, f) => about("y", f * 30));
    const { bytes } = retargetClip(walkerGlb(), clipOn(SMPL, 13, { Pelvis: spin }), { name: "spin" });
    const glb = readGlb(bytes)!;
    const animation = glb.json.animations![0]!;
    const hips = animation.channels!.find((channel) => channel.target!.node === 0 && channel.target!.path === "rotation")!;
    const track = accessorReader(glb, animation.samplers![hips.sampler]!.output)!;
    for (let f = 1; f < 13; f++) {
      const a = track.get(f - 1), b = track.get(f);
      expect(a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!).toBeGreaterThan(0);
    }
  });

  it("pairs by a map what the names do not, and refuses a body it cannot read without one", () => {
    const beast = SMPL.map((bone, index) => ({ ...bone, name: `b${index}`, parent: bone.parent ? `b${SMPL.findIndex((other) => other.name === bone.parent)}` : null }));
    expect(() => retargetClip(walkerGlb(), clipOn(beast, 2), { name: "x" })).toThrow(/the clip's bones could not be read as a two-legged skeleton.*Give `map`/s);
    const { report } = retargetClip(walkerGlb(), clipOn(beast, 2, { b5: [[0, 0, 0, 1], about("y", 90)] }), { name: "nod", map: { b5: "Head" } });
    expect(report.pairs).toEqual([["b5", "Head"]]);
    expect(() => retargetClip(walkerGlb(), clipOn(SMPL, 2), { name: "x", map: { Nose: "Head" } })).toThrow("map: the clip has no bone named Nose");
    expect(() => retargetClip(walkerGlb(), clipOn(SMPL, 2), { name: "x", map: { Head: "Nose" } })).toThrow("map: the rig has no bone named Nose");
  });

  it("refuses what is not a rig, and what is not a motion", () => {
    expect(() => retargetClip(Buffer.from("not a model"), clipOn(SMPL, 2), { name: "x" })).toThrow("the rig is not a binary glTF");
    expect(() => retargetClip(walkerGlb(), clipOn(SMPL, 1), { name: "x" })).toThrow("the clip holds no motion");
    const bare = readGlb(walkerGlb())!;
    expect(() => retargetClip(Buffer.from(JSON.stringify({})), clipOn(SMPL, 2), { name: "x" })).toThrow();
    expect(bare.json.skins).toHaveLength(1);
  });
});
