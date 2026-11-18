// ---------------------------------------------------------------------------
// A clip carried from one skeleton to another
// ---------------------------------------------------------------------------
// A motion is made for the skeleton it was made on: a walk generated from
// words comes on one rig, a character's body is on another, and the two name
// their bones differently, point them differently and are of different sizes.
//
// So nothing is copied joint by joint. For every bone of the source, in every
// frame, the clip says how far it has turned from its rest pose, measured in
// the world (@av/blender/clip-sample). The same turn is given to the bone of
// the target that plays the same part — hips, a thigh, a forearm — on top of
// the target's own rest pose. Limbs are first brought to where the source's
// limbs rest, so a clip made on a T-pose lands right on a body drawn in an
// A-pose. The hips travel as far as the legs are long.
//
// It is arithmetic on quaternions and no 3D program: the target's file is
// read, a clip is added to it, and its body is not touched.
// ---------------------------------------------------------------------------

import type { ClipSample, Point, Quat } from "@av/blender/clip-sample";
import { IDENTITY, multiply, nodeMatrix, readGlb, worldMatrices, writeGlb, type Facing, type GltfDocument, type Mat4, type Vec3 } from "./glb.js";

// -- quaternions (x y z w) and points ----------------------------------------
const mul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const conj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
const unit = (q: Quat): Quat => {
  const length = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
};
const NO_TURN: Quat = [0, 0, 0, 1];
const turnPoint = (q: Quat, v: Vec3): Vec3 => {
  const [x, y, z] = mul(mul(q, [v[0], v[1], v[2], 0]), conj(q));
  return [x, y, z];
};
const sub = (a: readonly number[], b: readonly number[]): Vec3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const lengthOf = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);

/** The shortest turn that takes one direction to another. */
export function arc(from: Vec3, to: Vec3): Quat {
  const a = lengthOf(from), b = lengthOf(to);
  if (a < 1e-9 || b < 1e-9) return NO_TURN;
  const f: Vec3 = [from[0] / a, from[1] / a, from[2] / a], t: Vec3 = [to[0] / b, to[1] / b, to[2] / b];
  const dot = f[0] * t[0] + f[1] * t[1] + f[2] * t[2];
  if (dot > 1 - 1e-9) return NO_TURN;
  if (dot < -1 + 1e-9) {
    // Opposite: half a turn about any axis across the direction.
    const across: Vec3 = Math.abs(f[0]) < 0.9 ? [0, -f[2], f[1]] : [-f[2], 0, f[0]];
    const n = lengthOf(across);
    return [across[0] / n, across[1] / n, across[2] / n, 0];
  }
  return unit([f[1] * t[2] - f[2] * t[1], f[2] * t[0] - f[0] * t[2], f[0] * t[1] - f[1] * t[0], 1 + dot]);
}

/** The turn a matrix holds, whatever it scales by. */
function turnOf(m: Mat4): Quat {
  const column = (i: number): Vec3 => {
    const v: Vec3 = [m[i * 4]!, m[i * 4 + 1]!, m[i * 4 + 2]!];
    const n = lengthOf(v) || 1;
    return [v[0] / n, v[1] / n, v[2] / n];
  };
  const [x, y, z] = [column(0), column(1), column(2)];
  const trace = x[0] + y[1] + z[2];
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return unit([(y[2] - z[1]) / s, (z[0] - x[2]) / s, (x[1] - y[0]) / s, s / 4]);
  }
  if (x[0] > y[1] && x[0] > z[2]) {
    const s = Math.sqrt(1 + x[0] - y[1] - z[2]) * 2;
    return unit([s / 4, (y[0] + x[1]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s]);
  }
  if (y[1] > z[2]) {
    const s = Math.sqrt(1 + y[1] - x[0] - z[2]) * 2;
    return unit([(y[0] + x[1]) / s, s / 4, (z[1] + y[2]) / s, (z[0] - x[2]) / s]);
  }
  const s = Math.sqrt(1 + z[2] - x[0] - y[1]) * 2;
  return unit([(z[0] + x[2]) / s, (z[1] + y[2]) / s, s / 4, (x[1] - y[0]) / s]);
}

