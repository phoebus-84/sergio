// ---------------------------------------------------------------------------
// Runs inside the headless page, beside the pinned @strudel/web bundle.
//
// It evaluates a piece exactly as the Strudel REPL does (the same `repl`, so
// `$:` and `name:` parts, `setcpm`, `all`, a muting `_name:` behave as they do
// on strudel.cc), says what the piece contains, and renders it offline.
//
// The render is not Strudel's own export. That one schedules every event
// before rendering starts, which loses three things superdough does on the
// main thread while a piece plays: ducking, the release of finished voices and
// the reverb's impulse, which is itself rendered. Here the offline context is
// suspended every few milliseconds, the events of the next stretch are
// triggered and the callbacks that came due run, so the file is what the live
// engine plays.
// ---------------------------------------------------------------------------

import * as S from "./web.mjs";

const QUANTUM = 128;
/** The render stops every STEP quanta: 512 frames, 10.7 ms at 48 kHz. */
const STEP = 4;
/** Events are triggered this far ahead of the render position, as the live scheduler does. */
const LOOKAHEAD = 0.1;
/** Silence before the first event: superdough schedules some things just before an onset. */
const PREROLL = 0.1;
const REST = new Set(["-", "~", "_"]);
/** Visuals of the REPL: a piece written there must still evaluate here. */
const DRAWING = [
  "pianoroll", "punchcard", "wordfall", "spiral", "scope", "tscope", "fscope", "spectrum", "pitchwheel", "markcss",
  "_pianoroll", "_punchcard", "_wordfall", "_spiral", "_scope", "_tscope", "_fscope", "_spectrum", "_pitchwheel",
  "animate", "draw", "onPaint", "onFrame",
];

const state = {
  repl: null,
  seed: 0,
  parts: [],
  anonymous: 0,
  select: { only: null, mute: new Set() },
  pattern: null,
  cps: 0.5,
  evalError: null,
  log: [],
  fetching: 0,
  rendered: null,
};

/** mulberry32 in place of Math.random, as source text: it also seeds the audio worklets. */
const seeded = (seed) =>
  `(() => { let a = ${seed >>> 0} ^ 0x9e3779b9; Math.random = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); ` +
  `t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();`;
const reseed = () => (0, eval)(seeded(state.seed));

const tick = () => new Promise((resolve) => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => resolve();
  channel.port2.postMessage(0);
});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every `.p(label)` passes here: the part is noted, and left out when the caller did not select it. */
function trapParts() {
  let inner = S.Pattern.prototype.p;
  function part(label) {
    const id = String(label);
    const muted = id.startsWith("_") || id.endsWith("_");
    const bare = id.replace(/^_+|_+$/g, "");
    const anonymous = bare.includes("$");
    const name = anonymous ? `${bare}${++state.anonymous}` : bare;
    const selected = !muted && (state.select.only === null || state.select.only.has(name)) && !state.select.mute.has(name);
    state.parts.push({ name, muted, selected, solo: /^S./.test(name), pattern: this });
    if (!selected) return inner.call(this, "_");
    // The REPL numbers a label holding `$` itself; ours is already numbered.
    return inner.call(this, name.replace("$", "anon"));
  }
  Object.defineProperty(S.Pattern.prototype, "p", { configurable: true, get: () => part, set: (fn) => { inner = fn; } });
}

export async function boot({ seed = 0 } = {}) {
  state.seed = seed;
  document.addEventListener("strudel.log", (event) => {
    const { message, type } = event.detail ?? {};
    state.log.push({ message: String(message ?? ""), type: type ?? "info" });
  });
  const realFetch = window.fetch.bind(window);
  window.fetch = (...args) => {
    state.fetching++;
    return realFetch(...args).finally(() => setTimeout(() => state.fetching--, 0));
  };
  S.registerWorklet(`data:text/javascript,${encodeURIComponent(seeded(seed))}`);
  state.repl = await S.initStrudel({ onEvalError: (error) => { state.evalError = error; } });
  S.registerZZFXSounds?.();
  for (const name of DRAWING) {
    if (!(name in S.Pattern.prototype)) S.Pattern.prototype[name] = function () { return this; };
  }
  // A slider of the REPL's editor is its starting value here.
  globalThis.sliderWithID = (_id, value) => S.pure(value);
  globalThis.slider = (value) => S.pure(value);
  trapParts();
  // The page's own realtime context is never used: nothing plays here.
  try { await S.getAudioContext().close(); } catch { /* it was never started */ }
  S.setAudioContext(null);
  return { sounds: builtinSounds() };
}

