// A style through the gateway: the templates listed, a film made in one, its
// palette changed by a person, and the change accepted for what read it.

import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFilmRoutes } from "../src/routes/films.js";
import { registerStyleRoutes, type RenewStyle } from "../src/routes/styles.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function gateway(renew?: RenewStyle) {
  const root = await mkdtemp(join(tmpdir(), "gw-styles-"));
  roots.push(root);
  await mkdir(join(root, "facts", "series", "odd", "episodes", "wombats"), { recursive: true });
  const app = Fastify();
  registerFilmRoutes(app, { root });
  registerStyleRoutes(app, { root, ...(renew ? { renew } : {}) });
  await app.ready();
  return { app, root };
}

describe("style routes", () => {
  it("lists the templates with their swatches", async () => {
    const { app } = await gateway();
    const styles = (await app.inject({ method: "GET", url: "/api/styles" })).json();
    const riso = styles.find((s: { id: string }) => s.id === "risograph");
    expect(riso).toMatchObject({ origin: "builtin", title: "Risograph print", problems: [] });
    expect(riso.swatches[0]).toEqual({ name: "Fluorescent pink", value: "#ff48b0" });
    expect((await app.inject({ method: "GET", url: "/api/styles/nothing-like-it" })).statusCode).toBe(404);
  });

  it("makes a film in a style, and a film with none", async () => {
    const { app, root } = await gateway();
    const made = await app.inject({ method: "POST", url: "/api/films", payload: { slug: "riso", title: "Riso", style: "Risograph" } });
    expect(made.statusCode).toBe(201);
    expect(made.json().style).toMatchObject({ id: "risograph" });
    expect(readFileSync(join(root, "riso", "film.yaml"), "utf-8")).toMatch(/id: hd-30/);
    const plain = await app.inject({ method: "POST", url: "/api/films", payload: { slug: "plain", title: "Plain" } });
    expect(plain.json().style).toBeNull();
    const none = (await app.inject({ method: "GET", url: "/api/style/plain/_" })).json();
    expect(none).toMatchObject({ level: "film", own: null, inherited: null });
  });

  it("changes a colour, checked, and renews what read the style", async () => {
    const renewed: string[] = [];
    const { app } = await gateway(async (unit) => {
      renewed.push(`${unit.channel}/${unit.series}/${unit.episode}`);
      return { affected: ["bible", "breakdown"] };
    });
    await app.inject({ method: "POST", url: "/api/films", payload: { slug: "tide", title: "Tide", style: "woodblock-print" } });
    await app.inject({ method: "POST", url: "/api/films/tide/scenes", payload: { slug: "010-storm", title: "Storm" } });
    const level = (await app.inject({ method: "GET", url: "/api/style/tide/010-storm" })).json();
    expect(level).toMatchObject({ level: "scene", own: null, inherited: { target: { project: "tide" } } });
    expect(level.inherited.dependents).toEqual(["tide/_/_", "tide/010-storm/_"]);

    const palette = level.inherited.params.palette;
    palette.colors[0].value = "#000000";
    const bad = await app.inject({ method: "PUT", url: "/api/style/tide/_/params/palette", payload: { doc: { ...palette, colors: [{ id: "x", name: "X", value: "black" }] } } });
    expect(bad.statusCode).toBe(422);
    const put = await app.inject({ method: "PUT", url: "/api/style/tide/_/params/palette", payload: { doc: palette } });
    expect(put.statusCode).toBe(200);
    expect(put.json().renewed).toEqual([
      { unit: "tide/_/_", affected: ["bible", "breakdown"] },
      { unit: "tide/010-storm/_", affected: ["bible", "breakdown"] },
    ]);
    expect(renewed).toHaveLength(2);
    const after = (await app.inject({ method: "GET", url: "/api/style/tide/_" })).json();
    expect(after.own.rendered).toContain("(#000000)");
  });

  it("applies a style to a channel's series, refuses a second, and keeps one as a template", async () => {
    const { app } = await gateway(async () => ({ affected: [] }));
    expect((await app.inject({ method: "POST", url: "/api/style/facts/odd", payload: { style: "chalkboard" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/style/facts/odd", payload: { style: "risograph" } })).statusCode).toBe(409);
    const saved = await app.inject({ method: "POST", url: "/api/styles", payload: { project: "facts", series: "odd", id: "odd-chalk", title: "Odd chalk" } });
    expect(saved.statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: "/api/styles/odd-chalk" })).json()).toMatchObject({ origin: "library", title: "Odd chalk" });
  });

  it("renews through the runtime by default: the film's bible and what follows it must be redone", async () => {
    const { app, root } = await gateway();
    await app.inject({ method: "POST", url: "/api/films", payload: { slug: "tide", title: "Tide", style: "risograph" } });
    const level = (await app.inject({ method: "GET", url: "/api/style/tide/_" })).json();
    level.own.params.palette.colors[0].value = "#ff0000";
    const put = (await app.inject({ method: "PUT", url: "/api/style/tide/_/params/palette", payload: { doc: level.own.params.palette } })).json();
    expect(put.failed).toEqual([]);
    expect(put.renewed[0].unit).toBe("tide/_/_");
    expect(put.renewed[0].affected).toEqual(expect.arrayContaining(["bible", "breakdown"]));
    expect(put.renewed[0].affected).not.toContain("screenplay");
    expect(readFileSync(join(root, "tide", "journal", "events.jsonl"), "utf-8")).toMatch(/"trigger":"pin:style"/);
  });
});
