// ---------------------------------------------------------------------------
// The exam a generated rig sits before it is used
// ---------------------------------------------------------------------------
// Automatic rigging is good and not reliable (ADR-0052): a skeleton that
// looks right in the one pose it was made in is the usual way it fails. So a
// rig is not believed; it is read. This looks at a rigged .glb in its rest
// pose and says what a person would otherwise find three steps later:
//
// - vertices that follow no bone — they stay behind when the body moves;
// - bones outside the body;
// - a body that stands on the ground with no bone near it;
// - a left with no right;
// - clips that move nothing.
//
// It is geometry, not judgement. It cannot say a rig is good: a rig that
// passes still has to be posed and looked at. It can say a rig is broken,
// cheaply, before anything is animated with it.
// ---------------------------------------------------------------------------

import { accessorReader, multiply, readGlb, transformPoint, worldMatrices, type Mat4, type Vec3 } from "./glb.js";

export interface RigFinding {
  /** fail: do not use this rig. warn: look at this before using it. */
  level: "fail" | "warn";
  message: string;
}

export interface RigClip {
  name: string;
  seconds: number;
  /** How many of the skeleton's joints the clip moves. */
  joints: number;
}

export interface RigExam {
  /** glb: read. other: a format this cannot read (an FBX): nothing below is known. */
  format: "glb" | "other";
  joints: number;
  /** The longest chain from a root joint to a tip. */
  depth: number;
  vertices: number;
  /** Vertices whose weights add to nothing. */
  unweighted: number;
  /** Joints no vertex follows: tips and helpers, usually. */
  idleJoints: number;
  /** Joints that lie outside the body's box. */
  outside: string[];
  /** Joints in the lowest eighth of the body: what it stands on. */
  grounded: number;
  /** Joints off the body's middle with no joint mirroring them. */
  unpaired: string[];
  /** The body's size in the rig's own units: width, height, depth (y up). */
  size: Vec3 | null;
  clips: RigClip[];
  findings: RigFinding[];
  /** No finding at level fail. */
  ok: boolean;
}

const EMPTY: Omit<RigExam, "format" | "findings" | "ok"> = {
  joints: 0, depth: 0, vertices: 0, unweighted: 0, idleJoints: 0, outside: [], grounded: 0, unpaired: [], size: null, clips: [],
};

const some = (names: string[], limit = 4) => (names.length <= limit ? names.join(", ") : `${names.slice(0, limit).join(", ")} and ${names.length - limit} more`);

/** Read a rigged model and examine it. Never throws. */
export function examineRig(bytes: Uint8Array): RigExam {
  const glb = readGlb(bytes);
  if (!glb) return { ...EMPTY, format: "other", findings: [], ok: true };
  try {
    return examine(glb);
  } catch (error) {
    return {
      ...EMPTY, format: "glb", ok: false,
      findings: [{ level: "fail", message: `the file could not be read as a rig: ${error instanceof Error ? error.message : String(error)}` }],
    };
  }
}

