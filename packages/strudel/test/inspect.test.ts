import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StrudelRenderer, strudelVersion } from "../src/index.js";
import { chrome } from "./helpers.js";

describe.skipIf(!chrome)("inspecting a piece", () => {
  let renderer: StrudelRenderer;
  beforeAll(async () => {
    renderer = await StrudelRenderer.launch();
  });
  afterAll(async () => {
    await renderer.close();
  });

  it("says what each part plays, cycle by cycle", async () => {
    const seen = await renderer.inspect(
      `setcpm(120/4)\ndrums: s("sbd*4, [~ white]*2").decay(.1)\nbass: note("<c2 [ab1 bb1]>").s("sawtooth").lpf(500)\n_lead: note("c5*16").s("square")`,
      { to: 4, events: 2 },
    );
    expect(seen.ok).toBe(true);
    expect(seen.cps).toBe(0.5);
    expect(seen.seconds).toBe(8);
    expect(seen.events).toBe(30);
    expect(seen.perCycle).toEqual([7, 8, 7, 8]);
    expect(seen.parts.map((p) => [p.name, p.muted, p.selected, p.events])).toEqual([["drums", false, true, 24], ["bass", false, true, 6], ["lead", true, false, 64]]);
    const bass = seen.parts[1]!;
    expect(bass.notes).toEqual({ low: 32, high: 36 });
    expect(bass.sounds).toEqual([{ name: "sawtooth", count: 6 }]);
    expect(bass.listed).toEqual([
      { at: 0, cycles: 1, value: { note: "c2", s: "sawtooth", cutoff: 500 } },
      { at: 1, cycles: 0.5, value: { note: "ab1", s: "sawtooth", cutoff: 500 } },
    ]);
    expect(seen.sounds).toEqual([
      { name: "sbd", count: 16, type: "synth" },
      { name: "white", count: 8, type: "synth" },
      { name: "sawtooth", count: 6, type: "synth" },
    ]);
    expect(seen.problems).toEqual([]);
  });

  it("describes a piece that is one unlabelled pattern", async () => {
    const seen = await renderer.inspect(`note("c3 e3 g3").s("triangle")`, { to: 1, events: 5 });
    expect(seen.ok).toBe(true);
    expect(seen.parts).toEqual([]);
    expect(seen.events).toBe(3);
    expect(seen.listed.map((e) => e.value.note)).toEqual(["c3", "e3", "g3"]);
  });

  it("names what is wrong instead of failing", async () => {
    const syntax = await renderer.inspect(`$: s("sbd"`);
    expect(syntax.ok).toBe(false);
    expect(syntax.problems[0]).toMatchObject({ level: "error", code: "eval" });

    const mini = await renderer.inspect(`$: s("sbd [")`);
    expect(mini.problems[0]).toMatchObject({ level: "error", code: "eval" });

    const unknown = await renderer.inspect(`$: s("bd hh")`);
    expect(unknown.ok).toBe(false);
    expect(unknown.problems.filter((p) => p.code === "unknown-sound").map((p) => p.message)).toEqual([
      expect.stringContaining(`"bd"`), expect.stringContaining(`"hh"`),
    ]);

    const bare = await renderer.inspect(`$: sequence("a", "b")`);
    expect(bare.problems.map((p) => p.code)).toContain("malformed-events");

    const empty = await renderer.inspect(`$: s("~ ~")`);
    expect(empty.problems.map((p) => p.code)).toEqual(["no-events"]);
    expect(empty.ok).toBe(false);
  });

  it("warns about labels that change what plays", async () => {
    const solo = await renderer.inspect(`Strings: note("c4").s("sawtooth")\nbass: note("c2").s("sine")`, { to: 1 });
    expect(solo.ok).toBe(true);
    expect(solo.problems).toEqual([expect.objectContaining({ level: "warning", code: "solo-label", message: expect.stringContaining("Strings") })]);
    // The REPL plays the soloed part alone: so does the count.
    expect(solo.events).toBe(1);

    const twice = await renderer.inspect(`bass: note("c2").s("sine")\nbass: note("c2 c2").s("sine")`, { to: 1 });
    expect(twice.problems.map((p) => p.code)).toEqual(["duplicate-label"]);
    expect(twice.events).toBe(2);

    const quiet = await renderer.inspect(`a: s("sbd")\nb: s("<~ sbd>")`, { to: 1 });
    expect(quiet.problems).toEqual([expect.objectContaining({ level: "warning", code: "silent-part" })]);

    const asked = await renderer.inspect(`a: s("sbd")`, { only: ["b"] });
    expect(asked.problems.map((p) => p.code)).toContain("unknown-part");
  });

  it("lists the engine's own sounds", async () => {
    const names = (await renderer.sounds()).map((s) => s.name);
    for (const name of ["sine", "triangle", "square", "sawtooth", "supersaw", "pulse", "sbd", "white", "pink", "brown"]) expect(names).toContain(name);
    expect(strudelVersion()).toBe("1.3.0");
  });
});
