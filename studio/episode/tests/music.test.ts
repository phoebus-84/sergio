import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeWav, encodeWav, findChrome, StrudelRenderer } from "@av/strudel";
import { validateMusicRender } from "@studio/contracts/src/music-renders.mjs";
import { checkMusic, listMusic, MusicError, renderMusic } from "../src/music.js";

const chrome = (() => {
  try {
    return findChrome();
  } catch {
    return null;
  }
})();

const PIECE = `setcpm(120/4)
drums: s("sbd*4").gain(.8)
bass: note("<c2 ab1>*2").s("sawtooth").lpf(500).decay(.2).sustain(.3).gain(.5)
pad: note("<[c3,eb3,g3] [ab2,c3,eb3]>").s("supersaw").lpf(1500).attack(.2).release(.8).room(.5).gain(.3)
_idea: note("c5*8").s("square")
`;

function workspace(pieces: Record<string, string> = { "music/theme.strudel": PIECE }): string {
  const dir = mkdtempSync(join(tmpdir(), "music-ws-"));
  for (const [path, code] of Object.entries(pieces)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), code);
  }
  return dir;
}

describe("a workspace's pieces, without a browser", () => {
  it("refuses what is not a piece of this workspace", async () => {
    const dir = workspace();
    await expect(renderMusic(dir, { path: "music/nothing.strudel", cycles: 2 })).rejects.toMatchObject({ code: "no-such-piece" });
    await expect(renderMusic(dir, { path: "../theme.strudel", cycles: 2 })).rejects.toMatchObject({ code: "bad-request" });
    await expect(renderMusic(dir, { path: "/etc/passwd", cycles: 2 })).rejects.toMatchObject({ code: "bad-request" });
    writeFileSync(join(dir, "music/notes.txt"), PIECE);
    await expect(renderMusic(dir, { path: "music/notes.txt", cycles: 2 })).rejects.toMatchObject({ code: "bad-request", message: expect.stringContaining(".strudel") });
  });

  it("refuses an output outside the places sound is kept, and a request with no length", async () => {
    const dir = workspace();
    for (const output of ["theme.wav", "output/theme.wav", "assets/sounds/../../theme.wav", "assets/sounds/theme.mp3", "/tmp/theme.wav"]) {
      await expect(renderMusic(dir, { path: "music/theme.strudel", cycles: 2, output })).rejects.toBeInstanceOf(MusicError);
    }
    await expect(renderMusic(dir, { path: "music/theme.strudel" })).rejects.toMatchObject({ code: "bad-request", message: expect.stringContaining("cycles, or seconds") });
    await expect(renderMusic(dir, { path: "music/theme.strudel", cycles: 2, seconds: 4 })).rejects.toMatchObject({ code: "bad-request" });
    await expect(checkMusic(dir, {})).rejects.toMatchObject({ code: "bad-request" });
    await expect(checkMusic(dir, { path: "music/theme.strudel", code: "x" })).rejects.toMatchObject({ code: "bad-request" });
  });

  it("lists pieces with no renders yet, and none in a workspace without music", () => {
    expect(listMusic(workspace({}))).toEqual({ pieces: [], orphans: [], invalid: [] });
    const listed = listMusic(workspace({ "music/theme.strudel": PIECE, "music/cues/sting.strudel": `$: s("sbd")` }));
    expect(listed.pieces.map((p) => [p.path, p.renders.length])).toEqual([["music/cues/sting.strudel", 0], ["music/theme.strudel", 0]]);
    expect(listed.pieces[1]!.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe.skipIf(!chrome)("a workspace's pieces, rendered", () => {
  let renderer: StrudelRenderer;
  const dirs: string[] = [];
  const fresh = (pieces?: Record<string, string>) => {
    const dir = workspace(pieces);
    dirs.push(dir);
    return dir;
  };
  beforeAll(async () => {
    renderer = await StrudelRenderer.launch();
  }, 60_000);
  afterAll(async () => {
    await renderer.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("checks a piece by its path, or code before it is saved", { timeout: 60_000 }, async () => {
    const dir = fresh();
    const saved = await checkMusic(dir, { path: "music/theme.strudel", cycles: 2, events: 1 }, { renderer });
    expect(saved.source).toEqual({ path: "music/theme.strudel", hash: expect.stringMatching(/^sha256:/) });
    expect(saved.inspection.ok).toBe(true);
    expect(saved.inspection.parts.map((p) => [p.name, p.selected, p.events])).toEqual([["drums", true, 8], ["bass", true, 4], ["pad", true, 6], ["idea", false, 16]]);
    const tried = await checkMusic(dir, { code: `$: s("bd")` }, { renderer });
    expect(tried.source).toBeNull();
    expect(tried.inspection.ok).toBe(false);
    expect(tried.inspection.problems.map((p) => p.code)).toEqual(["unknown-sound"]);
  });

  it("renders a piece to a levelled file with its record", { timeout: 120_000 }, async () => {
    const dir = fresh();
    const { record, recordPath } = await renderMusic(dir, { path: "music/theme.strudel", cycles: 4, tail: 3 }, { renderer, now: () => new Date("2026-11-17T10:00:00Z") });
    expect(recordPath).toBe("assets/sounds/theme.wav.music.json");
    expect(validateMusicRender(JSON.parse(readFileSync(join(dir, recordPath), "utf-8")))).toEqual([]);
    expect(record).toMatchObject({
      kind: "MusicRender",
      engine: { name: "strudel", version: "1.3.0" },
      source: { path: "music/theme.strudel" },
      request: { path: "music/theme.strudel", cycles: 4, tail: 3 },
      tempo: { cps: 0.5, cyclesPerMinute: 30 },
      range: { from: 0, to: 4 },
      output: { path: "assets/sounds/theme.wav", durationSeconds: 11, bodySeconds: 8, sampleRate: 48000, channels: 2, loop: false },
      stems: [],
      inputs: {},
      fetched: [],
      createdAt: "2026-11-17T10:00:00.000Z",
    });
    expect(record.parts.map((p) => p.name)).toEqual(["drums", "bass", "pad", "idea"]);
    // Brought to −18 LUFS with one gain, the peaks under the ceiling; the record says what was asked.
    expect(record.level).toMatchObject({ basis: "loudness", target: -18, ceiling: -1 });
    expect(record.level.peak).toBeLessThanOrEqual(-1);
    if (!record.level.held) expect(record.level.loudness).toBeCloseTo(-18, 0);
    expect((record.analysis as { peakAt: number }).peakAt).toBeGreaterThanOrEqual(0);
    const audio = decodeWav(readFileSync(join(dir, "assets/sounds/theme.wav")));
    expect(audio.sampleRate).toBe(48000);
    expect(audio.channels).toHaveLength(2);
    expect(audio.channels[0]!.length).toBe(11 * 48000);
    expect((record.analysis as { bands: { bass: number } }).bands.bass).toBeGreaterThan(-12);
  });

  it("renders stems that add up to the mix", { timeout: 180_000 }, async () => {
    const dir = fresh();
    // Parts made of plain oscillators sum to the mix exactly. Noise, supersaw and reverb draw on the seeded
    // randomness in the order events come, so alone they sound the same but are not the same samples.
    writeFileSync(join(dir, "music/theme.strudel"), PIECE.replace(".room(.5)", "").replace("supersaw", "sawtooth"));
    const { record } = await renderMusic(dir, { path: "music/theme.strudel", cycles: 2, stems: true, output: "music/theme.wav" }, { renderer });
    expect(record.stems.map((s) => [s.part, s.path])).toEqual([
      ["drums", "music/theme.drums.wav"], ["bass", "music/theme.bass.wav"], ["pad", "music/theme.pad.wav"],
    ]);
    const mix = decodeWav(readFileSync(join(dir, "music/theme.wav"))).channels[0]!;
    const stems = record.stems.map((s) => decodeWav(readFileSync(join(dir, s.path))).channels[0]!);
    let worst = 0;
    for (let i = 0; i < mix.length; i++) worst = Math.max(worst, Math.abs(mix[i]! - stems.reduce((sum, stem) => sum + stem[i]!, 0)));
    expect(worst).toBeLessThan(0.02);
    expect(record.stems.every((s) => s.loudness !== null && s.peak !== null && s.peak <= 0)).toBe(true);
    // Each stem is measured as the mix is: the kick is low, the plain oscillators are in the middle.
    const [drums, , pad] = record.stems;
    expect(drums!.centroid!).toBeLessThan(pad!.centroid!);
    expect(drums!.bands!.sub! + drums!.bands!.bass!).toBeGreaterThan(pad!.bands!.sub! + pad!.bands!.bass!);
    expect(drums!.correlation).toBe(1);
  });

  it("renders a stretch, one part, a loop; and names what to listen for", { timeout: 180_000 }, async () => {
    const dir = fresh();
    const bass = await renderMusic(dir, { path: "music/theme.strudel", from: 2, cycles: 2, only: ["bass"], output: "assets/audio/bass-b.wav", level: { loudness: null } }, { renderer });
    expect(bass.record.range).toEqual({ from: 2, to: 4 });
    expect(bass.record.parts.filter((p) => p.selected).map((p) => p.name)).toEqual(["bass"]);
    expect(bass.record.level).toMatchObject({ gain: 0, basis: "none" });
    expect(bass.record.output.durationSeconds).toBe(4);

    const loop = await renderMusic(dir, { path: "music/theme.strudel", seconds: 9, loop: true, tail: 2, only: ["pad"], output: "assets/sounds/pad-loop.wav" }, { renderer });
    expect(loop.record.output).toMatchObject({ loop: true, durationSeconds: 8, bodySeconds: 8 });
    expect(loop.record.concerns).toEqual([]);

    const cut = await renderMusic(dir, { path: "music/theme.strudel", cycles: 2, only: ["pad"], output: "assets/sounds/pad-cut.wav" }, { renderer });
    expect(cut.record.concerns.join(" ")).toContain("still sounding where it ends");
    const tailless = await renderMusic(dir, { path: "music/theme.strudel", cycles: 2, only: ["pad"], loop: true, output: "assets/sounds/pad-tailless.wav" }, { renderer });
    expect(tailless.record.concerns).toEqual([expect.stringContaining("a loop with no tail")]);
    // One cycle of a pad that alternates two chords does not come round: the record names the part.
    const seamed = await renderMusic(dir, { path: "music/theme.strudel", cycles: 1, tail: 2, loop: true, mute: ["drums"], output: "assets/sounds/seam.wav" }, { renderer });
    expect(seamed.record.concerns).toEqual([expect.stringMatching(/^as a loop it has a seam: "pad" does not play in cycles 1–2 what it played in 0–1/)]);
  });

  it("uses the workspace's own sounds as samples, and records them", { timeout: 120_000 }, async () => {
    const dir = fresh({ "music/rain.strudel": `samples({ drop: 'assets/sounds/drop.wav' })\ndrops: s("drop*4").speed("<1 1.5>")` });
    mkdirSync(join(dir, "assets/sounds"), { recursive: true });
    const drop = Float32Array.from({ length: 4800 }, (_, i) => Math.sin((2 * Math.PI * 660 * i) / 48000) * Math.exp(-i / 500));
    writeFileSync(join(dir, "assets/sounds/drop.wav"), encodeWav([drop], 48000, "pcm16"));
    const { record } = await renderMusic(dir, { path: "music/rain.strudel", cycles: 2 }, { renderer });
    expect(Object.keys(record.inputs)).toEqual(["assets/sounds/drop.wav"]);
    expect(record.inputs["assets/sounds/drop.wav"]).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("says where the peak is when a piece falls well short of its loudness", { timeout: 120_000 }, async () => {
    // One click in four seconds over a faint tone: 37 dB of crest. No gain brings it to −18 LUFS under the ceiling.
    const dir = fresh({ "music/spiky.strudel": `setcps(.5)\nhit: s("<~ white>").struct("~ x").decay(.005).sustain(0).gain(2)\npad: note("c3").s("sine").gain(.01)` });
    const { record } = await renderMusic(dir, { path: "music/spiky.strudel", cycles: 2 }, { renderer });
    expect(record.level).toMatchObject({ held: true, peak: -1 });
    const concern = record.concerns.find((c) => c.startsWith("its peaks keep it"))!;
    // The click is in the second half of the second 2 s cycle.
    expect(concern).toMatch(/dB under the -18 asked\. The highest is at 3\.00 s \(cycle 1\.50\)/);
    // A few decibels short is what drums cost, and is not a concern.
    const mild = fresh();
    const ordinary = await renderMusic(mild, { path: "music/theme.strudel", cycles: 4, tail: 3 }, { renderer });
    expect(ordinary.record.concerns.filter((c) => c.startsWith("its peaks"))).toEqual([]);
  });

  it("writes nothing when the piece is wrong", { timeout: 120_000 }, async () => {
    const dir = fresh({ "music/broken.strudel": `a: s("sbd")\nb: s("nosuchsound*2")`, "music/syntax.strudel": `a: s("sbd"` });
    await expect(renderMusic(dir, { path: "music/broken.strudel", cycles: 1 }, { renderer })).rejects.toMatchObject({ code: "bad-code", message: expect.stringContaining("nosuchsound") });
    await expect(renderMusic(dir, { path: "music/syntax.strudel", cycles: 1 }, { renderer })).rejects.toMatchObject({ code: "bad-code" });
    await expect(renderMusic(dir, { path: "music/broken.strudel", cycles: 1, only: ["c"] }, { renderer })).rejects.toMatchObject({ code: "bad-request" });
    expect(existsSync(join(dir, "assets"))).toBe(false);
  });

  it("lists what was rendered from each piece, and what went stale", { timeout: 120_000 }, async () => {
    const dir = fresh();
    await renderMusic(dir, { path: "music/theme.strudel", cycles: 1, tail: 1 }, { renderer, now: () => new Date("2026-11-17T10:00:00Z") });
    await renderMusic(dir, { path: "music/theme.strudel", cycles: 1, only: ["bass"], output: "assets/sounds/theme-bass.wav" }, { renderer, now: () => new Date("2026-11-17T11:00:00Z") });
    let listed = listMusic(dir);
    expect(listed.pieces).toHaveLength(1);
    expect(listed.pieces[0]!.renders.map((r) => [r.record.output.path, r.current, r.missing])).toEqual([
      ["assets/sounds/theme-bass.wav", true, false], ["assets/sounds/theme.wav", true, false],
    ]);
    writeFileSync(join(dir, "music/theme.strudel"), `${PIECE}\n// changed`);
    rmSync(join(dir, "assets/sounds/theme-bass.wav"));
    writeFileSync(join(dir, "assets/sounds/broken.wav.music.json"), "{ not json");
    listed = listMusic(dir);
    expect(listed.pieces[0]!.renders.map((r) => [r.current, r.missing])).toEqual([[false, true], [false, false]]);
    expect(listed.invalid).toEqual(["assets/sounds/broken.wav.music.json"]);
    rmSync(join(dir, "music/theme.strudel"));
    listed = listMusic(dir);
    expect(listed.pieces).toEqual([]);
    expect(listed.orphans).toHaveLength(2);
  });
});
