// A cast made through the agent's tools: a character on paper, a form, a
// release, a role in a series and in a film, and a script checked against it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerCharacterTools } from "../src/character-tools.js";

let root: string;
const previous = process.env.AVG_LIBRARY_ROOT;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "character-tools-"));
  process.env.AVG_LIBRARY_ROOT = root;
  mkdirSync(join(root, "jokes", "series", "sketches", "episodes"), { recursive: true });
  mkdirSync(join(root, "tide"), { recursive: true });
  writeFileSync(join(root, "tide", "film.yaml"), "apiVersion: studio.video/v1alpha1\nkind: Film\nslug: tide\ntitle: Tide\n");
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  if (previous === undefined) delete process.env.AVG_LIBRARY_ROOT;
  else process.env.AVG_LIBRARY_ROOT = previous;
});

function tools() {
  const registered = new Map<string, any>();
  registerCharacterTools({ registerTool: (t: { name: string }) => registered.set(t.name, t) } as never);
  return Object.assign(
    async (name: string, params: Record<string, unknown>) => {
      const result = await registered.get(name)!.execute("call", params);
      return { ...result, text: result.content[0].text as string };
    },
    { names: () => [...registered.keys()].sort(), get: (name: string) => registered.get(name) },
  );
}

describe("character tools", () => {
  const run = tools();

  it("registers four tools, and the form tool names every medium", () => {
    expect(run.names()).toEqual(["pva_cast", "pva_characters", "pva_create_character", "pva_update_character"]);
    for (const medium of ["rig-3d", "puppet-2d", "sprites", "vector", "photo", "graphic", "sound", "voice", "other"]) {
      expect(run.get("pva_update_character").description).toContain(medium);
    }
  });

  it("makes a character on paper, and makes nothing twice", async () => {
    expect((await run("pva_characters", { owner: "jokes" })).text).toMatch(/no character yet/);
    const made = await run("pva_create_character", {
      owner: "jokes", id: "sergeant", name: "Sergeant Hale", nature: "a person", summary: "A kind, literal man.", voiceProfile: "sergeant",
      identity: "Short and sturdy.", performance: "Never explains the joke.",
    });
    expect(made.isError).toBeUndefined();
    expect(made.text).toContain("Sergeant Hale (jokes/sergeant) — on paper: no form yet");
    expect(made.text).toContain("wrote character.yaml, character.md, backstory.md, performance.md");
    expect((await run("pva_create_character", { owner: "jokes", id: "sergeant", name: "Another" })).text).toMatch(/already there: nothing was changed/);
    expect((await run("pva_create_character", { owner: "nowhere", id: "x", name: "X" })).isError).toBe(true);
    const shown = await run("pva_characters", { owner: "jokes", id: "sergeant" });
    expect(shown.text).toContain("voice: sergeant");
    expect(shown.text).toContain("forms: none yet. It exists on paper");
    expect(shown.text).toContain("⚠️ no-form");
  });

  it("gives it a form that says what it can do, and records a release of it", async () => {
    const formed = await run("pva_update_character", {
      owner: "jokes", id: "sergeant", status: "ready",
      form: { id: "puppet", medium: "puppet-2d", can: { actions: ["idle", "walk", "salute"], expressions: ["neutral", "proud"] } },
    });
    expect(formed.text).toContain("▸ puppet — puppet-2d · 0 release(s), none current");
    expect(formed.text).toContain("actions: idle, walk, salute · expressions: neutral, proud");
    expect((await run("pva_update_character", { owner: "jokes", id: "sergeant", release: { form: "puppet", release: "v1" } })).text).toMatch(/no-release-folder: there is no folder forms\/puppet\/v1/);

    const folder = join(root, "jokes", "characters", "sergeant", "forms", "puppet", "v1");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "puppet.blend"), "the rig");
    const released = await run("pva_update_character", {
      owner: "jokes", id: "sergeant", defaultForm: "puppet",
      release: { form: "puppet", release: "v1", entry: "puppet.blend", madeWith: [{ tool: "Blender" }], licence: { id: "CC0-1.0", redistributable: true } },
    });
    expect(released.isError).toBeUndefined();
    expect(released.text).toMatch(/record changed; release v1 of "puppet" recorded: 1 file\(s\), 0\.0 MB, tree [0-9a-f]{12}…/);
    expect(released.text).toContain("▸ puppet (default) — puppet-2d · release v1 in forms/puppet/v1, open puppet.blend");
    expect((await run("pva_update_character", { owner: "jokes", id: "sergeant", release: { form: "puppet", release: "v1" } })).text).toMatch(/release-exists/);
    expect((await run("pva_update_character", { owner: "jokes", id: "sergeant" })).text).toMatch(/nothing to change/);
    expect((await run("pva_characters", { owner: "jokes" })).text).toBe(
      "Characters of jokes:\n● sergeant — Sergeant Hale, a person: A kind, literal man. · puppet (puppet-2d, v1) · voice sergeant",
    );
  });

  it("casts a series and a film, and checks what a script asks", async () => {
    expect((await run("pva_cast", { channel: "jokes", series: "sketches" })).text).toMatch(/has no cast yet/);
    expect((await run("pva_cast", { channel: "jokes" })).text).toMatch(/give one or the other/);
    const cast = await run("pva_cast", { channel: "jokes", series: "sketches", role: "sergeant", character: "sergeant", standing: "regular" });
    expect(cast.isError).toBeUndefined();
    expect(cast.text).toContain('✅ "sergeant" is sergeant as "puppet", pinned to v1');
    expect(cast.text).toContain('● sergeant — Sergeant Hale · regular · ready: Sergeant Hale as "puppet" v1');
    expect(cast.text).toContain("voice: sergeant");

    const film = await run("pva_cast", { film: "tide", role: "keeper", name: "The keeper", character: "jokes/sergeant", voice: "keeper-low" });
    expect(film.text).toContain('● keeper "The keeper" — Sergeant Hale (of jokes) · ready');
    expect(film.text).toContain("voice: keeper-low");

    const asked = await run("pva_cast", { channel: "jokes", series: "sketches", asks: [{ role: "sergeant", actions: ["salute", "cartwheel"] }, { role: "doctor" }] });
    expect(asked.isError).toBe(true);
    expect(asked.text).toContain('"sergeant" (Sergeant Hale, form "puppet") has no action "cartwheel": it has idle, walk, salute');
    expect(asked.text).toContain('nobody is cast as "doctor"');
    expect((await run("pva_cast", { channel: "jokes", series: "sketches", asks: [{ role: "sergeant", actions: ["salute"] }] })).text).toContain("✅ the cast can do everything asked");

    expect((await run("pva_cast", { channel: "jokes", series: "sketches", role: "sergeant", remove: true })).text).toContain("no longer in the cast");
    expect((await run("pva_cast", { channel: "jokes", series: "sketches", role: "ghost", character: "nobody" })).text).toMatch(/no-character/);
  });
});
