// A film made in a style through the agent's tools: the template found by the
// name a person gives it, applied at creation, read as a brief by a shot, a
// colour changed, and the edited style kept as a template of its own.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerStyleTools } from "../src/style-tools.js";
import { registerFilmTools } from "../src/film-tools.js";

let root: string;
const saved = { library: process.env.AVG_LIBRARY_ROOT, gateway: process.env.AVG_GATEWAY_URL };
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "style-tools-"));
  process.env.AVG_LIBRARY_ROOT = root;
  // Nothing listens here: the renewal must say so rather than pretend.
  process.env.AVG_GATEWAY_URL = "http://127.0.0.1:9";
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of [["AVG_LIBRARY_ROOT", saved.library], ["AVG_GATEWAY_URL", saved.gateway]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function tools() {
  const registered = new Map<string, any>();
  const pi = { registerTool: (t: { name: string }) => registered.set(t.name, t) } as never;
  registerStyleTools(pi);
  registerFilmTools(pi);
  return Object.assign(
    async (name: string, params: Record<string, unknown>) => {
      const result = await registered.get(name)!.execute("call", params);
      return { ...result, text: result.content[0].text as string };
    },
    { names: () => [...registered.keys()].filter((n) => n.includes("styl")).sort() },
  );
}

describe("style tools", () => {
  const run = tools();

  it("registers five tools", () => {
    expect(run.names()).toEqual(["pva_apply_style", "pva_save_style", "pva_set_style", "pva_style", "pva_styles"]);
  });

  it("lists the templates, and shows one by the words a person uses", async () => {
    expect((await run("pva_styles", {})).text).toMatch(/style template\(s\):[\s\S]*risograph/);
    const shown = await run("pva_styles", { name: "Woodblock" });
    expect(shown.text).toContain("woodblock-print");
    expect(shown.text).toContain("params/palette.json");
    expect(shown.text).toContain("{{palette}}");
  });

  it("makes a film in a style: its format, its style/, and a brief for every shot", async () => {
    const made = await run("pva_create_film", { slug: "tide", title: "Tide", logline: "Three boats ride out a storm.", style: "woodblock print" });
    expect(made.isError).toBeUndefined();
    expect(made.text).toContain('now reads "Animated woodblock print"');
    expect(readFileSync(join(root, "tide", "film.yaml"), "utf-8")).toMatch(/id: hd-30/);
    await run("pva_create_scene", { film: "tide", slug: "010-storm", title: "Storm", summary: "The wave." });
    const shot = await run("pva_create_shot", { film: "tide", scene: "010-storm", slug: "010-wide", title: "Wide", source: "graphics", description: "The whole sea." });
    expect(shot.text).toMatch(/Reads tide's style \(pin pinned\)/);

    const brief = await run("pva_style", { channel: "tide", series: "010-storm", episode: "010-wide" });
    expect(brief.text).toContain("The whole sea.");
    expect(brief.text).toContain("Prussian blue (#1d3b5a)");
    expect(brief.text).not.toMatch(/\{\{/);
  });

  it("a film made with no style reads none, and that is fine", async () => {
    await run("pva_create_film", { slug: "plain", title: "Plain" });
    expect((await run("pva_style", { channel: "plain" })).text).toMatch(/reads no style\. That is fine/);
  });

  it("changes a colour, checked, and says what it makes stale", async () => {
    const bad = await run("pva_set_style", { channel: "tide", param: "palette", set: { accent: "red" } });
    expect(bad.isError).toBe(true);
    const changed = await run("pva_set_style", { channel: "tide", param: "palette", set: { accent: "#ff0000" } });
    expect(changed.isError).toBeUndefined();
    expect(changed.text).toMatch(/3 unit\(s\) read this style and now show it changed/);
    expect((await run("pva_style", { channel: "tide" })).text).toContain("#ff0000");
  });

  it("keeps the edited style as a template anyone can name", async () => {
    const kept = await run("pva_save_style", { channel: "tide", id: "tide-print", title: "Tide print" });
    expect(kept.text).toContain("_styles");
    expect((await run("pva_styles", { name: "Tide print" })).text).toContain("#ff0000");
  });
});