function examine(glb: NonNullable<ReturnType<typeof readGlb>>): RigExam {
  const gltf = glb.json;
  const nodes = gltf.nodes ?? [];
  const findings: RigFinding[] = [];
  const skins = gltf.skins ?? [];
  const jointList = [...new Set(skins.flatMap((skin) => skin.joints))].filter((index) => index >= 0 && index < nodes.length);
  if (jointList.length === 0) {
    return { ...EMPTY, format: "glb", ok: false, findings: [{ level: "fail", message: "it has no skeleton: no skin, no joints" }] };
  }
  const isJoint = new Set(jointList);
  const { world, parents } = worldMatrices(gltf);
  const name = (index: number) => nodes[index]?.name || `joint ${index}`;
  const place = new Map<number, Vec3>(jointList.map((index) => [index, transformPoint(world[index]!, [0, 0, 0])]));

  // The longest chain of joints, root to tip.
  const depthOf = (index: number, guard = 0): number => {
    const parent = parents[index]!;
    return parent >= 0 && isJoint.has(parent) && guard < 512 ? 1 + depthOf(parent, guard + 1) : 1;
  };
  const depth = Math.max(...jointList.map((index) => depthOf(index)));

  // The body in its rest pose. A skinned mesh is placed by its joints, not by
  // its own node: joint × inverse bind is where the bind pose puts a vertex.
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let vertices = 0, unweighted = 0, skinnedPrimitives = 0, carriedParts = 0, bareVertices = 0, loose = 0;
  const followed = new Set<number>();
  // A rigid part hung under a joint has no skin and needs none: the bone carries it whole.
  const carriedBy = (index: number): number | null => {
    for (let at = parents[index]!, guard = 0; at >= 0 && guard < 512; at = parents[at]!, guard++) if (isJoint.has(at)) return at;
    return null;
  };
  nodes.forEach((node, nodeIndex) => {
    const mesh = node.mesh !== undefined ? gltf.meshes?.[node.mesh] : undefined;
    if (!mesh) return;
    const skin = node.skin !== undefined ? skins[node.skin] : undefined;
    let rest: Mat4 = world[nodeIndex]!;
    if (skin && skin.joints.length > 0) {
      const inverse = accessorReader(glb, skin.inverseBindMatrices);
      const first = world[skin.joints[0]!];
      if (inverse && inverse.size === 16 && inverse.count > 0 && first) rest = multiply(first, inverse.get(0));
    }
    for (const primitive of mesh.primitives ?? []) {
      const positions = gltf.accessors?.[primitive.attributes?.POSITION ?? -1];
      if (positions?.min?.length === 3 && positions.max?.length === 3) {
        for (let corner = 0; corner < 8; corner++) {
          const p = transformPoint(rest, [0, 1, 2].map((axis) => ((corner >> axis) & 1 ? positions.max![axis]! : positions.min![axis]!)));
          for (let axis = 0; axis < 3; axis++) {
            if (p[axis]! < min[axis]!) min[axis] = p[axis]!;
            if (p[axis]! > max[axis]!) max[axis] = p[axis]!;
          }
        }
      }
      const count = positions?.count ?? 0;
      vertices += count;
      const jointsOf = accessorReader(glb, primitive.attributes?.JOINTS_0);
      const weightsOf = accessorReader(glb, primitive.attributes?.WEIGHTS_0);
      if (!skin || !jointsOf || !weightsOf || jointsOf.size !== 4 || weightsOf.size !== 4) {
        const bone = skin ? null : carriedBy(nodeIndex);
        if (bone === null) bareVertices += count;
        else {
          carriedParts++;
          followed.add(bone);
        }
        continue;
      }
      skinnedPrimitives++;
      const n = Math.min(jointsOf.count, weightsOf.count);
      for (let i = 0; i < n; i++) {
        const w = weightsOf.get(i), j = jointsOf.get(i);
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          const weight = w[k]!;
          if (!(weight > 0)) continue;
          sum += weight;
          const joint = skin.joints[j[k]!];
          if (joint !== undefined) followed.add(joint);
        }
        if (sum < 0.01) unweighted++;
        else if (Math.abs(sum - 1) > 0.05) loose++;
      }
    }
  });

  const bound = skinnedPrimitives + carriedParts;
  if (bound === 0) findings.push({ level: "fail", message: "no part of the body is bound to the skeleton: there are bones and nothing follows them" });
  else if (bareVertices > 0) findings.push({ level: "warn", message: `${bareVertices.toLocaleString("en-US")} of ${vertices.toLocaleString("en-US")} vertices belong to parts with no skin and under no bone: they will not move with the body` });
  if (unweighted > 0) {
    const share = unweighted / Math.max(vertices, 1);
    findings.push({
      level: share > 0.001 ? "fail" : "warn",
      message: `${unweighted.toLocaleString("en-US")} vertices follow no bone (${(share * 100).toFixed(share < 0.01 ? 2 : 1)}% of the body): they stay behind when it moves`,
    });
  }
  if (loose > vertices * 0.01) findings.push({ level: "warn", message: `${loose.toLocaleString("en-US")} vertices have weights that do not add to one: they will stretch or shrink` });

  const idleJoints = bound > 0 ? jointList.filter((index) => !followed.has(index)).length : 0;
  if (bound > 0 && idleJoints > jointList.length / 2) {
    findings.push({ level: "warn", message: `${idleJoints} of ${jointList.length} joints move nothing: more than tips and helpers account for` });
  }

  const boxed = [...min, ...max].every(Number.isFinite);
  const size: Vec3 | null = boxed ? [max[0] - min[0], max[1] - min[1], max[2] - min[2]] : null;
  const outside: string[] = [], unpaired: string[] = [];
  let grounded = 0;
  if (size) {
    const reach = Math.hypot(...size) * 0.05;
    for (const index of jointList) {
      const p = place.get(index)!;
      if ([0, 1, 2].some((axis) => p[axis]! < min[axis]! - reach || p[axis]! > max[axis]! + reach)) outside.push(name(index));
    }
    if (outside.length > 0) {
      findings.push({
        level: outside.length > jointList.length / 4 ? "fail" : "warn",
        message: `${outside.length} of ${jointList.length} joints lie outside the body (${some(outside)}): the skeleton does not fit it`,
      });
    }

    grounded = jointList.filter((index) => place.get(index)![1] <= min[1] + size[1] * 0.125).length;
    if (grounded === 0) findings.push({ level: "warn", message: "no joint is near the ground: whatever the body stands on has no bone" });

    // A left for every right. The middle is the body's own, across whichever
    // horizontal axis pairs more joints: the file does not say which way it faces.
    const tolerance = size[1] * 0.04;
    const sides = (axis: 0 | 2): { loners: string[]; paired: number } => {
      const middle = (min[axis] + max[axis]) / 2;
      const other = axis === 0 ? 2 : 0;
      const loners: string[] = [];
      let paired = 0;
      for (const index of jointList) {
        const p = place.get(index)!;
        if (Math.abs(p[axis] - middle) <= tolerance) continue;
        const mirrored = jointList.some((candidate) => {
          if (candidate === index) return false;
          const q = place.get(candidate)!;
          return Math.abs(q[axis] - (2 * middle - p[axis])) <= tolerance && Math.abs(q[1] - p[1]) <= tolerance && Math.abs(q[other] - p[other]) <= tolerance;
        });
        if (mirrored) paired++;
        else loners.push(name(index));
      }
      return { loners, paired };
    };
    // The axis that pairs more joints is the one the body's sides lie along;
    // along the other, a body is thin and nothing is off its middle.
    const acrossX = sides(0), acrossZ = sides(2);
    unpaired.push(...(acrossX.paired >= acrossZ.paired ? acrossX : acrossZ).loners);
    if (unpaired.length > 0) {
      findings.push({ level: "warn", message: `${unpaired.length} joints have no mirror on the other side (${some(unpaired)}): right for a lopsided body, wrong for a symmetrical one` });
    }
  } else {
    findings.push({ level: "warn", message: "the body's size is not stated in the file: bones could not be checked against it" });
  }

  const clips: RigClip[] = (gltf.animations ?? []).map((animation, index) => {
    let seconds = 0;
    for (const sampler of animation.samplers ?? []) {
      const end = gltf.accessors?.[sampler.input]?.max?.[0];
      if (typeof end === "number" && end > seconds) seconds = end;
    }
    const moved = new Set((animation.channels ?? []).map((channel) => channel.target?.node).filter((node): node is number => node !== undefined && isJoint.has(node)));
    return { name: animation.name || `clip ${index + 1}`, seconds: Math.round(seconds * 100) / 100, joints: moved.size };
  });
  for (const clip of clips) {
    if (clip.joints === 0) findings.push({ level: "fail", message: `the clip "${clip.name}" moves none of the skeleton's joints` });
  }

  return {
    format: "glb", joints: jointList.length, depth, vertices, unweighted, idleJoints, outside, grounded, unpaired,
    size: size ? (size.map((v) => Math.round(v * 1000) / 1000) as Vec3) : null,
    clips, findings, ok: !findings.some((finding) => finding.level === "fail"),
  };
}

