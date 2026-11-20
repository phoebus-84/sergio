import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyPin, type SourcePin } from "@studio/contracts/src/source-pins.mjs";
import { setParamValue, type PaletteParams } from "@studio/contracts/src/style.mjs";
import {
  StyleError, applyStyle, dependentsOf, findStyle, listStyles, readStylePin, readTargetStyle, resolveUnitStyle, saveStyleAsTemplate,
  styleDirOf, syncStylePin, unitsUnder, writeStyleBrief, writeStyleParams,
} from "../src/index.js";

let root: string;

const write = (path: string, text: string) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
};

/** A film with one scene of two shots, and a channel with one series of one episode. */
function library() {
  write("tide/film.yaml", "apiVersion: studio.video/v1alpha1\nkind: Film\nslug: tide\ntitle: Tide\nlogline: A storm at sea, three boats ride it out.\n");
  write("tide/scenes/010-storm/scene.yaml", "apiVersion: studio.video/v1alpha1\nkind: Scene\nslug: 010-storm\ntitle: Storm\nsummary: The wave rises and falls.\nshots: [010-wide, 020-boat]\n");
  write("tide/scenes/010-storm/shots/010-wide/shot.yaml", "apiVersion: studio.video/v1alpha1\nkind: Shot\nslug: 010-wide\ntitle: Wide\nsource: graphics\ndescription: The whole sea.\n");
  write("tide/scenes/010-storm/shots/020-boat/shot.yaml", "apiVersion: studio.video/v1alpha1\nkind: Shot\nslug: 020-boat\ntitle: Boat\nsource: graphics\n");
  write("facts/channel.json", JSON.stringify({ slug: "facts", title: "Facts" }));
  write("facts/series/odd/.workspace/metadata.json", JSON.stringify({ title: "Odd facts", description: "One odd fact a week." }));
  write("facts/series/odd/episodes/wombats/.workspace/metadata.json", JSON.stringify({ title: "Wombats", description: "Wombats leave cube-shaped droppings." }));
}

const verify = async (unit: { channel: string; series: string; episode: string }) => {
  const pin = readStylePin(root, unit) as SourcePin;
  const target = pin.source.kind === "style" && pin.source.series ? { project: unit.channel, series: pin.source.series } : { project: unit.channel };
  return (await verifyPin(pin, styleDirOf(root, target))).changed;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "style-"));
  library();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the catalog", () => {
  it("ships templates that hold, each with swatches", () => {
    const all = listStyles(root);
    expect(all.length).toBeGreaterThanOrEqual(9);
    for (const style of all) {
      expect(style.problems, style.id).toEqual([]);
      expect(style.origin).toBe("builtin");
      expect(style.swatches.length, style.id).toBeGreaterThan(1);
    }
  });

  it("finds a template by the name a person gives it", () => {
    expect(findStyle(root, "risograph").id).toBe("risograph");
    expect(findStyle(root, "Risograph print").id).toBe("risograph");
    expect(findStyle(root, "woodblock").id).toBe("woodblock-print");
    expect(() => findStyle(root, "explainer")).toThrow(/could be any of/);
    expect(() => findStyle(root, "baroque opera")).toThrow(StyleError);
  });

  it("lets the library's own template shadow a built-in one", () => {
    const builtin = findStyle(root, "risograph").path;
    const copy = join(root, "_styles", "risograph");
    mkdirSync(copy, { recursive: true });
    for (const name of ["style.json", "STYLE.md"]) writeFileSync(join(copy, name), readFileSync(join(builtin, name)));
    mkdirSync(join(copy, "params"));
    for (const name of readdirSync(join(builtin, "params"))) writeFileSync(join(copy, "params", name), readFileSync(join(builtin, "params", name)));
    const found = findStyle(root, "risograph");
    expect(found.origin).toBe("library");
    expect(found.shadows).toEqual(["builtin"]);
  });
});

