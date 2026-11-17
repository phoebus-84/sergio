import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome } from "@av/strudel";
import { describeAnalysis, noteName, registerMusicTools } from "../src/music-tools.js";

/** Pi's music tools (ADR-0053), in a channel source: a piece checked, rendered with stems, and listed. */

const chrome = (() => {
  try {
    return findChrome();
  } catch {
    return null;
  }
})();

const PIECE = `setcpm(100/4)
kick: s("sbd*4").gain(.8)
bass: note("<a1 f1>*2").s("sawtooth").lpf(500).decay(.2).sustain(.3).gain(.5)
keys: n("<[0,2,4] [-2,0,2]>").scale("A2:minor").s("triangle").attack(.05).release(.5).gain(.5)
`;

let root: string;
const previous = process.env.AVG_LIBRARY_ROOT;
const src = () => join(root, "canale", "sources", "sigla");
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "music-tools-"));
  mkdirSync(join(src(), "music"), { recursive: true });
  writeFileSync(join(src(), "music", "sigla.strudel"), PIECE);
  process.env.AVG_LIBRARY_ROOT = root;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (previous === undefined) delete process.env.AVG_LIBRARY_ROOT; else process.env.AVG_LIBRARY_ROOT = previous;
});

function tools() {
  const registered = new Map<string, any>();
  registerMusicTools({ registerTool: (t: { name: string }) => registered.set(t.name, t) } as never);
  return (name: string, params: Record<string, unknown>) => registered.get(name)!.execute("call", params);
}
const where = { channel: "canale", source: "sigla" };

