// @strudel/web ships no types. The studio hands the module to @av/strudel's
// session and calls these few functions of it by name.
declare module "@strudel/web" {
  /** Start the engine: its repl, with the scheduler that plays. */
  export function initStrudel(options?: { onEvalError?: (error: unknown) => void }): Promise<{ stop(): void; scheduler: { now(): number } }>;
  /** Load the audio worklets; to be called from a click or a key. */
  export function initAudio(options?: Record<string, unknown>): Promise<void>;
  export function getAudioContext(): AudioContext;
  export function samples(map: unknown, base?: string, options?: unknown): Promise<void>;
  export const registerZZFXSounds: (() => void) | undefined;
}
