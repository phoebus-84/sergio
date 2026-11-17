// ---------------------------------------------------------------------------
// A piece evaluated as the Strudel REPL evaluates it, and described.
//
// This runs in a browser, beside a loaded @strudel/web: in the headless page
// that renders, and in the studio's own player. One implementation, so that
// what a person plays in the studio, what a check reports and what a render
// writes are the same piece, with the same parts.
//
// It has no imports: the caller hands it the Strudel module.
// ---------------------------------------------------------------------------

/**
 * @typedef {import("../types.js").EventSummary} EventSummary
 * @typedef {import("../types.js").PartSummary} PartSummary
 * @typedef {import("../types.js").SoundUse} SoundUse
 * @typedef {{ name: string, muted: boolean, selected: boolean, solo: boolean }} PartState
 * @typedef {{ ok: true, cps: number, parts: PartState[] } | { ok: false, error: string }} Evaluated
 * @typedef {EventSummary & { cps: number, from: number, to: number, sounds: SoundUse[], parts: PartSummary[] }} Described
 * @typedef {{ at: number, cycles: number, part: string, sound: string | null, midi: number | null, gain: number }} Note
 */

const REST = new Set(["-", "~", "_"]);
/** Visuals of the REPL: a piece written there must still evaluate where nothing draws them. */
const DRAWING = [
  "pianoroll", "punchcard", "wordfall", "spiral", "scope", "tscope", "fscope", "spectrum", "pitchwheel", "markcss",
  "_pianoroll", "_punchcard", "_wordfall", "_spiral", "_scope", "_tscope", "_fscope", "_spectrum", "_pitchwheel",
  "animate", "draw", "onPaint", "onFrame",
];

const messageOf = (error) => (error && typeof error === "object" && "message" in error ? String(error.message) : String(error));
const round = (n, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits;

/**
 * @param {any} S the loaded @strudel/web module
 */
export function createSession(S) {
  const state = {
    /** @type {any} */ repl: null,
    /** @type {(PartState & { pattern: any })[]} */ parts: [],
    anonymous: 0,
    select: { /** @type {Set<string> | null} */ only: null, mute: new Set() },
    /** @type {any} */ pattern: null,
    cps: 0.5,
    /** @type {unknown} */ evalError: null,
  };

  // Every `.p(label)` passes here: the part is noted, and left out when the caller did not select it.
  let inner = S.Pattern.prototype.p;
  function part(label) {
    const id = String(label);
    const muted = id.startsWith("_") || id.endsWith("_");
    const bare = id.replace(/^_+|_+$/g, "");
    const name = bare.includes("$") ? `${bare}${++state.anonymous}` : bare;
    const selected = !muted && (state.select.only === null || state.select.only.has(name)) && !state.select.mute.has(name);
    state.parts.push({ name, muted, selected, solo: /^S./.test(name), pattern: this });
    if (!selected) return inner.call(this, "_");
    // The REPL numbers a label holding `$` itself; ours is already numbered.
    return inner.call(this, name.replace("$", "anon"));
  }
  Object.defineProperty(S.Pattern.prototype, "p", { configurable: true, get: () => part, set: (fn) => { inner = fn; } });

  for (const name of DRAWING) {
    if (!(name in S.Pattern.prototype)) S.Pattern.prototype[name] = function () { return this; };
  }
  // A slider of the REPL's editor is its starting value here.
  globalThis.sliderWithID = (_id, value) => S.pure(value);
  globalThis.slider = (value) => S.pure(value);

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

  const need = () => {
    if (!state.pattern) throw new Error("nothing was evaluated");
    return state.pattern;
  };

  return {
    /** Give this to `initStrudel` as `onEvalError`. */
    fail(error) {
      state.evalError = error;
    },

    /** The repl `initStrudel` made. */
    attach(repl) {
      state.repl = repl;
    },

    /** Cycles per second of the piece last evaluated. */
    get cps() {
      return state.cps;
    },

    /** Every sound registered: the engine's synths, and the samples loaded since. */
    sounds() {
      return Object.entries(S.soundMap.get()).map(([name, sound]) => ({ name, type: sound?.data?.type ?? "synth" })).sort((a, b) => a.name.localeCompare(b.name));
    },

    /**
     * Evaluate a piece; with `play`, start it (or replace what plays).
     * @param {{ code: string, only?: string[] | null, mute?: string[], play?: boolean }} request
     * @returns {Promise<Evaluated>}
     */
    async evaluate({ code, only = null, mute = [], play = false }) {
      state.parts = [];
      state.anonymous = 0;
      state.select = { only: only ? new Set(only) : null, mute: new Set(mute) };
      state.evalError = null;
      state.pattern = null;
      // The REPL keeps the tempo from one evaluation to the next; a piece is read on its own.
      state.repl.setCps(0.5);
      const pattern = await state.repl.evaluate(code, play);
      if (state.evalError || !pattern) return { ok: false, error: messageOf(state.evalError ?? "the code gave no pattern") };
      state.pattern = pattern;
      state.cps = Number(state.repl.scheduler.cps);
      return { ok: true, cps: state.cps, parts: state.parts.map(({ pattern: _pattern, ...rest }) => rest) };
    },

    /** The events of the whole piece starting in a stretch of cycles, in order. */
    onsets(from, to) {
      return onsets(need(), from, to);
    },

    /**
     * What plays in a stretch of cycles: in all, and part by part.
     * @param {{ from?: number, to?: number, events?: number }} [range]
     * @returns {Described}
     */
    inspect({ from = 0, to = 4, events = 0 } = {}) {
      const pattern = need();
      const whole = describe(onsets(pattern, from, to), from, to, state.parts.length ? 0 : events);
      const parts = state.parts.map(({ pattern: own, ...rest }) => {
        try {
          return { ...rest, ...describe(onsets(own, from, to), from, to, events) };
        } catch (error) {
          return { ...rest, events: 0, perCycle: [], sounds: [], notes: null, orbits: [], malformed: 0, first: null, last: null, listed: [], error: messageOf(error) };
        }
      });
      const known = S.soundMap.get();
      const sounds = whole.sounds.map(({ name, count }) => ({ name, count, type: known[name] ? known[name].data?.type ?? "synth" : "unknown" }));
      return { cps: state.cps, from, to, ...whole, sounds, parts };
    },

    /**
     * Every event of the parts that play, for drawing them: when, how long, which part, which pitch.
     * @param {{ from?: number, to?: number, limit?: number }} [range]
     * @returns {Note[]}
     */
    notes({ from = 0, to = 4, limit = 4000 } = {}) {
      need();
      const sources = state.parts.length ? state.parts.filter((p) => p.selected) : [{ name: "", pattern: state.pattern }];
      const out = [];
      for (const source of sources) {
        let haps = [];
        try {
          haps = onsets(source.pattern, from, to);
        } catch { /* a part that cannot be queried draws nothing */ }
        for (const hap of haps) {
          if (out.length >= limit) return out;
          const value = hap.value;
          const sound = soundOf(value);
          if (sound && REST.has(sound)) continue;
          const at = hap.whole.begin.valueOf();
          const midi = midiOf(value);
          out.push({
            at: round(at), cycles: round(hap.whole.end.valueOf() - at), part: source.name, sound,
            midi: midi !== null && Number.isFinite(midi) ? round(midi, 2) : null,
            gain: value && typeof value === "object" && typeof value.gain === "number" ? value.gain : 1,
          });
        }
      }
      return out;
    },
  };
}
