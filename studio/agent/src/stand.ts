// ---------------------------------------------------------------------------
// A figure stood: facing +z, its feet on y 0, over the origin
// ---------------------------------------------------------------------------
// A generated model comes one unit tall with its origin at its middle,
// facing whichever way its picture did; one rigging service leaves it there
// and another puts its feet on the ground. Every scene that used one had to
// turn it, lift it and size it again, by numbers found by looking.
//
// Standing a figure does that once, in the file: the scene's roots are put
// under one new node that carries the turn, the size and the move. Nothing
// else is touched — the mesh, the weights, the textures and the clips are
// the same bytes — so a skinned body moves with its skeleton, and a clip
// made for the rig plays on the stood rig when it is given the same node.
// ---------------------------------------------------------------------------

import {
  accessorReader, multiply, readGlb, transformPoint, worldMatrices, writeGlb,
  type Facing, type Glb, type Mat4, type Vec3,
} from "./glb.js";

/** The node a stood figure hangs under. */
export const STOOD_NODE = "stood";

/** Degrees about +y that bring a figure facing that way to face +z. */
const TURN: Readonly<Record<Facing, number>> = { "+z": 0, "+x": -90, "-x": 90, "-z": 180 };

export interface Box {
  min: Vec3;
  max: Vec3;
}

/** What standing a figure does to it: a turn about +y, then a size, then a move. */
export interface Stand {
  degrees: number;
  scale: number;
  move: Vec3;
}

export interface StandOptions {
  /** The way the figure faces in its file. Default +z. */
  faces?: Facing;
  /** How tall it stands when stood, in the file's units (metres). Default: as tall as it is. */
  height?: number;
}

export interface Stood {
  bytes: Buffer;
  stand: Stand;
  /** The box the body filled, and the box it fills stood. */
  before: Box;
  after: Box;
  /** False when it stood already: the bytes are the ones given. */
  changed: boolean;
}

const tidy = (value: number) => Math.round(value * 1e6) / 1e6 + 0;

/**
 * The box a figure fills at rest, as its scene places it. A skinned mesh is
 * placed by its joints, not by its own node: joint × inverse bind is where
 * the bind pose puts a vertex. Read from the bounds every position accessor
 * states; null when the file states none.
 */
export function figureBox(glb: Glb): Box | null {
  const gltf = glb.json;
  const nodes = gltf.nodes ?? [];
  const { world } = worldMatrices(gltf);
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  nodes.forEach((node, index) => {
    const mesh = node.mesh !== undefined ? gltf.meshes?.[node.mesh] : undefined;
    if (!mesh) return;
    const skin = node.skin !== undefined ? gltf.skins?.[node.skin] : undefined;
    let rest: Mat4 = world[index]!;
    if (skin && skin.joints.length > 0) {
      const inverse = accessorReader(glb, skin.inverseBindMatrices);
      const first = world[skin.joints[0]!];
      if (inverse && inverse.size === 16 && inverse.count > 0 && first) rest = multiply(first, inverse.get(0));
    }
    for (const primitive of mesh.primitives ?? []) {
      const positions = gltf.accessors?.[primitive.attributes?.POSITION ?? -1];
      if (positions?.min?.length !== 3 || positions.max?.length !== 3) continue;
      for (let corner = 0; corner < 8; corner++) {
        const p = transformPoint(rest, [0, 1, 2].map((axis) => ((corner >> axis) & 1 ? positions.max![axis]! : positions.min![axis]!)));
        for (let axis = 0; axis < 3; axis++) {
          if (p[axis]! < min[axis]!) min[axis] = p[axis]!;
          if (p[axis]! > max[axis]!) max[axis] = p[axis]!;
        }
      }
    }
  });
  return [...min, ...max].every(Number.isFinite) ? { min, max } : null;
}

/** The node's own transform for a stand: glTF applies the size, then the turn, then the move. */
function standMatrix(stand: Stand): Mat4 {
  const angle = (stand.degrees * Math.PI) / 180, cos = Math.cos(angle) * stand.scale, sin = Math.sin(angle) * stand.scale;
  return [cos, 0, -sin, 0, 0, stand.scale, 0, 0, sin, 0, cos, 0, stand.move[0], stand.move[1], stand.move[2], 1];
}

