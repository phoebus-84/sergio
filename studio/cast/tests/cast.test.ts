// A cast from nothing: a character made on paper, given forms, released,
// cast in a series and in a film, and checked when its files change.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  CastError, castRole, checkAsks, checkCharacter, createCharacter, hashTree, listCharacters, readCast, readCharacter, releaseForm,
  resolveCast, uncastRole, updateCharacter, verifyRelease,
} from "../src/index.js";

describe("a channel's cast", () => {
  let root: string;
  const channel = ["jokes"] as const;
  const series = { channel: "jokes", series: "sketches" };
  const character = (id: string) => join(root, "jokes", "characters", id);
  const codes = (problems: { code: string }[]) => problems.map((p) => p.code);

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "cast-"));
    mkdirSync(join(root, "jokes", "series", "sketches", "episodes"), { recursive: true });
    mkdirSync(join(root, "clinic", "series"), { recursive: true });
    mkdirSync(join(root, "tide"), { recursive: true });
    writeFileSync(join(root, "tide", "film.yaml"), "apiVersion: studio.video/v1alpha1\nkind: Film\nslug: tide\ntitle: Tide\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("makes a character on paper: a manifest and three documents", () => {
    const made = createCharacter(root, channel, {
      id: "sergeant", name: "Sergeant Hale", summary: "A kind, literal man.", nature: "a person",
      identity: "Short and sturdy. Never slimmed for a new framing.", voice: { profile: "sergeant" },
    });
    expect(made.createdFiles).toEqual(["character.yaml", "character.md", "backstory.md", "performance.md"]);
    expect(made.manifest).toMatchObject({ kind: "Character", id: "sergeant", status: "draft", forms: [] });
    expect(readFileSync(join(character("sergeant"), "character.md"), "utf-8")).toBe("# Sergeant Hale\n\nShort and sturdy. Never slimmed for a new framing.\n");
    expect(readFileSync(join(character("sergeant"), "backstory.md"), "utf-8")).toContain("<!-- Where it comes from");
    expect(codes(checkCharacter(root, channel, "sergeant"))).toEqual(["no-form"]);
  });

  it("makes nothing twice and overwrites nothing", () => {
    writeFileSync(join(character("sergeant"), "performance.md"), "mine\n");
    const again = createCharacter(root, channel, { id: "sergeant", name: "Another name" });
    expect(again.createdFiles).toEqual([]);
    expect(again.manifest.name).toBe("Sergeant Hale");
    expect(readFileSync(join(character("sergeant"), "performance.md"), "utf-8")).toBe("mine\n");
  });

  it("refuses an owner that is not there, a bad id, a manifest the contract refuses", () => {
    expect(() => createCharacter(root, ["nobody"], { id: "x", name: "X" })).toThrow(/no channel or film nobody/);
    expect(() => createCharacter(root, channel, { id: "The Sergeant", name: "X" })).toThrow(CastError);
    expect(() => updateCharacter(root, channel, "sergeant", { status: "approved" as never })).toThrow(/was not changed/);
    expect(() => updateCharacter(root, channel, "nobody", { name: "X" })).toThrow(/has no character "nobody"/);
  });

  it("gives a character forms of any medium, and says what each can do", () => {
    updateCharacter(root, channel, "sergeant", {
      form: { id: "puppet", medium: "puppet-2d", title: "Cut-out puppet", can: { actions: ["idle", "walk", "salute"], expressions: ["neutral", "proud"], views: ["front"] } },
    });
    const manifest = updateCharacter(root, channel, "sergeant", { form: { id: "hum", medium: "sound", description: "He hums when he thinks." }, defaultForm: "puppet", status: "ready" });
    expect(manifest.forms!.map((f) => [f.id, f.medium])).toEqual([["puppet", "puppet-2d"], ["hum", "sound"]]);
    expect(() => updateCharacter(root, channel, "sergeant", { form: { id: "statue" } })).toThrow(/needs its medium/);
    expect(() => updateCharacter(root, channel, "sergeant", { form: { id: "smell", medium: "other" } })).toThrow(/says what it is/);
    expect(updateCharacter(root, channel, "sergeant", { form: { id: "puppet", title: null } }).forms![0]).not.toHaveProperty("title");
    expect(listCharacters(root, channel)).toEqual([{
      id: "sergeant", name: "Sergeant Hale", summary: "A kind, literal man.", nature: "a person", status: "ready", voice: "sergeant", broken: false,
      forms: [{ id: "puppet", medium: "puppet-2d", current: null, releases: 0 }, { id: "hum", medium: "sound", current: null, releases: 0 }],
    }]);
  });

  it("records a release with the hash of its tree, and never the same release twice", () => {
    const folder = join(character("sergeant"), "forms", "puppet", "v1");
    mkdirSync(join(folder, "parts"), { recursive: true });
    writeFileSync(join(folder, "puppet.blend"), "the rig");
    writeFileSync(join(folder, "parts", "head.png"), "a head");
    writeFileSync(join(folder, ".DS_Store"), "a desktop's leftovers");
    expect(() => releaseForm(root, channel, "sergeant", { form: "statue", release: "v1" })).toThrow(/no form "statue"/);
    expect(() => releaseForm(root, channel, "sergeant", { form: "puppet", release: "v2" })).toThrow(/no folder forms\/puppet\/v2/);
    expect(() => releaseForm(root, channel, "sergeant", { form: "puppet", release: "v1", entry: "missing.blend" })).toThrow(/entry file missing.blend is not in/);

    const { release, manifest } = releaseForm(root, channel, "sergeant", {
      form: "puppet", release: "v1", entry: "puppet.blend", madeWith: [{ tool: "Blender" }], licence: { id: "CC0-1.0", redistributable: true },
    });
    expect(release.tree).toEqual({ ...hashTree(folder), files: 2 });
    expect(release.entrySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.forms![0]!.current).toBe("v1");
    expect(() => releaseForm(root, channel, "sergeant", { form: "puppet", release: "v1" })).toThrow(/a release is never edited/);
    expect(verifyRelease(character("sergeant"), release).state).toBe("as-released");
  });

  it("records a release where a channel already kept it", () => {
    const old = join(character("sergeant"), "legacy-rig-v0");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "rig.blend"), "the first rig");
    const { release, manifest } = releaseForm(root, channel, "sergeant", { form: "puppet", release: "v0", path: "legacy-rig-v0", current: false });
    expect(release.path).toBe("legacy-rig-v0");
    expect(manifest.forms![0]!.current).toBe("v1");
    expect(() => releaseForm(root, channel, "sergeant", { form: "puppet", release: "v9", path: "../elsewhere" })).toThrow(/inside the character's own/);
  });

  it("casts a role in a series, pinned to the release the form has", () => {
    expect(readCast(root, series)).toEqual({ cast: null, exists: false, problems: [] });
    const { role } = castRole(root, series, { role: "sergeant", character: "sergeant", standing: "regular" });
    expect(role).toMatchObject({ character: "sergeant", form: "puppet", release: "v1", standing: "regular" });
    expect(role.treeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parse(readFileSync(join(root, "jokes", "series", "sketches", "cast.yaml"), "utf-8"))).toMatchObject({ kind: "Cast", roles: [role] });
    const [resolved] = resolveCast(root, series, { verify: true });
    expect(resolved).toMatchObject({ state: "ready", reason: 'Sergeant Hale as "puppet" v1', voice: "sergeant", owner: ["jokes"] });
    expect(() => castRole(root, series, { role: "ghost", character: "nobody" })).toThrow(/no character "nobody" in jokes\/sketches or jokes/);
    expect(() => castRole(root, series, { role: "sergeant", character: "sergeant", form: "statue" })).toThrow(/has no form "statue" \(it has: puppet, hum\)/);
  });

  it("lets the same character hold another role elsewhere, in another form, by its owner's path", () => {
    const film = { film: "tide" };
    expect(() => castRole(root, film, { role: "keeper", character: "sergeant" })).toThrow(/no character "sergeant" in tide/);
    const { role } = castRole(root, film, { role: "keeper", name: "The lighthouse keeper", character: "jokes/sergeant", form: "hum", voice: "keeper-low" });
    expect(role).toEqual({ role: "keeper", name: "The lighthouse keeper", character: "jokes/sergeant", form: "hum", voice: "keeper-low" });
    expect(resolveCast(root, film)[0]).toMatchObject({ state: "on-paper", voice: "keeper-low", owner: ["jokes"] });
  });

  it("finds a series' own character before the channel's of the same id", () => {
    createCharacter(root, ["jokes", "sketches"], { id: "sergeant", name: "Sergeant Hale, younger" });
    expect(resolveCast(root, series)[0]).toMatchObject({ owner: ["jokes", "sketches"], state: "broken" });
    rmSync(join(root, "jokes", "series", "sketches", "characters"), { recursive: true });
    expect(resolveCast(root, series)[0]).toMatchObject({ owner: ["jokes"], state: "ready" });
  });

  it("keeps a role on the release it was cast with when the character gets a newer one", () => {
    const folder = join(character("sergeant"), "forms", "puppet", "v2");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "puppet.blend"), "the rig, with a new cap");
    releaseForm(root, channel, "sergeant", { form: "puppet", release: "v2", entry: "puppet.blend" });
    expect(resolveCast(root, series)[0]).toMatchObject({ state: "behind", release: { id: "v1" } });
    expect(castRole(root, series, { role: "sergeant", character: "sergeant", standing: "regular" }).role.release).toBe("v2");
    expect(resolveCast(root, series)[0]).toMatchObject({ state: "ready", release: { id: "v2" } });
  });

  it("keeps what belongs to the part when the role is cast again, unless it is given anew", () => {
    castRole(root, series, { role: "sergeant", character: "sergeant", name: "The Sergeant", standing: "lead", voice: "gruff", note: "always late" });
    // Casting again is how a role takes a newer release: it names the role and the character, nothing else.
    expect(castRole(root, series, { role: "sergeant", character: "sergeant" }).role).toMatchObject({ name: "The Sergeant", standing: "lead", voice: "gruff", note: "always late" });
    expect(castRole(root, series, { role: "sergeant", character: "sergeant", standing: "guest" }).role).toMatchObject({ name: "The Sergeant", standing: "guest", voice: "gruff" });
    expect(readCast(root, series).cast?.roles).toHaveLength(1);
  });

  it("says when a released file changed, and when a script asks what the form cannot do", () => {
    expect(checkAsks(root, series, [{ role: "sergeant", actions: ["walk", "salute"], expressions: ["proud"] }])).toEqual([]);
    expect(checkAsks(root, series, [{ role: "sergeant", actions: ["cartwheel"] }, { role: "doctor", actions: ["nod"] }]).map((p) => [p.code, p.message])).toEqual([
      ["cannot-actions", '"sergeant" (Sergeant Hale, form "puppet") has no action "cartwheel": it has idle, walk, salute'],
      ["no-role", 'nobody is cast as "doctor"'],
    ]);

    writeFileSync(join(character("sergeant"), "forms", "puppet", "v2", "puppet.blend"), "the rig, edited in place");
    expect(codes(checkCharacter(root, channel, "sergeant").filter((p) => p.severity === "error"))).toEqual(["release-changed"]);
    expect(resolveCast(root, series)[0]!.state, "the records still agree").toBe("ready");
    expect(resolveCast(root, series, { verify: true })[0]).toMatchObject({ state: "broken", reason: 'the files of "puppet" v2 are not what was released' });
    expect(codes(checkCharacter(root, channel, "sergeant", { verify: false }).filter((p) => p.severity === "error"))).toEqual([]);
  });

  it("warns of a photograph that says nothing of whose likeness it is", () => {
    createCharacter(root, ["clinic"], { id: "doctor", name: "Dr. Reed" });
    updateCharacter(root, ["clinic"], "doctor", { form: { id: "portrait", medium: "photo" } });
    expect(codes(checkCharacter(root, ["clinic"], "doctor"))).toContain("likeness-unstated");
    updateCharacter(root, ["clinic"], "doctor", { likeness: { of: "A doctor who agreed", permission: "Signed release, 2026, for the channel's videos." } });
    expect(codes(checkCharacter(root, ["clinic"], "doctor"))).not.toContain("likeness-unstated");
  });

  it("takes a role away, and reads a cast or a character that is broken without throwing", () => {
    expect(uncastRole(root, series, "sergeant").roles).toEqual([]);
    expect(() => uncastRole(root, series, "sergeant")).toThrow(/has no role "sergeant"/);
    writeFileSync(join(root, "jokes", "series", "sketches", "cast.yaml"), "kind: Cast\nroles: nobody\n");
    expect(readCast(root, series).cast).toBeNull();
    expect(() => resolveCast(root, series)).toThrow(/cannot be read/);
    writeFileSync(join(character("sergeant"), "character.yaml"), "id: [not, a, slug\n");
    expect(readCharacter(root, channel, "sergeant")).toMatchObject({ manifest: null, exists: true, problems: [{ code: "yaml" }] });
    expect(listCharacters(root, channel)[0]).toMatchObject({ id: "sergeant", broken: true });
    expect(existsSync(join(character("sergeant"), "character.md"))).toBe(true);
  });
});
