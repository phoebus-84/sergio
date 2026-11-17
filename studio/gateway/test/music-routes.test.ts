// ---------------------------------------------------------------------------
// Music written as code, over HTTP (ADR-0053): the pieces of a workspace and
// what was rendered from them, a check, and a render — at an episode, and at
// a channel's source through `within`. On a bare Fastify, as the other route
// tests are. What needs a Chrome is skipped where there is none.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { musicReadiness } from "@studio/episode";
import { registerMusicRoutes } from "../src/routes/music.js";

const EPISODE = "/api/channels/canale/series/serie/episodes/uno";
const CHANNEL = "/api/channels/canale";
const PIECE = `setcpm(120/4)\nkick: s("sbd*4").gain(.8)\nbass: note("<c2 ab1>*2").s("sawtooth").lpf(500).decay(.2).sustain(.3).gain(.5)\n`;
const canRender = musicReadiness().available;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function studio(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "gw-music-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const app = Fastify();
  for (const [level, prefix] of [
    ["channel", "/api/channels/:channel"],
    ["series", "/api/channels/:channel/series/:series"],
    ["episode", "/api/channels/:channel/series/:series/episodes/:episode"],
  ] as const) registerMusicRoutes(app, { root, level, prefix });
  await app.ready();
  return { app, root };
}

const EPISODE_DIR = "canale/series/serie/episodes/uno";

describe("music routes", () => {
  it("lists the pieces of an episode, and of a channel's source through within", async () => {
    const { app } = await studio({
      [`${EPISODE_DIR}/music/tema.strudel`]: PIECE,
      "canale/sources/sigla/music/sigla.strudel": PIECE,
    });
    const episode = (await app.inject({ method: "GET", url: `${EPISODE}/music` })).json();
    expect(episode.pieces.map((p: { path: string }) => p.path)).toEqual(["music/tema.strudel"]);
    expect(episode.pieces[0].renders).toEqual([]);
    expect(episode.within).toBe("");
    expect(typeof episode.readiness.available).toBe("boolean");
    // The channel itself has no music/ of its own; its source has.
    expect((await app.inject({ method: "GET", url: `${CHANNEL}/music` })).json().pieces).toEqual([]);
    const source = (await app.inject({ method: "GET", url: `${CHANNEL}/music?within=sources/sigla` })).json();
    expect(source.pieces.map((p: { path: string }) => p.path)).toEqual(["music/sigla.strudel"]);
  });

  it("refuses a workspace that is not there, or outside the level", async () => {
    const { app } = await studio({ [`${EPISODE_DIR}/music/tema.strudel`]: PIECE });
    expect((await app.inject({ method: "GET", url: `${EPISODE}/music?within=../../../../altro` })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `${EPISODE}/music?within=nothing` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/channels/canale/series/serie/episodes/due/music" })).statusCode).toBe(404);
    const escaped = await app.inject({ method: "POST", url: `${EPISODE}/music/render`, payload: { within: "../..", path: "music/tema.strudel", cycles: 1 } });
    expect(escaped.statusCode).toBe(403);
  });

  it("answers a wrong request with what is wrong, before any browser is opened", async () => {
    const { app, root } = await studio({ [`${EPISODE_DIR}/music/tema.strudel`]: PIECE });
    const missing = await app.inject({ method: "POST", url: `${EPISODE}/music/render`, payload: { path: "music/altro.strudel", cycles: 1 } });
    expect([missing.statusCode, missing.json().error]).toEqual([404, "no-such-piece"]);
    const lengthless = await app.inject({ method: "POST", url: `${EPISODE}/music/render`, payload: { path: "music/tema.strudel" } });
    expect([lengthless.statusCode, lengthless.json().error]).toEqual([400, "bad-request"]);
    const outside = await app.inject({ method: "POST", url: `${EPISODE}/music/render`, payload: { path: "music/tema.strudel", cycles: 1, output: "output/tema.wav" } });
    expect(outside.statusCode).toBe(400);
    const neither = await app.inject({ method: "POST", url: `${EPISODE}/music/check`, payload: {} });
    expect(neither.statusCode).toBe(400);
    expect(existsSync(join(root, EPISODE_DIR, "assets"))).toBe(false);
  });

  it.skipIf(!canRender)("checks a piece, renders it, and then lists the render", { timeout: 120_000 }, async () => {
    const { app, root } = await studio({ [`${EPISODE_DIR}/music/tema.strudel`]: PIECE, "canale/sources/sigla/music/sigla.strudel": PIECE });
    const checked = await app.inject({ method: "POST", url: `${EPISODE}/music/check`, payload: { path: "music/tema.strudel", cycles: 2 } });
    expect(checked.statusCode).toBe(200);
    expect(checked.json().inspection.parts.map((p: { name: string; events: number }) => [p.name, p.events])).toEqual([["kick", 8], ["bass", 4]]);
    const tried = await app.inject({ method: "POST", url: `${EPISODE}/music/check`, payload: { code: `x: s("hh")` } });
    expect(tried.json().inspection.ok).toBe(false);

    const made = await app.inject({ method: "POST", url: `${EPISODE}/music/render`, payload: { path: "music/tema.strudel", cycles: 2, tail: 1, stems: true } });
    expect(made.statusCode, made.body).toBe(200);
    expect(made.json().recordPath).toBe("assets/sounds/tema.wav.music.json");
    expect(made.json().record.stems.map((s: { part: string }) => s.part)).toEqual(["kick", "bass"]);
    for (const file of ["tema.wav", "tema.kick.wav", "tema.bass.wav", "tema.wav.music.json"]) expect(existsSync(join(root, EPISODE_DIR, "assets/sounds", file)), file).toBe(true);

    const listed = (await app.inject({ method: "GET", url: `${EPISODE}/music` })).json();
    expect(listed.pieces[0].renders.map((r: { recordPath: string; current: boolean; missing: boolean }) => [r.recordPath, r.current, r.missing])).toEqual([
      ["assets/sounds/tema.wav.music.json", true, false],
    ]);

    // In a channel's source: the file lands in the source, not in the channel.
    const inSource = await app.inject({ method: "POST", url: `${CHANNEL}/music/render`, payload: { within: "sources/sigla", path: "music/sigla.strudel", seconds: 2, loop: true } });
    expect(inSource.statusCode, inSource.body).toBe(200);
    expect(existsSync(join(root, "canale/sources/sigla/assets/sounds/sigla.wav"))).toBe(true);

    const broken = await app.inject({ method: "POST", url: `${EPISODE}/music/render`, payload: { path: "music/tema.strudel", cycles: 1, only: ["snare"] } });
    expect([broken.statusCode, broken.json().error]).toEqual([400, "bad-request"]);
  });

  it.skipIf(!canRender)("refuses a second render of a workspace while one runs", { timeout: 120_000 }, async () => {
    const { app } = await studio({ [`${EPISODE_DIR}/music/tema.strudel`]: PIECE });
    const payload = { path: "music/tema.strudel", cycles: 4 };
    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url: `${EPISODE}/music/render`, payload }),
      app.inject({ method: "POST", url: `${EPISODE}/music/render`, payload }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
  });
});
