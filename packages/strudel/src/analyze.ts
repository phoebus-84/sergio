// ---------------------------------------------------------------------------
// What a render sounds like, in numbers: for whoever cannot listen to it.
// Level and loudness, where the energy sits across the spectrum, how wide the
// stereo image is, and how the level moves through the piece.
// ---------------------------------------------------------------------------

export interface Bands {
  /** 20–60 Hz */
  sub: number;
  /** 60–250 Hz */
  bass: number;
  /** 250–500 Hz */
  lowMid: number;
  /** 500 Hz–2 kHz */
  mid: number;
  /** 2–6 kHz */
  highMid: number;
  /** 6–20 kHz */
  high: number;
}

export interface AudioAnalysis {
  seconds: number;
  /** Sample peak, dBFS. Above 0 the file clips once written as PCM. */
  peak: number;
  /** dBFS. */
  rms: number;
  /** Integrated loudness, LUFS (ITU-R BS.1770, gated); null when too quiet or too short to measure. */
  lufs: number | null;
  /** Peak over RMS, dB: about 6–10 for a sustained pad, 12–20 with drums. */
  crest: number;
  /** Samples at or beyond full scale. */
  clipped: number;
  /** Mean of the signal, linear: far from 0 is a DC offset. */
  dc: number;
  silent: boolean;
  /** Seconds below −60 dBFS at the start and at the end. */
  head: number;
  tail: number;
  /** Share of the energy in each band, in dB relative to the whole (0 would be all of it). */
  bands: Bands;
  /** Spectral centroid, Hz: where the "weight" of the sound is. */
  centroid: number;
  stereo: {
    /** +1 mono, 0 unrelated channels, negative: cancels when summed to mono. */
    correlation: number;
    /** Side over mid, dB: −∞ mono, about −15 to −6 a natural width, above 0 wider than it is centred. */
    width: number;
    /** Left over right, dB. */
    balance: number;
  };
  /** RMS in dBFS of consecutive windows of `window` seconds: the shape of the piece. */
  envelope: { window: number; rms: number[] };
}

const dB = (power: number) => (power > 0 ? 10 * Math.log10(power) : -Infinity);
const round = (n: number, digits = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** digits) / 10 ** digits : n);

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = (-2 * Math.PI) / size;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < size / 2; k++) {
        const a = start + k;
        const b = a + size / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}

const EDGES: [keyof Bands, number, number][] = [
  ["sub", 20, 60], ["bass", 60, 250], ["lowMid", 250, 500], ["mid", 500, 2000], ["highMid", 2000, 6000], ["high", 6000, 20000],
];

function spectrum(mono: Float32Array, sampleRate: number): { bands: Bands; centroid: number } {
  const size = 4096;
  const power = new Float64Array(size / 2);
  const window = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let start = 0; start + size <= mono.length || start === 0; start += size / 2) {
    for (let i = 0; i < size; i++) {
      re[i] = (mono[start + i] ?? 0) * window[i]!;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < size / 2; k++) power[k]! += re[k]! * re[k]! + im[k]! * im[k]!;
    if (start + size >= mono.length) break;
  }
  const hz = sampleRate / size;
  let total = 0;
  let weighted = 0;
  const sums = Object.fromEntries(EDGES.map(([name]) => [name, 0])) as unknown as Bands;
  for (let k = 1; k < size / 2; k++) {
    const f = k * hz;
    if (f < 20 || f >= 20000) continue;
    total += power[k]!;
    weighted += power[k]! * f;
    for (const [name, low, high] of EDGES) if (f >= low && f < high) sums[name] += power[k]!;
  }
  const bands = Object.fromEntries(EDGES.map(([name]) => [name, round(dB(total > 0 ? sums[name] / total : 0))])) as unknown as Bands;
  return { bands, centroid: total > 0 ? Math.round(weighted / total) : 0 };
}

