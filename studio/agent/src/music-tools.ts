// ---------------------------------------------------------------------------
// Music written as code (ADR-0053): a piece is a file of Strudel code in an
// episode, a channel source or a film unit. These tools check it without a
// sound, render it — whole or in part, with a tail or as a loop, with stems —
// and list what a workspace holds. The agent writes and edits the piece with
// its own file tools; nothing here writes code.
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import type { AudioAnalysis, Inspection } from "@av/strudel";
import { checkMusic, listMusic, renderMusic, MUSIC_LOUDNESS, MUSIC_OUTPUT_DIRS, MUSIC_PEAK, MusicError, type MusicRequest } from "@studio/episode";
import type { MusicRenderRecord } from "@studio/contracts/src/music-renders.mjs";
import { WORKSPACE_PARAMS, guardWorkspacePath, workspaceOf } from "./workspace-target.js";

const fail = (error: unknown) => ({
  content: [{ type: "text" as const, text: `❌ ${error instanceof MusicError ? `${error.code}: ` : ""}${error instanceof Error ? error.message : String(error)}` }],
  details: (error instanceof MusicError ? { problems: error.problems } : {}) as Record<string, unknown>,
  isError: true as unknown as boolean,
});

const NOTES = ["c", "c#", "d", "d#", "e", "f", "f#", "g", "g#", "a", "a#", "b"];
/** A MIDI number as Strudel writes it: 60 is c4. */
export const noteName = (midi: number) => `${NOTES[((Math.round(midi) % 12) + 12) % 12]}${Math.floor(Math.round(midi) / 12) - 1}`;
const level = (n: number | null | undefined, unit: string) => (n === null || n === undefined || !Number.isFinite(n) ? `– ${unit}` : `${n.toFixed(1)} ${unit}`);
const tempo = (cps: number) => `${+(cps * 60).toFixed(2)} cycles/min (${+(cps * 240).toFixed(1)} bpm when a cycle is a 4/4 bar)`;

/** What a check found, as the agent reads it. */
export function describeInspection(what: string, seen: Inspection): string {
  const lines = [`${seen.ok ? "✅" : "❌"} ${what}: cycles ${seen.from}–${seen.to} = ${seen.seconds} s at ${tempo(seen.cps)}; ${seen.events} events`];
  const event = (e: Inspection["listed"][number]) => `    ${e.at.toFixed(3)} +${e.cycles}  ${Object.entries(e.value).map(([k, v]) => `${k}=${v}`).join(" ")}`;
  for (const part of seen.parts) {
    // What does not play is named and no more: its events are not what was asked about.
    if (part.muted || !part.selected) {
      lines.push(`- ${part.name}: ${part.muted ? "muted in the code" : "left out"}`);
      continue;
    }
    const state = part.solo ? " (SOLO)" : "";
    const notes = part.notes ? `; notes ${noteName(part.notes.low)}–${noteName(part.notes.high)}` : "";
    lines.push(`- ${part.name}${state}: ${part.events} events, per cycle [${part.perCycle.join(" ")}]${notes}; ${part.sounds.map((s) => s.name).join(", ") || "no sound"}`);
    lines.push(...part.listed.map(event));
  }
  lines.push(...seen.listed.map(event));
  if (seen.parts.length === 0 && seen.ok) lines.push("- one unlabelled pattern: label each part (`bass: …`) to render parts and stems");
  for (const problem of seen.problems) lines.push(`${problem.level === "error" ? "❌" : "⚠️"} ${problem.message}`);
  return lines.join("\n");
}

const BANDS = [["sub", "sub"], ["bass", "bass"], ["lowMid", "low-mid"], ["mid", "mid"], ["highMid", "high-mid"], ["high", "high"]] as const;

/** One stem as the agent reads it: where its energy is, how wide it is. */
export function describeStem(stem: MusicRenderRecord["stems"][number]): string {
  // The bands that carry it: the strongest, and any other within 12 dB of it.
  const bands = BANDS.flatMap(([key, name]) => {
    const share = stem.bands[key];
    return typeof share === "number" ? [{ name, share }] : [];
  });
  const top = Math.max(...bands.map((b) => b.share));
  const where = bands.filter((b) => b.share >= top - 12).sort((a, b) => b.share - a.share).map((b) => `${b.name} ${b.share}`).join(" · ");
  return `  - ${stem.part}: ${level(stem.loudness, "LUFS")}, peak ${level(stem.peak, "dBFS")}, crest ${stem.crest} dB` +
    `${where ? `; ${where}` : ""}; centroid ${stem.centroid} Hz; correlation ${stem.correlation} → ${stem.path}`;
}

