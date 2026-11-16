// A cut written from several processes at once: nothing is lost, and of the
// writers that read the same revision exactly one is accepted.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FilmError, createFilm, createScene, createShot, cutPath, editCut, readCut, shotUnit, withCutLock } from "../src/index.js";

const worker = fileURLToPath(new URL("./cut-writer.worker.ts", import.meta.url));

interface Report { name: string; written: number; refused: string[] }

function writer(root: string, ...args: string[]): Promise<Report> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", worker, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out) as Report) : reject(new Error(`writer exited ${code}: ${err}`))));
  });
}

/** Start the writers, let them all load, then release them together. */
async function race(root: string, argv: string[][]): Promise<Report[]> {
  rmSync(join(root, "go"), { force: true });
  const writers = argv.map((args) => writer(root, ...args));
  await new Promise((done) => setTimeout(done, 1500));
  writeFileSync(join(root, "go"), "");
  return Promise.all(writers);
}

describe("a cut written by several processes", () => {
  let root: string;
  const ref = shotUnit("tide", "010-shore", "010-sky");
  const unit = [() => root, "tide", "010-shore", "010-sky"] as const;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "film-lock-"));
    mkdirSync(join(root, "lessons", "series"), { recursive: true });
    createFilm(root, { slug: "tide", title: "Tide", format: "scope-24" });
    createScene(root, { film: "tide", slug: "010-shore", title: "The shore" });
    createShot(root, { film: "tide", scene: "010-shore", slug: "010-sky", title: "The sky", source: "generated" });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("keeps every edit of six processes that name no revision", async () => {
    const before = readCut(root, ref).cut?.revision ?? 0;
    const names = ["a", "b", "c", "d", "e", "f"];
    const each = 20;
    const reports = await race(root, names.map((name) => ["edit", unit[0](), unit[1], unit[2], unit[3], name, String(each)]));

    expect(reports.flatMap((r) => r.refused)).toEqual([]);
    const cut = readCut(root, ref).cut!;
    expect(cut.revision).toBe(before + names.length * each);
    const markers = new Set((cut.markers ?? []).map((m) => m.id));
    for (const name of names) for (let i = 0; i < each; i += 1) expect(markers.has(`${name}-${i}`), `${name}-${i}`).toBe(true);
    expect(existsSync(`${cutPath(root, ref)}.lock`)).toBe(false);
  }, 60_000);

  it("accepts exactly one of six processes that read the same revision", async () => {
    const revision = readCut(root, ref).cut!.revision;
    const names = ["p", "q", "r", "s", "t", "u"];
    const reports = await race(root, names.map((name) => ["write", unit[0](), unit[1], unit[2], unit[3], name, String(revision)]));

    expect(reports.filter((r) => r.written === 1)).toHaveLength(1);
    expect(reports.flatMap((r) => r.refused)).toEqual(Array(names.length - 1).fill("revision-conflict"));
    const cut = readCut(root, ref).cut!;
    expect(cut.revision).toBe(revision + 1);
    expect(cut.markers).toEqual([{ id: reports.find((r) => r.written === 1)!.name, at: 0 }]);
  }, 60_000);

  it("waits for a writer that holds the cut, and gives up when it does not come free", () => {
    const lock = `${cutPath(root, ref)}.lock`;
    const revision = readCut(root, ref).cut!.revision;
    writeFileSync(lock, JSON.stringify({ token: "another", pid: 1, expiresAt: Date.now() + 60_000 }));
    try {
      expect(() => editCut(root, ref, [{ op: "set-marker", marker: { id: "late", at: 1 } }], { waitMs: 80 })).toThrow(FilmError);
      expect(() => editCut(root, ref, [{ op: "set-marker", marker: { id: "late", at: 1 } }], { waitMs: 80 })).toThrow(/being written by someone else/);
      expect(readCut(root, ref).cut!.revision).toBe(revision);
      expect(existsSync(lock), "another writer's lock is left alone").toBe(true);
    } finally {
      rmSync(lock, { force: true });
    }
  });

  it("takes over a lock its holder left behind", () => {
    const lock = `${cutPath(root, ref)}.lock`;
    const revision = readCut(root, ref).cut!.revision;

    writeFileSync(lock, JSON.stringify({ token: "crashed", pid: 1, expiresAt: Date.now() - 1 }));
    expect(editCut(root, ref, [{ op: "set-marker", marker: { id: "after-crash", at: 2 } }], { waitMs: 80 }).cut.revision).toBe(revision + 1);

    // Half a lockfile: held while it is fresh, taken over once it is old.
    writeFileSync(lock, "{");
    expect(() => editCut(root, ref, [{ op: "set-marker", marker: { id: "half", at: 3 } }], { waitMs: 80 })).toThrow(/being written by someone else/);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(editCut(root, ref, [{ op: "set-marker", marker: { id: "half", at: 3 } }], { waitMs: 80 }).cut.revision).toBe(revision + 2);
    expect(existsSync(lock)).toBe(false);
  });

  it("refuses the write of a holder whose lock was taken from it", () => {
    const target = join(root, "slow.json");
    expect(() => withCutLock(target, "a slow writer", (stillHeld) => {
      writeFileSync(`${target}.lock`, JSON.stringify({ token: "the one that replaced it", pid: 1, expiresAt: Date.now() + 60_000 }));
      stillHeld();
    })).toThrow(/took too long/);
    expect(existsSync(`${target}.lock`), "the new holder's lock is not removed").toBe(true);
  });
});
