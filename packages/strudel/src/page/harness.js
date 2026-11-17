// ---------------------------------------------------------------------------
// Runs inside the headless page, beside the pinned @strudel/web bundle.
//
// The piece is evaluated by ./session.js, exactly as the Strudel REPL does
// (the same `repl`, so `$:` and `name:` parts, `setcpm`, `all`, a muting
// `_name:` behave as they do on strudel.cc). This file seeds the engine and
// renders offline.
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
import { createSession } from "./session.js";

const QUANTUM = 128;
/** The render stops every STEP quanta: 512 frames, 10.7 ms at 48 kHz. */
const STEP = 4;
/** Events are triggered this far ahead of the render position, as the live scheduler does. */
const LOOKAHEAD = 0.1;
/** Silence before the first event: superdough schedules some things just before an onset. */
const PREROLL = 0.1;

const state = { session: null, seed: 0, log: [], fetching: 0, rendered: null };

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
const messageOf = (error) => (error && typeof error === "object" && "message" in error ? String(error.message) : String(error));

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
  state.session = createSession(S);
  state.session.attach(await S.initStrudel({ onEvalError: state.session.fail }));
  S.registerZZFXSounds?.();
  // The page's own realtime context is never used: nothing plays here.
  try { await S.getAudioContext().close(); } catch { /* it was never started */ }
  S.setAudioContext(null);
  return { sounds: state.session.sounds() };
}

export async function evaluate({ code, only = null, mute = [] }) {
  state.log = [];
  reseed();
  const evaluated = await state.session.evaluate({ code, only, mute });
  // A piece may load a sample map without awaiting it: let those requests land.
  for (let quiet = 0; quiet < 3;) {
    await pause(15);
    quiet = state.fetching === 0 ? quiet + 1 : 0;
  }
  return { ...evaluated, log: state.log };
}

export function inspect(range) {
  return state.session.inspect(range);
}

export async function render({ from = 0, to = 4, lead = 0, tail = 0, loop = false, sampleRate = 48000, maxPolyphony = 128 }) {
  const cps = state.session.cps;
  const start = from - lead;
  const body = Math.round(((to - from) / cps) * sampleRate);
  const head = Math.round((PREROLL + lead / cps) * sampleRate);
  const ring = Math.round(tail * sampleRate);
  const frames = head + body + ring;
  const haps = state.session.onsets(start, to);
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
