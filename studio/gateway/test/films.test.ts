// A film through the gateway: listed beside the channels, read as a tree,
// its cut edited by a person, shown at a frame and rendered.

import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleCut, createFilm, createScene, createShot, editCut, filmUnit, sceneUnit, shotUnit } from "@studio/film";
import { EventBus, type GatewayEvent } from "../src/events/bus.js";
import { registerFilmRoutes } from "../src/routes/films.js";
import { FileSystemWorkspaceService } from "../src/workspace/filesystem-service.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function film() {
  const root = await mkdtemp(join(tmpdir(), "gw-films-"));
  roots.push(root);
  createFilm(root, { slug: "tide", title: "Tide", logline: "A keeper counts the waves.", format: { id: "tiny-24", width: 160, height: 90, fps: 24 } });
  createScene(root, { film: "tide", slug: "020-lamp", title: "The lamp", sequence: "night", act: "I" });
  createScene(root, { film: "tide", slug: "010-shore", title: "The shore", sequence: "dusk" });
  createShot(root, { film: "tide", scene: "010-shore", slug: "020-wave", title: "A wave", source: "footage" });
  createShot(root, { film: "tide", scene: "010-shore", slug: "010-sky", title: "The sky", source: "generated" });
  await mkdir(join(root, "lessons", "series", "poems", "episodes", "ep01"), { recursive: true });
  const events: GatewayEvent[] = [];
  const bus = new EventBus();
  bus.subscribe({ send: (event) => events.push(event), close: () => undefined, isAlive: () => true });
  const app = Fastify();
  registerFilmRoutes(app, { root, bus });
  await app.ready();
  return { app, root, events };
}

describe("a film in the library listing", () => {
  it("is listed beside the channels, its scenes in running order and its shots in cutting order", async () => {
    const { root } = await film();
    const workspace = new FileSystemWorkspaceService([root]);
    expect(await workspace.listChannels()).toEqual([
      { slug: "lessons", title: "Lessons", seriesCount: 1, kind: "channel" },
      { slug: "tide", title: "Tide", seriesCount: 2, kind: "film" },
    ]);
    expect(await workspace.listSeries("tide")).toEqual([
      { slug: "020-lamp", title: "The lamp", episodeCount: 0, sequence: "night", act: "I" },
      { slug: "010-shore", title: "The shore", episodeCount: 2, sequence: "dusk", act: null },
    ]);
    const shots = await workspace.listEpisodes("tide", "010-shore");
    expect(shots.map((shot) => [shot.slug, shot.title, shot.status, shot.pipeline])).toEqual([
      ["010-sky", "The sky", "idle", "film-shot"],
      ["020-wave", "A wave", "idle", "film-shot"],
    ]);
  });

  it("describes each of a film's units by its cut and render, and names each level's pipeline", async () => {
    const { root } = await film();
    const workspace = new FileSystemWorkspaceService([root]);
    editCut(root, shotUnit("tide", "010-shore", "010-sky"), [{ op: "add-clip", track: "v1", clip: { id: "c", source: { color: "#203050" }, duration: 12 } }]);
    await assembleCut(root, sceneUnit("tide", "010-shore"));
    expect(await workspace.getEpisode("tide", "010-shore", "010-sky")).toMatchObject({ title: "The sky", status: "running", pipeline: "film-shot", scenes: [], render: null });
    expect(await workspace.getEpisode("tide", "010-shore", "_")).toMatchObject({ title: "The shore", status: "blocked", pipeline: "film-scene", blocked: true });
    expect(await workspace.getEpisode("tide", "_", "_")).toMatchObject({ title: "Tide", status: "idle", pipeline: "film-project" });
    expect(await workspace.getEpisode("tide", "010-shore", "nowhere")).toBeNull();
  });
});

