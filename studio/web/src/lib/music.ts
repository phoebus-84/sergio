// Music written as code (ADR-0053), as the studio shows it: which workspace a
// piece belongs to, what a render request says, how a piece's events are laid
// out to be seen, and a render's record read out in words. No DOM, no gateway:
// what is here is tested as plain functions.

import type { MusicRenderRecord } from "@studio/contracts/src/music-renders.mjs";

export const MUSIC_EXTENSION = ".strudel";

export interface MusicRenderEntry {
  recordPath: string;
  record: MusicRenderRecord;
  /** The piece is as it was when this was rendered. */
  current: boolean;
  /** The file is gone, or is no longer the one the record describes. */
  missing: boolean;
}

export interface MusicPiece {
  path: string;
  hash: string;
  renders: MusicRenderEntry[];
}

export interface MusicAnswer {
  within: string;
  readiness: { available: boolean; detail: string };
  pieces: MusicPiece[];
  orphans: MusicRenderEntry[];
  invalid: string[];
}

/** One event of a piece, as @av/strudel's session lists them for drawing. */
export interface PieceNote {
  at: number;
  cycles: number;
  part: string;
  sound: string | null;
  midi: number | null;
  gain: number;
}

export interface PiecePart {
  name: string;
  muted: boolean;
  selected: boolean;
  solo: boolean;
}

/**
 * The workspace a piece belongs to, from its path in the level being browsed:
 * the directory that holds its `music/` folder. A channel's source is a
 * workspace of its own, so `sources/lampo/music/x.strudel` renders into
 * `sources/lampo/assets/`, not into the channel.
 */
export function musicWorkspace(path: string): { within: string; piece: string } | null {
  if (!path.endsWith(MUSIC_EXTENSION)) return null;
  const parts = path.split("/");
  const at = parts.lastIndexOf("music");
  if (at < 0 || at === parts.length - 1) return null;
  return { within: parts.slice(0, at).join("/"), piece: parts.slice(at).join("/") };
}

/** A workspace file's path in the level. */
export const inLevel = (within: string, path: string) => (within ? `${within}/${path}` : path);

export interface RenderForm {
  length: "cycles" | "seconds";
  amount: string;
  from: string;
  tail: string;
  loop: boolean;
  stems: boolean;
  /** Empty for the default: assets/sounds/<piece>.wav. */
  output: string;
}

export const DEFAULT_RENDER_FORM: RenderForm = { length: "cycles", amount: "8", from: "0", tail: "2", loop: false, stems: false, output: "" };

/** The request a filled form makes, or what is wrong with it. */
export function renderRequest(piece: string, within: string, form: RenderForm): { request: Record<string, unknown> } | { error: string } {
  const number = (text: string) => (text.trim() === "" ? NaN : Number(text));
  const amount = number(form.amount);
  if (!(amount > 0)) return { error: `how many ${form.length}? a number above 0` };
  const from = form.from.trim() === "" ? 0 : number(form.from);
  if (!(from >= 0)) return { error: "the first cycle is 0 or later" };
  const tail = form.tail.trim() === "" ? 0 : number(form.tail);
  if (!(tail >= 0 && tail <= 60)) return { error: "the tail is seconds, from 0 to 60" };
  const output = form.output.trim();
  if (output !== "" && !output.endsWith(".wav")) return { error: "the output is a .wav file" };
  return {
    request: {
      ...(within ? { within } : {}),
      path: piece,
      [form.length]: amount,
      ...(from > 0 ? { from } : {}),
      ...(tail > 0 ? { tail } : {}),
      ...(form.loop ? { loop: true } : {}),
      ...(form.stems ? { stems: true } : {}),
      ...(output ? { output } : {}),
    },
  };
}

const db = (n: number | null | undefined, unit: string) => (n === null || n === undefined || !Number.isFinite(n) ? `– ${unit}` : `${n.toFixed(1)} ${unit}`);

/** "32 s · cycles 0–16 · 2 s tail" */
export function shapeLine(record: MusicRenderRecord): string {
  const o = record.output;
  const tail = o.durationSeconds - o.bodySeconds;
  const end = o.loop ? "seamless loop" : tail > 0.005 ? `${+tail.toFixed(2)} s tail` : "no tail";
  const playing = record.parts.filter((p) => p.selected).map((p) => p.name);
  const partial = record.parts.some((p) => !p.selected && !p.muted);
  return [`${+o.durationSeconds.toFixed(2)} s`, `cycles ${record.range.from}–${record.range.to}`, end, ...(partial ? [`only ${playing.join(", ")}`] : [])].join(" · ");
}