/** What the exam found, as lines a person or the agent reads. */
export function describeRigExam(exam: RigExam): string[] {
  if (exam.format === "other") return ["not examined: only a binary glTF can be read here. Open it in Blender and pose it before it is used"];
  if (exam.joints === 0) return exam.findings.map((finding) => `❌ ${finding.message}`);
  const lines = [
    `${exam.joints} joints, ${exam.depth} deep; ${exam.vertices.toLocaleString("en-US")} vertices bound; ${exam.grounded} joint${exam.grounded === 1 ? "" : "s"} near the ground` +
      (exam.size ? `; ${Number(exam.size[0].toFixed(2))} wide × ${Number(exam.size[1].toFixed(2))} tall × ${Number(exam.size[2].toFixed(2))} deep` : ""),
  ];
  if (exam.clips.length > 0) lines.push(`clips inside: ${exam.clips.map((clip) => `${clip.name} (${clip.seconds}s, ${clip.joints} joints)`).join(", ")}`);
  for (const finding of exam.findings) lines.push(`${finding.level === "fail" ? "❌" : "⚠️"} ${finding.message}`);
  lines.push(exam.ok
    ? (exam.findings.length === 0 ? "exam: nothing wrong found at rest. That is not yet a good rig: pose it and look" : "exam: usable, with the warnings above. Pose it and look")
    : "exam: failed. Do not release this rig: make another attempt");
  return lines;
}
