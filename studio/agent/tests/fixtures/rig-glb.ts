// A rigged binary glTF built from a few lines, for tests that read one.
// It is a real file: JSON and a binary chunk with joint indices, weights,
// inverse bind matrices and animation times, laid out as the format asks.

export interface FixtureJoint {
  name: string;
  /** Index of its parent joint, or -1 for a root. */
  parent: number;
  /** Where it is in the world, in the rest pose. */
  at: [number, number, number];
}

export interface FixtureRig {
  joints: FixtureJoint[];
  /** The body's box, as the position accessor states it. */
  box: { min: [number, number, number]; max: [number, number, number] };
  /** One entry per vertex: up to four joints (indices into `joints`) and their weights. */
  vertices?: { joints: number[]; weights: number[] }[];
  /** Vertices of a second part of the body that has no skin at all. */
  bareVertices?: number;
  /** Rigid parts with no skin, each hung under a joint (an index into `joints`): a robot's shell. */
  carried?: { joint: number; vertices: number }[];
  /** Clips: the joints each moves (indices into `joints`) and how long it lasts. */
  clips?: { name?: string; seconds: number; moves: number[] }[];
  /** Leave the mesh out of the skin: bones, and nothing bound to them. */
  unbound?: boolean;
}

function pack(json: Record<string, unknown>, bin: Buffer): Buffer {
  let text = Buffer.from(JSON.stringify(json), "utf-8");
  if (text.length % 4 !== 0) text = Buffer.concat([text, Buffer.alloc(4 - (text.length % 4), 0x20)]);
  const body = bin.length % 4 !== 0 ? Buffer.concat([bin, Buffer.alloc(4 - (bin.length % 4))]) : bin;
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + text.length + 8 + body.length, 8);
  head.writeUInt32LE(text.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(body.length, 0);
  binHead.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, text, binHead, body]);
}

