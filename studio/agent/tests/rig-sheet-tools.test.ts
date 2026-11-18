// ---------------------------------------------------------------------------
// pva_rig_sheet: a rig posed in Blender, and what the tool keeps and says
// ---------------------------------------------------------------------------
// The real tool against a Blender that is a script: it writes what
// rig-sheet.py writes, so the paths, the files kept beside the rig and the
// words are tested without a 3D program. The script itself is tested with a
// real Blender in packages/blender (test:live).
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RigSheetReport } from "@av/blender/rig-sheet";
import { describeRigSheet, pulled, registerRigSheetTools, RIG_STRAIN_MARKS } from "../src/rig-sheet-tools.js";

const REF = { channel: "sample-channel", series: "sample-series", episode: "ep" };

interface Tool {
  name: string;
  description: string;
  execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
}

// What the fake measured, by pose name: the tool marks by these numbers.
const FAKE_BLENDER = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv.includes('--version')) { console.log('Blender 4.5.1'); process.exit(0); }
const cfg = JSON.parse(readFileSync(process.argv.at(-1), 'utf8'));
const rig = readFileSync(cfg.rigPath, 'utf8');
if (rig.includes('NO SKELETON')) { console.log('RuntimeError: the file has no skeleton: there is nothing to pose'); process.exit(1); }
const biped = !rig.includes('CREATURE');
const layout = (columns, rows) => ({ columns, rows, width: columns * cfg.tile, height: rows * cfg.tile });
const poses = cfg.poses.length ? cfg.poses : biped
  ? [{ name: 'arms up', turns: [{ bone: 'LeftArm', about: 'front', degrees: 110 }] }, { name: 'step', turns: [{ bone: 'LeftUpLeg', about: 'side', degrees: -60 }] }]
  : [{ name: 'swing Tail', turns: [{ bone: 'Tail', about: 'side', degrees: 40 }] }];
const strain = { 'arms up': [0.045, 810], step: [0.004, 3] };
const clips = [...cfg.actions.map((name) => ({ name, from: 'rig' })), ...cfg.clips.map((clip) => ({ name: clip.name, from: 'file' }))]
  .map((clip) => ({ ...clip, action: 'Armature|' + clip.name, seconds: 1.03, travel: clip.name === 'running' ? 1.4 : 0.01, strained: 0.06, torn: 301,
    sheet: 'clip.' + clip.name + '.png', ...layout(cfg.clipFrames, 2) }));