describe("film routes", () => {
  it("serves the films, the formats and the effects", async () => {
    const { app } = await film();
    expect((await app.inject({ method: "GET", url: "/api/films" })).json()).toEqual([
      { slug: "tide", title: "Tide", logline: "A keeper counts the waves.", format: { id: "tiny-24", width: 160, height: 90, fps: 24 } },
    ]);
    expect((await app.inject({ method: "GET", url: "/api/film-formats" })).json().map((f: { id: string }) => f.id)).toContain("scope-24");
    const effects = (await app.inject({ method: "GET", url: "/api/cut-effects" })).json();
    expect(effects.find((e: { type: string }) => e.type === "exposure")).toMatchObject({ domain: "video", params: { stops: { kind: "number", min: -3, max: 3 } } });
    await app.close();
  });

  it("serves the film as a tree in running order, with where each unit stands and what is next", async () => {
    const { app } = await film();
    const tree = (await app.inject({ method: "GET", url: "/api/films/tide/tree" })).json();
    expect(tree).toMatchObject({ slug: "tide", key: "tide/_/_", url: "/library/tide", rendering: null, totals: { scenes: 2, shots: 2 } });
    expect(tree.scenes.map((s: { slug: string; sequence: string; url: string }) => [s.slug, s.sequence, s.url])).toEqual([
      ["020-lamp", "night", "/library/tide/scenes/020-lamp"],
      ["010-shore", "dusk", "/library/tide/scenes/010-shore"],
    ]);
    expect(tree.scenes[1].shots.map((s: { key: string; status: { state: string } }) => [s.key, s.status.state])).toEqual([
      ["tide/010-shore/010-sky", "no-cut"], ["tide/010-shore/020-wave", "no-cut"],
    ]);
    expect(tree.next[0]).toMatchObject({ unit: "tide/020-lamp/_", state: "no-cut" });
    expect((await app.inject({ method: "GET", url: "/api/films/nothing/tree" })).statusCode).toBe(404);
    await app.close();
  });

  it("makes scenes and shots, refusing what cannot be one", async () => {
    const { app, root } = await film();
    const scene = await app.inject({ method: "POST", url: "/api/films/tide/scenes", payload: { slug: "030-dawn", title: "Dawn", sequence: "dusk" } });
    expect(scene.statusCode).toBe(201);
    const shot = await app.inject({ method: "POST", url: "/api/films/tide/scenes/030-dawn/shots", payload: { slug: "010-sun", title: "The sun", source: "stock" } });
    expect(shot.statusCode).toBe(201);
    expect(existsSync(join(root, "tide/scenes/030-dawn/shots/010-sun/shot.yaml"))).toBe(true);
    expect((await app.inject({ method: "POST", url: "/api/films/tide/scenes/030-dawn/shots", payload: { slug: "Bad Slug", title: "x", source: "stock" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/films", payload: { slug: "lessons", title: "Lessons" } })).json().error).toBe("name-taken");
    await app.close();
  });

  it("changes a manifest through its contract, and an order", async () => {
    const { app } = await film();
    const url = "/api/films/tide/units/010-shore/010-sky/manifest";
    expect((await app.inject({ method: "GET", url })).json()).toMatchObject({ level: "shot", manifest: { title: "The sky", source: "generated" }, problems: [] });
    const changed = await app.inject({ method: "PUT", url, payload: { set: { size: "wide", durationSeconds: 2.5, notes: null } } });
    expect(changed.json().manifest).toMatchObject({ size: "wide", durationSeconds: 2.5 });
    const refused = await app.inject({ method: "PUT", url, payload: { set: { size: "enormous" } } });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().problems[0]).toMatchObject({ code: "enum", path: "$.size" });
    expect((await app.inject({ method: "PUT", url, payload: { set: { slug: "other" } } })).statusCode).toBe(400);
    const ordered = await app.inject({ method: "PUT", url: "/api/films/tide/units/010-shore/_/manifest", payload: { order: ["020-wave", "010-sky"] } });
    expect(ordered.json().manifest.shots).toEqual(["020-wave", "010-sky"]);
    await app.close();
  });

  it("writes a person's edit of a cut only on the revision it was made on", async () => {
    const { app, events } = await film();
    const url = "/api/films/tide/units/010-shore/010-sky/cut";
    expect((await app.inject({ method: "GET", url })).json()).toMatchObject({ exists: false, cut: null, status: { state: "no-cut" } });
    const first = await app.inject({ method: "PUT", url, payload: { expectedRevision: 0, ops: [
      { op: "add-clip", track: "v1", clip: { id: "c", source: { color: "#203050" }, duration: 24, locked: true } },
    ] } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ cut: { revision: 1 }, status: { state: "not-rendered" } });
    expect(events.at(-1)).toMatchObject({ type: "cut.changed", episodeSlug: "tide/010-shore/010-sky", data: { by: "person" } });

    const cut = first.json().cut;
    cut.tracks[0].clips[0].duration = 48;
    expect((await app.inject({ method: "PUT", url, payload: { cut, expectedRevision: 1 } })).json().cut).toMatchObject({ revision: 2 });
    expect((await app.inject({ method: "PUT", url, payload: { cut, expectedRevision: 1 } })).statusCode).toBe(409);
    expect((await app.inject({ method: "PUT", url, payload: { cut } })).statusCode).toBe(400);
    cut.tracks[0].clips[0].duration = 0;
    const invalid = await app.inject({ method: "PUT", url, payload: { cut, expectedRevision: 2 } });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().problems[0].path).toBe("$.tracks[0].clips[0].duration");

    const assembled = await app.inject({ method: "POST", url: "/api/films/tide/units/010-shore/_/cut/assemble", payload: {} });
    expect(assembled.json().notes).toEqual(["010-sky: added, 48 frames (its cut)", "020-wave: added, 48 frames (a placeholder: it has no cut yet)"]);
    const check = (await app.inject({ method: "GET", url: "/api/films/tide/units/010-shore/_/cut/check" })).json();
    expect(check.problems.map((p: { code: string }) => p.code)).toEqual(["unit-not-rendered", "unit-not-rendered"]);
    await app.close();
  });

  it.skipIf(!hasFfmpeg)("shows a frame of a cut, renders it once at a time, and says when it is done", async () => {
    const { app, root, events } = await film();
    editCut(root, shotUnit("tide", "010-shore", "010-sky"), [{ op: "add-clip", track: "v1", clip: { id: "c", source: { color: "#203050" }, duration: 12 } }]);
    editCut(root, shotUnit("tide", "010-shore", "020-wave"), [{ op: "add-clip", track: "v1", clip: { id: "c", source: { color: "#305020" }, duration: 12 } }]);
    await assembleCut(root, sceneUnit("tide", "010-shore"));
    editCut(root, filmUnit("tide"), [{ op: "add-clip", track: "v1", clip: { id: "010-shore", source: { unit: "010-shore" }, duration: 24 } }]);

    const frame = await app.inject({ method: "POST", url: "/api/films/tide/units/010-shore/010-sky/cut/frame", payload: { frame: 3, width: 160 } });
    expect(frame.json()).toMatchObject({ frame: 3, url: "/library/tide/scenes/010-shore/shots/010-sky/artifacts/frames/frame-000003-r1.jpg" });

    expect((await app.inject({ method: "POST", url: "/api/films/tide/units/020-lamp/_/cut/render", payload: {} })).statusCode).toBe(409);
    const started = await app.inject({ method: "POST", url: "/api/films/tide/units/_/_/cut/render", payload: { quality: "final" } });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toMatchObject({ rendering: "tide/_/_", quality: "final" });
    const second = await app.inject({ method: "POST", url: "/api/films/tide/units/010-shore/_/cut/render", payload: {} });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("render-in-progress");
    expect((await app.inject({ method: "GET", url: "/api/films/tide/tree" })).json().rendering).toMatchObject({ unit: "tide/_/_" });

    await expect.poll(() => events.some((e) => e.type === "render.completed" || e.type === "render.failed"), { timeout: 60_000, interval: 100 }).toBe(true);
    const done = events.find((e) => e.type === "render.completed")!;
    expect(done.data).toMatchObject({ unit: "tide/_/_", quality: "final", current: true, frames: 24 });
    expect((done.data.units as { unit: string }[]).map((u) => u.unit)).toEqual(["tide/010-shore/010-sky", "tide/010-shore/020-wave", "tide/010-shore/_", "tide/_/_"]);
    expect(existsSync(join(root, done.data.path as string))).toBe(true);
    expect(events.some((e) => e.type === "render.progress")).toBe(true);

    const tree = (await app.inject({ method: "GET", url: "/api/films/tide/tree" })).json();
    expect(tree).toMatchObject({ rendering: null, status: { state: "current" } });
    expect(tree.renderUrl).toMatch(/^\/library\/tide\/output\/final-\d+-[a-f0-9]{8}\.mp4$/);
    expect((await app.inject({ method: "DELETE", url: "/api/films/tide/render" })).statusCode).toBe(404);
    await app.close();
  }, 120_000);
});
