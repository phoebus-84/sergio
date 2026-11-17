import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StrudelError, StrudelRenderer, encodeWav } from "../src/index.js";
import { chrome, firstAbove, peak, rmsDb } from "./helpers.js";

const RATE = 48000;

describe.skipIf(!chrome)("rendering a piece", () => {
  let renderer: StrudelRenderer;
  beforeAll(async () => {
    renderer = await StrudelRenderer.launch();
  });
  afterAll(async () => {
    await renderer.close();
  });

  it("places every event on its sample", async () => {
    // Two kicks a cycle, a cycle every two seconds: one a second.
    const made = await renderer.render(`$: s("sbd*2")`, { to: 2 });
    expect(made.cps).toBe(0.5);
    expect(made.channels[0].length).toBe(4 * RATE);
    expect(made.seconds).toBe(4);
    expect(firstAbove(made.channels[0], 1e-4)).toBeLessThan(8);
    const second = firstAbove(made.channels[0], 1e-4, RATE - 2000);
    expect(Math.abs(second - RATE)).toBeLessThan(8);
    expect(made.problems).toEqual([]);
  });

  it("follows the tempo the piece sets, and counts whole cycles in seconds", async () => {
    const made = await renderer.render(`setcpm(120/4)\n$: s("sbd*4")`, { seconds: 9 });
    // 0.5 cycles a second: four whole cycles fit in nine seconds.
    expect(made.to).toBe(4);
    expect(made.seconds).toBe(8);
    const fast = await renderer.render(`setcps(1)\n$: s("sbd")`, { to: 3 });
    expect(fast.seconds).toBe(3);
    // A tempo does not carry from one piece to the next.
    const plain = await renderer.render(`$: s("sbd")`, { to: 1 });
    expect(plain.cps).toBe(0.5);
  });

  it("plays the event at the very start when it ducks another part", async () => {
    // Strudel's own export loses it: the duck is scheduled 10 ms before an onset at 0.
    const made = await renderer.render(
      `pad: note("c3,e3,g3").s("sawtooth").lpf(1200).orbit(2)\nkick: s("sbd*2").duckorbit(2).duckattack(0.3).duckdepth(1)`,
      { to: 1 },
    );
    expect(made.problems).toEqual([]);
    expect(peak(made.channels[0], 0, 2400)).toBeGreaterThan(0.6);
    // The pad is pushed down after each kick, and is back before the next.
    const pad = await renderer.render(
      `pad: note("c3,e3,g3").s("sawtooth").lpf(1200).orbit(2)\nkick: s("sbd*2").duckorbit(2).duckattack(0.3).duckdepth(1).gain(0)`,
      { to: 1 },
    );
    expect(rmsDb(pad.channels[0], 0.02 * RATE, 0.08 * RATE)).toBeLessThan(rmsDb(pad.channels[0], 0.7 * RATE, 0.9 * RATE) - 6);
  });

  it("renders a part that ducks another when that other is not playing", async () => {
    // The kick is written before the pad it ducks, and then rendered alone: neither is an error.
    const code = `kick: s("sbd*2").duckorbit(2).duckattack(0.3)\npad: note("c3,e3,g3").s("sawtooth").lpf(1200).orbit(2)`;
    const both = await renderer.render(code, { to: 1 });
    expect(both.problems).toEqual([]);
    const alone = await renderer.render(code, { to: 1, only: ["kick"] });
    expect(alone.problems).toEqual([]);
    expect(peak(alone.channels[0], 0, 2400)).toBeGreaterThan(0.6);
  });

  it("renders the same sound from the same seed, and another from another", async () => {
    // A chord of supersaws is the hard case: its voices start together, and each draws its phases at random.
    const code = `setcpm(30)\n$: note("<[c3,eb3,g3,bb3] [ab2,c3,eb3,g3]>").s("supersaw").unison(7).lpf(800).room(0.5).delay(0.3)\n$: s("white*8").decay(0.05).gain(0.3)\n$: s("pink*2").decay(0.2).crush(4).pan(rand)`;
    const [a, b, c] = [await renderer.render(code, { to: 2, tail: 1 }), await renderer.render(code, { to: 2, tail: 1 }), await renderer.render(code, { to: 2, tail: 1, seed: 7 })];
    const apart = (x: Float32Array, y: Float32Array) => {
      let max = 0;
      for (let i = 0; i < x.length; i++) max = Math.max(max, Math.abs(x[i]! - y[i]!));
      return 20 * Math.log10(max || 1e-12);
    };
    // Not bit for bit (Chrome's audio maths rounds differently from run to run), but far under anything audible.
    expect(apart(a.channels[0], b.channels[0])).toBeLessThan(-110);
    expect(apart(a.channels[1], b.channels[1])).toBeLessThan(-110);
    expect(apart(a.channels[0], c.channels[0])).toBeGreaterThan(-40);
  });

  it("keeps a tail, or folds it over the start for a loop", async () => {
    const code = `$: note("~ c4").s("sine").decay(.1).sustain(0).room(.9).rsize(4)`;
    const plain = await renderer.render(code, { to: 1, tail: 2 });
    expect(plain.seconds).toBe(4);
    expect(plain.bodySeconds).toBe(2);
    expect(plain.loop).toBe(false);
    // The note is in the second half; the reverb rings on into the tail.
    expect(rmsDb(plain.channels[0], 0, 0.5 * RATE)).toBeLessThan(-100);
    expect(rmsDb(plain.channels[0], 2.1 * RATE, 2.6 * RATE)).toBeGreaterThan(-70);
    const loop = await renderer.render(code, { to: 1, tail: 2, loop: true });
    expect(loop.seconds).toBe(2);
    expect(loop.bodySeconds).toBe(2);
    // The same ring now opens the loop.
    expect(rmsDb(loop.channels[0], 0.1 * RATE, 0.6 * RATE)).toBeCloseTo(rmsDb(plain.channels[0], 2.1 * RATE, 2.6 * RATE), 0);
    await expect(renderer.render(code, { to: 1, tail: 3, loop: true })).rejects.toMatchObject({ code: "bad-options" });
  });

  it("opens a stretch with what the cycles before it left ringing", async () => {
    const code = `$: note("<[~ c4] ~>").s("sine").decay(.1).sustain(0).room(.9).rsize(4)`;
    const cold = await renderer.render(code, { from: 1, to: 2 });
    expect(cold.problems.map((p) => p.code)).toEqual(["no-events"]);
    expect(peak(cold.channels[0])).toBe(0);
    const warm = await renderer.render(code, { from: 1, to: 2, lead: 1 });
    expect(warm.seconds).toBe(2);
    expect(rmsDb(warm.channels[0], 0, 0.5 * RATE)).toBeGreaterThan(-70);
    await expect(renderer.render(code, { from: 1, to: 2, lead: 2 })).rejects.toMatchObject({ code: "bad-options" });
  });

  it("plays only the parts asked for", async () => {
    const code = `kick: s("sbd")\nhat: s("~ white").decay(.05).sustain(0).hpf(8000)\n_off: s("sbd*8")\n$: note("c5").s("sine").gain(.2)`;
    const all = await renderer.render(code, { to: 1 });
    expect(all.parts).toEqual([
      { name: "kick", muted: false, selected: true, solo: false },
      { name: "hat", muted: false, selected: true, solo: false },
      { name: "off", muted: true, selected: false, solo: false },
      { name: "$1", muted: false, selected: true, solo: false },
    ]);
    const hat = await renderer.render(code, { to: 1, only: ["hat"] });
    expect(hat.events).toBe(1);
    expect(peak(hat.channels[0], 0, 0.9 * RATE)).toBe(0);
    expect(peak(hat.channels[0], RATE, 1.1 * RATE)).toBeGreaterThan(0.01);
    const without = await renderer.render(code, { to: 1, mute: ["kick", "$1"] });
    expect(without.events).toBe(1);
    const anonymous = await renderer.render(code, { to: 1, only: ["$1"] });
    expect(anonymous.events).toBe(1);
    await expect(renderer.render(code, { to: 1, only: ["snare"] })).rejects.toMatchObject({ code: "bad-options", message: expect.stringContaining("kick, hat, off, $1") });
  });

  it("refuses code that does not evaluate, and options that make no sense", async () => {
    await expect(renderer.render(`$: s("sbd"`, { to: 1 })).rejects.toMatchObject({ code: "bad-code" });
    await expect(renderer.render(`$: s("sbd").nothingCalledThis()`, { to: 1 })).rejects.toMatchObject({ code: "bad-code" });
    await expect(renderer.render(`$: s("sbd")`, {})).rejects.toMatchObject({ code: "bad-options" });
    await expect(renderer.render(`$: s("sbd")`, { to: 1, seconds: 2 })).rejects.toMatchObject({ code: "bad-options" });
    await expect(renderer.render(`$: s("sbd")`, { to: 1, sampleRate: 12345 })).rejects.toMatchObject({ code: "bad-options" });
    await expect(renderer.render(`$: s("sbd")`, { to: 2000 })).rejects.toMatchObject({ code: "bad-options", message: expect.stringContaining("loop") });
    await expect(renderer.render("  ", { to: 1 })).rejects.toBeInstanceOf(StrudelError);
  });

  it("reports a sound it could not play, and still renders the rest", async () => {
    const made = await renderer.render(`$: s("sbd nosuchsound")`, { to: 1 });
    expect(made.problems).toEqual([expect.objectContaining({ level: "error", code: "render", message: expect.stringContaining("nosuchsound") })]);
    expect(peak(made.channels[0])).toBeGreaterThan(0.5);
  });

  it("evaluates a piece written with the REPL's visuals and sliders", async () => {
    const made = await renderer.render(`$: note("c3 e3").s("sawtooth").lpf(slider(800, 100, 4000))._pianoroll().scope()`, { to: 1 });
    expect(made.problems).toEqual([]);
    expect(made.events).toBe(2);
  });

  describe("samples", () => {
    const dir = mkdtempSync(join(tmpdir(), "strudel-files-"));
    const blip = Float32Array.from({ length: 4800 }, (_, i) => Math.sin((2 * Math.PI * 880 * i) / RATE) * Math.exp(-i / 600));
    mkdirSync(join(dir, "assets", "sounds"), { recursive: true });
    writeFileSync(join(dir, "assets", "sounds", "blip.wav"), encodeWav([blip], RATE, "pcm16"));
    writeFileSync(join(dir, "secret.txt"), "not audio");

    it("loads audio files of the directory it was given, by relative path", async () => {
      const code = `samples({ blip: 'assets/sounds/blip.wav' })\n$: s("blip*2")`;
      const made = await renderer.render(code, { to: 1, files: dir });
      expect(made.problems).toEqual([]);
      expect(peak(made.channels[0], 0, 4800)).toBeGreaterThan(0.3);
      expect(made.requests).toEqual([expect.objectContaining({ path: "assets/sounds/blip.wav", outcome: "served", sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) })]);
    });

    it("serves nothing else: not another kind of file, not a path that leaves the directory, not without a directory", async () => {
      const other = await renderer.render(`samples({ x: 'secret.txt' })\n$: s("x")`, { to: 1, files: dir });
      expect(other.problems.map((p) => p.code)).toContain("missing-file");
      const outside = await renderer.render(`samples({ x: '../outside.wav' })\n$: s("x")`, { to: 1, files: join(dir, "assets") });
      expect(outside.problems.map((p) => p.code)).toContain("missing-file");
      const none = await renderer.render(`samples({ blip: 'assets/sounds/blip.wav' })\n$: s("blip")`, { to: 1 });
      expect(none.problems.map((p) => p.code)).toContain("missing-file");
      expect(peak(none.channels[0])).toBe(0);
    });

    it("says so when sample names are written as patterns", async () => {
      await expect(renderer.render(`samples({ blip: "assets/sounds/blip.wav" })\n$: s("blip")`, { to: 1, files: dir })).rejects.toMatchObject({
        code: "bad-code", message: expect.stringContaining("single quotes"),
      });
    });

    it("keeps the network off unless it is allowed", async () => {
      // samples() of an address is awaited by the transpiler: the piece stops there.
      await expect(renderer.render(`samples('github:tidalcycles/dirt-samples')\n$: s("bd")`, { to: 1 })).rejects.toMatchObject({
        code: "bad-code", message: expect.stringContaining("the network is off"),
      });
      const seen = await renderer.inspect(`samples('github:tidalcycles/dirt-samples')\n$: s("bd")`);
      expect(seen.ok).toBe(false);
      expect(seen.problems.map((p) => p.code)).toEqual(["eval", "blocked-request"]);
      expect(seen.requests).toEqual([expect.objectContaining({ outcome: "blocked", url: expect.stringContaining("githubusercontent.com") })]);
    });
  });
});
