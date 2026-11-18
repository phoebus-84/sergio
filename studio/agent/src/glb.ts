// ---------------------------------------------------------------------------
// Reading a binary glTF without a 3D program
// ---------------------------------------------------------------------------
// A generated model and a generated rig are judged by what their file holds,
// not by what the provider says of them. This reads a .glb far enough for
// that: its JSON, its numbers (accessors over the binary chunk), where its
// scene places each node — and writes one back when a model has to be turned
// before it is sent on.
//
// It is not a glTF library. It reads what the model and rig tools ask of it
// and returns null, never throws, on a file it cannot follow.
// ---------------------------------------------------------------------------

export interface GltfNode {
  name?: string;
  mesh?: number;
  skin?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

export interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType?: number;
  normalized?: boolean;
  count: number;
  type?: string;
  min?: number[];
  max?: number[];
}

export interface GltfDocument {
  asset?: Record<string, unknown>;
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: { primitives: { mode?: number; indices?: number; attributes: Record<string, number> }[] }[];
  accessors?: GltfAccessor[];
  bufferViews?: { buffer?: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  materials?: unknown[];
  images?: unknown[];
  skins?: { joints: number[]; inverseBindMatrices?: number; skeleton?: number }[];
  animations?: {
    name?: string;
    channels?: { sampler: number; target?: { node?: number; path?: string } }[];
    samplers?: { input: number; output: number }[];
  }[];
}

export interface Glb {
  json: GltfDocument;
  /** The binary chunk, or null for a file that has none. */
  bin: Uint8Array | null;
}

const MAGIC = 0x46546c67; // "glTF"
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

/** A .glb's two chunks, or null when the bytes are not one. */
export function readGlb(bytes: Uint8Array): Glb | null {
  if (bytes.byteLength < 20) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC || view.getUint32(16, true) !== JSON_CHUNK) return null;
  const length = view.getUint32(12, true);
  if (20 + length > bytes.byteLength) return null;
  let json: GltfDocument;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length))) as GltfDocument;
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  let bin: Uint8Array | null = null;
  const next = 20 + length;
  if (next + 8 <= bytes.byteLength && view.getUint32(next + 4, true) === BIN_CHUNK) {
    const size = view.getUint32(next, true);
    if (next + 8 + size <= bytes.byteLength) bin = bytes.subarray(next + 8, next + 8 + size);
  }
  return { json, bin };
}

/** A .glb from its two chunks, padded as the format asks. */
export function writeGlb(json: GltfDocument, bin: Uint8Array | null): Buffer {
  let text = Buffer.from(JSON.stringify(json), "utf-8");
  if (text.length % 4 !== 0) text = Buffer.concat([text, Buffer.alloc(4 - (text.length % 4), 0x20)]);
  const body = bin && bin.byteLength % 4 !== 0 ? Buffer.concat([Buffer.from(bin), Buffer.alloc(4 - (bin.byteLength % 4))]) : bin ? Buffer.from(bin) : null;
  const total = 12 + 8 + text.length + (body ? 8 + body.length : 0);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(MAGIC, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(total, 8);
  head.writeUInt32LE(text.length, 12);
  head.writeUInt32LE(JSON_CHUNK, 16);
  if (!body) return Buffer.concat([head, text]);
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(body.length, 0);
  binHead.writeUInt32LE(BIN_CHUNK, 4);
  return Buffer.concat([head, text, binHead, body]);
}

// ── Where the scene places things ───────────────────────────────────────────

export type Mat4 = number[];
export type Vec3 = [number, number, number];
export const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Column-major, as glTF writes them. */
export const multiply = (a: Mat4, b: Mat4): Mat4 => IDENTITY.map((_, i) => {
  const column = Math.floor(i / 4), row = i % 4;
  return a[row]! * b[column * 4]! + a[4 + row]! * b[column * 4 + 1]! + a[8 + row]! * b[column * 4 + 2]! + a[12 + row]! * b[column * 4 + 3]!;
});

export function nodeMatrix(node: GltfNode): Mat4 {
  if (node.matrix?.length === 16) return node.matrix;
  const [tx, ty, tz] = node.translation ?? [0, 0, 0], [x, y, z, w] = node.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = node.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y! * y! + z! * z!)) * sx!, 2 * (x! * y! + z! * w!) * sx!, 2 * (x! * z! - y! * w!) * sx!, 0,
    2 * (x! * y! - z! * w!) * sy!, (1 - 2 * (x! * x! + z! * z!)) * sy!, 2 * (y! * z! + x! * w!) * sy!, 0,
    2 * (x! * z! + y! * w!) * sz!, 2 * (y! * z! - x! * w!) * sz!, (1 - 2 * (x! * x! + y! * y!)) * sz!, 0,
    tx!, ty!, tz!, 1,
  ];
}

export const transformPoint = (m: Mat4, p: readonly number[]): Vec3 => [
  m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!,
  m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!,
  m[2]! * p[0]! + m[6]! * p[1]! + m[10]! * p[2]! + m[14]!,
];

