// ---------------------------------------------------------------------------
// The piece, evaluated and rendered in a headless Chrome.
//
// The page is closed to the world: it is served the pinned Strudel bundle and
// the harness from this package, audio files under `files` when the caller
// gives a directory, and nothing else unless `network` is set. Every request
// is recorded with the hash of what answered it.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, JSHandle, Route } from "playwright-core";
import { findChrome, type ChromeSearch } from "./chrome.js";
import { StrudelError } from "./errors.js";
import { IGNORED_CONTROLS, ignoredControlHint } from "./ignored-controls.js";
import type { BuiltinSound, InspectOptions, Inspection, PartSummary, PieceOptions, Problem, RenderOptions, Rendering, Request } from "./types.js";

const ORIGIN = "https://strudel.local";
const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** The longest render, in seconds: longer music is a loop, repeated where it is used. */
export const MAX_RENDER_SECONDS = 900;
/** Events per second above which a stretch is reported as dense. */
const DENSE = 64;

const MIME: Record<string, string> = {
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".flac": "audio/flac",
  ".m4a": "audio/mp4", ".aac": "audio/aac", ".aif": "audio/aiff", ".aiff": "audio/aiff", ".webm": "audio/webm",
  ".json": "application/json",
};

interface Bundle { web: Buffer; harness: Buffer; session: Buffer; assets: string; version: string }
let bundle: Bundle | null = null;

function loadBundle(): Bundle {
  if (bundle) return bundle;
  const web = require.resolve("@strudel/web/dist/index.mjs");
  const version = (JSON.parse(readFileSync(join(dirname(web), "..", "package.json"), "utf-8")) as { version: string }).version;
  const page = (name: string) => readFileSync(join(HERE, "page", name));
  bundle = { web: readFileSync(web), harness: page("harness.js"), session: page("session.js"), assets: join(dirname(web), "assets"), version };
  return bundle;
}

/** The version of Strudel this package renders with. */
export function strudelVersion(): string {
  return loadBundle().version;
}

interface Harness {
  boot(args: { seed: number }): Promise<{ sounds: BuiltinSound[] }>;
  evaluate(args: { code: string; only: string[] | null; mute: string[] }): Promise<
    | { ok: true; cps: number; parts: { name: string; muted: boolean; selected: boolean; solo: boolean }[]; log: { message: string; type: string }[] }
    | { ok: false; error: string; log: { message: string; type: string }[] }
  >;
  inspect(args: { from: number; to: number; events: number }): Omit<Inspection, "ok" | "seconds" | "problems" | "requests"> & { logged: string[] };
  render(args: { from: number; to: number; lead: number; tail: number; loop: boolean; sampleRate: number }): Promise<{
    frames: number; sampleRate: number; cps: number; events: number; errors: { message: string; count: number }[];
  }>;
  pull(args: { channel: number; offset: number; length: number }): string;
  release(): void;
}

function checkPiece(code: string, options: PieceOptions): void {
  if (typeof code !== "string" || code.trim() === "") throw new StrudelError("bad-options", "there is no code to evaluate");
  if (options.files !== undefined && !(existsSync(options.files) && statSync(options.files).isDirectory())) {
    throw new StrudelError("bad-options", `files: ${options.files} is not a directory`);
  }
  if (options.seed !== undefined && (!Number.isInteger(options.seed) || options.seed < 0)) throw new StrudelError("bad-options", "seed must be a whole number, 0 or more");
}

/** What the evaluation says about the parts the caller asked for and the labels the piece uses. */
function partProblems(parts: { name: string; muted: boolean; solo: boolean }[], options: PieceOptions): Problem[] {
  const problems: Problem[] = [];
  const names = parts.map((p) => p.name);
  for (const asked of [...(options.only ?? []), ...(options.mute ?? [])]) {
    if (!names.includes(asked)) {
      problems.push({ level: "error", code: "unknown-part", message: `there is no part "${asked}": the piece has ${names.length ? names.join(", ") : "no labelled parts"}` });
    }
  }
  const seen = new Set<string>();
  for (const part of parts) {
    if (seen.has(part.name) && !part.muted) {
      problems.push({ level: "warning", code: "duplicate-label", message: `the label "${part.name}" is used more than once: only the last one plays` });
    }
    seen.add(part.name);
    if (part.solo && !part.muted) {
      problems.push({ level: "warning", code: "solo-label", message: `"${part.name}" starts with a capital S, which solos it: every part without one is silent. Rename it unless that is meant` });
    }
  }
  return problems;
}

