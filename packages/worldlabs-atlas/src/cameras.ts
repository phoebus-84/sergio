// ---------------------------------------------------------------------------
// Cameras
// ---------------------------------------------------------------------------
// A camera path is geometry: the cameras themselves, in order. Here a camera
// is a pinhole with a camera-to-world matrix in the convention Atlas's
// outputs use ("rub"): +x right, +y up, the camera looking along its own -z,
// as OpenGL, Three.js and Blender's cameras do. The world's up is +y, and
// its unit is the scene's: metres as Atlas predicted them, so approximate.
//
// Atlas's own JSON gives a camera as a position and an XYZW quaternion.
// Converting to and from it happens once, in wire.ts.
// ---------------------------------------------------------------------------

import { AtlasValidationError } from "./errors.js";

export type Vec3 = readonly [number, number, number];
/** 16 numbers, row by row. */
export type Mat4 = readonly number[];

export interface AtlasCamera {
  readonly width: number;
  readonly height: number;
  /** Focal lengths and principal point, in pixels. */
  readonly fx: number;
  readonly fy: number;
  readonly cx: number;
  readonly cy: number;
  readonly cameraToWorld: Mat4;
}

/** The sizes a target camera may have: nothing above 720p. */
export const ATLAS_TARGET_SIZES: readonly (readonly [number, number])[] = [[1280, 720], [960, 720], [528, 704], [720, 1280]];

export const isTargetSize = (width: number, height: number): boolean => ATLAS_TARGET_SIZES.some(([w, h]) => w === width && h === height);

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const n = length(a);
  if (!(n > 1e-9)) throw new AtlasValidationError("a camera cannot look at the place it stands on, or straight along its up");
  return scale(a, 1 / n);
};

/** A pinhole of this size with this vertical field of view. */
export function pinhole(width: number, height: number, fovYDegrees: number): Pick<AtlasCamera, "width" | "height" | "fx" | "fy" | "cx" | "cy"> {
  if (!(fovYDegrees > 1 && fovYDegrees < 170)) throw new AtlasValidationError("a field of view is between 1 and 170 degrees");
  const f = height / 2 / Math.tan((fovYDegrees * Math.PI) / 360);
  return { width, height, fx: f, fy: f, cx: width / 2, cy: height / 2 };
}

export const fovYDegrees = (camera: Pick<AtlasCamera, "height" | "fy">): number => (2 * Math.atan(camera.height / 2 / camera.fy) * 180) / Math.PI;

/** The camera-to-world matrix of a camera standing at `eye` and looking at `target`. */
export function lookAt(eye: Vec3, target: Vec3, up: Vec3 = [0, 1, 0]): Mat4 {
  const back = unit(sub(eye, target));
  const right = unit(cross(up, back));
  const above = cross(back, right);
  return [
    right[0], above[0], back[0], eye[0],
    right[1], above[1], back[1], eye[1],
    right[2], above[2], back[2], eye[2],
    0, 0, 0, 1,
  ];
}

export const cameraPosition = (camera: Pick<AtlasCamera, "cameraToWorld">): Vec3 => [camera.cameraToWorld[3]!, camera.cameraToWorld[7]!, camera.cameraToWorld[11]!];
/** The way it looks: its own -z, in the world. */
export const cameraForward = (camera: Pick<AtlasCamera, "cameraToWorld">): Vec3 => unit([-camera.cameraToWorld[2]!, -camera.cameraToWorld[6]!, -camera.cameraToWorld[10]!]);

/** A camera-to-world matrix from where the camera stands and how it is turned: a unit quaternion, x y z w. */
export function matrixOf(position: Vec3, quaternion: readonly [number, number, number, number]): Mat4 {
  const n = Math.hypot(...quaternion);
  if (!(n > 1e-9)) throw new AtlasValidationError("a quaternion of length 0 turns nothing");
  const [x, y, z, w] = quaternion.map((value) => value / n) as [number, number, number, number];
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), position[0],
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), position[1],
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), position[2],
    0, 0, 0, 1,
  ];
}

/** How a camera-to-world matrix is turned, as a unit quaternion x y z w with w at or above 0. */
export function quaternionOf(m: Mat4): [number, number, number, number] {
  const [m00, m01, m02, , m10, m11, m12, , m20, m21, m22] = m as number[];
  const trace = m00! + m11! + m22!;
  let q: [number, number, number, number];
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(m21! - m12!) / s, (m02! - m20!) / s, (m10! - m01!) / s, s / 4];
  } else if (m00! > m11! && m00! > m22!) {
    const s = Math.sqrt(1 + m00! - m11! - m22!) * 2;
    q = [s / 4, (m01! + m10!) / s, (m02! + m20!) / s, (m21! - m12!) / s];
  } else if (m11! > m22!) {
    const s = Math.sqrt(1 + m11! - m00! - m22!) * 2;
    q = [(m01! + m10!) / s, s / 4, (m12! + m21!) / s, (m02! - m20!) / s];
  } else {
    const s = Math.sqrt(1 + m22! - m00! - m11!) * 2;
    q = [(m02! + m20!) / s, (m12! + m21!) / s, s / 4, (m10! - m01!) / s];
  }
  const n = Math.hypot(...q) * (q[3] < 0 ? -1 : 1);
  return q.map((value) => value / n + 0) as [number, number, number, number];
}

/** The inverse of a rigid transform (a turn and a move), row by row. */
export function invertRigid(m: Mat4): Mat4 {
  const t: Vec3 = [m[3]!, m[7]!, m[11]!];
  const r0: Vec3 = [m[0]!, m[4]!, m[8]!], r1: Vec3 = [m[1]!, m[5]!, m[9]!], r2: Vec3 = [m[2]!, m[6]!, m[10]!];
  return [...r0, -dot(r0, t), ...r1, -dot(r1, t), ...r2, -dot(r2, t), 0, 0, 0, 1];
}

