// A render is current while the files it read are the ones it read: a source
// replaced by other bytes of the same size and date makes it stale.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFilm, createScene, createShot, editCut, isFresh, readCut, resolveCut, shotUnit, unitDir, type RenderPointer,
} from "../src/index.js";

describe("what a render of a cut depends on", () => {
  let root: string;
  let file: string;
  const ref = shotUnit("tide", "010-shore", "010-sky");
  const resolved = () => resolveCut(root, ref, readCut(root, ref).cut!, { quality: "final" });
  const pointer = (fingerprint: string): RenderPointer => ({
    renderId: "final-1", path: "final-1.mp4", quality: "final", fingerprint, frames: 24, durationSeconds: 1, createdAt: "2026-01-01T00:00:00.000Z",
  });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "film-fingerprint-"));
    mkdirSync(join(root, "lessons", "series"), { recursive: true });
    createFilm(root, { slug: "tide", title: "Tide", format: "scope-24" });
    createScene(root, { film: "tide", slug: "010-shore", title: "The shore" });
    createShot(root, { film: "tide", scene: "010-shore", slug: "010-sky", title: "The sky", source: "footage" });
    file = join(unitDir(root, ref), "assets", "sky.bin");
    mkdirSync(join(unitDir(root, ref), "assets"), { recursive: true });
    writeFileSync(file, "the first take");
    editCut(root, ref, [{ op: "add-clip", track: "v1", clip: { id: "sky", source: { path: "assets/sky.bin" }, duration: 24 } }], { expectedRevision: 0 });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("is the same from one reading to the next", () => {
    expect(resolved().problems.filter((p) => p.severity === "error")).toEqual([]);
    expect(resolved().fingerprint).toBe(resolved().fingerprint);
    expect(isFresh(root, ref, pointer(resolved().fingerprint))).toBe(true);
  });

  it("keeps a render made before files were named by identity current", () => {
    const { fingerprint, earlierFingerprint } = resolved();
    expect(earlierFingerprint).not.toBe(fingerprint);
    expect(isFresh(root, ref, pointer(earlierFingerprint))).toBe(true);
    expect(isFresh(root, ref, pointer("something else"))).toBe(false);
  });

  it("is another when a source was replaced by other bytes of the same size and date", async () => {
    const before = { ...resolved(), at: statSync(file) };
    await new Promise((done) => setTimeout(done, 20));
    writeFileSync(file, "the other take");
    utimesSync(file, before.at.atime, before.at.mtime);

    const after = resolved();
    expect(after.earlierFingerprint, "size and date cannot tell").toBe(before.earlierFingerprint);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(isFresh(root, ref, pointer(before.fingerprint))).toBe(false);
  });
});
