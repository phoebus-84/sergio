// ---------------------------------------------------------------------------
// A figure stood: facing +z, its feet on y 0, over the origin
// ---------------------------------------------------------------------------
// Built on tests/fixtures/rig-glb.ts: real binary glTFs, so what is checked
// is where the written file puts the body, read back from its bytes.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { readGlb, transformPoint, worldMatrices, writeGlb } from "../src/glb.js";
import { examineRig } from "../src/rig-exam.js";
import { STOOD_NODE, applyStand, figureBox, standFigure } from "../src/stand.js";
import { BIPED, rigGlb, type FixtureRig } from "./fixtures/rig-glb.js";

const round = (values: readonly number[]) => values.map((v) => Math.round(v * 1000) / 1000 + 0);

/** The biped as a generator leaves it: its origin at its middle, and moved off to one side. */
const moved = (by: [number, number, number]): FixtureRig => ({
  ...BIPED,
  box: { min: BIPED.box.min.map((v, axis) => v + by[axis]!) as [number, number, number], max: BIPED.box.max.map((v, axis) => v + by[axis]!) as [number, number, number] },
  joints: BIPED.joints.map((joint) => ({ ...joint, at: joint.at.map((v, axis) => v + by[axis]!) as [number, number, number] })),
});
const MIDDLE = rigGlb(moved([0.3, -0.9, -0.1]));

/** Where the wrapper sends a point of the body, read from the written file. */
function sent(bytes: Buffer, point: [number, number, number]): number[] {
  const gltf = readGlb(bytes)!.json;
  const root = gltf.scenes![0]!.nodes![0]!;
  expect(gltf.nodes![root]!.name).toBe(STOOD_NODE);
  return round(transformPoint(worldMatrices(gltf).world[root]!, point));
}

describe("a figure, stood", () => {
  it("is put on the ground and over the origin, and says how far it was moved", () => {
    expect(round(figureBox(readGlb(MIDDLE)!)!.min)).toEqual([-0.3, -0.9, -0.3]);
    const stood = standFigure(MIDDLE)!;
    expect(stood.changed).toBe(true);
    expect(stood.stand).toEqual({ degrees: 0, scale: 1, move: [-0.3, 0.9, 0.1] });
    expect(round(stood.before.min)).toEqual([-0.3, -0.9, -0.3]);
    expect({ min: round(stood.after.min), max: round(stood.after.max) }).toEqual({ min: [-0.6, 0, -0.2], max: [0.6, 1.8, 0.2] });
    // The exam reads the written file the same way: it stands on y 0.
    expect(examineRig(stood.bytes)).toMatchObject({ ok: true, floor: 0, size: [1.2, 1.8, 0.4] });
  });

  it("is turned to face +z from the way it faced, about its own middle", () => {
    const stood = standFigure(MIDDLE, { faces: "+x" })!;
    expect(stood.stand.degrees).toBe(-90);
    // The body was 1.2 wide and 0.4 deep facing +x: turned, its width lies along z.
    expect({ min: round(stood.after.min), max: round(stood.after.max) }).toEqual({ min: [-0.2, 0, -0.6], max: [0.2, 1.8, 0.6] });
    // What was in front of it (+x of its middle) is now in front (+z), and up is still up.
    expect(sent(stood.bytes, [0.3 + 1, -0.9, -0.1])).toEqual([0, 0, 1]);
    expect(sent(stood.bytes, [0.3, -0.9 + 1, -0.1])).toEqual([0, 1, 0]);
    expect(sent(standFigure(MIDDLE, { faces: "-z" })!.bytes, [0.3, -0.9, -0.1 - 1])).toEqual([0, 0, 1]);
  });

  it("is made as tall as it is said to be", () => {
    const stood = standFigure(MIDDLE, { height: 0.9 })!;
    expect(stood.stand.scale).toBe(0.5);
    expect({ min: round(stood.after.min), max: round(stood.after.max) }).toEqual({ min: [-0.3, 0, -0.1], max: [0.3, 0.9, 0.1] });
    expect(examineRig(stood.bytes)).toMatchObject({ ok: true, floor: 0, size: [0.6, 0.9, 0.2] });
    expect(() => standFigure(MIDDLE, { height: 0 })).toThrow("height is how tall the figure stands, above 0");
  });

  it("is left byte for byte when it already stands", () => {
    const standing = rigGlb(BIPED);
    const stood = standFigure(standing)!;
    expect(stood.changed).toBe(false);
    expect(stood.bytes.equals(standing)).toBe(true);
    expect(stood.stand).toEqual({ degrees: 0, scale: 1, move: [0, 0, 0] });
  });

  it("touches nothing but the scene's roots: the numbers of the body are the same bytes", () => {
    const before = readGlb(MIDDLE)!;
    const after = readGlb(standFigure(MIDDLE, { faces: "+x", height: 1.2 })!.bytes)!;
    expect(Buffer.from(after.bin!).equals(Buffer.from(before.bin!))).toBe(true);
    expect(after.json.nodes!.slice(0, before.json.nodes!.length)).toEqual(before.json.nodes);
    expect(after.json.nodes).toHaveLength(before.json.nodes!.length + 1);
    expect(after.json.skins).toEqual(before.json.skins);
  });

  it("stands a model with no skeleton by where its scene puts it", () => {
    const rig = readGlb(MIDDLE)!;
    const statue = writeGlb({ ...rig.json, skins: [], nodes: rig.json.nodes!.map((node) => (node.mesh !== undefined ? { name: node.name, mesh: node.mesh, translation: [0, 2, 0] } : node)) }, rig.bin);
    expect(round(figureBox(readGlb(statue)!)!.min)).toEqual([-0.3, 1.1, -0.3]);
    const stood = standFigure(statue, { faces: "-x" })!;
    expect(stood.stand).toEqual({ degrees: 90, scale: 1, move: [0.1, -1.1, 0.3] });
    expect({ min: round(stood.after.min), max: round(stood.after.max) }).toEqual({ min: [-0.2, 0, -0.6], max: [0.2, 1.8, 0.6] });
  });

  it("gives a clip the stand of its rig, whatever pose the clip's file rests in", () => {
    const rig = standFigure(MIDDLE, { faces: "+x" })!;
    const clip = rigGlb({ ...moved([0.3, -0.9, -0.1]), clips: [{ name: "walking", seconds: 1, moves: [7, 9] }] });
    const stoodClip = applyStand(clip, rig.stand)!;
    const gltf = readGlb(stoodClip)!.json;
    expect(gltf.animations).toEqual(readGlb(clip)!.json.animations);
    expect(sent(stoodClip, [0.3 + 1, -0.9, -0.1])).toEqual([0, 0, 1]);
    expect(round(figureBox(readGlb(stoodClip)!)!.min)).toEqual(round(rig.after.min));
    // A stand that moves nothing leaves the clip's bytes alone.
    expect(applyStand(clip, { degrees: 0, scale: 1, move: [0, 0, 0] })!.equals(clip)).toBe(true);
  });

  it("is refused for what is not a model, and for a model with nothing in it", () => {
    expect(standFigure(Buffer.from("not a model"))).toBeNull();
    expect(applyStand(Buffer.from("not a model"), { degrees: 90, scale: 1, move: [0, 0, 0] })).toBeNull();
    const rig = readGlb(MIDDLE)!;
    const empty = writeGlb({ ...rig.json, meshes: [], skins: [], nodes: rig.json.nodes!.map(({ mesh: _mesh, skin: _skin, ...node }) => node) }, rig.bin);
    expect(() => standFigure(empty)).toThrow("the file holds no body: there is nothing to stand");
  });
});