/** How a render was levelled: what it reached, where its peak is, and what was asked. */
export function describeLevel(record: MusicRenderRecord): string {
  const l = record.level;
  const at = (record.analysis as { peakAt?: number }).peakAt;
  const peak = `peak ${level(l.peak, "dBFS")}${l.peak !== null && at !== undefined ? ` at ${at.toFixed(2)} s` : ""}`;
  if (l.basis === "none") return `level: ${level(l.loudness, "LUFS")}, ${peak} (its own level)`;
  const asked = l.target === null ? `under ${l.ceiling} dBFS` : `asked ${l.target} LUFS under ${l.ceiling} dBFS`;
  const short = l.held && l.target !== null && l.loudness !== null ? `: the ceiling holds it ${(l.target - l.loudness).toFixed(1)} dB short` : "";
  // The piece's own peak, before the gain: over 0 dBFS it clips when a person plays it in the studio.
  const own = l.peak === null ? "" : `; the piece itself peaks at ${(l.peak - l.gain).toFixed(1)} dBFS`;
  return `level: ${level(l.loudness, "LUFS")}, ${peak} (gain ${l.gain >= 0 ? "+" : ""}${l.gain} dB; ${asked}${short}${own})`;
}

/** A rendered file's measurements, as the agent reads them. */
export function describeAnalysis(a: AudioAnalysis): string[] {
  const b = a.bands;
  return [
    `spectrum (share of the energy, dB): sub ${b.sub} · bass ${b.bass} · low-mid ${b.lowMid} · mid ${b.mid} · high-mid ${b.highMid} · high ${b.high}; centroid ${a.centroid} Hz; crest ${a.crest} dB`,
    `stereo: correlation ${a.stereo.correlation}, width ${Number.isFinite(a.stereo.width) ? `${a.stereo.width} dB` : "none (mono)"}`,
    `level through time (dBFS, every ${a.envelope.window} s): ${a.envelope.rms.map((v) => Math.round(v)).join(" ")}`,
  ];
}

