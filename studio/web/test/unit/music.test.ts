import { describe, expect, it } from "vitest";
import type { MusicRenderRecord } from "@studio/contracts/src/music-renders.mjs";
import {
  DEFAULT_RENDER_FORM, bandsOf, inLevel, levelLine, musicWorkspace, pianoRoll, renderRequest, rollPage, shapeLine, type PieceNote,
} from "../../src/lib/music";

const record: MusicRenderRecord = {
  apiVersion: "studio.video/v1alpha1",
  kind: "MusicRender",
  engine: { name: "strudel", version: "1.3.0" },
  source: { path: "music/tema.strudel", hash: "sha256:a" },
  request: {},
  tempo: { cps: 0.5, cyclesPerMinute: 30 },
  range: { from: 0, to: 16 },
  output: { path: "assets/sounds/tema.wav", hash: "sha256:b", durationSeconds: 34, bodySeconds: 32, sampleRate: 48000, channels: 2, loop: false },
  parts: [
    { name: "drums", muted: false, selected: true, solo: false },
    { name: "bass", muted: false, selected: true, solo: false },
    { name: "idea", muted: true, selected: false, solo: false },
  ],
  level: { gain: 4.2, basis: "loudness", held: false, loudness: -18, peak: -3.1, target: -18, ceiling: -1 },
  analysis: { bands: { sub: -9, bass: -3, lowMid: -8, mid: -18, highMid: -36, high: -60 } },
  inputs: {},
  fetched: [],
  stems: [],
  concerns: [],
  createdAt: "2026-11-17T10:00:00.000Z",
};

describe("where a piece belongs", () => {
  it("is the directory that holds its music folder", () => {
    expect(musicWorkspace("music/tema.strudel")).toEqual({ within: "", piece: "music/tema.strudel" });
    expect(musicWorkspace("music/cues/sting.strudel")).toEqual({ within: "", piece: "music/cues/sting.strudel" });
    // A channel's source is a workspace of its own.
    expect(musicWorkspace("sources/lampo/music/tema.strudel")).toEqual({ within: "sources/lampo", piece: "music/tema.strudel" });
    expect(inLevel("sources/lampo", "assets/sounds/tema.wav")).toBe("sources/lampo/assets/sounds/tema.wav");
    expect(inLevel("", "assets/sounds/tema.wav")).toBe("assets/sounds/tema.wav");
  });

  it("is nowhere for a file that is not a piece in a music folder", () => {
    expect(musicWorkspace("notes/tema.strudel")).toBeNull();
    expect(musicWorkspace("music/tema.txt")).toBeNull();
    expect(musicWorkspace("music")).toBeNull();
  });
});

describe("a render request from the form", () => {
  it("says only what was filled in", () => {
    expect(renderRequest("music/tema.strudel", "", DEFAULT_RENDER_FORM)).toEqual({ request: { path: "music/tema.strudel", cycles: 8, tail: 2 } });
    expect(renderRequest("music/tema.strudel", "sources/lampo", {
      length: "seconds", amount: "30", from: "4", tail: "0", loop: true, stems: true, output: " music/tema-loop.wav ",
    })).toEqual({ request: { within: "sources/lampo", path: "music/tema.strudel", seconds: 30, from: 4, loop: true, stems: true, output: "music/tema-loop.wav" } });
  });

  it("names what is wrong before anything is sent", () => {
    const filled = (change: Partial<typeof DEFAULT_RENDER_FORM>) => renderRequest("music/tema.strudel", "", { ...DEFAULT_RENDER_FORM, ...change });
    expect(filled({ amount: "" })).toEqual({ error: "how many cycles? a number above 0" });
    expect(filled({ amount: "0", length: "seconds" })).toEqual({ error: "how many seconds? a number above 0" });
    expect(filled({ from: "-1" })).toEqual({ error: "the first cycle is 0 or later" });
    expect(filled({ tail: "90" })).toEqual({ error: "the tail is seconds, from 0 to 60" });
    expect(filled({ output: "assets/sounds/tema.mp3" })).toEqual({ error: "the output is a .wav file" });
  });
});