/** The two K-weighting filters of BS.1770, for any sample rate. */
function kWeighting(sampleRate: number): [number[], number[]][] {
  const shelf = (() => {
    const f0 = 1681.974450955533;
    const G = 3.999843853973347;
    const Q = 0.7071752369554196;
    const K = Math.tan((Math.PI * f0) / sampleRate);
    const Vh = 10 ** (G / 20);
    const Vb = Vh ** 0.4996667741545416;
    const a0 = 1 + K / Q + K * K;
    return [[(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0], [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0]] as [number[], number[]];
  })();
  const highpass = (() => {
    const f0 = 38.13547087602444;
    const Q = 0.5003270373238773;
    const K = Math.tan((Math.PI * f0) / sampleRate);
    const a0 = 1 + K / Q + K * K;
    return [[1, -2, 1], [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0]] as [number[], number[]];
  })();
  return [shelf, highpass];
}

function filtered(input: Float32Array, stages: [number[], number[]][]): Float64Array {
  let signal = Float64Array.from(input);
  for (const [b, a] of stages) {
    const out = new Float64Array(signal.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < signal.length; i++) {
      const x = signal[i]!;
      const y = b[0]! * x + b[1]! * x1 + b[2]! * x2 - a[1]! * y1 - a[2]! * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      out[i] = y;
    }
    signal = out;
  }
  return signal;
}

/** Integrated loudness in LUFS: 400 ms blocks every 100 ms, gated at −70 LUFS and at 10 LU under the ungated level. */
export function integratedLoudness(channels: Float32Array[], sampleRate: number): number | null {
  const stages = kWeighting(sampleRate);
  const weighted = channels.map((channel) => filtered(channel, stages));
  const block = Math.round(0.4 * sampleRate);
  const hop = Math.round(0.1 * sampleRate);
  const frames = channels[0]?.length ?? 0;
  if (frames < block) return null;
  const powers: number[] = [];
  for (let start = 0; start + block <= frames; start += hop) {
    let sum = 0;
    for (const channel of weighted) {
      let s = 0;
      for (let i = start; i < start + block; i++) s += channel[i]! * channel[i]!;
      sum += s / block;
    }
    powers.push(sum);
  }
  const loudness = (power: number) => -0.691 + 10 * Math.log10(power);
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  const audible = powers.filter((power) => power > 0 && loudness(power) > -70);
  if (audible.length === 0) return null;
  const gate = loudness(mean(audible)) - 10;
  const kept = audible.filter((power) => loudness(power) > gate);
  return kept.length === 0 ? null : round(loudness(mean(kept)));
}

/** Measure a render. Mono is one channel; stereo two. */
export function analyzeAudio(channels: Float32Array[], sampleRate: number): AudioAnalysis {
  const left = channels[0] ?? new Float32Array(0);
  const right = channels[1] ?? left;
  const frames = left.length;
  let peak = 0, sum = 0, mean = 0, clipped = 0;
  let ll = 0, rr = 0, lr = 0, mid = 0, side = 0;
  for (let i = 0; i < frames; i++) {
    const l = left[i]!;
    const r = right[i]!;
    const a = Math.max(Math.abs(l), Math.abs(r));
    if (a > peak) peak = a;
    if (a >= 1) clipped++;
    sum += (l * l + r * r) / 2;
    mean += (l + r) / 2;
    ll += l * l; rr += r * r; lr += l * r;
    mid += ((l + r) / 2) ** 2;
    side += ((l - r) / 2) ** 2;
  }
  const rms = frames > 0 ? Math.sqrt(sum / frames) : 0;
  const quiet = 10 ** (-60 / 20);
  let head = 0;
  while (head < frames && Math.abs(left[head]!) < quiet && Math.abs(right[head]!) < quiet) head++;
  let tail = 0;
  while (tail < frames - head && Math.abs(left[frames - 1 - tail]!) < quiet && Math.abs(right[frames - 1 - tail]!) < quiet) tail++;

  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) mono[i] = (left[i]! + right[i]!) / 2;

  const seconds = frames / sampleRate;
  // At most 120 windows, of at least a quarter of a second.
  const window = Math.max(0.25, Math.ceil((seconds / 120) * 4) / 4);
  const size = Math.max(1, Math.round(window * sampleRate));
  const envelope: number[] = [];
  for (let start = 0; start < frames; start += size) {
    let s = 0;
    const end = Math.min(frames, start + size);
    for (let i = start; i < end; i++) s += (left[i]! * left[i]! + right[i]! * right[i]!) / 2;
    envelope.push(Math.max(-99, round(dB(s / (end - start)))));
  }

  return {
    seconds: round(seconds, 3),
    peak: round(dB(peak * peak)),
    rms: round(dB(rms * rms)),
    lufs: integratedLoudness(channels.length > 1 ? [left, right] : [left], sampleRate),
    crest: rms > 0 ? round(dB((peak * peak) / (rms * rms))) : 0,
    clipped,
    dc: round(frames > 0 ? mean / frames : 0, 5),
    silent: peak < quiet,
    head: round(head / sampleRate, 3),
    tail: round(tail / sampleRate, 3),
    ...spectrum(mono, sampleRate),
    stereo: {
      correlation: ll > 0 && rr > 0 ? round(lr / Math.sqrt(ll * rr), 2) : 1,
      width: round(dB(mid > 0 ? side / mid : 0)),
      balance: ll > 0 && rr > 0 ? round(dB(ll / rr)) : 0,
    },
    envelope: { window, rms: envelope },
  };
}
