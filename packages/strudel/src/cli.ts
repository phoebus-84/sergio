#!/usr/bin/env node
// strudel-render: check a piece, render it, or list the engine's sounds.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import { analyzeAudio } from "./analyze.js";
import { StrudelError } from "./errors.js";
import { StrudelRenderer } from "./renderer.js";
import type { Inspection, RenderOptions } from "./types.js";
import { encodeWav, type WavFormat } from "./wav.js";

const USAGE = `strudel-render check <piece> [--from N] [--cycles N] [--events N] [--only a,b] [--mute a,b] [--files DIR] [--network] [--json]
strudel-render render <piece> -o <file.wav> (--cycles N | --seconds S) [--from N] [--lead N] [--tail S] [--loop]
                      [--only a,b] [--mute a,b] [--stems] [--seed N] [--rate HZ] [--format f32|pcm24|pcm16]
                      [--files DIR] [--network] [--json]
strudel-render sounds [--json]

<piece> is a file of Strudel code, or - for standard input.`;

function parse(argv: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const bare = new Set(["loop", "stems", "network", "json", "help"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-o") flags.set("output", argv[++i] ?? "");
    else if (arg.startsWith("--")) {
      const name = arg.slice(2);
      flags.set(name, bare.has(name) ? true : argv[++i] ?? "");
    } else positional.push(arg);
  }
  return { positional, flags };
}

const list = (value: string | true | undefined) => (typeof value === "string" && value ? value.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
const number = (value: string | true | undefined, name: string) => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (typeof value !== "string" || !Number.isFinite(n)) throw new StrudelError("bad-options", `--${name} takes a number`);
  return n;
};

function printInspection(seen: Inspection): void {
  const bar = seen.cps > 0 ? `${(seen.cps * 60).toFixed(2)} cycles a minute` : "";
  console.log(`${seen.ok ? "ok" : "NOT OK"}: cycles ${seen.from}–${seen.to}, ${seen.seconds} s at ${bar}; ${seen.events} events`);
  for (const part of seen.parts) {
    const state = part.muted ? " (muted in the code)" : !part.selected ? " (left out)" : part.solo ? " (solo)" : "";
    const notes = part.notes ? `, notes ${part.notes.low}–${part.notes.high}` : "";
    console.log(`  ${part.name}${state}: ${part.events} events [${part.perCycle.join(" ")}]${notes}, ${part.sounds.map((s) => s.name).join(" ") || "no sound"}`);
    for (const e of part.listed) console.log(`    ${e.at.toFixed(3)} +${e.cycles} ${JSON.stringify(e.value)}`);
  }
  if (seen.sounds.length) console.log(`  sounds: ${seen.sounds.map((s) => `${s.name} (${s.type}, ${s.count})`).join(", ")}`);
  for (const e of seen.listed) console.log(`    ${e.at.toFixed(3)} +${e.cycles} ${JSON.stringify(e.value)}`);
  for (const problem of seen.problems) console.log(`  ${problem.level}: ${problem.message}`);
}

async function main(): Promise<number> {
  const [command, piece] = process.argv.slice(2);
  const { flags } = parse(process.argv.slice(command === "sounds" ? 3 : 4));
  if (!command || flags.has("help") || !["check", "render", "sounds"].includes(command) || (command !== "sounds" && !piece)) {
    console.error(USAGE);
    return 2;
  }
  const json = flags.has("json");
  const renderer = await StrudelRenderer.launch();
  try {
    if (command === "sounds") {
      const sounds = await renderer.sounds();
      console.log(json ? JSON.stringify(sounds) : sounds.map((s) => `${s.name}\t${s.type}`).join("\n"));
      return 0;
    }
    const code = readFileSync(piece === "-" ? 0 : piece!, "utf-8");
    const from = number(flags.get("from"), "from") ?? 0;
    const cycles = number(flags.get("cycles"), "cycles");
    const shared = {
      only: list(flags.get("only")), mute: list(flags.get("mute")), seed: number(flags.get("seed"), "seed"),
      files: typeof flags.get("files") === "string" ? (flags.get("files") as string) : undefined, network: flags.has("network"),
    };
    if (command === "check") {
      const seen = await renderer.inspect(code, { ...shared, from, to: from + (cycles ?? 4), events: number(flags.get("events"), "events") ?? 0 });
      if (json) console.log(JSON.stringify(seen));
      else printInspection(seen);
      return seen.ok ? 0 : 1;
    }

    const output = flags.get("output");
    if (typeof output !== "string" || !output) throw new StrudelError("bad-options", "render needs -o <file.wav>");
    const format = (flags.get("format") ?? "f32") as WavFormat;
    if (!["f32", "pcm24", "pcm16"].includes(format)) throw new StrudelError("bad-options", "--format is f32, pcm24 or pcm16");
    const options: RenderOptions = {
      ...shared, from,
      ...(cycles !== undefined ? { to: from + cycles } : {}),
      seconds: number(flags.get("seconds"), "seconds"),
      lead: number(flags.get("lead"), "lead"), tail: number(flags.get("tail"), "tail"),
      loop: flags.has("loop"), sampleRate: number(flags.get("rate"), "rate"),
    };
    const report: Record<string, unknown>[] = [];
    const renderTo = async (file: string, extra: Partial<RenderOptions>) => {
      const made = await renderer.render(code, { ...options, ...extra });
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, encodeWav(made.channels, made.sampleRate, format));
      const analysis = analyzeAudio(made.channels, made.sampleRate);
      report.push({ file, cps: made.cps, from: made.from, to: made.to, events: made.events, parts: made.parts, problems: made.problems, requests: made.requests, analysis });
      if (!json) {
        const b = analysis.bands;
        console.log(`${file}: ${analysis.seconds} s, cycles ${made.from}–${made.to}, ${made.events} events; peak ${analysis.peak} dBFS, ${analysis.lufs ?? "–"} LUFS, crest ${analysis.crest} dB`);
        console.log(`  bands dB: sub ${b.sub}, bass ${b.bass}, low-mid ${b.lowMid}, mid ${b.mid}, high-mid ${b.highMid}, high ${b.high}; centroid ${analysis.centroid} Hz`);
        console.log(`  stereo: correlation ${analysis.stereo.correlation}, width ${analysis.stereo.width} dB; envelope (${analysis.envelope.window} s): ${analysis.envelope.rms.map((v) => Math.round(v)).join(" ")}`);
        for (const problem of made.problems) console.log(`  ${problem.level}: ${problem.message}`);
      }
      return made;
    };
    const mix = await renderTo(output, {});
    if (flags.has("stems")) {
      const extension = extname(output);
      for (const part of mix.parts.filter((p) => p.selected)) {
        await renderTo(`${output.slice(0, output.length - extension.length)}.${part.name.replace(/[^\w-]/g, "_")}${extension}`, { only: [part.name], mute: [] });
      }
    }
    if (json) console.log(JSON.stringify(report));
    return report.some((r) => (r.problems as { level: string }[]).some((p) => p.level === "error")) ? 1 : 0;
  } finally {
    await renderer.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof StrudelError ? `${error.code}: ${error.message}` : error);
    process.exit(1);
  },
);