writeFileSync(join(cfg.outputDir, 'poses.png'), 'poses of ' + cfg.faces);
for (const clip of clips) writeFileSync(join(cfg.outputDir, clip.sheet), 'clip ' + clip.name);
writeFileSync(join(cfg.outputDir, 'sheet.json'), JSON.stringify({
  rig: { bones: 24, vertices: 17020, edges: rig.includes('COARSE') ? 1200 : 45904, size: [0.57, 1, 0.54], skeleton: biped ? 'biped' : 'unknown', roles: {} },
  bones: [{ name: 'Root', parent: null, at: [0, 0, 0] }, { name: 'Tail', parent: 'Root', at: [0, 0, 1] }],
  views: ['front', 'three-quarter', 'side'],
  poses: { sheet: 'poses.png', ...layout(poses.length + 1, 3), list: [{ name: 'rest', turns: [], strained: 0, torn: 0 },
    ...poses.map((pose) => ({ ...pose, strained: (strain[pose.name] ?? [0.001, 0])[0], torn: (strain[pose.name] ?? [0.001, 0])[1] }))] },
  clips, actionsInside: rig.includes('WITH CLIPS') ? ['Idle', 'Walk'] : [],
  notes: biped ? [] : ["the bones' names are not a two-legged body's: each of its 1 largest limbs is swung instead. Give poses of your own, as turns of named bones, to see more"],
}));
`;

describe("pva_rig_sheet", () => {
  let root: string;
  let models: string;
  let tool: Tool;
  const saved = { library: process.env.AVG_LIBRARY_ROOT, blender: process.env.BLENDER_BIN };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rig-sheet-tool-"));
    models = join(root, REF.channel, "series", REF.series, "episodes", REF.episode, "assets", "models");
    mkdirSync(models, { recursive: true });
    const blender = join(root, "blender.mjs");
    writeFileSync(blender, FAKE_BLENDER);
    chmodSync(blender, 0o755);
    process.env.AVG_LIBRARY_ROOT = root;
    process.env.BLENDER_BIN = blender;
    const tools: Tool[] = [];
    registerRigSheetTools({ registerTool: (one: Tool) => tools.push(one) } as never);
    tool = tools[0]!;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (saved.library === undefined) delete process.env.AVG_LIBRARY_ROOT; else process.env.AVG_LIBRARY_ROOT = saved.library;
    if (saved.blender === undefined) delete process.env.BLENDER_BIN; else process.env.BLENDER_BIN = saved.blender;
  });

  const run = (params: Record<string, unknown>) => tool.execute("call", { ...REF, ...params }, undefined, undefined);

  it("is one tool, and says it is local and free", () => {
    expect(tool.name).toBe("pva_rig_sheet");
    expect(tool.description).toContain("Local (Blender), free");
  });

  it("poses the rig, plays the clips beside it, and keeps the sheets beside the rig", async () => {
    writeFileSync(join(models, "figure.glb"), "RIG WITH CLIPS");
    writeFileSync(join(models, "figure.clip.walking.glb"), "clip");
    writeFileSync(join(models, "figure.clip.running.glb"), "clip");
    writeFileSync(join(models, "figure.clip.old.sheet.png"), "a sheet of a clip that is gone");
    writeFileSync(join(models, "other.clip.jump.glb"), "another rig's clip");

    const result = await run({ rigPath: "assets/models/figure.glb" });
    expect(readdirSync(models).sort()).toEqual([
      "figure.clip.running.glb", "figure.clip.running.sheet.png", "figure.clip.walking.glb", "figure.clip.walking.sheet.png",
      "figure.glb", "figure.poses.png", "figure.sheet.json", "other.clip.jump.glb",
    ]);
    expect(readFileSync(join(models, "figure.poses.png"), "utf8")).toBe("poses of +z");
    expect(readFileSync(join(models, "figure.clip.walking.sheet.png"), "utf8")).toBe("clip walking");

    expect(result.content[0]!.text.split("\n")).toEqual([
      "✅ assets/models/figure.poses.png — 3 columns (rest, arms up, step) × 3 rows (front, three-quarter, side)",
      "   24 bones, 17,020 vertices; its bones' names were read as a two-legged body's",
      "   ⚠️ arms up: 4.5% of the surface strained, 810 edges torn",
      "   step: 0.4% of the surface strained, 3 edges torn",
      "   clip running: assets/models/figure.clip.running.sheet.png — 1.03s, at its worst 6.0% of the surface strained, 301 edges torn, the body travels 1.4 of its height",
      "   clip walking: assets/models/figure.clip.walking.sheet.png — 1.03s, at its worst 6.0% of the surface strained, 301 edges torn, played on the spot",
      "   clips inside the rig not played: Idle, Walk — name up to 8 in `actions`",
      "   open the sheet and read it tile by tile: where a limb meets the body, and whatever the character wears. Start at arms up: a sound rig of a body this fine strains under 2.0% of its surface in these poses and tears almost none",
    ]);

    const kept = JSON.parse(readFileSync(join(models, "figure.sheet.json"), "utf8"));
    expect(kept).toMatchObject({ version: 1, rigFile: "figure.glb", faces: "+z", marks: RIG_STRAIN_MARKS, rig: { skeleton: "biped" }, poses: { sheet: "figure.poses.png" } });
    expect(kept.rigSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(kept.clips.map((clip: { sheet: string }) => clip.sheet)).toEqual(["figure.clip.running.sheet.png", "figure.clip.walking.sheet.png"]);
    expect(result.details).toMatchObject({ sheetPath: join(models, "figure.poses.png"), reportPath: join(models, "figure.sheet.json") });
    // Nothing is left where Blender worked.
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith("rig-sheet-") && !name.startsWith("rig-sheet-tool-") && existsSync(join(tmpdir(), name, "sheet", "request.json")))).toEqual([]);
  });

  it("takes the way the body faces, poses of its own, clips by name, and no clip files when told none", async () => {
    writeFileSync(join(models, "figure.glb"), "RIG WITH CLIPS");
    writeFileSync(join(models, "figure.clip.walking.glb"), "clip");
    const result = await run({
      rigPath: "assets/models/figure.glb", faces: "+x", clips: [], actions: ["Walk"],
      poses: [{ name: "lean", turns: [{ bone: "Spine", about: "side", degrees: 20 }] }],
    });
    const lines = result.content[0]!.text.split("\n");
    expect(lines[0]).toBe("✅ assets/models/figure.poses.png — 2 columns (rest, lean) × 3 rows (front, three-quarter, side)");
    expect(lines).toContain("   clip Walk: assets/models/figure.clip.Walk.sheet.png — 1.03s, at its worst 6.0% of the surface strained, 301 edges torn, played on the spot");
    expect(lines).toContain("   clips inside the rig not played: Idle — name up to 8 in `actions`");
    expect(lines.at(-1)).toContain("No pose pulled the surface further than a sound rig does");
    expect(readFileSync(join(models, "figure.poses.png"), "utf8")).toBe("poses of +x");
    expect(existsSync(join(models, "figure.clip.walking.sheet.png"))).toBe(false);
  });

  it("lists the bones of a body it could not read, so poses can be written for it", async () => {
    writeFileSync(join(models, "beast.glb"), "CREATURE");
    const lines = (await run({ rigPath: "assets/models/beast.glb" })).content[0]!.text.split("\n");
    expect(lines[1]).toBe("   24 bones, 17,020 vertices; its bones' names were not read as a two-legged body's");
    expect(lines).toContain("   the bones' names are not a two-legged body's: each of its 1 largest limbs is swung instead. Give poses of your own, as turns of named bones, to see more");
    expect(lines).toContain("   bones: Root, Tail");
  });

  it("does not mark a pose of a body too coarse to tell", async () => {
    writeFileSync(join(models, "blocky.glb"), "COARSE");
    const lines = (await run({ rigPath: "assets/models/blocky.glb" })).content[0]!.text.split("\n");
    expect(lines).toContain("   arms up: 4.5% of the surface strained, 810 edges torn");
    expect(lines.at(-1)).toContain("The body is too coarse for the numbers to mark a pose");
    expect(pulled({ strained: 0.045, torn: 810 }, 1200)).toBe(false);
    expect(pulled({ strained: 0.021, torn: 0 }, 45904)).toBe(true);
    expect(pulled({ strained: 0.001, torn: 100 }, 45904)).toBe(true);
    expect(pulled({ strained: 0.019, torn: 90 }, 45904)).toBe(false);
  });

  it("refuses what is not a rig of the episode, and keeps the last sheet when a run fails", async () => {
    await expect(run({ rigPath: "assets/models/none.glb" })).rejects.toThrow("Rig not found: assets/models/none.glb");
    await expect(run({ rigPath: "../../../../../outside.glb" })).rejects.toThrow();
    writeFileSync(join(models, "figure.fbx"), "fbx");
    await expect(run({ rigPath: "assets/models/figure.fbx" })).rejects.toThrow("Rig must be a binary glTF (.glb): assets/models/figure.fbx");
    writeFileSync(join(models, "figure.glb"), "rig");
    await expect(run({ rigPath: "assets/models/figure.glb", clips: ["assets/models/absent.glb"] })).rejects.toThrow("Clip not found: assets/models/absent.glb");
    await expect(run({ rigPath: "assets/models/figure.glb", poses: [{ name: "up", turns: [{ bone: "Arm", about: "front", degrees: 1 }] }], faces: "sideways" })).rejects.toThrow("faces is one of");

    writeFileSync(join(models, "figure.poses.png"), "the last sheet");
    writeFileSync(join(models, "figure.glb"), "NO SKELETON");
    await expect(run({ rigPath: "assets/models/figure.glb" })).rejects.toThrow("the file has no skeleton: there is nothing to pose");
    expect(readFileSync(join(models, "figure.poses.png"), "utf8")).toBe("the last sheet");
  });
});

describe("what the sheet says", () => {
  it("counts one torn edge as one", () => {
    const report = {
      rig: { bones: 2, vertices: 8, edges: 12, size: [1, 1, 1], skeleton: "biped", roles: {} }, bones: [], views: ["front"],
      poses: { sheet: "p.png", columns: 2, rows: 1, width: 2, height: 1, list: [{ name: "rest", turns: [], strained: 0, torn: 0 }, { name: "bow", turns: [], strained: 0.5, torn: 1 }] },
      clips: [], actionsInside: [], notes: [],
    } as unknown as RigSheetReport;
    expect(describeRigSheet(report, { poses: "p.png", clips: {} })[2]).toBe("   bow: 50.0% of the surface strained, 1 edge torn");
  });
});