/** The inverse of a matrix that places, turns and scales (no shear worth the name). */
function inverse(m: Mat4): Mat4 {
  const a = m, out = new Array<number>(16).fill(0);
  const c00 = a[5]! * a[10]! - a[6]! * a[9]!, c01 = a[6]! * a[8]! - a[4]! * a[10]!, c02 = a[4]! * a[9]! - a[5]! * a[8]!;
  const det = a[0]! * c00 + a[1]! * c01 + a[2]! * c02;
  if (Math.abs(det) < 1e-18) return IDENTITY;
  out[0] = c00 / det; out[1] = (a[2]! * a[9]! - a[1]! * a[10]!) / det; out[2] = (a[1]! * a[6]! - a[2]! * a[5]!) / det;
  out[4] = c01 / det; out[5] = (a[0]! * a[10]! - a[2]! * a[8]!) / det; out[6] = (a[2]! * a[4]! - a[0]! * a[6]!) / det;
  out[8] = c02 / det; out[9] = (a[1]! * a[8]! - a[0]! * a[9]!) / det; out[10] = (a[0]! * a[5]! - a[1]! * a[4]!) / det;
  out[12] = -(out[0]! * a[12]! + out[4]! * a[13]! + out[8]! * a[14]!);
  out[13] = -(out[1]! * a[12]! + out[5]! * a[13]! + out[9]! * a[14]!);
  out[14] = -(out[2]! * a[12]! + out[6]! * a[13]! + out[10]! * a[14]!);
  out[15] = 1;
  return out;
}

const FRONTS: Record<Facing, Vec3> = { "+z": [0, 0, 1], "-z": [0, 0, -1], "+x": [1, 0, 0], "-x": [-1, 0, 0] };
const heading = (facing: Facing) => Math.atan2(FRONTS[facing][0], FRONTS[facing][2]);
/** The body's own left, for a body that faces this way (y up). */
const leftOf = (facing: Facing): Vec3 => { const f = FRONTS[facing]; return [f[2], 0, -f[0]]; };

// -- a two-legged skeleton, read from its bones' names ------------------------
export interface Bone {
  name: string;
  parent: string | null;
  /** Where it starts at rest, in the world (y up). */
  at: Vec3;
}

const SIDES = ["left", "right"] as const;
const LIMBS = ["clavicle", "upperArm", "foreArm", "hand", "thigh", "shin", "foot", "toe"] as const;
type Limb = (typeof LIMBS)[number];
export type RoleName = "hips" | "neck" | "head" | `${Limb}.${"left" | "right"}`;

export interface Roles {
  /** Which naming it was read by: bones named for the part (LeftArm, thigh.L) or for the joint they start at (L_Shoulder, L_Knee). */
  naming: "segments" | "joints";
  bones: Partial<Record<RoleName, string>>;
  /** The spine, from the hips up. */
  spine: string[];
}

const plain = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
const HELPER = /twist|roll|helper|pole|ctrl|armature|(end|nub)$/;
const FINGER = /thumb|index|middle|ring|pinky|finger/;

const SEGMENTS: Record<Limb | "hips" | "neck" | "head" | "spine", (n: string) => boolean> = {
  hips: (n) => /hips|pelvis/.test(n),
  spine: (n) => /spine|chest|torso/.test(n),
  neck: (n) => /neck/.test(n),
  head: (n) => /head$/.test(n),
  clavicle: (n) => /shoulder|clavicle|collar/.test(n),
  upperArm: (n) => /arm/.test(n) && !/fore|lower|elbow/.test(n),
  foreArm: (n) => /forearm|lowerarm/.test(n),
  hand: (n) => /hand|wrist/.test(n) && !FINGER.test(n),
  thigh: (n) => /upleg|thigh|upperleg/.test(n),
  shin: (n) => /shin|calf|lowerleg/.test(n) || (/leg/.test(n) && !/upleg|upperleg|thigh/.test(n)),
  foot: (n) => /foot|ankle/.test(n) && !/toe/.test(n),
  toe: (n) => /toe|ball/.test(n),
};
// A skeleton that names a bone for the joint it starts at: the SMPL family, which generated motion comes on.
const JOINTS: typeof SEGMENTS = {
  ...SEGMENTS,
  clavicle: (n) => /collar|clavicle/.test(n),
  upperArm: (n) => /shoulder/.test(n),
  foreArm: (n) => /elbow/.test(n),
  hand: (n) => /wrist/.test(n) && !FINGER.test(n),
  thigh: (n) => /hip(?!s)/.test(n),
  shin: (n) => /knee/.test(n),
  foot: (n) => /ankle/.test(n),
  toe: (n) => /foot|toe/.test(n),
};

