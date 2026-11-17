import { describe, expect, it } from "vitest";
import { analyzeAudio, levelAudio } from "../src/index.js";

const RATE = 48000;
const sine = (hz: number, seconds: number, gain: number) => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => gain * Math.sin((2 * Math.PI * hz * i) / RATE));

describe("levelAudio", () => {
  it("reaches a loudness with one gain", () => {
    const quiet = [sine(997, 3, 0.05), sine(997, 3, 0.05)];
    const made = levelAudio(quiet, RATE, { loudness: -16 });
    expect(made).toMatchObject({ basis: "loudness", held: false, loudness: -16 });
    expect(made.gain).toBeCloseTo(10, 0);
    expect(analyzeAudio(made.channels, RATE).lufs).toBeCloseTo(-16, 1);
    // The input is left as it was.
    expect(Math.max(...quiet[0]!)).toBeCloseTo(0.05, 3);
  });

  it("holds the peaks under the ceiling, and says the loudness was not reached", () => {
    // A click train: very high peaks for its loudness.
    const clicks = new Float32Array(RATE * 3);
    for (let i = 0; i < clicks.length; i += RATE / 4) clicks[i] = 0.9;
    const made = levelAudio([clicks], RATE, { loudness: -14 });
    expect(made.held).toBe(true);
    expect(made.basis).toBe("loudness");
    expect(made.peak).toBe(-1);
    expect(made.loudness!).toBeLessThan(-14);
  });

  it("gives stems the mix's gain, and never lets them pass the ceiling", () => {
    const stem = [sine(220, 2, 0.1)];
    expect(levelAudio(stem, RATE, { gain: 6 })).toMatchObject({ gain: 6, basis: "given", peak: -14 });
    expect(levelAudio(stem, RATE, { gain: 40 })).toMatchObject({ gain: 19, basis: "peak", peak: -1 });
  });

  it("sets something too short to measure by its peak, and leaves silence alone", () => {
    const blip = [sine(880, 0.2, 0.2)];
    expect(levelAudio(blip, RATE, { loudness: -16 })).toMatchObject({ basis: "peak", peak: -1, loudness: null });
    expect(levelAudio([new Float32Array(RATE)], RATE, { loudness: -16 })).toMatchObject({ gain: 0, basis: "none", loudness: null, peak: -Infinity });
  });

  it("keeps the render's level when no loudness is asked, unless it clips", () => {
    expect(levelAudio([sine(440, 2, 0.5)], RATE, { loudness: null })).toMatchObject({ gain: 0, basis: "none", peak: -6 });
    expect(levelAudio([sine(440, 2, 1.5)], RATE, {})).toMatchObject({ gain: -4.5, basis: "peak", peak: -1 });
  });

  it("fades the ends", () => {
    const made = levelAudio([sine(440, 2, 0.5)], RATE, { fadeIn: 0.5, fadeOut: 0.5 }).channels[0]!;
    const peakIn = (from: number, to: number) => Math.max(...made.slice(from * RATE, to * RATE).map(Math.abs));
    expect(peakIn(0, 0.01)).toBeLessThan(0.02);
    expect(peakIn(0.24, 0.26)).toBeCloseTo(0.5 * Math.SQRT1_2, 1);
    expect(peakIn(0.9, 1.1)).toBeCloseTo(0.5, 2);
    expect(peakIn(1.99, 2)).toBeLessThan(0.02);
    expect(() => levelAudio([sine(440, 1, 0.5)], RATE, { peak: 3 })).toThrow(/ceiling/);
    expect(() => levelAudio([sine(440, 1, 0.5)], RATE, { fadeIn: -1 })).toThrow(/fadeIn/);
  });
});