/**
 * Every node's place in the world: its own transform under its parents'.
 * A node no scene reaches is placed as a root, so a skeleton kept outside the
 * scene is still found. `parents` gives each node's parent, -1 for a root.
 */
export function worldMatrices(gltf: GltfDocument): { world: Mat4[]; parents: number[] } {
  const nodes = gltf.nodes ?? [];
  const parents = new Array<number>(nodes.length).fill(-1);
  nodes.forEach((node, index) => {
    for (const child of node.children ?? []) if (child >= 0 && child < nodes.length && child !== index) parents[child] = index;
  });
  const world = new Array<Mat4 | undefined>(nodes.length);
  const place = (index: number, depth: number): Mat4 => {
    const known = world[index];
    if (known) return known;
    const own = nodeMatrix(nodes[index]!);
    const parent = parents[index]!;
    const placed = parent >= 0 && depth < 256 ? multiply(place(parent, depth + 1), own) : own;
    world[index] = placed;
    return placed;
  };
  nodes.forEach((_, index) => place(index, 0));
  return { world: world as Mat4[], parents };
}

// ── Numbers ─────────────────────────────────────────────────────────────────

const COMPONENTS: Readonly<Record<string, number>> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const BYTES: Readonly<Record<number, number>> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

export interface AccessorReader {
  count: number;
  /** Numbers per element: 3 for a position, 16 for a matrix. */
  size: number;
  /** Element `i` as plain numbers; an integer accessor marked normalized comes back in 0..1 (or -1..1). */
  get(i: number): number[];
}

/** A reader over one accessor's numbers, or null when the file does not hold them. */
export function accessorReader(glb: Glb, index: number | undefined): AccessorReader | null {
  if (index === undefined || !glb.bin) return null;
  const accessor = glb.json.accessors?.[index];
  const bufferView = accessor?.bufferView !== undefined ? glb.json.bufferViews?.[accessor.bufferView] : undefined;
  if (!accessor || !bufferView || (bufferView.buffer ?? 0) !== 0) return null;
  const size = COMPONENTS[accessor.type ?? ""];
  const width = BYTES[accessor.componentType ?? -1];
  if (!size || !width) return null;
  const stride = bufferView.byteStride ?? size * width;
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  if (accessor.count < 0 || start + (accessor.count > 0 ? (accessor.count - 1) * stride + size * width : 0) > glb.bin.byteLength) return null;
  const view = new DataView(glb.bin.buffer, glb.bin.byteOffset, glb.bin.byteLength);
  const type = accessor.componentType!;
  const scale = accessor.normalized ? ({ 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 } as Record<number, number>)[type] : undefined;
  const read = (at: number): number => {
    switch (type) {
      case 5120: return view.getInt8(at);
      case 5121: return view.getUint8(at);
      case 5122: return view.getInt16(at, true);
      case 5123: return view.getUint16(at, true);
      case 5125: return view.getUint32(at, true);
      default: return view.getFloat32(at, true);
    }
  };
  return {
    count: accessor.count,
    size,
    get(i: number): number[] {
      const at = start + i * stride;
      const out = new Array<number>(size);
      for (let c = 0; c < size; c++) {
        const value = read(at + c * width);
        out[c] = scale ? Math.max(value / scale, -1) : value;
      }
      return out;
    },
  };
}

// ── Turning a model ─────────────────────────────────────────────────────────

/** The way a model faces in its own file. glTF's front is +z. */
export type Facing = "+z" | "-z" | "+x" | "-x";
export const FACINGS: readonly Facing[] = ["+z", "+x", "-x", "-z"];

/** Degrees about +y that bring a model facing `from` to face +z. */
const TURN: Readonly<Record<Facing, number>> = { "+z": 0, "+x": -90, "-x": 90, "-z": 180 };

/**
 * The same model, turned about its vertical axis to face +z: its scene's
 * roots are put under one new node that carries the turn, and nothing else
 * is touched. Returns null for bytes that are not a .glb; returns the same
 * bytes for a model that already faces +z.
 */
export function turnToFaceZ(bytes: Uint8Array, from: Facing): Buffer | null {
  const glb = readGlb(bytes);
  if (!glb) return null;
  if (from === "+z") return Buffer.from(bytes);
  const json = structuredClone(glb.json);
  const nodes = (json.nodes ??= []);
  const scenes = (json.scenes ??= [{ nodes: nodes.map((_, index) => index).filter((index) => !nodes.some((n) => n.children?.includes(index))) }]);
  const half = (TURN[from] * Math.PI) / 360;
  for (const scene of scenes) {
    const roots = scene.nodes ?? [];
    if (roots.length === 0) continue;
    nodes.push({ name: "turned-to-face-z", rotation: [0, Math.sin(half), 0, Math.cos(half)], children: roots });
    scene.nodes = [nodes.length - 1];
  }
  return writeGlb(json, glb.bin);
}
