// ---------------------------------------------------------------------------
// pva_release_model: a model or a rig of an episode, released as a form
// ---------------------------------------------------------------------------
// The real tool on real binary glTFs (tests/fixtures/rig-glb.ts) and a real
// character on disk: what lands in the character's folder is read back from
// its bytes, and the record from the character's own manifest.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { castRole, checkCharacter, createCharacter, readCharacter, resolveCast, updateCharacter } from "@studio/cast";
import { readGlb, writeGlb } from "../src/glb.js";
import { examineRig } from "../src/rig-exam.js";
import { readReleasedForm, registerReleaseTools } from "../src/release-tools.js";
import { STOOD_NODE, figureBox } from "../src/stand.js";
import { BIPED, rigGlb, type FixtureRig } from "./fixtures/rig-glb.js";

const REF = { channel: "sample-channel", series: "sample-series", episode: "ep" };
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const round = (values: readonly number[]) => values.map((v) => Math.round(v * 1000) / 1000 + 0);

/** The biped as a rigging service leaves it: one unit tall, its origin at its middle. */
const AS_MADE: FixtureRig = {
  ...BIPED,
  box: { min: [-1 / 3, -0.5, -1 / 9], max: [1 / 3, 0.5, 1 / 9] },
  joints: BIPED.joints.map((joint) => ({ ...joint, at: [joint.at[0] / 1.8, joint.at[1] / 1.8 - 0.5, joint.at[2] / 1.8] as [number, number, number] })),
};
const RIG = rigGlb(AS_MADE);
const clipOf = (name: string) => rigGlb({ ...AS_MADE, clips: [{ name, seconds: 1, moves: [7, 9] }] });

interface Tool {
  name: string;
  description: string;
  execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
}

function listed(folder: string, under = ""): string[] {
  return readdirSync(join(folder, under)).sort().flatMap((name) => (statSync(join(folder, under, name)).isDirectory() ? listed(folder, `${under}${name}/`) : [`${under}${name}`]));
}

