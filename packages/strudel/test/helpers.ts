import { findChrome } from "../src/index.js";

/** A browser to render with, or null: the tests that need one are skipped without it. */
export const chrome: string | null = (() => {
  try {
    return findChrome();
  } catch {
    return null;
  }
})();

export const rmsDb = (samples: Float32Array, from = 0, to = samples.length) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i]! * samples[i]!;
  return 10 * Math.log10(sum / Math.max(1, to - from) || 1e-12);
};

export const peak = (samples: Float32Array, from = 0, to = samples.length) => {
  let max = 0;
  for (let i = from; i < to; i++) max = Math.max(max, Math.abs(samples[i]!));
  return max;
};

export const firstAbove = (samples: Float32Array, threshold: number, from = 0) => {
  for (let i = from; i < samples.length; i++) if (Math.abs(samples[i]!) > threshold) return i;
  return -1;
};
