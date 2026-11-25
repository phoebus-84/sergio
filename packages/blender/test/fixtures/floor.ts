// A place as a model: one square floor, `side` across, `height` above the origin.
// A binary glTF is y up; Blender stands it z up.
export function floorGlb(side = 6, height = 0.5): Buffer {
  const h = side / 2;
  const positions = new Float32Array([-h, height, -h, h, height, -h, h, height, h, -h, height, h]);
  const indices = new Uint16Array([0, 2, 1, 0, 3, 2]);
  const bin = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer)]);
  let json = JSON.stringify({
    asset: { version: "2.0" },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: "floor" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: "VEC3", min: [-h, height, -h], max: [h, height, h] },
      { bufferView: 1, componentType: 5123, count: 6, type: "SCALAR" },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 48 }, { buffer: 0, byteOffset: 48, byteLength: 12 }],
    buffers: [{ byteLength: bin.length }],
  });
  while (json.length % 4 !== 0) json += " ";
  const head = Buffer.alloc(12), jsonHead = Buffer.alloc(8), binHead = Buffer.alloc(8);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  jsonHead.writeUInt32LE(json.length, 0); jsonHead.writeUInt32LE(0x4e4f534a, 4);
  binHead.writeUInt32LE(bin.length, 0); binHead.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, jsonHead, Buffer.from(json), binHead, bin]);
}
