// The film render stage, on a film made of solid colours: no media to generate.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { episodePath } from "@studio/contracts/src/layout.mjs";
import { assembleCut, createFilm, createScene, createShot, editCut, filmUnit, sceneUnit, shotUnit } from "@studio/film";
import { createStudioRegistry } from "../src/index.js";
import { cutRender } from "../src/adapters/film.js";
import { builtin, stageOf } from "./helpers.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe("the film render stage", () => {
  it("is what performs the render of every film pipeline, at every level", async () => {
    const registry = createStudioRegistry();
    for (const name of ["film-shot", "film-shot-auto", "film-shot-directed", "film-scene", "film-scene-auto", "film-project", "film-project-auto"]) {
      const pipeline = await builtin(name);
      expect(registry.match(stageOf(pipeline, "render"))?.id, name).toBe("cut-render");
      // What a cut says is editorial: nothing here writes one.
      expect(registry.match(stageOf(pipeline, "cut")), name).toBeUndefined();
    }
  });

  it("keeps a person's gates where the guided pipelines put them, and none in the automatic ones", async () => {
    const gates = async (name: string) => Object.fromEntries((await builtin(name)).stages.map((s) => [s.definition.id, s.definition.gates.review]));
    expect(await gates("film-shot")).toEqual({ plan: "none", media: "human", cut: "none", render: "none" });
    expect(await gates("film-shot-auto")).toEqual({ plan: "none", media: "none", cut: "none", render: "none" });
    expect(await gates("film-shot-directed")).toEqual({ plan: "human", media: "human", cut: "human", render: "none" });
    expect(await gates("film-scene")).toMatchObject({ direction: "human", cut: "human" });
    expect(Object.values(await gates("film-scene-auto"))).toEqual(["none", "none", "none", "none", "none"]);
    expect(await gates("film-project-auto")).toMatchObject({ development: "none", cut: "none", review: "human" });
  });
});

describe.skipIf(!hasFfmpeg)("rendering a film through the stage", () => {
  let root: string;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "adapter-film-"));
    createFilm(root, { slug: "tide", title: "Tide", format: { id: "tiny-24", width: 160, height: 90, fps: 24 } });
    createScene(root, { film: "tide", slug: "010", title: "One" });
    createShot(root, { film: "tide", scene: "010", slug: "a", title: "A", source: "graphics" });
    editCut(root, shotUnit("tide", "010", "a"), [{ op: "add-clip", track: "v1", clip: { id: "c", source: { color: "#204060" }, duration: 12 } }]);
    await assembleCut(root, sceneUnit("tide", "010"));
    await assembleCut(root, filmUnit("tide"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("renders the film and everything under it, and records the render", async () => {
    const ref = filmUnit("tide");
    const episodeDir = episodePath(root, ref.channel, ref.series, ref.episode);
    const log: string[] = [];
    const written = await cutRender.perform({ episodeDir, ref, log: (message) => log.push(message) });
    expect(written).toEqual([join(episodeDir, "artifacts", "cut-render.json")]);
    const record = JSON.parse(readFileSync(written[0]!, "utf-8"));
    expect(record).toMatchObject({ kind: "CutRenderRecord", quality: "final", frames: 12 });
    expect(existsSync(join(root, record.path))).toBe(true);
    expect(log.join("\n")).toMatch(/tide: rendered final-.*\(3 units rendered in all\)/);

    const again = await cutRender.perform({ episodeDir, ref, log: (message) => log.push(message) });
    expect(JSON.parse(readFileSync(again[0]!, "utf-8")).renderId).toBe(record.renderId);
    expect(log.at(-1)).toMatch(/already rendered/);
  }, 120_000);

  it("fails, saying why, on a unit whose cut cannot be rendered", async () => {
    createScene(root, { film: "tide", slug: "020", title: "Two" });
    const ref = sceneUnit("tide", "020");
    const log: string[] = [];
    await expect(cutRender.perform({ episodeDir: episodePath(root, ref.channel, ref.series, ref.episode), ref, log: (m) => log.push(m) }))
      .rejects.toThrow(/has no cut to render/);
  });
});
