// ---------------------------------------------------------------------------
// Reading a binary glTF, and the exam a rig sits
// ---------------------------------------------------------------------------
// Every file here is built by tests/fixtures/rig-glb.ts: real binary glTFs
// with joints, weights and clips, so the readers are tested on the bytes
// they will meet and not on objects shaped like their own output.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { accessorReader, readGlb, transformPoint, turnToFaceZ, worldMatrices, writeGlb } from "../src/glb.js";
import { describeRigExam, examineRig } from "../src/rig-exam.js";
import { BIPED, rigGlb, type FixtureRig } from "./fixtures/rig-glb.js";

const FBX = Buffer.concat([Buffer.from("Kaydara FBX Binary  \0\x1a\0", "latin1"), Buffer.alloc(32)]);
const withJoints = (joints: FixtureRig["joints"]): FixtureRig => ({ ...BIPED, joints });
const levels = (bytes: Buffer) => examineRig(bytes).findings.map((finding) => `${finding.level}: ${finding.message}`);

describe("a binary glTF, read", () => {
  it("gives its JSON and its numbers, and nothing for what is not one", () => {
    const glb = readGlb(rigGlb(BIPED))!;
    expect(glb.json.skins?.[0]?.joints).toHaveLength(11);
    expect(accessorReader(glb, 1)!.get(3)).toEqual([3, 0, 0, 0]);
    expect(accessorReader(glb, 2)!.get(3)).toEqual([1, 0, 0, 0]);
    expect(accessorReader(glb, 3)!.get(0).slice(12)).toEqual([-0, -1, -0, 1]);
    // Positions have no bytes in the fixture: a reader is refused, not invented.
    expect(accessorReader(glb, 0)).toBeNull();
    expect(accessorReader(glb, 99)).toBeNull();
    expect(readGlb(FBX)).toBeNull();
    expect(readGlb(Buffer.from("not a model"))).toBeNull();
    expect(readGlb(rigGlb(BIPED).subarray(0, 40))).toBeNull();
  });

  it("places every node under its parents", () => {
    const { world, parents } = worldMatrices(readGlb(rigGlb(BIPED))!.json);
    expect(parents[4]).toBe(3);
    expect(transformPoint(world[4]!, [0, 0, 0]).map((v) => Math.round(v * 100) / 100)).toEqual([0.55, 1.4, 0]);
    expect(transformPoint(world[8]!, [0, 0, 0]).map((v) => Math.round(v * 100) / 100)).toEqual([0.12, 0.06, 0]);
  });

  it("is written back as it was read", () => {
    const first = readGlb(rigGlb(BIPED))!;
    const again = readGlb(writeGlb(first.json, first.bin))!;
    expect(again.json).toEqual(first.json);
    expect(Buffer.from(again.bin!).equals(Buffer.from(first.bin!))).toBe(true);
  });

  it("turns a model to face +z, and leaves one that already does", () => {
    const original = rigGlb(BIPED);
    expect(turnToFaceZ(original, "+z")!.equals(original)).toBe(true);
    expect(turnToFaceZ(FBX, "+x")).toBeNull();
    const whereXGoes = (facing: "+x" | "-x" | "-z", point: [number, number, number]) => {
      const turned = readGlb(turnToFaceZ(original, facing)!)!.json;
      const scene = turned.scenes![0]!.nodes!;
      expect(scene).toHaveLength(1);
      expect(turned.nodes![scene[0]!]!.name).toBe("turned-to-face-z");
      return transformPoint(worldMatrices(turned).world[scene[0]!]!, point).map((v) => Math.round(v * 1000) / 1000 + 0);
    };
    expect(whereXGoes("+x", [1, 0, 0])).toEqual([0, 0, 1]);
    expect(whereXGoes("-x", [-1, 0, 0])).toEqual([0, 0, 1]);
    expect(whereXGoes("-z", [0, 0, -1])).toEqual([0, 0, 1]);
    // Up stays up.
    expect(whereXGoes("+x", [0, 1, 0])).toEqual([0, 1, 0]);
  });
});

