import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeAudio, decodeWav, encodeWav, integratedLoudness } from "../src/index.js";

const RATE = 48000;
const sine = (hz: number, seconds: number, gain = 0.5) => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => gain * Math.sin((2 * Math.PI * hz * i) / RATE));
const noise = (seconds: number, gain = 0.25) => {
  let state = 22222;
  return Float32Array.from({ length: Math.round(seconds * RATE) }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    return (state / 2147483648) * gain;
  });
};
const ffmpeg = (() => {
  try {
    execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-version"], { stdio: "ignore" });
    return process.env.FFMPEG_PATH || "ffmpeg";
  } catch {
    return null;
  }
})();

describe("analyzeAudio", () => {
  it("measures level, clipping and silence at the ends", () => {
    const tone = sine(440, 2);
    const padded = new Float32Array(RATE * 4);
    padded.set(tone, RATE);
    const a = analyzeAudio([padded, padded], RATE);
    expect(a.seconds).toBe(4);
    expect(a.peak).toBeCloseTo(-6, 0);
    expect(a.rms).toBeCloseTo(-12, 0);
    expect(a.crest).toBeCloseTo(6, 0);
    expect(a.head).toBeCloseTo(1, 2);
    expect(a.tail).toBeCloseTo(1, 2);
    expect(a.clipped).toBe(0);
    expect(a.silent).toBe(false);
    expect(analyzeAudio([sine(440, 1, 1.5)], RATE).clipped).toBeGreaterThan(1000);
    expect(analyzeAudio([new Float32Array(RATE)], RATE)).toMatchObject({ silent: true, lufs: null, peak: -Infinity });
  });

  it("says where the energy is", () => {
    expect(analyzeAudio([sine(40, 2)], RATE).bands.sub).toBeGreaterThan(-0.5);
    const bass = analyzeAudio([sine(100, 2)], RATE);
    expect(bass.bands.bass).toBeGreaterThan(-0.5);
    expect(bass.bands.high).toBeLessThan(-40);
    expect(bass.centroid).toBeGreaterThan(80);
    expect(bass.centroid).toBeLessThan(130);
    expect(analyzeAudio([sine(1000, 2)], RATE).bands.mid).toBeGreaterThan(-0.5);
    expect(analyzeAudio([sine(4000, 2)], RATE).bands.highMid).toBeGreaterThan(-0.5);
    expect(analyzeAudio([sine(10000, 2)], RATE).bands.high).toBeGreaterThan(-0.5);
    // White noise: most of its energy is above 6 kHz, because most of the hertz are.
    const white = analyzeAudio([noise(2)], RATE);
    expect(white.bands.high).toBeGreaterThan(-3);
    expect(white.bands.bass).toBeLessThan(-18);
  });

  it("reads the stereo image", () => {
    const l = sine(440, 1);
    const mono = analyzeAudio([l, l], RATE).stereo;
    expect(mono).toEqual({ correlation: 1, width: -Infinity, balance: 0 });
    const inverted = analyzeAudio([l, l.map((x) => -x)], RATE).stereo;
    expect(inverted.correlation).toBe(-1);
    const apart = analyzeAudio([l, sine(660, 1)], RATE).stereo;
    expect(Math.abs(apart.correlation)).toBeLessThan(0.05);
    expect(apart.width).toBeCloseTo(0, 0);
    expect(analyzeAudio([l, l.map((x) => x / 2)], RATE).stereo.balance).toBeCloseTo(6, 0);
  });

  it("draws the piece's shape in at most 120 windows", () => {
    const loudThenQuiet = new Float32Array(RATE * 4);
    loudThenQuiet.set(sine(440, 2, 0.5), 0);
    loudThenQuiet.set(sine(440, 2, 0.05), RATE * 2);
    const short = analyzeAudio([loudThenQuiet], RATE).envelope;
    expect(short.window).toBe(0.25);
    expect(short.rms).toHaveLength(16);
    expect(short.rms[0]).toBeCloseTo(-9, 0);
    expect(short.rms[15]).toBeCloseTo(-29, 0);
    const long = analyzeAudio([new Float32Array(RATE * 300)], RATE).envelope;
    expect(long.window).toBe(2.5);
    expect(long.rms).toHaveLength(120);
  });

  it("measures loudness as BS.1770 defines it", () => {
    // The standard's own reference: a 997 Hz sine at full scale in one channel reads −3.01 LKFS.
    expect(integratedLoudness([sine(997, 5, 1)], RATE)).toBeCloseTo(-3.0, 1);
    expect(integratedLoudness([sine(997, 5, 0.1)], RATE)).toBeCloseTo(-23.0, 1);
    // Two channels carrying it are 3 dB louder than one.
    expect(integratedLoudness([sine(997, 5, 0.1), sine(997, 5, 0.1)], RATE)).toBeCloseTo(-20.0, 1);
    expect(integratedLoudness([sine(997, 0.2, 1)], RATE)).toBeNull();
  });

  it.skipIf(!ffmpeg)("agrees with ffmpeg's meter", () => {
    const dir = mkdtempSync(join(tmpdir(), "strudel-lufs-"));
    for (const [name, rate, channels] of [
      ["mix-48k", 48000, [mix(48000, 0), mix(48000, 1)]],
      ["mix-44k", 44100, [mix(44100, 0), mix(44100, 1)]],
    ] as const) {
      const file = join(dir, `${name}.wav`);
      writeFileSync(file, encodeWav([...channels], rate, "f32"));
      // ffmpeg writes its meter's summary to standard error.
      const text = spawnSync(ffmpeg!, ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128=framelog=quiet", "-f", "null", "-"], { encoding: "utf-8" }).stderr;
      const measured = Number(/I:\s+(-?[\d.]+) LUFS/.exec(text.slice(text.lastIndexOf("Summary")))?.[1]);
      expect(Number.isFinite(measured)).toBe(true);
      expect(Math.abs(integratedLoudness([...channels], rate)! - measured)).toBeLessThan(0.3);
    }
  });
});

/** Something like music: a loud passage, a quiet one, bass and noise, different left and right. */
function mix(rate: number, channel: number): Float32Array {
  const seconds = 12;
  let state = 1234 + channel;
  return Float32Array.from({ length: seconds * rate }, (_, i) => {
    const t = i / rate;
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    const level = t < 5 ? 0.4 : t < 9 ? 0.04 : 0.25;
    return level * (0.6 * Math.sin(2 * Math.PI * 80 * t) + 0.3 * Math.sin(2 * Math.PI * (channel ? 660 : 440) * t) + 0.2 * (state / 2147483648));
  });
}

describe("WAV", () => {
  it("writes and reads float and PCM", () => {
    const left = sine(440, 0.1, 0.5);
    const right = sine(880, 0.1, 0.25);
    for (const [format, tolerance] of [["f32", 1e-7], ["pcm24", 2e-7], ["pcm16", 4e-5]] as const) {
      const back = decodeWav(encodeWav([left, right], RATE, format));
      expect(back.sampleRate).toBe(RATE);
      expect(back.channels).toHaveLength(2);
      expect(back.channels[0]!.length).toBe(left.length);
      let worst = 0;
      for (let i = 0; i < left.length; i++) worst = Math.max(worst, Math.abs(back.channels[0]![i]! - left[i]!), Math.abs(back.channels[1]![i]! - right[i]!));
      expect(worst).toBeLessThan(tolerance);
    }
  });

  it("keeps what passes full scale as float, and clamps it as PCM", () => {
    const hot = Float32Array.from([1.5, -1.5, 0.5]);
    expect([...decodeWav(encodeWav([hot], RATE, "f32")).channels[0]!]).toEqual([1.5, -1.5, 0.5]);
    const clamped = decodeWav(encodeWav([hot], RATE, "pcm24")).channels[0]!;
    expect(clamped[0]).toBeCloseTo(1, 5);
    expect(clamped[1]).toBeCloseTo(-1, 5);
  });

  it("refuses what is not a WAV", () => {
    expect(() => decodeWav(Buffer.from("not a wav file at all"))).toThrow(/not a WAV/);
    expect(() => encodeWav([], RATE)).toThrow(/at least one channel/);
  });
});