/** "−16.0 LUFS · peak −3.1 dBFS · gain +4.2 dB" */
export function levelLine(record: MusicRenderRecord): string {
  const l = record.level;
  const gain = l.basis === "none" ? "its own level" : `gain ${l.gain >= 0 ? "+" : ""}${l.gain} dB`;
  return [db(l.loudness, "LUFS"), `peak ${db(l.peak, "dBFS")}`, gain, ...(l.held ? ["held by its peaks"] : [])].join(" · ");
}

const BANDS: [string, string][] = [["sub", "sub"], ["bass", "bass"], ["lowMid", "low-mid"], ["mid", "mid"], ["highMid", "high-mid"], ["high", "high"]];

/** The spectrum by band, each as a share of the energy in dB and as a bar length from 0 to 1 (−36 dB and under is empty). */
export function bandsOf(record: MusicRenderRecord): { name: string; label: string; db: number | null; fill: number }[] {
  const bands = (record.analysis as { bands?: Record<string, unknown> }).bands ?? {};
  return BANDS.map(([name, label]) => {
    const value = bands[name];
    const level = typeof value === "number" && Number.isFinite(value) ? value : null;
    return { name, label, db: level, fill: level === null ? 0 : Math.max(0, Math.min(1, 1 + level / 36)) };
  });
}

export interface RollLane {
  part: string;
  top: number;
  height: number;
  /** Position in the list of parts: what its colour is chosen by. */
  index: number;
}

export interface RollRect {
  x: number;
  y: number;
  w: number;
  h: number;
  lane: number;
  /** 0–1: louder events are drawn stronger. */
  weight: number;
}

/**
 * A piece's events as a roll: time across, a lane for each part, and in a
 * lane pitch upwards — or, for sounds with no pitch, a row for each sound.
 */
export function pianoRoll(
  notes: PieceNote[],
  parts: string[],
  view: { from: number; to: number; width: number; height: number },
): { lanes: RollLane[]; rects: RollRect[] } {
  const names = parts.length > 0 ? parts : [...new Set(notes.map((n) => n.part))];
  const lanes: RollLane[] = names.map((part, index) => ({ part, index, top: (view.height * index) / names.length, height: view.height / names.length }));
  const span = Math.max(1e-9, view.to - view.from);
  const rects: RollRect[] = [];
  for (const lane of lanes) {
    const own = notes.filter((n) => n.part === lane.part && n.at < view.to && n.at + n.cycles > view.from);
    const pitched = own.filter((n) => n.midi !== null);
    const low = Math.min(...pitched.map((n) => n.midi!));
    const high = Math.max(...pitched.map((n) => n.midi!));
    const sounds = [...new Set(own.filter((n) => n.midi === null).map((n) => n.sound ?? ""))].sort();
    // Pitches share the lane with a margin; a lone pitch sits in the middle.
    const rows = Math.max(1, Math.round(high - low) + 1 + sounds.length);
    const row = Math.max(2, Math.min(10, (lane.height - 4) / rows));
    const inner = lane.height - 4 - row;
    for (const note of own) {
      const x = ((Math.max(note.at, view.from) - view.from) / span) * view.width;
      const end = ((Math.min(note.at + note.cycles, view.to) - view.from) / span) * view.width;
      let place: number;
      if (note.midi !== null) {
        const range = high - low + sounds.length;
        place = range > 0 ? (note.midi - low + sounds.length) / range : 0.5;
      } else {
        const range = sounds.length - 1 + (pitched.length > 0 ? high - low + 1 : 0);
        place = range > 0 ? sounds.indexOf(note.sound ?? "") / range : 0.5;
      }
      rects.push({
        x, w: Math.max(1.5, end - x - 1), h: row,
        y: lane.top + 2 + (1 - place) * inner,
        lane: lane.index, weight: Math.max(0.35, Math.min(1, note.gain)),
      });
    }
  }
  return { lanes, rects };
}

/** The stretch of cycles shown while the piece plays at `cycle`: pages of `span` cycles. */
export function rollPage(cycle: number, span: number): { from: number; to: number } {
  const from = Math.max(0, Math.floor(cycle / span) * span);
  return { from, to: from + span };
}