describe("the exam a rig sits", () => {
  it("finds nothing wrong with a body every bone fits, and says that is not proof", () => {
    const exam = examineRig(rigGlb(BIPED));
    expect(exam).toMatchObject({ format: "glb", ok: true, joints: 11, depth: 4, vertices: 11, unweighted: 0, idleJoints: 0, outside: [], grounded: 2, unpaired: [], size: [1.2, 1.8, 0.4], clips: [] });
    expect(exam.findings).toEqual([]);
    const said = describeRigExam(exam);
    expect(said[0]).toBe("11 joints, 4 deep; 11 vertices bound; 2 joints near the ground; 1.2 wide × 1.8 tall × 0.4 deep");
    expect(said.at(-1)).toBe("exam: nothing wrong found at rest. That is not yet a good rig: pose it and look");
  });

  it("fails a body with vertices no bone moves", () => {
    const vertices = BIPED.joints.map((_, index) => ({ joints: [index], weights: [index < 3 ? 0 : 1] }));
    const exam = examineRig(rigGlb({ ...BIPED, vertices }));
    expect(exam.ok).toBe(false);
    expect(exam.unweighted).toBe(3);
    expect(levels(rigGlb({ ...BIPED, vertices }))[0]).toBe("fail: 3 vertices follow no bone (27.3% of the body): they stay behind when it moves");
    expect(describeRigExam(exam).at(-1)).toBe("exam: failed. Do not release this rig: make another attempt");
  });

  it("fails bones with nothing bound to them, and a model with no bones", () => {
    expect(levels(rigGlb({ ...BIPED, unbound: true }))).toContain("fail: no part of the body is bound to the skeleton: there are bones and nothing follows them");
    const bare = readGlb(rigGlb(BIPED))!;
    const exam = examineRig(writeGlb({ ...bare.json, skins: [] }, bare.bin));
    expect(exam).toMatchObject({ ok: false, joints: 0 });
    expect(describeRigExam(exam)).toEqual(["❌ it has no skeleton: no skin, no joints"]);
  });

  it("warns of a part of the body left out of the skin, and of weights that do not add to one", () => {
    expect(levels(rigGlb({ ...BIPED, bareVertices: 40 }))).toEqual(["warn: 40 of 51 vertices belong to parts with no skin and under no bone: they will not move with the body"]);
    const vertices = BIPED.joints.map((_, index) => ({ joints: [index, 0], weights: [0.3, 0.3] }));
    expect(levels(rigGlb({ ...BIPED, vertices }))).toEqual(["warn: 11 vertices have weights that do not add to one: they will stretch or shrink"]);
  });

  it("counts a rigid part hung under a bone as carried by it: a robot's shell needs no skin", () => {
    const robot = examineRig(rigGlb({ ...BIPED, carried: [{ joint: 2, vertices: 300 }, { joint: 8, vertices: 120 }] }));
    expect(robot).toMatchObject({ ok: true, vertices: 431, idleJoints: 0 });
    expect(robot.findings).toEqual([]);
    // With no skin anywhere, the carried parts are what the bones move.
    const shellOnly = examineRig(rigGlb({ ...BIPED, unbound: true, carried: [{ joint: 0, vertices: 300 }] }));
    expect(shellOnly.findings.map((finding) => finding.message)).toEqual([
      "11 of 311 vertices belong to parts with no skin and under no bone: they will not move with the body",
      "10 of 11 joints move nothing: more than tips and helpers account for",
    ]);
  });

  it("warns of a bone outside the body, and fails when many are", () => {
    const one = withJoints(BIPED.joints.map((joint) => (joint.name === "Head" ? { ...joint, at: [0, 2.6, 0] } : joint)));
    expect(levels(rigGlb(one))).toEqual(["warn: 1 of 11 joints lie outside the body (Head): the skeleton does not fit it"]);
    expect(examineRig(rigGlb(one)).ok).toBe(true);
    const many = withJoints(BIPED.joints.map((joint) => ({ ...joint, at: [joint.at[0] * 4, joint.at[1], joint.at[2]] })));
    const exam = examineRig(rigGlb(many));
    expect(exam.ok).toBe(false);
    expect(exam.outside).toEqual(["LeftArm", "LeftHand", "RightArm", "RightHand"]);
  });

  it("warns of a body that stands on nothing, and of a left with no right", () => {
    const floating = withJoints(BIPED.joints.filter((joint) => !joint.name.endsWith("Foot")));
    expect(levels(rigGlb(floating))).toEqual(["warn: no joint is near the ground: whatever the body stands on has no bone"]);
    const oneArmed = withJoints(BIPED.joints.filter((joint) => !joint.name.startsWith("RightArm") && joint.name !== "RightHand")
      .map((joint, _, kept) => ({ ...joint, parent: kept.findIndex((k) => k.name === BIPED.joints[joint.parent]?.name) })));
    const exam = examineRig(rigGlb(oneArmed));
    expect(exam.unpaired).toEqual(["LeftArm", "LeftHand"]);
    expect(exam.findings).toEqual([{ level: "warn", message: "2 joints have no mirror on the other side (LeftArm, LeftHand): right for a lopsided body, wrong for a symmetrical one" }]);
    expect(exam.ok).toBe(true);
  });

  it("pairs left and right across whichever way the body faces", () => {
    const sideways = withJoints(BIPED.joints.map((joint) => ({ ...joint, at: [joint.at[2], joint.at[1], joint.at[0]] as [number, number, number] })));
    expect(examineRig(rigGlb({ ...sideways, box: { min: [-0.2, 0, -0.6], max: [0.2, 1.8, 0.6] } })).unpaired).toEqual([]);
  });

  it("warns when most joints move nothing", () => {
    const vertices = [{ joints: [0], weights: [1] }, { joints: [1], weights: [1] }];
    expect(levels(rigGlb({ ...BIPED, vertices }))).toEqual(["warn: 9 of 11 joints move nothing: more than tips and helpers account for"]);
  });

  it("reads the clips inside, and fails one that moves none of the skeleton", () => {
    const moving = examineRig(rigGlb({ ...BIPED, clips: [{ name: "walk", seconds: 1.2, moves: [0, 7, 8, 9, 10] }, { seconds: 0.5, moves: [2] }] }));
    expect(moving.clips).toEqual([{ name: "walk", seconds: 1.2, joints: 5 }, { name: "clip 2", seconds: 0.5, joints: 1 }]);
    expect(moving.ok).toBe(true);
    expect(describeRigExam(moving)[1]).toBe("clips inside: walk (1.2s, 5 joints), clip 2 (0.5s, 1 joints)");
    const still = examineRig(rigGlb({ ...BIPED, clips: [{ name: "idle", seconds: 2, moves: [] }] }));
    expect(still.findings).toEqual([{ level: "fail", message: 'the clip "idle" moves none of the skeleton\'s joints' }]);
  });

  it("does not pretend to read what it cannot", () => {
    expect(examineRig(FBX)).toMatchObject({ format: "other", ok: true, joints: 0, findings: [] });
    expect(describeRigExam(examineRig(FBX))[0]).toContain("not examined");
    expect(examineRig(Buffer.from("nothing"))).toMatchObject({ format: "other" });
  });
});