/** What usually lies behind an error of the evaluation, when the code shows it. */
function hint(code: string, message: string): string {
  if (/samples\(\s*(["`]|\{[^}]*["`])/.test(code) && /Invalid argument|is not a function|not iterable|startsWith/.test(message)) {
    return `${message}. samples() takes plain strings: write its names and paths in 'single quotes' ("double quotes" and \`backticks\` make a pattern)`;
  }
  return message;
}

/**
 * An orbit has one reverb and one delay. Parts that ask it for different ones do not each get their own: the
 * setting changes with every event, and a long tail is cut when a short one is asked for.
 */
function orbitProblems(parts: { name: string; spaces: { orbit: number; room: number | null; delay: string | null }[] }[]): Problem[] {
  const problems: Problem[] = [];
  for (const [what, key] of [["reverb sizes", "room"], ["delays", "delay"]] as const) {
    const asked = new Map<number, Map<string, Set<string>>>();
    for (const part of parts) {
      for (const space of part.spaces) {
        const value = space[key];
        if (value === null) continue;
        const text = key === "room" ? `${value} s` : String(value);
        const orbit = asked.get(space.orbit) ?? new Map<string, Set<string>>();
        orbit.set(text, (orbit.get(text) ?? new Set()).add(part.name));
        asked.set(space.orbit, orbit);
      }
    }
    for (const [orbit, values] of asked) {
      if (values.size < 2) continue;
      const who = [...values].map(([text, names]) => `${text}${[...names].filter(Boolean).length ? ` (${[...names].filter(Boolean).join(", ")})` : ""}`).join(" and ");
      problems.push({
        level: "warning", code: "orbit-conflict",
        message: `orbit ${orbit} is asked for different ${what}: ${who}. It has one, which changes with every event and cuts the other's tail: give them the same, or each its own .orbit(n)`,
      });
    }
  }
  return problems;
}

/** An error a pattern raised while it was asked for its events, with what usually causes it. */
function queryHint(message: string): string {
  const text = message.replace(/^\[\w+\]\s*error:\s*/i, "");
  if (/reading 'query'/.test(text)) {
    return `a pattern failed when asked for its events (${text}): usually a pick() or pickRestart() whose table lacks one of the names its pattern uses — give every name a key (silence for none). The whole piece is silent while it fails`;
  }
  return `a pattern failed when asked for its events: ${text}`;
}

function requestProblems(requests: Request[]): Problem[] {
  return requests.flatMap((request): Problem[] => {
    if (request.outcome === "blocked") return [{ level: "error", code: "blocked-request", message: `${request.url} was not fetched: the network is off. Keep the samples in the workspace and load them by relative path, or allow the network` }];
    if (request.outcome === "missing") return [{ level: "error", code: "missing-file", message: `${request.path ?? request.url} is not an audio file the piece can load` }];
    return [];
  });
}

class Session {
  private constructor(
    private readonly context: BrowserContext,
    readonly harness: JSHandle<Harness>,
    readonly sounds: BuiltinSound[],
    readonly requests: Request[],
  ) {}

  static async open(browser: Browser, options: PieceOptions): Promise<Session> {
    const { web, harness, session, assets } = loadBundle();
    const context = await browser.newContext();
    const requests: Request[] = [];
    const root = options.files ? realpathSync(options.files) : null;
    const sha256 = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

    await context.route("**/*", async (route: Route) => {
      const url = new URL(route.request().url());
      try {
        if (url.origin !== ORIGIN) {
          if (!options.network) {
            requests.push({ url: url.href, outcome: "blocked" });
            return await route.abort("blockedbyclient");
          }
          const response = await route.fetch();
          const body = await response.body();
          requests.push({ url: url.href, outcome: response.ok() ? "fetched" : "missing", bytes: body.length, sha256: sha256(body) });
          return await route.fulfill({ response, body });
        }
        const path = decodeURIComponent(url.pathname);
        if (path === "/") return await route.fulfill({ contentType: "text/html", body: "<!doctype html><meta charset=\"utf-8\"><title>strudel</title><body></body>" });
        if (path === "/__strudel__/web.mjs") return await route.fulfill({ contentType: "text/javascript", body: web });
        if (path === "/__strudel__/harness.js") return await route.fulfill({ contentType: "text/javascript", body: harness });
        if (path === "/__strudel__/session.js") return await route.fulfill({ contentType: "text/javascript", body: session });
        if (path.startsWith("/__strudel__/assets/")) {
          const file = join(assets, path.slice("/__strudel__/assets/".length).replace(/[^\w.-]/g, ""));
          return existsSync(file) ? await route.fulfill({ contentType: "text/javascript", body: readFileSync(file) }) : await route.fulfill({ status: 404, body: "" });
        }
        const relative = path.replace(/^\/+/, "");
        const type = MIME[extname(relative).toLowerCase()];
        const full = root && type ? resolve(root, relative) : null;
        const real = full && existsSync(full) && statSync(full).isFile() ? realpathSync(full) : null;
        if (!real || !root || !real.startsWith(root + sep)) {
          requests.push({ url: url.href, path: relative, outcome: "missing" });
          return await route.fulfill({ status: 404, body: "" });
        }
        const body = readFileSync(real);
        requests.push({ url: url.href, path: relative, outcome: "served", bytes: body.length, sha256: sha256(body) });
        return await route.fulfill({ contentType: type!, body });
      } catch {
        // The page went away while a request was in flight.
      }
    });

    try {
      const page = await context.newPage();
      await page.goto(`${ORIGIN}/`);
      // As text: a bundler or a test runner would rewrite an import() written here.
      const handle = (await page.evaluateHandle(`import("/__strudel__/harness.js")`)) as JSHandle<Harness>;
      const { sounds } = await handle.evaluate((h, args) => h.boot(args), { seed: options.seed ?? 0 });
      return new Session(context, handle, sounds, requests);
    } catch (error) {
      await context.close().catch(() => undefined);
      throw new StrudelError("render-failed", `the Strudel page did not start: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
  }
}

/**
 * Run `work` until it ends, the caller aborts or the time is up; whichever comes first closes the page.
 * Without a limit of the caller's, `work` may ask for more time once it knows how long the piece is.
 */
async function bounded<T>(options: PieceOptions, session: Session, work: (allow: (ms: number) => void) => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  let allow: (ms: number) => void = () => undefined;
  const stopped = new Promise<never>((_, reject) => {
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => reject(new StrudelError("timeout", `the piece took more than ${Math.round(ms / 1000)} s: render a shorter stretch, or raise the limit`)), ms);
    };
    arm(options.timeoutMs ?? 120_000);
    if (options.timeoutMs === undefined) allow = arm;
    if (options.signal) {
      if (options.signal.aborted) reject(new StrudelError("aborted", "cancelled"));
      onAbort = () => reject(new StrudelError("aborted", "cancelled"));
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([work((ms) => allow(ms)), stopped]);
  } catch (error) {
    if (error instanceof StrudelError) throw error;
    throw new StrudelError("render-failed", error instanceof Error ? error.message.split("\n")[0]! : String(error));
  } finally {
    clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    await session.close();
  }
}

/** A browser kept open for several pieces. Each call still gets a page of its own, so nothing carries over between them. */
export class StrudelRenderer {
  private constructor(private readonly browser: Browser, readonly chromePath: string) {}

  static async launch(search: ChromeSearch = {}): Promise<StrudelRenderer> {
    const chromePath = findChrome(search);
    try {
      // Loaded here, not with the module: whoever imports this package without rendering does not pay for it.
      const { chromium } = await import("playwright-core");
      const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] });
      return new StrudelRenderer(browser, chromePath);
    } catch (error) {
      throw new StrudelError("no-browser", `${chromePath} did not start: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }

  async close(): Promise<void> {
    await this.browser.close().catch(() => undefined);
  }

  /** Every sound the engine has without loading anything: synths and noises. */
  async sounds(): Promise<BuiltinSound[]> {
    const session = await Session.open(this.browser, {});
    try {
      return session.sounds;
    } finally {
      await session.close();
    }
  }

  /** Evaluate a piece and say what it holds, without making any sound. A piece that does not evaluate is `ok: false`, not an exception. */
  async inspect(code: string, options: InspectOptions = {}): Promise<Inspection> {
    checkPiece(code, options);
    const from = options.from ?? 0;
    const to = options.to ?? from + 4;
    if (!(Number.isFinite(from) && Number.isFinite(to) && to > from && from >= 0)) throw new StrudelError("bad-options", "from and to are cycles, with to after from");
    const session = await Session.open(this.browser, options);
    return bounded(options, session, async () => {
      const evaluated = await session.harness.evaluate((h, args) => h.evaluate(args), { code, only: options.only ?? null, mute: options.mute ?? [] });
      if (!evaluated.ok) {
        return {
          ok: false, cps: 0.5, from, to, seconds: 0, events: 0, perCycle: [], notes: null, orbits: [], controls: [], spaces: [], signature: "", malformed: 0, first: null, last: null, listed: [],
          sounds: [], parts: [], problems: [{ level: "error", code: "eval", message: hint(code, evaluated.error) }, ...requestProblems(session.requests)], requests: session.requests,
        } satisfies Inspection;
      }
      const { logged, ...seen } = await session.harness.evaluate((h, args) => h.inspect(args), { from, to, events: options.events ?? 0 });
      const problems: Problem[] = [
        ...partProblems(evaluated.parts, options), ...requestProblems(session.requests),
        ...logged.map((message): Problem => ({ level: "error", code: "eval", message: queryHint(message) })),
      ];
      const seconds = (to - from) / seen.cps;
      if (seen.events === 0) problems.push({ level: "error", code: "no-events", message: `nothing plays between cycle ${from} and ${to}` });
      for (const part of seen.parts as PartSummary[]) {
        if (part.error) problems.push({ level: "error", code: "eval", message: `part "${part.name}": ${part.error}` });
        else if (part.selected && part.events === 0 && seen.events > 0) problems.push({ level: "warning", code: "silent-part", message: `part "${part.name}" plays nothing between cycle ${from} and ${to}` });
      }
      for (const sound of seen.sounds) {
        if (sound.type === "unknown") problems.push({ level: "error", code: "unknown-sound", message: `no sound is called "${sound.name}" (${sound.count} events): it is neither a built-in synth nor a sample the piece loaded` });
      }
      // A control Strudel accepts and this engine never reads: said once, with the parts that use it.
      const users = new Map<string, string[]>();
      for (const part of (seen.parts.length ? (seen.parts as PartSummary[]).filter((p) => p.selected) : [{ name: "", controls: seen.controls }])) {
        for (const control of part.controls) if (IGNORED_CONTROLS.has(control)) users.set(control, [...(users.get(control) ?? []), part.name]);
      }
      for (const [control, parts] of users) {
        const where = parts.filter(Boolean).length ? ` (in ${parts.filter(Boolean).join(", ")})` : "";
        problems.push({ level: "warning", code: "ignored-control", message: `${ignoredControlHint(control)}${where}` });
      }
      problems.push(...orbitProblems(seen.parts.length ? (seen.parts as PartSummary[]).filter((p) => p.selected) : [{ name: "", spaces: seen.spaces }]));
      if (seen.malformed > 0) problems.push({ level: "error", code: "malformed-events", message: `${seen.malformed} events are bare values, not sounds: end the pattern with .note() or .s()` });
      if (seen.events / seconds > DENSE) problems.push({ level: "warning", code: "dense", message: `${Math.round(seen.events / seconds)} events a second: that is a texture more than a rhythm, and slow to render` });
      return { ok: !problems.some((p) => p.level === "error"), ...seen, seconds: Math.round(seconds * 1000) / 1000, problems, requests: session.requests } as Inspection;
    });
  }

  /** Render a stretch of a piece to float samples. A piece that does not evaluate throws `bad-code`. */
  async render(code: string, options: RenderOptions = {}): Promise<Rendering> {
    checkPiece(code, options);
    const from = options.from ?? 0;
    const sampleRate = options.sampleRate ?? 48000;
    const lead = options.lead ?? 0;
    const tail = options.tail ?? 0;
    if (![8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000].includes(sampleRate)) throw new StrudelError("bad-options", `sampleRate ${sampleRate} is not one a browser renders at`);
    if (!(Number.isFinite(from) && from >= 0)) throw new StrudelError("bad-options", "from is a cycle, 0 or later");
    if (!(Number.isFinite(lead) && lead >= 0 && lead <= from)) throw new StrudelError("bad-options", "lead is a number of cycles before from: it cannot reach before cycle 0");
    if (!(Number.isFinite(tail) && tail >= 0 && tail <= 60)) throw new StrudelError("bad-options", "tail is seconds, from 0 to 60");
    if ((options.to === undefined) === (options.seconds === undefined)) throw new StrudelError("bad-options", "give to (a cycle) or seconds, one of them");

    const session = await Session.open(this.browser, options);
    return bounded(options, session, async (allow) => {
      const evaluated = await session.harness.evaluate((h, args) => h.evaluate(args), { code, only: options.only ?? null, mute: options.mute ?? [] });
      if (!evaluated.ok) {
        const refused = requestProblems(session.requests).map((p) => p.message);
        throw new StrudelError("bad-code", [hint(code, evaluated.error), ...refused].join(". "));
      }
      const partErrors = partProblems(evaluated.parts, options);
      const unknown = partErrors.find((p) => p.code === "unknown-part");
      if (unknown) throw new StrudelError("bad-options", unknown.message);

      const cps = evaluated.cps;
      const to = options.to ?? from + Math.max(1, Math.floor(options.seconds! * cps + 1e-9));
      if (!(Number.isFinite(to) && to > from)) throw new StrudelError("bad-options", "to is a cycle after from");
      const bodySeconds = (to - from) / cps;
      if (options.loop && tail > bodySeconds) throw new StrudelError("bad-options", `a loop of ${bodySeconds.toFixed(2)} s cannot fold a tail of ${tail} s over itself: shorten the tail or lengthen the loop`);
      const total = bodySeconds + lead / cps + tail;
      if (total > MAX_RENDER_SECONDS) throw new StrudelError("bad-options", `${Math.round(total)} s is more than one render holds (${MAX_RENDER_SECONDS} s): render a loop, or the piece in sections`);

      // A render runs several times faster than the music; a dense piece on a slow machine may not.
      allow(120_000 + total * 2000);
      const made = await session.harness.evaluate((h, args) => h.render(args), { from, to, lead, tail, loop: Boolean(options.loop), sampleRate });
      const channels = [new Float32Array(made.frames), new Float32Array(made.frames)] as [Float32Array, Float32Array];
      const chunk = 1 << 19;
      for (let c = 0; c < 2; c++) {
        for (let offset = 0; offset < made.frames; offset += chunk) {
          const length = Math.min(chunk, made.frames - offset);
          const text = await session.harness.evaluate((h, args) => h.pull(args), { channel: c, offset, length });
          const bytes = Buffer.from(text, "base64");
          channels[c]!.set(new Float32Array(bytes.buffer, bytes.byteOffset, length), offset);
        }
      }
      await session.harness.evaluate((h) => h.release());

      const problems: Problem[] = [
        ...partErrors,
        ...requestProblems(session.requests),
        ...made.errors.map((e): Problem => ({ level: "error", code: "render", message: e.count > 1 ? `${e.message} (${e.count} events)` : e.message })),
      ];
      if (made.events === 0) problems.push({ level: "error", code: "no-events", message: `nothing plays between cycle ${from} and ${to}` });
      return {
        channels, sampleRate: made.sampleRate, seconds: made.frames / made.sampleRate, cps, from, to,
        bodySeconds: options.loop ? made.frames / made.sampleRate : bodySeconds, loop: Boolean(options.loop), events: made.events,
        parts: evaluated.parts, problems, requests: session.requests,
      };
    });
  }
}

async function once<T>(search: ChromeSearch, work: (renderer: StrudelRenderer) => Promise<T>): Promise<T> {
  const renderer = await StrudelRenderer.launch(search);
  try {
    return await work(renderer);
  } finally {
    await renderer.close();
  }
}

/** Evaluate a piece and say what it holds: one browser, opened and closed. */
export const inspectPattern = (code: string, options: InspectOptions & ChromeSearch = {}): Promise<Inspection> =>
  once(options, (renderer) => renderer.inspect(code, options));

/** Render a stretch of a piece: one browser, opened and closed. */
export const renderPattern = (code: string, options: RenderOptions & ChromeSearch = {}): Promise<Rendering> =>
  once(options, (renderer) => renderer.render(code, options));

/** Every built-in sound of the engine. */
export const builtinSounds = (search: ChromeSearch = {}): Promise<BuiltinSound[]> => once(search, (renderer) => renderer.sounds());