export function registerMusicTools(pi: ExtensionAPI): void {
  const libraryRoot = () => process.env.AVG_LIBRARY_ROOT || join(process.cwd(), "library");
  const PARTS = {
    only: Type.Optional(Type.Array(Type.String(), { description: "Only these parts play (their labels; $1, $2… for unlabelled ones)" })),
    mute: Type.Optional(Type.Array(Type.String(), { description: "These parts do not play" })),
    network: Type.Optional(Type.Boolean({ description: "Let the piece fetch sample packs from the network (default no: a piece then depends only on its code and the workspace's files). Their licence is yours to check" })),
  };

  pi.registerTool({
    name: "pva_music_check",
    label: "Check Music",
    description:
      "Evaluate a piece of music written as Strudel code, without making a sound: its tempo, its parts (labelled statements), how many events " +
      "each plays in every cycle, their notes and sounds, and what is wrong — a syntax error, a sound that does not exist, a part that is silent, " +
      "a label that solos. Give the piece's path (music/<name>.strudel in the workspace), or `code` to try something before saving it. " +
      "`events` lists a part's first events with every control, to read what a chord or scale expression really produced. Fast and free: " +
      "check after every edit, before pva_music_render. Load the strudel-music skill before writing a piece.",
    parameters: Type.Object({
      ...WORKSPACE_PARAMS,
      path: Type.Optional(Type.String({ description: "The piece, relative to the workspace (e.g. music/theme.strudel)" })),
      code: Type.Optional(Type.String({ description: "Instead of path: Strudel code to try" })),
      from: Type.Optional(Type.Number({ minimum: 0, description: "First cycle (default 0)" })),
      cycles: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "How many cycles to look at (default 4)" })),
      events: Type.Optional(Type.Integer({ minimum: 0, maximum: 200, description: "List up to this many events of each part (default 0)" })),
      ...PARTS,
    }),
    async execute(_id, params, signal) {
      try {
        const root = libraryRoot();
        const ws = workspaceOf(root, params);
        if (params.path !== undefined) {
          const guard = await guardWorkspacePath(root, ws, params.path);
          if (!guard.allowed) throw new Error(`path: ${guard.reason ?? "rejected"}`);
        }
        const { inspection, source } = await checkMusic(ws.dir, {
          ...(params.path !== undefined ? { path: params.path } : {}), ...(params.code !== undefined ? { code: params.code } : {}),
          ...(params.from !== undefined ? { from: params.from } : {}), ...(params.cycles !== undefined ? { cycles: params.cycles } : {}),
          ...(params.events !== undefined ? { events: params.events } : {}), ...(params.only ? { only: params.only } : {}),
          ...(params.mute ? { mute: params.mute } : {}), ...(params.network ? { network: true } : {}),
        }, signal ? { signal } : {});
        return {
          content: [{ type: "text" as const, text: describeInspection(source?.path ?? "the code", inspection) }],
          details: { inspection, source } as unknown as Record<string, unknown>,
          ...(inspection.ok ? {} : { isError: true as unknown as boolean }),
        };
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "pva_music_render",
    label: "Render Music",
    description:
      "Render a piece of music written as Strudel code to a WAV (48 kHz stereo, 24-bit) in the workspace, locally at $0: the whole piece or " +
      "a stretch of its cycles (`from`, `cycles` or `seconds`), every part or some (`only`, `mute`), with a `tail` for reverb and releases to " +
      "ring out, or as a seamless `loop` (the tail folded over the start). `stems` also writes each part alone, at the gain it has in the mix. " +
      `The file is brought to a loudness with one gain (default ${MUSIC_LOUDNESS} LUFS, peaks under ${MUSIC_PEAK} dBFS; never a compressor). ` +
      `Output goes under ${MUSIC_OUTPUT_DIRS.join(", ")} (default assets/sounds/<piece>.wav, which a spec names as its sound id), with ` +
      "<file>.music.json beside it: the piece and the file by hash, the level and where the peak is, the spectrum by band, the stereo image, " +
      "the level through time, the same for each stem, and what to listen for. Nothing is written when the piece does not evaluate. " +
      "You cannot hear it: read the numbers the tool returns.",
    parameters: Type.Object({
      ...WORKSPACE_PARAMS,
      path: Type.String({ description: "The piece, relative to the workspace (e.g. music/theme.strudel)" }),
      output: Type.Optional(Type.String({ description: "Where the WAV goes, relative to the workspace (default assets/sounds/<piece name>.wav). In a film, music/<name>.wav on the film itself" })),
      from: Type.Optional(Type.Number({ minimum: 0, description: "First cycle (default 0)" })),
      cycles: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "How many cycles to render. Give this or seconds" })),
      seconds: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Instead of cycles: as many whole cycles as fit in so many seconds at the piece's tempo" })),
      lead: Type.Optional(Type.Number({ minimum: 0, description: "Cycles played before `from` and cut off, so a stretch opens with what they left ringing (default 0)" })),
      tail: Type.Optional(Type.Number({ minimum: 0, maximum: 60, description: "Seconds kept after the last cycle for the sound to end (default 0)" })),
      loop: Type.Optional(Type.Boolean({ description: "Fold the tail over the start: the file repeats without a seam, and is exactly the cycles long" })),
      stems: Type.Optional(Type.Boolean({ description: "Also write each part alone as <output>.<part>.wav" })),
      seed: Type.Optional(Type.Integer({ minimum: 0, description: "Seeds the engine's randomness (noise, reverb, detune): another seed is another take of the same notes (default 0)" })),
      loudness: Type.Optional(Type.Union([Type.Number({ maximum: 0 }), Type.Null()], { description: `Integrated loudness to bring the file to, LUFS (default ${MUSIC_LOUDNESS}); null keeps the level the piece has` })),
      peak: Type.Optional(Type.Number({ maximum: 0, description: `Peak ceiling, dBFS (default ${MUSIC_PEAK})` })),
      fadeIn: Type.Optional(Type.Number({ minimum: 0, description: "Seconds of fade at the start of the file (the render's, not a control of the piece)" })),
      fadeOut: Type.Optional(Type.Number({ minimum: 0, description: "Seconds of fade at the end of the file" })),
      ...PARTS,
    }),
    async execute(_id, params, signal) {
      try {
        const root = libraryRoot();
        const ws = workspaceOf(root, params);
        for (const [what, relative] of [["path", params.path], ["output", params.output]] as const) {
          if (relative === undefined) continue;
          const guard = await guardWorkspacePath(root, ws, relative);
          if (!guard.allowed) throw new Error(`${what}: ${guard.reason ?? "rejected"}`);
        }
        const hasLevel = params.loudness !== undefined || params.peak !== undefined || params.fadeIn !== undefined || params.fadeOut !== undefined;
        const request: MusicRequest = {
          path: params.path,
          ...(params.output !== undefined ? { output: params.output } : {}),
          ...(params.from !== undefined ? { from: params.from } : {}), ...(params.cycles !== undefined ? { cycles: params.cycles } : {}),
          ...(params.seconds !== undefined ? { seconds: params.seconds } : {}), ...(params.lead !== undefined ? { lead: params.lead } : {}),
          ...(params.tail !== undefined ? { tail: params.tail } : {}), ...(params.loop ? { loop: true } : {}),
          ...(params.only ? { only: params.only } : {}), ...(params.mute ? { mute: params.mute } : {}),
          ...(params.stems ? { stems: true } : {}), ...(params.seed !== undefined ? { seed: params.seed } : {}),
          ...(params.network ? { network: true } : {}),
          ...(hasLevel ? { level: {
            ...(params.loudness !== undefined ? { loudness: params.loudness } : {}), ...(params.peak !== undefined ? { peak: params.peak } : {}),
            ...(params.fadeIn !== undefined ? { fadeIn: params.fadeIn } : {}), ...(params.fadeOut !== undefined ? { fadeOut: params.fadeOut } : {}),
          } } : {}),
        };
        const { record, recordPath } = await renderMusic(ws.dir, request, signal ? { signal } : {});
        const o = record.output;
        const shape = o.loop ? "a seamless loop" : o.durationSeconds > o.bodySeconds ? `${+(o.durationSeconds - o.bodySeconds).toFixed(2)} s of it tail` : "no tail";
        const lines = [
          `${record.concerns.length === 0 ? "✅" : "⚠️"} ${o.path}: ${o.durationSeconds} s (cycles ${record.range.from}–${record.range.to} at ${tempo(record.tempo.cps)}; ${shape}) → ${recordPath}`,
          describeLevel(record),
          `parts: ${record.parts.filter((p) => p.selected).map((p) => p.name).join(", ") || "one unlabelled pattern"}` +
            `${record.parts.some((p) => !p.selected) ? `; not playing: ${record.parts.filter((p) => !p.selected).map((p) => p.name).join(", ")}` : ""}`,
          ...describeAnalysis(record.analysis as unknown as AudioAnalysis),
          ...(record.stems.length > 0 ? ["stems (each part alone, at the mix's gain; its strongest bands):", ...record.stems.map(describeStem)] : []),
          ...(Object.keys(record.inputs).length > 0 ? [`samples from the workspace: ${Object.keys(record.inputs).join(", ")}`] : []),
          ...record.concerns.map((c) => `- ${c}`),
        ];
        return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { recordPath, record } as unknown as Record<string, unknown> };
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "pva_music",
    label: "Music",
    description:
      "List the pieces of music of an episode, a channel source or a film unit (music/*.strudel) and what was rendered from each: the file, " +
      "the cycles, the parts, its length and loudness, whether the piece changed since (stale) and whether the file is still there.",
    parameters: Type.Object({ ...WORKSPACE_PARAMS }),
    async execute(_id, params) {
      try {
        const ws = workspaceOf(libraryRoot(), params);
        const listed = listMusic(ws.dir);
        const render = (r: (typeof listed.orphans)[number]) => {
          const parts = r.record.parts.filter((p) => p.selected).map((p) => p.name);
          const all = r.record.parts.every((p) => p.selected || p.muted);
          return `  - ${r.record.output.path}${r.missing ? " (MISSING or replaced)" : ""}${r.current ? "" : " (STALE: the piece changed since)"}: cycles ${r.record.range.from}–${r.record.range.to}, ` +
            `${r.record.output.durationSeconds} s${r.record.output.loop ? ", loop" : ""}, ${level(r.record.level.loudness, "LUFS")}${all ? "" : `, only ${parts.join(", ")}`}` +
            `${r.record.stems.length > 0 ? `, ${r.record.stems.length} stems` : ""}`;
        };
        const lines = listed.pieces.flatMap((piece) => [`- ${piece.path}${piece.renders.length === 0 ? ": not rendered yet" : ""}`, ...piece.renders.map(render)]);
        if (listed.orphans.length > 0) lines.push("- rendered from pieces that are gone:", ...listed.orphans.map(render));
        if (listed.invalid.length > 0) lines.push(`⚠️ unreadable records: ${listed.invalid.join(", ")}`);
        const text = lines.length > 0 ? `${ws.label}:\n${lines.join("\n")}` : `${ws.label} has no music: a piece is music/<name>.strudel (load the strudel-music skill)`;
        return { content: [{ type: "text" as const, text }], details: listed as unknown as Record<string, unknown> };
      } catch (error) {
        return fail(error);
      }
    },
  });
}
