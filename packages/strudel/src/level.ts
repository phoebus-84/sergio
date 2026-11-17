// ---------------------------------------------------------------------------
// A render brought to a level: one gain for the whole file, never a
// compressor or a limiter. Loudness is reached when the peaks allow it; when
// they do not, the file stays under the ceiling and is quieter than asked,
// and says so.
// ---------------------------------------------------------------------------

import { integratedLoudness } from "./analyze.js";
import { StrudelError } from "./errors.js";

export interface LevelOptions {
  /** Integrated loudness to reach, LUFS. Null keeps the render's own level (the ceiling still holds). */
  loudness?: number | null;
  /** The highest sample peak allowed, dBFS. Default −1. */
  peak?: number;
  /** Instead of a loudness: exactly this gain, dB. For stems, which must keep the level they have in the mix. */
  gain?: number;
  /** Seconds of fade at the start and at the end. */
  fadeIn?: number;
  fadeOut?: number;
}

export interface Leveled {
  channels: Float32Array[];
  /** The gain applied, dB. */
  gain: number;
  /** What the gain was set by: the loudness asked for, the peak ceiling, a given gain, or nothing. */
  basis: "loudness" | "peak" | "given" | "none";
  /** The ceiling kept the file under the loudness asked for. */
  held: boolean;
  /** Integrated loudness of the result, LUFS; null when too short or too quiet to measure. */
  loudness: number | null;
  /** Sample peak of the result, dBFS. */
  peak: number;
}

const round = (n: number) => Math.round(n * 10) / 10;

export function levelAudio(channels: Float32Array[], sampleRate: number, options: LevelOptions = {}): Leveled {
  const ceiling = options.peak ?? -1;
  if (!(ceiling <= 0)) throw new StrudelError("bad-options", "peak is a ceiling in dBFS, 0 or lower");
  for (const [name, value] of [["fadeIn", options.fadeIn], ["fadeOut", options.fadeOut]] as const) {
    if (value !== undefined && !(Number.isFinite(value) && value >= 0)) throw new StrudelError("bad-options", `${name} is seconds, 0 or more`);
  }
  const frames = channels[0]?.length ?? 0;
  let max = 0;
  for (const channel of channels) for (let i = 0; i < frames; i++) max = Math.max(max, Math.abs(channel[i]!));
  const peak = max > 0 ? 20 * Math.log10(max) : -Infinity;
  const measured = integratedLoudness(channels, sampleRate);

  let gain = 0;
  let basis: Leveled["basis"] = "none";
  let held = false;
  if (max > 0) {
    if (options.gain !== undefined) {
      gain = options.gain;
      basis = "given";
    } else if (options.loudness !== undefined && options.loudness !== null) {
      if (measured !== null) {
        gain = options.loudness - measured;
        basis = "loudness";
      } else {
        // Too short for a loudness (a hit, a blip): its peak goes to the ceiling.
        gain = ceiling - peak;
        basis = "peak";
      }
    }
    if (peak + gain > ceiling) {
      held = basis === "loudness";
      gain = ceiling - peak;
      if (basis !== "loudness") basis = "peak";
    }
  }

  const factor = 10 ** (gain / 20);
  const fadeIn = Math.min(frames, Math.round((options.fadeIn ?? 0) * sampleRate));
  const fadeOut = Math.min(frames, Math.round((options.fadeOut ?? 0) * sampleRate));
  const out = channels.map((channel) => {
    const made = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let g = factor;
      // Quarter-sine: two of these crossed keep the power constant.
      if (i < fadeIn) g *= Math.sin((Math.PI / 2) * (i / fadeIn));
      if (i >= frames - fadeOut) g *= Math.sin((Math.PI / 2) * ((frames - 1 - i) / fadeOut));
      made[i] = channel[i]! * g;
    }
    return made;
  });
  return {
    channels: out,
    gain: round(gain),
    basis,
    held,
    loudness: measured === null ? null : round(measured + gain),
    peak: Number.isFinite(peak) ? round(peak + gain) : peak,
  };
}