function builtinSounds() {
  return Object.entries(S.soundMap.get()).map(([name, sound]) => ({ name, type: sound?.data?.type ?? "synth" })).sort((a, b) => a.name.localeCompare(b.name));
}

const messageOf = (error) => (error && typeof error === "object" && "message" in error ? String(error.message) : String(error));

export async function evaluate({ code, only = null, mute = [] }) {
  state.parts = [];
  state.anonymous = 0;
  state.select = { only: only ? new Set(only) : null, mute: new Set(mute) };
  state.evalError = null;
  state.pattern = null;
  state.log = [];
  state.repl.setCps(0.5);
  reseed();
  const pattern = await state.repl.evaluate(code, false);
  // A piece may load a sample map without awaiting it: let those requests land.
  for (let quiet = 0; quiet < 3;) {
    await pause(15);
    quiet = state.fetching === 0 ? quiet + 1 : 0;
  }
  if (state.evalError || !pattern) {
    return { ok: false, error: messageOf(state.evalError ?? "the code gave no pattern"), log: state.log };
  }
  state.pattern = pattern;
  state.cps = Number(state.repl.scheduler.cps);
  return { ok: true, cps: state.cps, parts: state.parts.map(({ pattern: _pattern, ...part }) => part), log: state.log };
}

const onsets = (pattern, from, to) =>
  pattern
    .queryArc(from, to, { _cps: state.cps })
    .filter((hap) => hap.hasOnset() && hap.whole.begin.valueOf() >= from - 1e-9 && hap.whole.begin.valueOf() < to - 1e-9)
    .sort((a, b) => a.whole.begin.valueOf() - b.whole.begin.valueOf());

function soundOf(value) {
  if (value === null || typeof value !== "object") return null;
  if (typeof value.s === "string") return (value.bank ? `${value.bank}_${value.s}` : value.s).toLowerCase();
  if (value.s !== undefined) return String(value.s);
  // superdough's default sound when a hap only carries a pitch
  return "triangle";
}

function midiOf(value) {
  if (value === null || typeof value !== "object") return null;
  try {
    if (typeof value.freq === "number") return 69 + 12 * Math.log2(value.freq / 440);
    if (typeof value.note === "number") return value.note;
    if (typeof value.note === "string") return S.noteToMidi(value.note);
  } catch { /* not a pitch */ }
  return null;
}