describe("applying a style", () => {
  it("scaffolds the film's style/, pins it for every unit, and writes the brief for each", async () => {
    const result = await applyStyle(root, { project: "tide" }, { style: "Animated woodblock print" });
    expect(result.level).toBe("film");
    expect(result.scaffold.filmFormat).toBe("hd-30");
    expect(result.problems).toEqual([]);
    expect(result.units.map((u) => u.outcome)).toEqual(["pinned", "pinned", "pinned", "pinned"]);
    expect(existsSync(join(root, "tide/style/params/palette.json"))).toBe(true);
    expect(readFileSync(join(root, "tide/style/style.yaml"), "utf-8")).toMatch(/id: woodblock-print/);

    const shot = resolveUnitStyle(root, { channel: "tide", series: "010-storm", episode: "010-wide" })!;
    expect(shot.rendered).not.toMatch(/\{\{/);
    expect(shot.rendered).toMatch(/The whole sea\./);
    expect(shot.rendered).toMatch(/Prussian blue \(#1d3b5a\)/);
    expect(shot.readers).toEqual(["plan", "media"]);
    expect(readStylePin(root, { channel: "tide", series: "_", episode: "_" })?.usedBy).toEqual(["bible"]);
  });

  it("is optional: a unit with no style reads none and keeps no pin", async () => {
    expect(resolveUnitStyle(root, { channel: "tide", series: "_", episode: "_" })).toBeNull();
    expect((await syncStylePin(root, { channel: "tide", series: "_", episode: "_" })).outcome).toBe("unstyled");
    expect(readStylePin(root, { channel: "tide", series: "_", episode: "_" })).toBeNull();
  });

  it("refuses to overwrite a style, and sets the old one aside when asked to replace it", async () => {
    await applyStyle(root, { project: "tide" }, { style: "risograph" });
    await expect(applyStyle(root, { project: "tide" }, { style: "cut-paper" })).rejects.toThrow(/already has risograph/);
    const replaced = await applyStyle(root, { project: "tide" }, { style: "cut-paper", replace: true });
    expect(replaced.replaced).toMatch(/\.style-history/);
    expect(readTargetStyle(root, { project: "tide" })?.binding?.template.id).toBe("cut-paper");
    // The units read another style now: their pins still hold what they read, so they are stale.
    expect((await verify({ channel: "tide", series: "010-storm", episode: "020-boat" })).length).toBeGreaterThan(0);
  });

  it("refuses a level the template is not made for", async () => {
    const dir = join(root, "_styles", "only-films");
    mkdirSync(join(dir, "params"), { recursive: true });
    writeFileSync(join(dir, "style.json"), JSON.stringify({
      apiVersion: "studio.video/v1alpha1", kind: "StyleTemplate", id: "only-films", version: "1.0.0", title: "Only films", summary: "For films.", levels: ["film"], parameters: [],
    }));
    writeFileSync(join(dir, "STYLE.md"), "Just a film.\n");
    await expect(applyStyle(root, { project: "facts", series: "odd" }, { style: "only-films" })).rejects.toThrow(/made for film, not a series/);
  });

  it("works on a channel's series and its episodes the same way", async () => {
    const result = await applyStyle(root, { project: "facts", series: "odd" }, { style: "chalkboard" });
    expect(result.level).toBe("series");
    expect(result.units).toHaveLength(1);
    const episode = resolveUnitStyle(root, { channel: "facts", series: "odd", episode: "wombats" })!;
    expect(episode.rendered).toMatch(/Wombats leave cube-shaped droppings\./);
    expect(unitsUnder(root, { project: "facts" })).toEqual([{ channel: "facts", series: "odd", episode: "wombats" }]);
  });
});

describe("changing a parameter", () => {
  it("makes everything that read the style see it changed", async () => {
    await applyStyle(root, { project: "tide" }, { style: "woodblock-print" });
    const palette = readTargetStyle(root, { project: "tide" })!.folder.params.palette as PaletteParams;
    const { doc, problems } = setParamValue(palette, "accent", "#ff0000");
    expect(problems).toEqual([]);
    const change = writeStyleParams(root, { project: "tide" }, "palette", doc);
    expect(change.dependents).toHaveLength(4);
    for (const unit of change.dependents) expect(await verify(unit)).toEqual([{ path: "params/palette.json", change: "modified" }]);
    expect(resolveUnitStyle(root, { channel: "tide", series: "_", episode: "_" })!.rendered).toMatch(/\(#ff0000\)/);
  });

  it("refuses a value that does not hold, and a brief that names nothing", async () => {
    await applyStyle(root, { project: "tide" }, { style: "risograph" });
    expect(() => writeStyleParams(root, { project: "tide" }, "palette", { kind: "palette", title: "Inks", colors: [{ id: "a", name: "A", value: "red" }] })).toThrow(/cannot be written/);
    expect(() => writeStyleParams(root, { project: "tide" }, "nope", { kind: "palette", title: "P", colors: [{ id: "a", name: "A", value: "#000000" }] })).toThrow(/no parameter file/);
    expect(() => writeStyleBrief(root, { project: "tide" }, "In {{palette.gold}}")).toThrow(/cannot say that/);
    expect(writeStyleBrief(root, { project: "tide" }, "In {{palette}}").dependents).toHaveLength(4);
  });

  it("a scene that copies its film's style is read by the scene's units from then on", async () => {
    await applyStyle(root, { project: "tide" }, { style: "woodblock-print" });
    const scene = await applyStyle(root, { project: "tide", series: "010-storm" }, { fromParent: true, note: "night" });
    expect(scene.units.map((u) => u.outcome)).toEqual(["moved", "moved", "moved"]);
    expect(readTargetStyle(root, { project: "tide", series: "010-storm" })?.binding?.copiedFrom).toBe("tide");
    expect(dependentsOf(root, { project: "tide" })).toEqual([{ channel: "tide", series: "_", episode: "_" }]);
    expect(dependentsOf(root, { project: "tide", series: "010-storm" })).toHaveLength(3);
    // A copy is identical, so nothing the scene's units read has changed yet.
    expect(await verify({ channel: "tide", series: "010-storm", episode: "010-wide" })).toEqual([]);
  });
});

describe("keeping a style as a template", () => {
  it("saves a level's edited style under a new name, without the binding", async () => {
    await applyStyle(root, { project: "tide" }, { style: "risograph" });
    const saved = saveStyleAsTemplate(root, { project: "tide" }, { id: "tide-riso", title: "Tide riso" });
    expect(saved.origin).toBe("library");
    expect(existsSync(join(saved.path, "style.yaml"))).toBe(false);
    const found = findStyle(root, "Tide riso");
    expect(found.origin).toBe("library");
    expect(found.problems).toEqual([]);
    expect(() => saveStyleAsTemplate(root, { project: "tide" }, { id: "tide-riso" })).toThrow(/already a template/);
  });
});
