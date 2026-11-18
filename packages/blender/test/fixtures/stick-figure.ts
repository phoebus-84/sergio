// A two-legged figure made of small solids, one at each joint and bound to
// it, written as a real binary glTF: positions, triangles, joints, weights,
// inverse bind matrices and a walk. It faces +z; its left is +x.

type Vec3 = [number, number, number];
interface Joint { name: string; parent: number; at: Vec3 }

export const STICK_JOINTS: Joint[] = [
  { name: "Hips", parent: -1, at: [0, 1, 0] },
  { name: "Spine", parent: 0, at: [0, 1.3, 0] },
  { name: "Head", parent: 1, at: [0, 1.7, 0] },
  { name: "LeftArm", parent: 1, at: [0.25, 1.5, 0] },
  { name: "LeftForeArm", parent: 3, at: [0.55, 1.5, 0] },
  { name: "RightArm", parent: 1, at: [-0.25, 1.5, 0] },
  { name: "RightForeArm", parent: 5, at: [-0.55, 1.5, 0] },
  { name: "LeftUpLeg", parent: 0, at: [0.12, 0.95, 0] },
  { name: "LeftLeg", parent: 7, at: [0.12, 0.5, 0] },
  { name: "RightUpLeg", parent: 0, at: [-0.12, 0.95, 0] },
  { name: "RightLeg", parent: 9, at: [-0.12, 0.5, 0] },
];

/** The figure. `names` renames its joints, for a skeleton whose names say nothing. */
export function stickFigure(options: { names?: (name: string) => string; walk?: boolean } = {}): Buffer {
  const joints = STICK_JOINTS;
  const chunks: Buffer[] = [];
  const bufferViews: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];
  let offset = 0;
  const add = (buffer: Buffer, accessor: Record<string, unknown>): number => {
    const padded = buffer.length % 4 ? Buffer.concat([buffer, Buffer.alloc(4 - (buffer.length % 4))]) : buffer;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buffer.length });
    chunks.push(padded);
    offset += padded.length;
    accessors.push({ bufferView: bufferViews.length - 1, ...accessor });
    return accessors.length - 1;
  };

  // A tetrahedron at each joint, reaching down towards the ground so the body has a height.
  const corners: Vec3[] = [[0.06, 0, 0], [-0.06, 0, 0.05], [-0.06, 0, -0.05], [0, -0.3, 0]];
  const faces = [0, 1, 2, 0, 3, 1, 1, 3, 2, 2, 3, 0];
  const count = joints.length * 4;
  const positions = Buffer.alloc(count * 12), bound = Buffer.alloc(count * 4), weights = Buffer.alloc(count * 16);
  const indices = Buffer.alloc(joints.length * faces.length * 2);
  const low: Vec3 = [Infinity, Infinity, Infinity], high: Vec3 = [-Infinity, -Infinity, -Infinity];
  joints.forEach((joint, j) => {
    corners.forEach((corner, c) => {
      const vertex = j * 4 + c;
      for (let axis = 0; axis < 3; axis++) {
        const value = joint.at[axis]! + corner[axis]!;
        positions.writeFloatLE(value, vertex * 12 + axis * 4);
        low[axis] = Math.min(low[axis]!, value);
        high[axis] = Math.max(high[axis]!, value);
      }
      bound.writeUInt8(j, vertex * 4);
      weights.writeFloatLE(1, vertex * 16);
    });
    faces.forEach((corner, f) => indices.writeUInt16LE(j * 4 + corner, (j * faces.length + f) * 2));
  });
  const position = add(positions, { componentType: 5126, count, type: "VEC3", min: low.map((v) => Math.fround(v)), max: high.map((v) => Math.fround(v)) });
  const jointsAt = add(bound, { componentType: 5121, count, type: "VEC4" });
  const weightsAt = add(weights, { componentType: 5126, count, type: "VEC4" });
  const indexAt = add(indices, { componentType: 5123, count: joints.length * faces.length, type: "SCALAR" });
  const inverse = Buffer.alloc(joints.length * 64);
  joints.forEach((joint, j) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -joint.at[0], -joint.at[1], -joint.at[2], 1].forEach((value, k) => inverse.writeFloatLE(value, j * 64 + k * 4)));
  const inverseAt = add(inverse, { componentType: 5126, count: joints.length, type: "MAT4" });

  const name = options.names ?? ((given: string) => given);
  const nodes: Record<string, unknown>[] = joints.map((joint, index) => {
    const parent: Vec3 = joint.parent >= 0 ? joints[joint.parent]!.at : [0, 0, 0];
    const children = joints.map((other, at) => (other.parent === index ? at : -1)).filter((at) => at >= 0);
    return { name: name(joint.name), translation: joint.at.map((value, axis) => value - parent[axis]!), ...(children.length ? { children } : {}) };
  });
  nodes.push({ name: "body", mesh: 0, skin: 0 });

  const animations: Record<string, unknown>[] = [];
  if (options.walk !== false) {
    const times = Buffer.alloc(12);
    [0, 0.5, 1].forEach((value, k) => times.writeFloatLE(value, k * 4));
    const input = add(times, { componentType: 5126, count: 3, type: "SCALAR", min: [0], max: [1] });
    // A swing about x: forward, back, forward.
    const swing = (sign: number): number => {
      const turns = Buffer.alloc(48);
      [sign, -sign, sign].forEach((way, k) => {
        const half = (way * Math.PI) / 8;
        [Math.sin(half), 0, 0, Math.cos(half)].forEach((value, i) => turns.writeFloatLE(value, k * 16 + i * 4));
      });
      return add(turns, { componentType: 5126, count: 3, type: "VEC4" });
    };
    animations.push({
      name: "walk",
      samplers: [{ input, output: swing(1), interpolation: "LINEAR" }, { input, output: swing(-1), interpolation: "LINEAR" }],
      channels: [{ sampler: 0, target: { node: 7, path: "rotation" } }, { sampler: 1, target: { node: 9, path: "rotation" } }],
    });
  }

  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0, joints.length] }],
    nodes,
    meshes: [{ primitives: [{ attributes: { POSITION: position, JOINTS_0: jointsAt, WEIGHTS_0: weightsAt }, indices: indexAt }] }],
    skins: [{ joints: joints.map((_, index) => index), inverseBindMatrices: inverseAt, skeleton: 0 }],
    accessors, bufferViews, buffers: [{ byteLength: offset }],
    ...(animations.length ? { animations } : {}),
  };
  let text = Buffer.from(JSON.stringify(json), "utf8");
  if (text.length % 4) text = Buffer.concat([text, Buffer.alloc(4 - (text.length % 4), 0x20)]);
  const bin = Buffer.concat(chunks);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + text.length + 8 + bin.length, 8);
  head.writeUInt32LE(text.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(bin.length, 0);
  binHead.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, text, binHead, bin]);
}