describe("music tools", () => {
  it("names notes as Strudel writes them, and reads a file's numbers out in words", () => {
    expect([60, 69, 33, 21.2, 61].map(noteName)).toEqual(["c4", "a4", "a1", "a0", "c#4"]);
    const lines = describeAnalysis({
      seconds: 4, peak: -1, rms: -18, lufs: -16, crest: 17, clipped: 0, dc: 0, silent: false, head: 0, tail: 0,
      bands: { sub: -9, bass: -4, lowMid: -8, mid: -10, highMid: -18, high: -24 }, centroid: 410,
      stereo: { correlation: 1, width: -Infinity, balance: 0 }, envelope: { window: 0.25, rms: [-18.4, -17.6] },
    });
    expect(lines[0]).toContain("sub -9 · bass -4 · low-mid -8 · mid -10 · high-mid -18 · high -24; centroid 410 Hz; crest 17 dB");
    expect(lines[1]).toBe("stereo: correlation 1, width none (mono)");
    expect(lines[2]).toBe("level through time (dBFS, every 0.25 s): -18 -18");
  });

  it("lists a workspace's pieces before anything is rendered, and says so when there are none", async () => {
    const run = tools();
    const listed = await run("pva_music", where);
    expect(listed.content[0].text).toBe("canale/sources/sigla:\n- music/sigla.strudel: not rendered yet");
    rmSync(join(src(), "music"), { recursive: true });
    expect((await run("pva_music", where)).content[0].text).toContain("has no music");
  });

  it("refuses a piece or an output that leaves the workspace, without a browser", async () => {
    const run = tools();
    for (const params of [
      { path: "../../other/music/x.strudel", cycles: 1 },
      { path: "music/sigla.strudel", cycles: 1, output: "../../escape.wav" },
      { path: "music/sigla.strudel", cycles: 1, output: "output/render.wav" },
      { path: "music/sigla.strudel" },
    ]) {
      const refused = await run("pva_music_render", { ...where, ...params });
      expect(refused.isError, JSON.stringify(params)).toBe(true);
    }
    expect((await run("pva_music_check", { ...where, path: "music/none.strudel" })).content[0].text).toContain("no-such-piece");
    expect(existsSync(join(src(), "assets"))).toBe(false);
  });

  it.skipIf(!chrome)("checks, renders with stems and lists a piece", { timeout: 180_000 }, async () => {
    const run = tools();
    const checked = await run("pva_music_check", { ...where, path: "music/sigla.strudel", cycles: 2, events: 3 });
    expect(checked.isError, checked.content[0].text).toBeUndefined();
    const text = checked.content[0].text as string;
    expect(text).toContain("✅ music/sigla.strudel: cycles 0–2 = 4.8 s at 25 cycles/min (100 bpm when a cycle is a 4/4 bar); 18 events");
    expect(text).toContain("- kick: 8 events, per cycle [4 4]; sbd");
    expect(text).toContain("- bass: 4 events, per cycle [2 2]; notes f1–a1; sawtooth");
    // The scale expression, read back: an A minor triad, then the one a third below it.
    expect(text).toContain("- keys: 6 events, per cycle [3 3]; notes f2–e3; triangle");
    expect(text).toMatch(/0\.000 \+1 {2}note=A2 s=triangle/);

    const tried = await run("pva_music_check", { ...where, code: `sub: note("a1").s("sine")\nhat: s("hh*8")` });
    expect(tried.isError).toBe(true);
    expect(tried.content[0].text).toContain(`❌ no sound is called "hh"`);
    // A label with a capital S solos its part: the check passes, and says what that does.
    const solo = await run("pva_music_check", { ...where, code: `Sub: note("a1").s("sine")\nhat: s("white*8")` });
    expect(solo.isError).toBeUndefined();
    expect(solo.content[0].text).toContain("- Sub (SOLO): 4 events");
    expect(solo.content[0].text).toContain("⚠️ \"Sub\" starts with a capital S");

    const made = await run("pva_music_render", { ...where, path: "music/sigla.strudel", cycles: 4, tail: 1.5, stems: true });
    expect(made.isError, made.content[0].text).toBeUndefined();
    const report = made.content[0].text as string;
    expect(report).toMatch(/assets\/sounds\/sigla\.wav: 11\.1 s \(cycles 0–4 at 25 cycles\/min .*; 1\.5 s of it tail\), -\d+\.\d LUFS, peak -\d+\.\d dBFS \(gain [+-][\d.]+ dB on a piece that peaks at -?[\d.]+ dBFS\) → assets\/sounds\/sigla\.wav\.music\.json/);
    expect(report).toContain("parts: kick, bass, keys");
    expect(report).toContain("spectrum (share of the energy, dB): sub ");
    expect(report).toMatch(/stems \(at the mix's gain\): kick -\d+\.\d LUFS, peak -\d+\.\d dBFS → assets\/sounds\/sigla\.kick\.wav; bass .* → assets\/sounds\/sigla\.bass\.wav; keys .* → assets\/sounds\/sigla\.keys\.wav/);
    for (const file of ["sigla.wav", "sigla.kick.wav", "sigla.bass.wav", "sigla.keys.wav", "sigla.wav.music.json"]) expect(existsSync(join(src(), "assets/sounds", file)), file).toBe(true);
    const record = JSON.parse(readFileSync(join(src(), "assets/sounds/sigla.wav.music.json"), "utf-8"));
    expect(record.request).toEqual({ path: "music/sigla.strudel", cycles: 4, tail: 1.5, stems: true });

    const loop = await run("pva_music_render", { ...where, path: "music/sigla.strudel", seconds: 5, loop: true, only: ["keys"], output: "assets/sounds/keys-loop.wav", loudness: null });
    expect(loop.content[0].text).toMatch(/keys-loop\.wav: 4\.8 s \(cycles 0–2 at .*; a seamless loop\), .*\(its own level\)/);
    expect(loop.content[0].text).toContain("parts: keys; not playing: kick, bass");

    writeFileSync(join(src(), "music", "sigla.strudel"), `${PIECE}// a change\n`);
    const listed = (await run("pva_music", where)).content[0].text as string;
    expect(listed).toContain("- music/sigla.strudel\n");
    expect(listed).toMatch(/assets\/sounds\/keys-loop\.wav \(STALE: the piece changed since\): cycles 0–2, 4\.8 s, loop, .*, only keys/);
    expect(listed).toMatch(/assets\/sounds\/sigla\.wav \(STALE: the piece changed since\): cycles 0–4, 11\.1 s, -\d+\.\d LUFS, 3 stems/);
  });

  it.skipIf(!chrome)("says what is wrong with a piece that does not render, and writes nothing", { timeout: 60_000 }, async () => {
    writeFileSync(join(src(), "music", "sigla.strudel"), `kick: s("sbd*4"`);
    const run = tools();
    const made = await run("pva_music_render", { ...where, path: "music/sigla.strudel", cycles: 2 });
    expect(made.isError).toBe(true);
    expect(made.content[0].text).toMatch(/^❌ bad-code: /);
    expect(existsSync(join(src(), "assets"))).toBe(false);
  });
});