export function rigGlb(rig: FixtureRig): Buffer {
  const vertices = rig.vertices ?? rig.joints.map((_, index) => ({ joints: [index], weights: [1] }));
  const chunks: Buffer[] = [];
  const bufferViews: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];
  let offset = 0;
  const view = (buffer: Buffer): number => {
    const padded = buffer.length % 4 !== 0 ? Buffer.concat([buffer, Buffer.alloc(4 - (buffer.length % 4))]) : buffer;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buffer.length });
    chunks.push(padded);
    offset += padded.length;
    return bufferViews.length - 1;
  };

  // 0: positions (only their count and box are read), 1: joints, 2: weights, 3: inverse bind matrices.
  accessors.push({ componentType: 5126, count: vertices.length, type: "VEC3", min: rig.box.min, max: rig.box.max });
  const jointBytes = Buffer.alloc(vertices.length * 4);
  const weightBytes = Buffer.alloc(vertices.length * 16);
  vertices.forEach((vertex, i) => {
    for (let k = 0; k < 4; k++) {
      jointBytes.writeUInt8(vertex.joints[k] ?? 0, i * 4 + k);
      weightBytes.writeFloatLE(vertex.weights[k] ?? 0, i * 16 + k * 4);
    }
  });
  accessors.push({ bufferView: view(jointBytes), componentType: 5121, count: vertices.length, type: "VEC4" });
  accessors.push({ bufferView: view(weightBytes), componentType: 5126, count: vertices.length, type: "VEC4" });
  const inverse = Buffer.alloc(rig.joints.length * 64);
  rig.joints.forEach((joint, i) => {
    const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -joint.at[0], -joint.at[1], -joint.at[2], 1];
    m.forEach((value, k) => inverse.writeFloatLE(value, i * 64 + k * 4));
  });
  accessors.push({ bufferView: view(inverse), componentType: 5126, count: rig.joints.length, type: "MAT4" });

  // Nodes: the joints first (so a joint's index is its node's), then the body.
  const nodes: Record<string, unknown>[] = rig.joints.map((joint, index) => {
    const parent = joint.parent >= 0 ? rig.joints[joint.parent]!.at : [0, 0, 0];
    const children = rig.joints.map((other, otherIndex) => (other.parent === index ? otherIndex : -1)).filter((i) => i >= 0);
    return { name: joint.name, translation: [joint.at[0] - parent[0]!, joint.at[1] - parent[1]!, joint.at[2] - parent[2]!], ...(children.length > 0 ? { children } : {}) };
  });
  const primitives: Record<string, unknown>[] = [{ attributes: rig.unbound ? { POSITION: 0 } : { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } }];
  if (rig.bareVertices) {
    accessors.push({ componentType: 5126, count: rig.bareVertices, type: "VEC3", min: rig.box.min, max: rig.box.max });
    primitives.push({ attributes: { POSITION: accessors.length - 1 } });
  }
  nodes.push({ name: "body", mesh: 0, ...(rig.unbound ? {} : { skin: 0 }) });
  const meshes: Record<string, unknown>[] = [{ primitives }];
  for (const part of rig.carried ?? []) {
    accessors.push({ componentType: 5126, count: part.vertices, type: "VEC3", min: [-0.05, -0.05, -0.05], max: [0.05, 0.05, 0.05] });
    meshes.push({ primitives: [{ attributes: { POSITION: accessors.length - 1 } }] });
    nodes.push({ name: `part-${part.joint}`, mesh: meshes.length - 1 });
    const joint = nodes[part.joint]!;
    joint["children"] = [...((joint["children"] as number[] | undefined) ?? []), nodes.length - 1];
  }
  const roots = rig.joints.map((joint, index) => (joint.parent < 0 ? index : -1)).filter((i) => i >= 0);

  const animations = (rig.clips ?? []).map((clip) => {
    const times = Buffer.alloc(8);
    times.writeFloatLE(0, 0);
    times.writeFloatLE(clip.seconds, 4);
    accessors.push({ bufferView: view(times), componentType: 5126, count: 2, type: "SCALAR", min: [0], max: [clip.seconds] });
    const input = accessors.length - 1;
    const turns = Buffer.alloc(32);
    [0, 0, 0, 1, 0, 0, 0, 1].forEach((value, k) => turns.writeFloatLE(value, k * 4));
    accessors.push({ bufferView: view(turns), componentType: 5126, count: 2, type: "VEC4" });
    return {
      ...(clip.name ? { name: clip.name } : {}),
      samplers: [{ input, output: accessors.length - 1 }],
      // A clip that moves none of the joints still moves something: the body's own node.
      channels: (clip.moves.length > 0 ? clip.moves : [rig.joints.length]).map((node) => ({ sampler: 0, target: { node, path: "rotation" } })),
    };
  });

  return pack({
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [...roots, rig.joints.length] }],
    nodes,
    meshes,
    skins: [{ joints: rig.joints.map((_, index) => index), inverseBindMatrices: 3 }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
    ...(animations.length > 0 ? { animations } : {}),
  }, Buffer.concat(chunks));
}

/** A small biped that passes the exam: a spine, a head, two arms, two legs to the ground. */
export const BIPED: FixtureRig = {
  box: { min: [-0.6, 0, -0.2], max: [0.6, 1.8, 0.2] },
  joints: [
    { name: "Hips", parent: -1, at: [0, 1, 0] },
    { name: "Spine", parent: 0, at: [0, 1.35, 0] },
    { name: "Head", parent: 1, at: [0, 1.65, 0] },
    { name: "LeftArm", parent: 1, at: [0.3, 1.4, 0] },
    { name: "LeftHand", parent: 3, at: [0.55, 1.4, 0] },
    { name: "RightArm", parent: 1, at: [-0.3, 1.4, 0] },
    { name: "RightHand", parent: 5, at: [-0.55, 1.4, 0] },
    { name: "LeftLeg", parent: 0, at: [0.12, 0.55, 0] },
    { name: "LeftFoot", parent: 7, at: [0.12, 0.06, 0] },
    { name: "RightLeg", parent: 0, at: [-0.12, 0.55, 0] },
    { name: "RightFoot", parent: 9, at: [-0.12, 0.06, 0] },
  ],
};