/** A camera-to-world matrix between OpenGL's convention and OpenCV's (+y down, looking along +z): the same flip both ways. */
export function flipYZ(m: Mat4): Mat4 {
  return m.map((value, index) => (index < 12 && (index % 4 === 1 || index % 4 === 2) ? -value : value));
}

/**
 * What a set of cameras is looking at: the point nearest all their lines of
 * sight, and how far from it they stand on average. Cameras that all look
 * the same way share no such point: it is then two metres ahead of their
 * middle, a guess that says so.
 */
export function sceneFocus(cameras: readonly AtlasCamera[]): { centre: Vec3; radius: number; guessed: boolean } {
  if (cameras.length === 0) throw new AtlasValidationError("no cameras to read a scene's middle from");
  const positions = cameras.map(cameraPosition), ways = cameras.map(cameraForward);
  const middle = scale(positions.reduce(add, [0, 0, 0] as Vec3), 1 / cameras.length);
  // Σ (I - d dᵀ) p = Σ (I - d dᵀ) o
  const a = [0, 0, 0, 0, 0, 0, 0, 0, 0], b = [0, 0, 0];
  positions.forEach((o, index) => {
    const d = ways[index]!;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const m = (r === c ? 1 : 0) - d[r]! * d[c]!;
        a[r * 3 + c]! += m;
        b[r]! += m * o[c]!;
      }
    }
  });
  const det = a[0]! * (a[4]! * a[8]! - a[5]! * a[7]!) - a[1]! * (a[3]! * a[8]! - a[5]! * a[6]!) + a[2]! * (a[3]! * a[7]! - a[4]! * a[6]!);
  const together = ways.reduce(add, [0, 0, 0] as Vec3);
  const ahead = add(middle, scale(length(together) > 1e-6 ? unit(together) : ways[0]!, 2));
  if (Math.abs(det) < 1e-6) return { centre: ahead, radius: 2, guessed: true };
  const col = (index: number): number[] => a.map((value, at) => (at % 3 === index ? b[Math.floor(at / 3)]! : value));
  const det3 = (m: number[]) => m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) - m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) + m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!);
  const centre: Vec3 = [det3(col(0)) / det, det3(col(1)) / det, det3(col(2)) / det];
  const radius = positions.reduce((sum, p) => sum + length(sub(p, centre)), 0) / cameras.length;
  // A point behind the cameras, or absurdly far, is arithmetic, not a scene.
  const inFront = positions.every((p, index) => dot(sub(centre, p), ways[index]!) > 0);
  if (!inFront || !(radius > 1e-3) || radius > 1e4) return { centre: ahead, radius: 2, guessed: true };
  return { centre, radius, guessed: false };
}

export interface OrbitPath {
  /** Where the path starts: a camera the scene was seen from. */
  readonly from: AtlasCamera;
  /** What it goes round. */
  readonly centre: Vec3;
  /** Degrees round the vertical through the centre; negative goes the other way. */
  readonly sweepDegrees: number;
  readonly count: number;
  readonly width: number;
  readonly height: number;
}

/** Cameras on an arc round a point, at the height and distance of the one it starts from, each looking at the point. */
export function orbit(path: OrbitPath): AtlasCamera[] {
  if (!Number.isInteger(path.count) || path.count < 1) throw new AtlasValidationError("an orbit has at least one camera");
  if (!(Math.abs(path.sweepDegrees) <= 360)) throw new AtlasValidationError("an orbit sweeps at most 360 degrees");
  const start = sub(cameraPosition(path.from), path.centre);
  const lens = pinhole(path.width, path.height, fovYDegrees(path.from));
  const steps = path.count === 1 ? 1 : Math.abs(path.sweepDegrees) === 360 ? path.count : path.count - 1;
  return Array.from({ length: path.count }, (_, index) => {
    const angle = ((path.sweepDegrees * Math.PI) / 180) * (path.count === 1 ? 0 : index / steps);
    const eye: Vec3 = add(path.centre, [start[0] * Math.cos(angle) + start[2] * Math.sin(angle), start[1], -start[0] * Math.sin(angle) + start[2] * Math.cos(angle)]);
    return { ...lens, cameraToWorld: lookAt(eye, path.centre) };
  });
}

export interface PushPath {
  readonly from: AtlasCamera;
  /** How far along its line of sight, in the scene's units; negative pulls back. */
  readonly distance: number;
  readonly count: number;
  readonly width: number;
  readonly height: number;
}

/** Cameras moving straight along the line of sight of the one they start from, turned as it is. */
export function push(path: PushPath): AtlasCamera[] {
  if (!Number.isInteger(path.count) || path.count < 1) throw new AtlasValidationError("a push has at least one camera");
  if (!Number.isFinite(path.distance)) throw new AtlasValidationError("a push goes a finite distance");
  const lens = pinhole(path.width, path.height, fovYDegrees(path.from));
  const way = cameraForward(path.from), start = cameraPosition(path.from);
  return Array.from({ length: path.count }, (_, index) => {
    // One camera alone stands where the push ends: a view from where it starts is a picture already taken.
    const eye = add(start, scale(way, path.count === 1 ? path.distance : (path.distance * index) / (path.count - 1)));
    const m = [...path.from.cameraToWorld];
    m[3] = eye[0]; m[7] = eye[1]; m[11] = eye[2];
    return { ...lens, cameraToWorld: m };
  });
}

/** A camera placed in words: where it stands and what it looks at. */
export function placed(at: Vec3, lookingAt: Vec3, width: number, height: number, fov = 50): AtlasCamera {
  return { ...pinhole(width, height, fov), cameraToWorld: lookAt(at, lookingAt) };
}