/** Read which bone plays which part. Sides are told by where a bone is, never by its name. */
export function readRoles(bones: readonly Bone[], facing: Facing = "+z"): Roles {
  const named = bones.map((bone) => ({ bone, n: plain(bone.name) })).filter(({ n }) => !HELPER.test(n));
  const all = named.map(({ n }) => n);
  const naming: Roles["naming"] = all.some((n) => /knee|elbow/.test(n)) && !all.some((n) => /forearm|lowerarm|upleg|upperleg|thigh|shin|calf/.test(n)) ? "joints" : "segments";
  const is = naming === "joints" ? JOINTS : SEGMENTS;
  const byName = new Map(bones.map((bone) => [bone.name, bone]));
  const depth = (bone: Bone): number => {
    let count = 0;
    for (let at = bone.parent ? byName.get(bone.parent) : undefined, guard = 0; at && guard < 512; at = at.parent ? byName.get(at.parent) : undefined, guard++) count++;
    return count;
  };
  const highest = (found: Bone[]) => (found.length ? found.reduce((best, bone) => (depth(bone) < depth(best) ? bone : best)) : undefined);

  const out: Roles = { naming, bones: {}, spine: [] };
  const hips = highest(named.filter(({ n }) => is.hips(n)).map(({ bone }) => bone));
  if (hips) out.bones.hips = hips.name;
  out.spine = named.filter(({ n }) => is.spine(n)).map(({ bone }) => bone).sort((a, b) => depth(a) - depth(b) || a.at[1] - b.at[1]).map((bone) => bone.name);
  const neck = highest(named.filter(({ n }) => is.neck(n)).map(({ bone }) => bone));
  if (neck) out.bones.neck = neck.name;
  const head = highest(named.filter(({ n }) => is.head(n)).map(({ bone }) => bone));
  if (head) out.bones.head = head.name;

  const left = leftOf(facing);
  const across = (bone: Bone) => bone.at[0] * left[0] + bone.at[2] * left[2];
  const middle = hips ? across(hips) : bones.reduce((sum, bone) => sum + across(bone), 0) / Math.max(bones.length, 1);
  const tall = Math.max(...bones.map((bone) => bone.at[1])) - Math.min(...bones.map((bone) => bone.at[1]));
  for (const limb of LIMBS) {
    const found = named.filter(({ n }) => is[limb](n)).map(({ bone }) => bone);
    for (const side of SIDES) {
      const sign = side === "left" ? 1 : -1;
      const mine = highest(found.filter((bone) => (across(bone) - middle) * sign > tall * 0.005));
      if (mine) out.bones[`${limb}.${side}`] = mine.name;
    }
  }
  return out;
}

/** A two-legged body can be carried when its hips and both its legs were found. */
export const isBiped = (roles: Roles) => Boolean(roles.bones.hips && SIDES.every((side) => roles.bones[`thigh.${side}`] && roles.bones[`shin.${side}`]));

// -- carrying the clip --------------------------------------------------------
export interface RetargetOptions {
  /** The clip's name in the file that is written. */
  name: string;
  /** Which way the target faces in its file. Default +z. */
  faces?: Facing;
  /** Which way the source faces in its own. Default +z. */
  sourceFaces?: Facing;
  /** Keep the body where it stands: the hips rise and fall, and do not travel. */
  inPlace?: boolean;
  /** Bones the names did not pair, or paired wrongly: source bone to target bone. */
  map?: Record<string, string>;
}

export interface RetargetReport {
  name: string;
  seconds: number;
  frames: number;
  /** Source bone and the target bone that plays its part. */
  pairs: [string, string][];
  /** Parts one skeleton has and the other does not, or neither has. */
  unpaired: string[];
  sourceNaming: Roles["naming"];
  targetNaming: Roles["naming"];
  /** How the target's legs compare with the source's: the hips travel by this much of what the source's did. */
  scale: number;
  /** How far the hips travel over the ground, in heights of the target's skeleton. */
  travel: number;
  notes: string[];
}

