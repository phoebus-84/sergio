/** Something a person or an agent should know about a piece before trusting its sound. */
export interface Problem {
  level: "error" | "warning";
  code:
    | "eval"
    | "no-events"
    | "silent-part"
    | "unknown-sound"
    | "malformed-events"
    | "solo-label"
    | "duplicate-label"
    | "unknown-part"
    | "blocked-request"
    | "missing-file"
    | "render"
    | "dense";
  message: string;
}

export interface ListedEvent {
  /** Onset, in cycles. */
  at: number;
  /** Length, in cycles. */
  cycles: number;
  /** The event's controls: numbers, strings and booleans only. */
  value: Record<string, number | string | boolean>;
}

export interface EventSummary {
  events: number;
  /** Events starting in each cycle of the stretch. */
  perCycle: number[];
  /** Lowest and highest pitch as MIDI numbers (60 is c4, 69 is a4), when any event has one. */
  notes: { low: number; high: number } | null;
  orbits: number[];
  /** Events whose value is not a set of controls: superdough cannot play them. */
  malformed: number;
  /** Onset of the first and of the last event, in cycles. */
  first: number | null;
  last: number | null;
  listed: ListedEvent[];
}

export interface PartSummary extends EventSummary {
  /** The label: `bass` for `bass:`, `$1`, `$2`… for each `$:` in order. */
  name: string;
  /** Written muted in the code (`_bass:`). */
  muted: boolean;
  /** Plays in this evaluation: not muted in the code, and not left out by `only` or `mute`. */
  selected: boolean;
  /** Its label starts with a capital S: the REPL plays such parts alone. */
  solo: boolean;
  sounds: { name: string; count: number }[];
  error?: string;
}

export interface SoundUse {
  name: string;
  count: number;
  /** `synth`, `sample`, another type superdough registered it with, or `unknown` when nothing is registered under the name. */
  type: string;
}

/** A file or address the piece asked for while it was evaluated or rendered. */
export interface Request {
  url: string;
  /** Relative to `files`, for a file of the workspace. */
  path?: string;
  outcome: "served" | "fetched" | "blocked" | "missing";
  bytes?: number;
  sha256?: string;
}

export interface Inspection extends EventSummary {
  ok: boolean;
  /** Cycles per second; a cycle is usually a bar. */
  cps: number;
  from: number;
  to: number;
  /** How long the stretch lasts at this tempo. */
  seconds: number;
  sounds: SoundUse[];
  parts: PartSummary[];
  problems: Problem[];
  requests: Request[];
}

export interface PieceOptions {
  /** Only these parts play (labels; `$1`, `$2`… for anonymous ones). */
  only?: string[];
  /** These parts do not play. */
  mute?: string[];
  /** Seeds every random source of the engine (noise, reverb, detune); the same seed gives the same sound. Default 0. */
  seed?: number;
  /** A directory whose audio files the piece may load as samples, by relative path. */
  files?: string;
  /** Let the piece fetch from the network (sample packs). Off by default: a render then depends only on the code and `files`. */
  network?: boolean;
  signal?: AbortSignal;
  /** Give up after this long. Default: two minutes to evaluate, and for a render two more seconds for each second of music. */
  timeoutMs?: number;
}

export interface InspectOptions extends PieceOptions {
  /** First cycle. Default 0. */
  from?: number;
  /** One past the last cycle. Default `from + 4`. */
  to?: number;
  /** List up to this many events per part. Default 0. */
  events?: number;
}

export interface RenderOptions extends PieceOptions {
  /** First cycle. Default 0. */
  from?: number;
  /** One past the last cycle. Give this or `seconds`. */
  to?: number;
  /** Instead of `to`: as many whole cycles as fit in so many seconds, at the piece's tempo. */
  seconds?: number;
  /** Cycles played before `from` and cut off: what they leave ringing opens the stretch. Default 0. */
  lead?: number;
  /** Seconds kept after the last cycle for releases, delays and reverb to end. Default 0. */
  tail?: number;
  /** Fold the tail over the start instead of appending it: the file then repeats without a seam. */
  loop?: boolean;
  /** Default 48000. */
  sampleRate?: number;
}

export interface Rendering {
  /** Left and right, float samples; they may exceed ±1 before mastering. */
  channels: [Float32Array, Float32Array];
  sampleRate: number;
  seconds: number;
  cps: number;
  from: number;
  to: number;
  /** Seconds of the file that are the stretch itself; the rest is tail. Equal to `seconds` for a loop. */
  bodySeconds: number;
  loop: boolean;
  events: number;
  parts: { name: string; muted: boolean; selected: boolean; solo: boolean }[];
  problems: Problem[];
  requests: Request[];
}

export interface BuiltinSound {
  name: string;
  type: string;
}
