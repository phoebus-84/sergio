/**
 * The studio's one Strudel engine: it plays the piece being edited.
 *
 * It is the engine a render uses (@strudel/web, pinned by @av/strudel) and the
 * piece is evaluated by the same code (@av/strudel's session), so what plays
 * here is what pva_music_render writes — parts, tempo and all. The engine is
 * loaded the first time something is played: a studio session that never
 * opens a piece does not pay for it.
 *
 * One piece plays at a time, as on strudel.cc: playing another replaces it.
 */

import type { PieceNote, PiecePart } from "$lib/music";

interface Session {
  fail(error: unknown): void;
  attach(repl: unknown): void;
  readonly cps: number;
  evaluate(request: { code: string; only?: string[] | null; mute?: string[]; play?: boolean }): Promise<{ ok: true; cps: number; parts: PiecePart[] } | { ok: false; error: string }>;
  notes(range: { from: number; to: number; limit?: number }): PieceNote[];
}

interface Engine {
  strudel: typeof import("@strudel/web");
  session: Session;
  repl: { stop(): void; scheduler: { now(): number } };
}

export interface PlayRequest {
  /** Which piece this is: what `owner` reports while it plays. */
  owner: string;
  code: string;
  /** Parts silenced from the studio, on top of what the code mutes. */
  mute?: string[];
  only?: string[] | null;
  /** Where a relative sample path of the piece is fetched from: the workspace, as the gateway serves it. */
  sampleBase?: string | null;
  play: boolean;
}

class StrudelPlayer {
  phase = $state<"idle" | "loading" | "ready" | "failed">("idle");
  /** The piece that is playing, or null. */
  owner = $state<string | null>(null);
  /** What the last evaluation said was wrong; null when it evaluated. */
  error = $state<string | null>(null);
  cps = $state(0.5);
  parts = $state<PiecePart[]>([]);

  #engine: Promise<Engine> | null = null;
  #sampleBase = "";

  #load(): Promise<Engine> {
    this.#engine ??= (async () => {
      this.phase = "loading";
      try {
        const [strudel, { createSession }] = await Promise.all([import("@strudel/web"), import("@av/strudel/session")]);
        const session = createSession(strudel) as Session;
        const repl = await strudel.initStrudel({ onEvalError: (error: unknown) => session.fail(error) });
        session.attach(repl);
        strudel.registerZZFXSounds?.();
        // A piece names its own samples by paths in its workspace; here those are the gateway's.
        (globalThis as Record<string, unknown>).samples = (map: unknown, base?: string, options?: unknown) =>
          strudel.samples(map, base || (map !== null && typeof map === "object" ? this.#sampleBase : ""), options);
        this.phase = "ready";
        return { strudel, session, repl };
      } catch (error) {
        this.phase = "failed";
        this.#engine = null;
        throw error;
      }
    })();
    return this.#engine;
  }

  /** Evaluate a piece, and play it when asked. False when it does not evaluate: `error` says why. */
  async evaluate(request: PlayRequest): Promise<boolean> {
    try {
      const { strudel, session } = await this.#load();
      this.#sampleBase = request.sampleBase ?? "";
      if (request.play) {
        // Called from a click or a key: the browser lets audio start here.
        await strudel.initAudio();
        await strudel.getAudioContext().resume?.();
      }
      const evaluated = await session.evaluate({ code: request.code, only: request.only ?? null, mute: request.mute ?? [], play: request.play });
      if (!evaluated.ok) {
        this.error = evaluated.error;
        return false;
      }
      this.error = null;
      this.cps = evaluated.cps;
      this.parts = evaluated.parts;
      if (request.play) this.owner = request.owner;
      return true;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  /** The events of what was last evaluated, for drawing. */
  async notes(from: number, to: number): Promise<PieceNote[]> {
    if (!this.#engine) return [];
    try {
      return (await this.#engine).session.notes({ from, to });
    } catch {
      return [];
    }
  }

  /** Where the piece is, in cycles; null when nothing plays. */
  async position(): Promise<number | null> {
    if (!this.#engine || this.owner === null) return null;
    try {
      return (await this.#engine).repl.scheduler.now();
    } catch {
      return null;
    }
  }

  async stop(): Promise<void> {
    this.owner = null;
    if (!this.#engine) return;
    try {
      (await this.#engine).repl.stop();
    } catch { /* nothing was playing */ }
  }
}

export const player = new StrudelPlayer();