// The next part down a limb: where a bone points at rest.
const NEXT: Partial<Record<Limb, Limb>> = { upperArm: "foreArm", foreArm: "hand", thigh: "shin", shin: "foot", foot: "toe" };
// A part with nothing below it to point at is brought to rest with the part above it.
const ABOVE: Partial<Record<Limb, Limb>> = { hand: "foreArm", foot: "shin", toe: "foot" };

/** Add a clip to a rigged binary glTF: the source's motion, on the target's skeleton. */
export function retargetClip(target: Uint8Array, clip: ClipSample, options: RetargetOptions): { bytes: Buffer; report: RetargetReport } {
  const glb = readGlb(target);
  if (!glb) throw new Error("the rig is not a binary glTF");
  const gltf = glb.json;
  const nodes = gltf.nodes ?? [];
  const joints = [...new Set((gltf.skins ?? []).flatMap((skin) => skin.joints))].filter((index) => index >= 0 && index < nodes.length);
  if (joints.length === 0) throw new Error("the rig has no skeleton: there is nothing to move");
  if (clip.times.length < 2) throw new Error("the clip holds no motion: fewer than two frames");
  const faces = options.faces ?? "+z", sourceFaces = options.sourceFaces ?? "+z";
  const notes: string[] = [];

  const { world, parents } = worldMatrices(gltf);
  const isJoint = new Set(joints);
  const nameOf = (index: number) => nodes[index]?.name || `joint ${index}`;
  const seen = new Set<string>();
  for (const index of joints) {
    if (seen.has(nameOf(index))) notes.push(`two joints are named ${nameOf(index)}: the first is used`);
    seen.add(nameOf(index));
  }
  const indexOf = new Map<string, number>();
  for (const index of joints) if (!indexOf.has(nameOf(index))) indexOf.set(nameOf(index), index);
  const place = (index: number): Vec3 => [world[index]![12]!, world[index]![13]!, world[index]![14]!];
  const jointParent = (index: number): string | null => {
    for (let at = parents[index]!, guard = 0; at >= 0 && guard < 512; at = parents[at]!, guard++) if (isJoint.has(at)) return nameOf(at);
    return null;
  };
  const targetBones: Bone[] = joints.map((index) => ({ name: nameOf(index), parent: jointParent(index), at: place(index) }));
  const sourceBones: Bone[] = clip.bones.map((bone) => ({ name: bone.name, parent: bone.parent, at: bone.rest }));
  const to = readRoles(targetBones, faces), from = readRoles(sourceBones, sourceFaces);

  // The source turned to face the way the target does.
  const yawBy = heading(faces) - heading(sourceFaces);
  const yaw: Quat = [0, Math.sin(yawBy / 2), 0, Math.cos(yawBy / 2)];
  const sourceRest = new Map(sourceBones.map((bone) => [bone.name, turnPoint(yaw, bone.at)]));
  const targetRest = new Map(targetBones.map((bone) => [bone.name, bone.at]));

  // Pairs: [source bone, target bone, the turn that brings the target's part to where the source's rests].
  const pairs: { source: string; target: string; settle: Quat }[] = [];
  const unpaired: string[] = [];
  const settled = new Map<string, Quat>();
  const settle = (role: RoleName): Quat => {
    const cached = settled.get(role);
    if (cached) return cached;
    let result: Quat = NO_TURN;
    const [limb, side] = role.split(".") as [Limb, "left" | "right" | undefined];
    if (side) {
      const next = NEXT[limb], above = ABOVE[limb];
      const s = from.bones[role], t = to.bones[role];
      const sNext = next && from.bones[`${next}.${side}`], tNext = next && to.bones[`${next}.${side}`];
      if (s && t && sNext && tNext) result = arc(sub(targetRest.get(tNext)!, targetRest.get(t)!), sub(sourceRest.get(sNext)!, sourceRest.get(s)!));
      else if (above) result = settle(`${above}.${side}`);
    }
    settled.set(role, result);
    return result;
  };
  const roles: RoleName[] = ["hips", "neck", "head", ...SIDES.flatMap((side) => LIMBS.map((limb) => `${limb}.${side}` as RoleName))];
  for (const role of roles) {
    const s = from.bones[role], t = to.bones[role];
    if (s && t) pairs.push({ source: s, target: t, settle: settle(role) });
    else if (s || t) unpaired.push(`${role} (${s ? "the rig has none" : "the clip has none"})`);
  }
  // A spine of one length on a spine of another: each target bone takes the source bone as far up its own.
  to.spine.forEach((t, k) => {
    if (from.spine.length === 0) return;
    const at = to.spine.length === 1 ? from.spine.length - 1 : Math.round((k * (from.spine.length - 1)) / (to.spine.length - 1));
    pairs.push({ source: from.spine[at]!, target: t, settle: NO_TURN });
  });
  if (to.spine.length > 0 && from.spine.length === 0) unpaired.push("spine (the clip has none)");
  for (const [s, t] of Object.entries(options.map ?? {})) {
    if (!clip.rotations[s]) throw new Error(`map: the clip has no bone named ${s}`);
    if (!indexOf.has(t)) throw new Error(`map: the rig has no bone named ${t}`);
    const existing = pairs.findIndex((pair) => pair.target === t);
    if (existing >= 0) pairs.splice(existing, 1);
    pairs.push({ source: s, target: t, settle: NO_TURN });
  }
  if (pairs.length === 0 || (!options.map && !(isBiped(to) && isBiped(from)))) {
    const which = !isBiped(to) ? "the rig's" : "the clip's";
    throw new Error(
      `${which} bones could not be read as a two-legged skeleton: its hips and both its legs were looked for by name. ` +
        "Give `map`, source bone to target bone, for a body that is not one",
    );
  }

  // Each frame, every joint from the roots down: a paired joint takes the source's turn, the rest keep their own.
  const paired = new Map(pairs.map((pair) => [indexOf.get(pair.target)!, pair]));
  const order: number[] = [];
  const visit = (index: number) => { if (isJoint.has(index)) order.push(index); for (const child of nodes[index]?.children ?? []) visit(child); };
  for (let index = 0; index < nodes.length; index++) if (parents[index]! < 0) visit(index);
  const restWorld = world.map((m) => turnOf(m));
  const restLocal = nodes.map((node) => turnOf(nodeMatrix(node)));
  const frames = clip.times.length;
  const tracks = new Map<number, Quat[]>([...paired.keys()].map((index) => [index, []]));
  for (let f = 0; f < frames; f++) {
    const now = new Map<number, Quat>();
    for (const index of order) {
      const parent = parents[index]!;
      const above = parent < 0 ? NO_TURN : now.get(parent) ?? restWorld[parent]!;
      const pair = paired.get(index);
      if (!pair) { now.set(index, mul(above, restLocal[index]!)); continue; }
      const turned = clip.rotations[pair.source]?.[f] ?? NO_TURN;
      const here = unit(mul(mul(mul(mul(yaw, turned), conj(yaw)), pair.settle), restWorld[index]!));
      now.set(index, here);
      const track = tracks.get(index)!;
      let local = unit(mul(conj(above), here));
      const last = track[track.length - 1];
      // The same turn has two signs: keep to the one beside the last frame's, or the body flips between them.
      if (last && last[0] * local[0] + last[1] * local[1] + last[2] * local[2] + last[3] * local[3] < 0) local = [-local[0], -local[1], -local[2], -local[3]];
      track.push(local);
    }
  }

  // The hips: as high above the ground as the source's, by the length of the legs; as far over it, unless told to stay.
  const hipsPair = to.bones.hips && from.bones.hips ? { t: indexOf.get(to.bones.hips)!, s: from.bones.hips } : null;
  let scale = 1, travel = 0;
  let moves: Vec3[] | null = null;
  if (hipsPair && clip.positions[hipsPair.s]) {
    const sourceFloor = Math.min(...sourceBones.map((bone) => bone.at[1])), targetFloor = Math.min(...targetBones.map((bone) => bone.at[1]));
    const sourceLegs = sourceRest.get(hipsPair.s)![1] - sourceFloor, targetLegs = place(hipsPair.t)[1] - targetFloor;
    if (sourceLegs > 1e-6 && targetLegs > 1e-6) {
      scale = targetLegs / sourceLegs;
      const path = clip.positions[hipsPair.s]!.map((p) => turnPoint(yaw, p as Point));
      const ground = Math.min(...Object.values(clip.positions).flatMap((track) => track.map((p) => p[1])));
      const start = path[0]!, rest = place(hipsPair.t);
      const into = inverse(parents[hipsPair.t]! >= 0 ? world[parents[hipsPair.t]!]! : IDENTITY);
      moves = path.map((p) => {
        const over: Vec3 = options.inPlace ? [0, 0, 0] : [(p[0] - start[0]) * scale, 0, (p[2] - start[2]) * scale];
        travel = Math.max(travel, Math.hypot(over[0], over[2]));
        const at: Vec3 = [rest[0] + over[0], targetFloor + (p[1] - ground) * scale, rest[2] + over[2]];
        return [
          into[0]! * at[0] + into[4]! * at[1] + into[8]! * at[2] + into[12]!,
          into[1]! * at[0] + into[5]! * at[1] + into[9]! * at[2] + into[13]!,
          into[2]! * at[0] + into[6]! * at[1] + into[10]! * at[2] + into[14]!,
        ];
      });
      travel = travel / Math.max(Math.max(...targetBones.map((bone) => bone.at[1])) - targetFloor, 1e-6);
    } else notes.push("the hips' height could not be measured: they turn, and do not rise, fall or travel");
  }

  // The clip, written into the file: one set of times, a turn for each paired joint, the hips' path.
  const chunks: Buffer[] = [];
  const bufferViews = [...(gltf.bufferViews ?? [])];
  const accessors = [...(gltf.accessors ?? [])];
  let length = glb.bin ? glb.bin.byteLength + ((4 - (glb.bin.byteLength % 4)) % 4) : 0;
  const add = (values: number[], type: "SCALAR" | "VEC3" | "VEC4", extra: Record<string, unknown> = {}): number => {
    const buffer = Buffer.alloc(values.length * 4);
    values.forEach((value, i) => buffer.writeFloatLE(value, i * 4));
    bufferViews.push({ buffer: 0, byteOffset: length, byteLength: buffer.length });
    chunks.push(buffer);
    length += buffer.length;
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: values.length / (type === "SCALAR" ? 1 : type === "VEC3" ? 3 : 4), type, ...extra });
    return accessors.length - 1;
  };
  const input = add(clip.times, "SCALAR", { min: [clip.times[0]!], max: [clip.times[frames - 1]!] });
  const samplers: { input: number; output: number; interpolation: string }[] = [];
  const channels: { sampler: number; target: { node: number; path: string } }[] = [];
  for (const [index, track] of tracks) {
    samplers.push({ input, output: add(track.flat(), "VEC4"), interpolation: "LINEAR" });
    channels.push({ sampler: samplers.length - 1, target: { node: index, path: "rotation" } });
  }
  if (moves && hipsPair) {
    samplers.push({ input, output: add(moves.flat(), "VEC3"), interpolation: "LINEAR" });
    channels.push({ sampler: samplers.length - 1, target: { node: hipsPair.t, path: "translation" } });
  }
  const before = glb.bin ? Buffer.concat([Buffer.from(glb.bin), Buffer.alloc((4 - (glb.bin.byteLength % 4)) % 4)]) : Buffer.alloc(0);
  const json: GltfDocument = {
    ...gltf, bufferViews, accessors,
    // One motion a file: what the rig held before (a rest pose, another clip) is left out of this one.
    animations: [{ name: options.name, samplers, channels }],
    ...({ buffers: [{ byteLength: length }] } as object),
  };
  return {
    bytes: writeGlb(json, Buffer.concat([before, ...chunks])),
    report: {
      name: options.name, seconds: clip.times[frames - 1]! - clip.times[0]!, frames,
      pairs: pairs.map((pair) => [pair.source, pair.target]), unpaired,
      sourceNaming: from.naming, targetNaming: to.naming,
      scale: Math.round(scale * 1000) / 1000, travel: Math.round(travel * 100) / 100, notes,
    },
  };
}