describe("pva_release_model", () => {
  let root: string;
  let models: string;
  let tool: Tool;
  const saved = process.env.AVG_LIBRARY_ROOT;
  const character = () => join(root, REF.channel, "characters", "guide");
  const release = (params: Record<string, unknown> = {}) => tool.execute("call", { ...REF, modelPath: "assets/models/guide.glb", character: "guide", ...params });
  const put = (name: string, content: string | Uint8Array) => writeFileSync(join(models, name), content);
  /** The sheet pva_rig_sheet leaves beside a rig: what was posed, and which clips were played. */
  const pose = (rig: Uint8Array, played: string[], poses = [{ name: "rest", strained: 0, torn: 0 }, { name: "arms up", strained: 0.004, torn: 3 }]) => {
    put("guide.poses.png", "the pose sheet");
    for (const name of played) put(`guide.clip.${name}.sheet.png`, `six moments of ${name}`);
    put("guide.sheet.json", JSON.stringify({
      version: 1, rigFile: "guide.glb", rigSha256: sha256(rig), faces: "+z", rig: { bones: 11, vertices: 11, edges: 45000, skeleton: "biped" },
      poses: { sheet: "guide.poses.png", list: poses },
      clips: played.map((name) => ({ name, from: "file", sheet: `guide.clip.${name}.sheet.png`, seconds: 1.04, travel: name === "walking" ? 0.05 : 0 })),
    }));
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pva-release-"));
    const episode = join(root, REF.channel, "series", REF.series, "episodes", REF.episode);
    models = join(episode, "assets", "models");
    mkdirSync(models, { recursive: true });
    mkdirSync(join(episode, "assets", "images"), { recursive: true });
    writeFileSync(join(episode, "assets", "images", "boy.png"), "the picture");
    put("boy.glb", "the model the rig was made from");
    put("boy.preview.webp", "its preview");
    put("boy.provenance.json", JSON.stringify({ provider: "fal.ai", model: "Tripo H3.1 image to 3D", imagePath: "assets/images/boy.png" }));
    put("guide.glb", RIG);
    put("guide.provenance.json", JSON.stringify({ provider: "fal.ai", model: "Hyper3D Rigging", engine: "hyper3d", skinning: "core", modelPath: "assets/models/boy.glb", clips: [{ name: "walking" }, { name: "running" }] }));
    put("guide.clip.walking.glb", clipOf("walk"));
    put("guide.clip.running.glb", clipOf("run"));
    put("guide.clip.wave.glb", clipOf("wave"));
    put("guide.clip.wave.provenance.json", JSON.stringify({ tool: "pva_generate_motion", generation: { provider: "fal.ai", model: "Hunyuan Motion", prompt: "A person waves hello." } }));
    pose(RIG, ["walking", "wave"]);
    process.env.AVG_LIBRARY_ROOT = root;
    createCharacter(root, [REF.channel], { id: "guide", name: "The Guide" });
    const tools: Tool[] = [];
    registerReleaseTools({ registerTool: (one: Tool) => tools.push(one) } as never);
    tool = tools[0]!;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (saved === undefined) delete process.env.AVG_LIBRARY_ROOT; else process.env.AVG_LIBRARY_ROOT = saved;
  });

  it("is one tool, and says it is local and free", () => {
    expect(tool.name).toBe("pva_release_model");
    expect(tool.description).toContain("in one step. Local, free");
  });

  it("releases a rig with the clips that were played, its sheets and the records of what made it", async () => {
    const result = await release({ height: 1.2, licence: { id: "LicenseRef-channel", holder: "The channel", redistributable: false } });
    const folder = join(character(), "forms", "rig", "v1");
    expect(listed(folder)).toEqual([
      "clips/walking.glb", "clips/wave.glb", "form.json",
      "provenance/boy.provenance.json", "provenance/guide.clip.wave.provenance.json", "provenance/guide.provenance.json",
      "reference/picture.png", "reference/preview.webp", "rig.glb",
      "sheets/clip.walking.png", "sheets/clip.wave.png", "sheets/poses.png", "sheets/sheet.json",
    ]);
    expect(result.content[0]!.text.split("\n")).toEqual([
      expect.stringMatching(/^✅ The Guide \(sample-channel\/guide\): "rig" v1 released — rig-3d, 13 files, 0\.0MB, tree [0-9a-f]{12}…$/),
      "   stood (sized ×1.2, moved 0, 0.6, 0): faces +z, feet on y 0, 0.8 wide × 1.2 tall × 0.267 deep",
      "   in sample-channel/characters/guide/forms/rig/v1: open rig.glb; clips in clips/",
      "   actions: walking, wave",
      "   left out: running (not played on the rig's sheet)",
      '   next: give it a role — pva_cast { channel, series, role, character: "guide" } — then film it by its role: pva_rig_shot { role }',
    ]);

    // The released rig stands: read from its own bytes, by the exam every rig sits.
    const stood = readFileSync(join(folder, "rig.glb"));
    expect(examineRig(stood)).toMatchObject({ ok: true, floor: 0, size: [0.8, 1.2, 0.267] });
    // Nothing of the body was rewritten: the numbers are the bytes the service returned.
    expect(Buffer.from(readGlb(stood)!.bin!).equals(Buffer.from(readGlb(RIG)!.bin!))).toBe(true);
    // A clip stands where its rig does, and still holds its motion.
    const clip = readGlb(readFileSync(join(folder, "clips", "walking.glb")))!;
    expect(clip.json.nodes!.at(-1)).toMatchObject({ name: STOOD_NODE, translation: [0, 0.6, 0], scale: [1.2, 1.2, 1.2] });
    expect(clip.json.animations).toHaveLength(1);
    expect(round(figureBox(clip)!.min)).toEqual([-0.4, 0, -0.133]);

    const record = readReleasedForm(folder)!;
    expect(record).toMatchObject({
      version: 1, tool: "pva_release_model", medium: "rig-3d", entry: "rig.glb", faces: "+z", floor: 0, size: [0.8, 1.2, 0.267],
      from: { ...REF, path: "assets/models/guide.glb", sha256: sha256(RIG) },
      stand: { degrees: 0, scale: 1.2, move: [0, 0.6, 0], faced: "+z" },
      skeleton: { joints: 11, kind: "biped", influences: 1 },
      leftOut: [{ name: "running", why: "not played on the rig's sheet" }],
      sheet: { poses: "sheets/poses.png", report: "sheets/sheet.json", pulled: [] },
    });
    expect(record.clips).toEqual([
      { name: "walking", file: "clips/walking.glb", seconds: 1.04, travel: 0.05, made: "came with the rig", sheet: "sheets/clip.walking.png", from: { path: "assets/models/guide.clip.walking.glb", sha256: sha256(clipOf("walk")) } },
      { name: "wave", file: "clips/wave.glb", seconds: 1.04, travel: 0, made: "generated from a sentence", sheet: "sheets/clip.wave.png", from: { path: "assets/models/guide.clip.wave.glb", sha256: sha256(clipOf("wave")) } },
    ]);
    expect(record.files.find((file) => file.file === "reference/picture.png")).toEqual({ file: "reference/picture.png", from: "assets/images/boy.png", sha256: sha256(Buffer.from("the picture")) });

    // The character has the form, says what it can do, and the release is on record with what made it.
    const manifest = readCharacter(root, [REF.channel], "guide").manifest!;
    expect(manifest.forms).toHaveLength(1);
    expect(manifest.forms![0]).toMatchObject({ id: "rig", medium: "rig-3d", current: "v1", can: { actions: ["walking", "wave"], views: ["front", "three-quarter", "side", "back"] } });
    expect(manifest.forms![0]!.releases![0]).toMatchObject({
      id: "v1", path: "forms/rig/v1", entry: "rig.glb", tree: { files: 13 }, licence: { id: "LicenseRef-channel", holder: "The channel", redistributable: false },
      madeWith: [
        { tool: "pva_generate_model", provider: "fal.ai", model: "Tripo H3.1 image to 3D" },
        { tool: "pva_rig_model", provider: "fal.ai", model: "Hyper3D Rigging", note: "engine hyper3d, core skinning; clips that came with it: walking, running" },
        { tool: "pva_generate_motion", provider: "fal.ai", model: "Hunyuan Motion", note: 'the clip wave: "A person waves hello."' },
        { tool: "pva_release_model", note: "stood: sized ×1.2, moved 0, 0.6, 0" },
      ],
    });
    expect(checkCharacter(root, [REF.channel], "guide").filter((problem) => problem.severity === "error")).toEqual([]);

    // It can be cast as it is: the role pins the release.
    castRole(root, { channel: REF.channel, series: REF.series }, { role: "host", character: "guide" });
    expect(resolveCast(root, { channel: REF.channel, series: REF.series }, { verify: true })[0]).toMatchObject({ state: "ready", reason: 'The Guide as "rig" v1' });
  });

  it("takes the next release id, leaves the first as it was, and says what the form can do now", async () => {
    await release();
    const first = join(character(), "forms", "rig", "v1");
    const before = listed(first).map((file) => sha256(readFileSync(join(first, file))));
    put("guide.clip.bow.glb", clipOf("bow"));
    pose(RIG, ["bow"]);
    const second = await release({ clips: ["bow"], note: "a bow, and no walk" });
    expect(second.content[0]!.text).toContain('"rig" v2 released');
    expect(second.content[0]!.text).toContain("   stood (moved 0, 0.5, 0): faces +z, feet on y 0, 0.667 wide × 1 tall × 0.222 deep");
    expect(listed(first).map((file) => sha256(readFileSync(join(first, file))))).toEqual(before);
    const form = readCharacter(root, [REF.channel], "guide").manifest!.forms![0]!;
    expect(form).toMatchObject({ current: "v2", can: { actions: ["bow"] } });
    expect(form.releases!.map((entry) => entry.id)).toEqual(["v1", "v2"]);
    expect(form.releases![1]).toMatchObject({ note: "a bow, and no walk" });
    // The same file, stood the same way: a release does not depend on the one before it.
    expect(readReleasedForm(join(character(), "forms", "rig", "v2"))!.stand.move).toEqual([0, 0.5, 0]);
    await expect(release({ release: "v2" })).rejects.toThrow('the release "v2" of guide\'s form "rig" is already there: a release is never edited');
    await expect(release({ release: "Second One" })).rejects.toThrow("must be lowercase letters, digits and single hyphens");
  });

  it("says when its sheet showed poses that pulled the surface, and that no licence was stated", async () => {
    pose(RIG, [], [{ name: "rest", strained: 0, torn: 0 }, { name: "arms up", strained: 0.05, torn: 3 }, { name: "bow", strained: 0.001, torn: 200 }, { name: "step", strained: 0.01, torn: 10 }]);
    const lines = (await release()).content[0]!.text.split("\n");
    expect(lines).toContain("   no actions: it has no clip that was played on its sheet. It can stand");
    expect(lines).toContain("   left out: running (not played on the rig's sheet), walking (not played on the rig's sheet), wave (not played on the rig's sheet)");
    expect(lines).toContain("   ⚠️ on its sheet these poses pulled the surface further than a sound rig does: arms up, bow. It was released as it is; look at sheets/poses.png");
    expect(lines).toContain("   no licence was stated: say whose it is and whether it may be published with pva_update_character before the channel is shared");
    const form = readCharacter(root, [REF.channel], "guide").manifest!.forms![0]!;
    expect(form.can).toEqual({ views: ["front", "three-quarter", "side", "back"] });
  });

  it("releases a model with no skeleton as a statue, turned from the way it was told it faces", async () => {
    const rig = readGlb(RIG)!;
    put("boy.glb", writeGlb({ ...rig.json, skins: [], nodes: rig.json.nodes!.map((node) => (node.mesh !== undefined ? { name: node.name, mesh: node.mesh } : node)) }, rig.bin));
    await expect(release({ modelPath: "assets/models/boy.glb" })).rejects.toThrow("say which way the model faces in its file (`faces`: +z, +x, -x or -z)");
    await expect(release({ modelPath: "assets/models/boy.glb", faces: "+x", clips: ["walking"] })).rejects.toThrow("a model with no skeleton has no clips to release");
    const result = await release({ modelPath: "assets/models/boy.glb", faces: "+x" });
    const folder = join(character(), "forms", "model", "v1");
    expect(listed(folder)).toEqual(["form.json", "model.glb", "provenance/boy.provenance.json", "reference/picture.png", "reference/preview.webp"]);
    const lines = result.content[0]!.text.split("\n");
    expect(lines[0]).toContain('"model" v1 released — model-3d, 5 files');
    expect(lines[1]).toBe("   stood (turned -90°, moved 0, 0.5, 0): faces +z, feet on y 0, 0.222 wide × 1 tall × 0.667 deep");
    expect(lines.at(-1)).toBe('   next: give it a role — pva_cast { channel, series, role, character: "guide" }. It is a statue: it can be placed, turned and lit');
    expect(readReleasedForm(folder)).toMatchObject({ medium: "model-3d", entry: "model.glb", stand: { degrees: -90, faced: "+x" }, clips: [], leftOut: [] });
    expect(readReleasedForm(folder)).not.toHaveProperty("skeleton");
    const form = readCharacter(root, [REF.channel], "guide").manifest!.forms![0]!;
    expect(form).toMatchObject({ id: "model", medium: "model-3d", can: { views: ["front", "three-quarter", "side", "back"] } });
    expect(form.releases![0]!.madeWith).toEqual([
      { tool: "pva_generate_model", provider: "fal.ai", model: "Tripo H3.1 image to 3D" },
      { tool: "pva_release_model", note: "stood: turned -90°, moved 0, 0.5, 0" },
    ]);
  });

  it("refuses a rig that failed its exam, one never posed, and one changed since it was posed", async () => {
    const forms = join(character(), "forms");
    rmSync(join(models, "guide.sheet.json"));
    await expect(release()).rejects.toThrow("the rig was never posed: assets/models/guide.sheet.json is not there. Run pva_rig_sheet, look at the sheet, then release it");
    pose(clipOf("another file"), []);
    await expect(release()).rejects.toThrow("the rig changed since it was posed: assets/models/guide.sheet.json is of another file");
    const unbound = rigGlb({ ...AS_MADE, unbound: true });
    put("guide.glb", unbound);
    pose(unbound, []);
    await expect(release()).rejects.toThrow("the rig failed its exam and is not released:\n  - no part of the body is bound to the skeleton");
    expect(existsSync(forms)).toBe(false);
    expect(readCharacter(root, [REF.channel], "guide").manifest!.forms).toEqual([]);
  });

  it("refuses a clip that is not there, one that was not played, and one of another skeleton", async () => {
    await expect(release({ clips: ["jump"] })).rejects.toThrow("the rig has no clip named jump: assets/models/guide.clip.jump.glb is not there. It has: running, walking, wave");
    await expect(release({ clips: ["running"] })).rejects.toThrow("the clip running was not played on the rig's sheet: run pva_rig_sheet, look at guide.clip.running.sheet.png, then release it");
    put("guide.clip.walking.glb", rigGlb({ ...AS_MADE, joints: AS_MADE.joints.map((joint) => ({ ...joint, name: `mixamorig:${joint.name}` })), clips: [{ seconds: 1, moves: [7] }] }));
    await expect(release({ clips: ["walking"] })).rejects.toThrow("the clip walking is not of this rig: its skeleton has other bones. Carry it to the rig with pva_retarget_clip");
    expect(existsSync(join(character(), "forms"))).toBe(false);
    // Left to choose, it leaves that clip out and says why.
    const lines = (await release()).content[0]!.text.split("\n");
    expect(lines).toContain("   actions: wave");
    expect(lines).toContain("   left out: running (not played on the rig's sheet), walking (its skeleton is not this rig's)");
  });

  it("refuses what it cannot place: no such file, no such character, a form of another medium", async () => {
    await expect(release({ modelPath: "assets/models/none.glb" })).rejects.toThrow("Model not found: assets/models/none.glb");
    await expect(release({ modelPath: "../../../../../outside.glb" })).rejects.toThrow();
    put("guide.fbx", "Kaydara FBX Binary");
    await expect(release({ modelPath: "assets/models/guide.fbx" })).rejects.toThrow("a model is released from a binary glTF (.glb)");
    put("broken.glb", "not a model");
    await expect(release({ modelPath: "assets/models/broken.glb" })).rejects.toThrow("assets/models/broken.glb could not be read as a binary glTF");
    await expect(release({ character: "nobody" })).rejects.toThrow('there is no character "nobody" in sample-channel/sample-series or sample-channel: make the character first (pva_create_character)');
    updateCharacter(root, [REF.channel], "guide", { form: { id: "rig", medium: "puppet-2d" } });
    await expect(release()).rejects.toThrow('guide already has a form "rig" and it is puppet-2d: this file is rig-3d. Give it another form id');
    const result = await release({ form: "body" });
    expect(result.content[0]!.text).toContain('"body" v1 released');
  });

  it("finds a series' own character before its channel's", async () => {
    createCharacter(root, [REF.channel, REF.series], { id: "guide", name: "The Series' Guide" });
    const result = await release();
    expect(result.content[0]!.text).toContain("The Series' Guide (sample-channel/sample-series/guide)");
    expect(existsSync(join(root, REF.channel, "series", REF.series, "characters", "guide", "forms", "rig", "v1", "rig.glb"))).toBe(true);
    expect(existsSync(join(character(), "forms"))).toBe(false);
  });
});
