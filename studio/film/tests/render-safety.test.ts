// What keeps a render honest when more than one process renders a film, when
// its cut is edited meanwhile, and when its journal cannot be written.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  FilmError, createFilm, createScene, createShot, editCut, readCut, readPointer, readRenderLease, renderUnit, resolveCut,
  settleRenderJournal, shotUnit, unitDir, withRenderLease,
} from "../src/index.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe("rendering a film safely", () => {
  let root: string;
  const sky = shotUnit("tide", "010-shore", "010-sky");
  const sea = shotUnit("tide", "010-shore", "020-sea");
  const lease = () => join(root, "tide", ".cut", "render.lease.json");

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "film-render-safety-"));
    mkdirSync(join(root, "lessons", "series"), { recursive: true });
    createFilm(root, { slug: "tide", title: "Tide", format: { id: "tiny-24", width: 160, height: 90, fps: 24 } });
    createScene(root, { film: "tide", slug: "010-shore", title: "The shore" });
    for (const [slug, color] of [["010-sky", "#203050"], ["020-sea", "#104030"]] as const) {
      createShot(root, { film: "tide", scene: "010-shore", slug, title: slug, source: "generated" });
      editCut(root, shotUnit("tide", "010-shore", slug), [{ op: "add-clip", track: "v1", clip: { id: "c", source: { color }, duration: 12 } }], { expectedRevision: 0 });
    }
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("lets one render of a film run at a time, and says what is being rendered", async () => {
    let release!: () => void;
    const first = withRenderLease(root, sky, "final", () => new Promise<string>((done) => (release = () => done("rendered"))));
    expect(readRenderLease(root, "tide")).toMatchObject({ unit: "tide/010-shore/010-sky", quality: "final", pid: process.pid });

    const second = withRenderLease(root, sea, "preview", async () => "should not run");
    await expect(second).rejects.toThrow(FilmError);
    await expect(second).rejects.toThrow(/tide\/010-shore\/010-sky is being rendered \(final\).*020-sea is not rendered beside it/);
    await expect(second).rejects.toMatchObject({ code: "render-in-progress" });

    release();
    expect(await first).toBe("rendered");
    expect(readRenderLease(root, "tide")).toBeNull();
    expect(existsSync(lease())).toBe(false);
    expect(await withRenderLease(root, sea, "preview", async () => "runs now")).toBe("runs now");
  });

  it("gives the lease back when the render fails", async () => {
    await expect(withRenderLease(root, sky, "final", async () => { throw new Error("ffmpeg fell over"); })).rejects.toThrow("ffmpeg fell over");
    expect(readRenderLease(root, "tide")).toBeNull();
  });

  it("takes over a lease its holder left behind", async () => {
    mkdirSync(join(root, "tide", ".cut"), { recursive: true });
    const left = { token: "gone", unit: "tide/010-shore/010-sky", quality: "final", startedAt: new Date().toISOString(), host: hostname() };

    // Its process is gone.
    writeFileSync(lease(), JSON.stringify({ ...left, pid: 2 ** 22 + 12345 }));
    expect(readRenderLease(root, "tide")).toBeNull();
    expect(await withRenderLease(root, sea, "final", async () => "taken over")).toBe("taken over");

    // Its process is there (this one), but it stopped touching the lease long ago.
    writeFileSync(lease(), JSON.stringify({ ...left, pid: process.pid }));
    expect(readRenderLease(root, "tide")).not.toBeNull();
    const old = new Date(Date.now() - 120_000);
    utimesSync(lease(), old, old);
    expect(readRenderLease(root, "tide")).toBeNull();
    expect(await withRenderLease(root, sea, "final", async () => "taken over")).toBe("taken over");
  });

  it.skipIf(!hasFfmpeg)("does not let a render of the cut as it was take the place of one that is current", async () => {
    const output = join(unitDir(root, sky), "output");
    let edited = false;
    const render = await renderUnit(root, sky, {
      onProgress: () => {
        if (edited) return;
        edited = true;
        // While this renders, a person edits the cut and it is rendered again elsewhere.
        const cut = editCut(root, sky, [{ op: "set-clip", clip: "c", set: { opacity: 0.5 } }], { editor: "person" }).cut;
        mkdirSync(output, { recursive: true });
        writeFileSync(join(output, "final-newer.mp4"), "the render of the cut as it now is");
        writeFileSync(join(output, "current.json"), JSON.stringify({
          renderId: "final-newer", path: "final-newer.mp4", quality: "final", fingerprint: resolveCut(root, sky, cut, { quality: "final" }).fingerprint,
          frames: 12, durationSeconds: 0.5, createdAt: new Date().toISOString(),
        }));
      },
    });

    expect(edited).toBe(true);
    expect(render.current).toBe(false);
    expect(existsSync(join(root, render.path)), "the render is kept").toBe(true);
    expect(render.warnings.map((w) => w.code)).toContain("render-superseded");
    expect(readPointer(root, sky, "final")!.renderId).toBe("final-newer");
  });

  it.skipIf(!hasFfmpeg)("still points a unit at a render of an edited cut when nothing current stands in its place", async () => {
    let edited = false;
    const render = await renderUnit(root, sea, {
      onProgress: () => {
        if (edited) return;
        edited = true;
        editCut(root, sea, [{ op: "set-clip", clip: "c", set: { opacity: 0.5 } }], { editor: "person" });
      },
    });
    expect(render.current).toBe(true);
    expect(readPointer(root, sea, "final")!.renderId).toBe(render.renderId);
    expect(render.warnings.map((w) => w.code)).not.toContain("render-superseded");
  });

  it.skipIf(!hasFfmpeg)("keeps the journal's line of a render it could not write, and writes it later", async () => {
    const dir = unitDir(root, sea);
    const journal = join(dir, "journal");
    const lines = () => readFileSync(join(journal, "events.jsonl"), "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; data: { renderId?: string } });

    // The journal cannot be written: a file stands where its folder was.
    renameSync(journal, join(dir, "journal.aside"));
    writeFileSync(journal, "not a folder");
    const render = await renderUnit(root, sea, { force: true });
    expect(render.current).toBe(true);
    expect(render.warnings.map((w) => w.code)).toContain("journal-not-written");
    const pending = join(dir, "output", `${render.renderId}.journal-pending.json`);
    expect(existsSync(pending)).toBe(true);
    expect(await settleRenderJournal(dir), "still not possible: kept").toEqual([]);
    expect(existsSync(pending)).toBe(true);

    rmSync(journal);
    renameSync(join(dir, "journal.aside"), journal);
    expect(await settleRenderJournal(dir)).toEqual([render.renderId]);
    expect(existsSync(pending)).toBe(false);
    expect(lines().filter((e) => e.type === "deliverable-current-changed" && e.data.renderId === render.renderId)).toHaveLength(1);
    expect(await settleRenderJournal(dir)).toEqual([]);
  });
});
