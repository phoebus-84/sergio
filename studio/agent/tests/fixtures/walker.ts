// A two-legged skeleton and a clip for it, for tests of carrying a motion.
// The rig is a real binary glTF (rig-glb.ts); the clip is what
// @av/blender/clip-sample writes after playing a file in Blender.

import type { ClipSample, Point, Quat } from "@av/blender/clip-sample";
import { rigGlb, type FixtureJoint, type FixtureRig } from "./rig-glb.js";

type V = [number, number, number];
const J = (name: string, parent: number, at: V): FixtureJoint => ({ name, parent, at });

/** Named for its parts, as the rigging services name them. It rests in an A-pose: its arms hang at 45 degrees. */
export const WALKER: FixtureRig = {
  box: { min: [-0.7, 0, -0.2], max: [0.7, 1.8, 0.2] },
  joints: [
    J("Hips", -1, [0, 1, 0]),
    J("Spine", 0, [0, 1.2, 0]), J("Spine1", 1, [0, 1.4, 0]), J("Neck", 2, [0, 1.55, 0]), J("Head", 3, [0, 1.65, 0]),
    J("LeftShoulder", 2, [0.08, 1.5, 0]), J("LeftArm", 5, [0.2, 1.5, 0]), J("LeftForeArm", 6, [0.4, 1.3, 0]), J("LeftHand", 7, [0.6, 1.1, 0]),
    J("RightShoulder", 2, [-0.08, 1.5, 0]), J("RightArm", 9, [-0.2, 1.5, 0]), J("RightForeArm", 10, [-0.4, 1.3, 0]), J("RightHand", 11, [-0.6, 1.1, 0]),
    J("LeftUpLeg", 0, [0.12, 0.95, 0]), J("LeftLeg", 13, [0.12, 0.5, 0]), J("LeftFoot", 14, [0.12, 0.08, 0]), J("LeftToeBase", 15, [0.12, 0, 0.12]),
    J("RightUpLeg", 0, [-0.12, 0.95, 0]), J("RightLeg", 17, [-0.12, 0.5, 0]), J("RightFoot", 18, [-0.12, 0.08, 0]), J("RightToeBase", 19, [-0.12, 0, 0.12]),
  ],
};
export const walkerGlb = (): Buffer => rigGlb(WALKER);

/** The skeleton generated motion comes on: bones named for the joint they start at, twice the size, resting in a T-pose with the pelvis at the origin. */
export const SMPL: { name: string; parent: string | null; rest: Point }[] = [
  { name: "Pelvis", parent: null, rest: [0, 0, 0] },
  { name: "Spine1", parent: "Pelvis", rest: [0, 0.3, 0] }, { name: "Spine2", parent: "Spine1", rest: [0, 0.6, 0] }, { name: "Spine3", parent: "Spine2", rest: [0, 0.9, 0] },
  { name: "Neck", parent: "Spine3", rest: [0, 1.1, 0] }, { name: "Head", parent: "Neck", rest: [0, 1.3, 0] },
  { name: "L_Collar", parent: "Spine3", rest: [0.15, 1, 0] }, { name: "L_Shoulder", parent: "L_Collar", rest: [0.4, 1, 0] }, { name: "L_Elbow", parent: "L_Shoulder", rest: [0.9, 1, 0] }, { name: "L_Wrist", parent: "L_Elbow", rest: [1.4, 1, 0] },
  { name: "R_Collar", parent: "Spine3", rest: [-0.15, 1, 0] }, { name: "R_Shoulder", parent: "R_Collar", rest: [-0.4, 1, 0] }, { name: "R_Elbow", parent: "R_Shoulder", rest: [-0.9, 1, 0] }, { name: "R_Wrist", parent: "R_Elbow", rest: [-1.4, 1, 0] },
  { name: "L_Hip", parent: "Pelvis", rest: [0.24, -0.1, 0] }, { name: "L_Knee", parent: "L_Hip", rest: [0.24, -1, 0] }, { name: "L_Ankle", parent: "L_Knee", rest: [0.24, -1.84, 0] }, { name: "L_Foot", parent: "L_Ankle", rest: [0.24, -2, 0.24] },
  { name: "R_Hip", parent: "Pelvis", rest: [-0.24, -0.1, 0] }, { name: "R_Knee", parent: "R_Hip", rest: [-0.24, -1, 0] }, { name: "R_Ankle", parent: "R_Knee", rest: [-0.24, -1.84, 0] }, { name: "R_Foot", parent: "R_Ankle", rest: [-0.24, -2, 0.24] },
];

/** A turn about an axis, in degrees: x y z w. */
export const about = (axis: "x" | "y" | "z", degrees: number): Quat => {
  const half = (degrees * Math.PI) / 360, s = Math.sin(half);
  return [axis === "x" ? s : 0, axis === "y" ? s : 0, axis === "z" ? s : 0, Math.cos(half)];
};

/**
 * A clip on a skeleton: `turns` gives, for some bones, the turn each frame holds; the rest do not turn.
 * `hips` is where the first bone is in each frame; without it, where it rests, lifted so the feet are on the ground.
 */
export function clipOn(bones: typeof SMPL, frames: number, turns: Record<string, Quat[]> = {}, hips?: Point[]): ClipSample {
  const floor = Math.min(...bones.map((bone) => bone.rest[1]));
  const still: Quat = [0, 0, 0, 1];
  const root = bones[0]!;
  return {
    action: "Take", actions: ["Take"], fps: 30, seconds: (frames - 1) / 30,
    times: Array.from({ length: frames }, (_, f) => f / 30),
    bones,
    rotations: Object.fromEntries(bones.map((bone) => [bone.name, turns[bone.name] ?? Array.from({ length: frames }, () => still)])),
    positions: Object.fromEntries(bones.map((bone) => [bone.name, Array.from({ length: frames }, (_, f): Point =>
      bone === root && hips ? hips[f]! : [bone.rest[0], bone.rest[1] - floor, bone.rest[2]])])),
  };
}