const round = (n, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits;

function describe(haps, from, to, eventLimit) {
  const cycles = Math.max(1, Math.ceil(to - 1e-9) - Math.floor(from));
  const perCycle = new Array(cycles).fill(0);
  const sounds = new Map();
  const orbits = new Set();
  let low = Infinity;
  let high = -Infinity;
  let malformed = 0;
  const events = [];
  for (const hap of haps) {
    const at = hap.whole.begin.valueOf();
    perCycle[Math.min(cycles - 1, Math.floor(at - Math.floor(from)))]++;
    const value = hap.value;
    if (value === null || typeof value !== "object") {
      malformed++;
      continue;
    }
    const sound = soundOf(value);
    if (sound && !REST.has(sound)) sounds.set(sound, (sounds.get(sound) ?? 0) + 1);
    const midi = midiOf(value);
    if (midi !== null && Number.isFinite(midi)) {
      low = Math.min(low, midi);
      high = Math.max(high, midi);
    }
    orbits.add(value.orbit ?? 1);
    if (events.length < eventLimit) {
      const shown = {};
      for (const [key, v] of Object.entries(value)) {
        if (typeof v === "number") shown[key] = round(v);
        else if (typeof v === "string" || typeof v === "boolean") shown[key] = v;
      }
      events.push({ at: round(at), cycles: round(hap.whole.end.valueOf() - at), value: shown });
    }
  }
  return {
    events: haps.length,
    perCycle,
    sounds: [...sounds].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    notes: Number.isFinite(low) ? { low: round(low, 2), high: round(high, 2) } : null,
    orbits: [...orbits].sort((a, b) => a - b),
    malformed,
    first: haps.length ? round(haps[0].whole.begin.valueOf()) : null,
    last: haps.length ? round(haps[haps.length - 1].whole.begin.valueOf()) : null,
    listed: events,
  };
}

export function inspect({ from = 0, to = 4, events = 0 }) {
  if (!state.pattern) throw new Error("nothing was evaluated");
  const whole = describe(onsets(state.pattern, from, to), from, to, 0);
  const parts = state.parts.map(({ pattern, ...part }) => {
    try {
      return { ...part, ...describe(onsets(pattern, from, to), from, to, events) };
    } catch (error) {
      return { ...part, events: 0, perCycle: [], sounds: [], notes: null, orbits: [], malformed: 0, first: null, last: null, listed: [], error: messageOf(error) };
    }
  });
  const known = S.soundMap.get();
  const sounds = whole.sounds.map(({ name, count }) => {
    const sound = known[name];
    return { name, count, type: sound ? sound.data?.type ?? "synth" : "unknown" };
  });
  return { cps: state.cps, from, to, ...whole, sounds, parts, listed: describe(onsets(state.pattern, from, to), from, to, state.parts.length ? 0 : events).listed };
}

export async function render({ from = 0, to = 4, lead = 0, tail = 0, loop = false, sampleRate = 48000, maxPolyphony = 128 }) {
  if (!state.pattern) throw new Error("nothing was evaluated");
  const cps = state.cps;
  const start = from - lead;
  const body = Math.round(((to - from) / cps) * sampleRate);
  const head = Math.round((PREROLL + lead / cps) * sampleRate);
  const ring = Math.round(tail * sampleRate);
  const frames = head + body + ring;
  const haps = onsets(state.pattern, start, to);
  const timeOf = (hap) => PREROLL + (hap.whole.begin.valueOf() - start) / cps;
  const errors = new Map();

  // The reverb's impulse is rendered in a context of its own: the render waits for it.
  const Offline = window.OfflineAudioContext;
  const startRendering = Offline.prototype.startRendering;
  let impulses = 0;
  let context = null;
  Offline.prototype.startRendering = function () {
    if (this === context) return startRendering.call(this);
    impulses++;
    return startRendering.call(this).finally(() => { impulses--; });
  };

  try {
    context = new Offline(2, frames, sampleRate);
    S.setAudioContext(context);
    S.setSuperdoughAudioController(null);
    reseed();
    await S.initAudio({ maxPolyphony });

    let next = 0;
    const trigger = async (until) => {
      while (next < haps.length && timeOf(haps[next]) < until) {
        const hap = haps[next++];
        try {
          hap.ensureObjectValue();
          await S.superdough(hap.value, timeOf(hap), hap.duration / cps, cps, hap.whole.begin.valueOf());
        } catch (error) {
          const message = messageOf(error);
          errors.set(message, (errors.get(message) ?? 0) + 1);
        }
      }
      for (let settled = 0; settled < 2;) {
        await tick();
        settled = impulses === 0 ? settled + 1 : 0;
      }
    };

    const step = QUANTUM * STEP;
    await trigger(step / sampleRate + LOOKAHEAD);
    for (let frame = step; frame < frames; frame += step) {
      context.suspend(frame / sampleRate).then(async () => {
        await trigger(frame / sampleRate + LOOKAHEAD);
        context.resume();
      });
    }
    const buffer = await startRendering.call(context);

    const channels = [0, 1].map((c) => {
      const all = buffer.getChannelData(c);
      if (!loop) return all.slice(head, head + body + ring);
      // A loop carries its own ending: what rings past the last cycle is laid over the first.
      const out = all.slice(head, head + body);
      for (let i = 0; i < ring; i++) out[i % body] += all[head + body + i];
      return out;
    });
    state.rendered = channels;
    for (const entry of state.log) {
      if (/error/i.test(entry.message) && !/\[eval\]/.test(entry.message)) errors.set(entry.message, (errors.get(entry.message) ?? 0) + 1);
    }
    return {
      frames: channels[0].length,
      sampleRate,
      cps,
      events: haps.length,
      errors: [...errors].map(([message, count]) => ({ message, count })),
    };
  } finally {
    Offline.prototype.startRendering = startRendering;
    try { S.resetGlobalEffects(); } catch { /* nothing to reset */ }
    S.setSuperdoughAudioController(null);
    S.setAudioContext(null);
  }
}

/** A stretch of a rendered channel, as base64 of its float32 samples. */
export function pull({ channel, offset, length }) {
  const bytes = new Uint8Array(state.rendered[channel].buffer, offset * 4, length * 4);
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export function release() {
  state.rendered = null;
}
