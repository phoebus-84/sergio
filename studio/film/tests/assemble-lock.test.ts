// What a person's lock holds when a scene is assembled again.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleCut, createFilm, createScene, createShot, editCut, readCut, sceneUnit, shotUnit } from "../src/index.js";

describe("assembling a scene that has a locked clip", () => {
  let root: string;
  const scene = sceneUnit("tide", "010-shore");
  const shot = (slug: string) => shotUnit("tide", "010-shore", slug);
  const clip = (id: string) => readCut(root, scene).cut!.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
  const colour = (slug: string, frames: number, revision: number) =>
    editCut(root, shot(slug), [{ op: revision === 0 ? "add-clip" : "set-clip", ...(revision === 0
      ? { track: "v1", clip: { id: "c", source: { color: "#203050" }, duration: frames } }
      : { clip: "c", set: { duration: frames } }) } as never], { expectedRevision: revision });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "film-assemble-lock-"));
    mkdirSync(join(root, "lessons", "series"), { recursive: true });
    createFilm(root, { slug: "tide", title: "Tide", format: "scope-24" });
    createScene(root, { film: "tide", slug: "010-shore", title: "The shore" });
    for (const slug of ["010-sky", "020-sea", "030-sand"]) createShot(root, { film: "tide", scene: "010-shore", slug, title: slug, source: "generated" });
    colour("010-sky", 24, 0);
    colour("020-sea", 24, 0);
    colour("030-sand", 24, 0);
    await assembleCut(root, scene);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("keeps what a locked clip shows, and says when it had to move it", async () => {
    expect([clip("010-sky").at, clip("020-sea").at, clip("030-sand").at]).toEqual([0, 24, 48]);
    editCut(root, scene, [{ op: "set-clip", clip: "020-sea", set: { locked: true, in: 0.5, effects: [{ type: "vignette" }] } }], { editor: "person" });
    const locked = clip("020-sea");

    // The shot before it grows by a second, and its own shot is recut longer.
    colour("010-sky", 48, 1);
    colour("020-sea", 72, 1);
    const result = await assembleCut(root, scene, { transition: { type: "dissolve", duration: 6 } });

    const after = clip("020-sea");
    expect({ ...after, at: locked.at }).toEqual(locked);
    expect(after.transitionIn).toBeUndefined();
    expect(after.at).toBe(48);
    expect(result.notes).toContain("020-sea: locked, kept as it is; it now starts at 00:00:02:00, not 00:00:01:00, because what precedes it changed length");
    expect(clip("010-sky").duration).toBe(48);
    expect(clip("030-sand").transitionIn).toEqual({ type: "dissolve", duration: 6 });
    expect(clip("030-sand").at).toBe(48 + 24 - 6);
  });

  it("says nothing of a locked clip that stayed where it was", async () => {
    const result = await assembleCut(root, scene);
    expect(result.notes.filter((note) => note.includes("locked"))).toEqual([]);
  });

  it("does not reassemble a track a person locked", async () => {
    editCut(root, scene, [{ op: "set-track", track: "v1", set: { locked: true } }], { editor: "person" });
    await expect(assembleCut(root, scene)).rejects.toThrow(/locked by a person: it is not reassembled/);
  });
});