function boxUnder(box: Box, matrix: Mat4): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const p = transformPoint(matrix, [0, 1, 2].map((axis) => ((corner >> axis) & 1 ? box.max[axis]! : box.min[axis]!)));
    for (let axis = 0; axis < 3; axis++) {
      if (p[axis]! < min[axis]!) min[axis] = p[axis]!;
      if (p[axis]! > max[axis]!) max[axis] = p[axis]!;
    }
  }
  return { min, max };
}

const stands = (stand: Stand) => stand.degrees === 0 && stand.scale === 1 && stand.move.every((value) => value === 0);

/**
 * The same file with its scene's roots under one node that carries the
 * stand. Returns the bytes given for a stand that moves nothing, and null
 * for bytes that are not a .glb.
 */
export function applyStand(bytes: Uint8Array, stand: Stand): Buffer | null {
  const glb = readGlb(bytes);
  if (!glb) return null;
  if (stands(stand)) return Buffer.from(bytes);
  const json = structuredClone(glb.json);
  const nodes = (json.nodes ??= []);
  const scenes = (json.scenes ??= [{ nodes: nodes.map((_, index) => index).filter((index) => !nodes.some((node) => node.children?.includes(index))) }]);
  const half = (stand.degrees * Math.PI) / 360;
  for (const scene of scenes) {
    const roots = scene.nodes ?? [];
    if (roots.length === 0) continue;
    nodes.push({
      name: STOOD_NODE,
      ...(stand.move.some((value) => value !== 0) ? { translation: [...stand.move] } : {}),
      ...(stand.degrees !== 0 ? { rotation: [0, tidy(Math.sin(half)), 0, tidy(Math.cos(half))] } : {}),
      ...(stand.scale !== 1 ? { scale: [stand.scale, stand.scale, stand.scale] } : {}),
      children: roots,
    });
    scene.nodes = [nodes.length - 1];
  }
  return writeGlb(json, glb.bin);
}

/**
 * A figure turned to face +z, sized, and moved so that its lowest point is
 * on y 0 and its middle is over the origin. The written file is read back:
 * a file whose body does not follow its scene's roots is refused, not
 * released standing somewhere else. Null for bytes that are not a .glb.
 */
export function standFigure(bytes: Uint8Array, options: StandOptions = {}): Stood | null {
  const glb = readGlb(bytes);
  if (!glb) return null;
  if (options.height !== undefined && !(options.height > 0 && Number.isFinite(options.height))) throw new Error("height is how tall the figure stands, above 0");
  const before = figureBox(glb);
  if (!before) throw new Error("the file holds no body: there is nothing to stand");
  const tall = before.max[1] - before.min[1];
  if (!(tall > 0)) throw new Error("the body has no height: there is nothing to stand");
  const degrees = TURN[options.faces ?? "+z"];
  const scale = options.height === undefined ? 1 : tidy(options.height / tall);
  const turned = boxUnder(before, standMatrix({ degrees, scale, move: [0, 0, 0] }));
  const stand: Stand = {
    degrees,
    scale,
    move: [tidy(-(turned.min[0] + turned.max[0]) / 2), tidy(-turned.min[1]), tidy(-(turned.min[2] + turned.max[2]) / 2)],
  };
  const after = boxUnder(before, standMatrix(stand));
  if (stands(stand)) return { bytes: Buffer.from(bytes), stand, before, after, changed: false };

  const stood = applyStand(bytes, stand)!;
  const read = figureBox(readGlb(stood)!);
  const slack = Math.max(after.max[1] - after.min[1], 1e-6) * 1e-3;
  const off = read ? Math.max(...[0, 1, 2].flatMap((axis) => [Math.abs(read.min[axis]! - after.min[axis]!), Math.abs(read.max[axis]! - after.max[axis]!)])) : Infinity;
  if (off > slack) throw new Error("the body does not follow its scene's roots: the file could not be stood");
  return { bytes: stood, stand, before, after, changed: true };
}