describe("a render's record in words", () => {
  it("says its length, its cycles and how it ends", () => {
    expect(shapeLine(record)).toBe("34 s · cycles 0–16 · 2 s tail");
    expect(shapeLine({ ...record, output: { ...record.output, durationSeconds: 32, loop: true } })).toBe("32 s · cycles 0–16 · seamless loop");
    expect(shapeLine({ ...record, output: { ...record.output, durationSeconds: 32 } })).toBe("32 s · cycles 0–16 · no tail");
    // A part left out by the request is named; one muted in the code is not news.
    const partial = { ...record, parts: [record.parts[0]!, { ...record.parts[1]!, selected: false }, record.parts[2]!] };
    expect(shapeLine(partial)).toBe("34 s · cycles 0–16 · 2 s tail · only drums");
  });

  it("says its level, and when its peaks held it back", () => {
    expect(levelLine(record)).toBe("-18.0 LUFS · peak -3.1 dBFS · gain +4.2 dB");
    expect(levelLine({ ...record, level: { gain: -2, basis: "loudness", held: true, loudness: -19.5, peak: -1, target: -18, ceiling: -1 } }))
      .toBe("-19.5 LUFS · peak -1.0 dBFS · gain -2 dB · 1.5 dB under the -18 asked");
    expect(levelLine({ ...record, level: { gain: 0, basis: "none", held: false, loudness: null, peak: null, target: null, ceiling: -1 } })).toBe("– LUFS · peak – dBFS · its own level");
  });

  it("gives the spectrum as bars: all of the energy is full, −36 dB and under is empty", () => {
    const bands = bandsOf(record);
    expect(bands.map((b) => b.label)).toEqual(["sub", "bass", "low-mid", "mid", "high-mid", "high"]);
    expect(bands.map((b) => +b.fill.toFixed(2))).toEqual([0.75, 0.92, 0.78, 0.5, 0, 0]);
    expect(bandsOf({ ...record, analysis: {} }).every((b) => b.db === null && b.fill === 0)).toBe(true);
  });
});

describe("the roll", () => {
  const notes: PieceNote[] = [
    { at: 0, cycles: 1, part: "bass", sound: "sawtooth", midi: 36, gain: 1 },
    { at: 1, cycles: 1, part: "bass", sound: "sawtooth", midi: 48, gain: 0.5 },
    { at: 0, cycles: 0.25, part: "drums", sound: "sbd", midi: null, gain: 1 },
    { at: 0.5, cycles: 0.25, part: "drums", sound: "white", midi: null, gain: 0.2 },
    { at: 3.5, cycles: 1, part: "drums", sound: "sbd", midi: null, gain: 1 },
  ];
  const view = { from: 0, to: 4, width: 400, height: 100 };

  it("gives each part a lane, in the piece's order", () => {
    const { lanes } = pianoRoll(notes, ["drums", "bass"], view);
    expect(lanes).toEqual([{ part: "drums", index: 0, top: 0, height: 50 }, { part: "bass", index: 1, top: 50, height: 50 }]);
    // With no labelled parts, the lanes are the notes' own.
    expect(pianoRoll(notes, [], view).lanes.map((l) => l.part)).toEqual(["bass", "drums"]);
  });

  it("places events in time, higher pitches higher, each unpitched sound on its own row", () => {
    const { rects } = pianoRoll(notes, ["drums", "bass"], view);
    const [kick, hat, late, low, high] = rects;
    expect([kick!.x, hat!.x, low!.x, high!.x]).toEqual([0, 50, 0, 100]);
    expect(low!.w).toBeCloseTo(99);
    expect(high!.y).toBeLessThan(low!.y);
    expect(kick!.y).not.toBe(hat!.y);
    expect(kick!.lane).toBe(0);
    expect(low!.lane).toBe(1);
    // Every event stays inside its lane.
    for (const r of rects) {
      const top = r.lane * 50;
      expect(r.y).toBeGreaterThanOrEqual(top);
      expect(r.y + r.h).toBeLessThanOrEqual(top + 50);
    }
    // An event running past the view is cut at its edge; a quiet one is drawn fainter, never invisible.
    expect(late!.x + late!.w).toBeLessThanOrEqual(400);
    expect(hat!.weight).toBe(0.35);
  });

  it("shows only what falls in the view", () => {
    expect(pianoRoll(notes, ["drums", "bass"], { ...view, from: 2, to: 3 }).rects).toHaveLength(0);
    expect(pianoRoll(notes, ["drums", "bass"], { ...view, from: 3, to: 4 }).rects).toHaveLength(1);
  });

  it("turns its pages with the music", () => {
    expect(rollPage(0, 8)).toEqual({ from: 0, to: 8 });
    expect(rollPage(7.99, 8)).toEqual({ from: 0, to: 8 });
    expect(rollPage(8, 8)).toEqual({ from: 8, to: 16 });
    expect(rollPage(21.5, 4)).toEqual({ from: 20, to: 24 });
  });
});
