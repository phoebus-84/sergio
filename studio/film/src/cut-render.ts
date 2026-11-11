// ---------------------------------------------------------------------------
// A unit's cut, resolved to files and rendered
// ---------------------------------------------------------------------------
// A cut names its sources as the film knows them: a file of the unit, a file
// of the film (footage/, music/), or a unit below it. Rendering resolves each
// to a file. A unit below resolves to its render — so a scene is rendered from
// its shots' renders and the film from its scenes', each level once, and a
// change re-renders what it touches and what is above it.
//
// A render is immutable: output/<render-id>.mp4 with the cut it rendered and a
// report beside it. output/current.json points at the unit's final render and
// output/preview.json at its latest preview; neither moves until the file is
// whole. A render is FRESH while the cut and every file it read are as they
// were: the report keeps a fingerprint of both.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  checkCut, renderCut, renderCutFrame, CutError,
  type Cut, type CutClip as RenderClip, type CutProblem as RenderProblem, type RenderCutResult, type RenderProgress, type RenderQuality,
} from "@av/video-composer";
import { filmPath } from "@studio/contracts/src/layout.mjs";
import { appendJournalEvent } from "@studio/contracts/src/journal.mjs";
import { CUT_TIMELINE_PATH, cutDuration, hasCutErrors, sourceKind, type CutProblem, type CutTimeline } from "@studio/contracts/src/cut-timeline.mjs";
import type { FilmManifest } from "@studio/contracts/src/film.mjs";
import { writeAtomically } from "./authoring.js";
import { readCut, serialize, sha256 } from "./cut-store.js";
import {
  FilmError, childUnit, existingUnitDir, filmUnit, levelOf, libraryRelative, readManifest, unitDir, unitLabel, type UnitRef,
} from "./units.js";

export type { RenderQuality };

/** Where a unit's pieces are kept between renders. Never content: the name is reserved. */
export const WORK_DIR = ".cut";

const POINTER: Record<RenderQuality, string> = { final: "current.json", preview: "preview.json" };

export interface RenderPointer {
  renderId: string;
  /** The video, relative to output/. */
  path: string;
  quality: RenderQuality;
  fingerprint: string;
  frames: number;
  durationSeconds: number;
  createdAt: string;
  /** The lossless mix beside the video, relative to output/, when one was kept. */
  mix?: string;
}

/** A unit's pointer to its final or its preview render, when it points at a file that is there. */
export function readPointer(root: string, ref: UnitRef, quality: RenderQuality): RenderPointer | null {
  const output = join(unitDir(root, ref), "output");
  let pointer: Partial<RenderPointer>;
  try {
    pointer = JSON.parse(readFileSync(join(output, POINTER[quality]), "utf-8")) as Partial<RenderPointer>;
  } catch {
    return null;
  }
  if (typeof pointer.renderId !== "string" || typeof pointer.path !== "string" || pointer.path.includes("..") || pointer.path.startsWith("/")) return null;
  if (typeof pointer.fingerprint !== "string") return null;
  if (!existsSync(join(output, pointer.path))) return null;
  return {
    renderId: pointer.renderId,
    path: pointer.path,
    quality,
    fingerprint: pointer.fingerprint,
    frames: Number(pointer.frames) || 0,
    durationSeconds: Number(pointer.durationSeconds) || 0,
    createdAt: typeof pointer.createdAt === "string" ? pointer.createdAt : "",
    ...(typeof pointer.mix === "string" && existsSync(join(output, pointer.mix)) ? { mix: pointer.mix } : {}),
  };
}

const fileState = (file: string): [number, number] | null => {
  try {
    const info = statSync(file);
    return info.isFile() ? [info.size, Math.round(info.mtimeMs)] : null;
  } catch {
    return null;
  }
};

export interface ResolvedCut {
  /** The cut as the renderer takes it: every source a file. */
  cut: Cut;
  /** What stops the cut from being resolved or rendered, and what to know about it. */
  problems: CutProblem[];
  /** What the render depends on: the cut and the state of every file it reads. */
  fingerprint: string;
  /** The units below that the cut reads, with the render each resolved to (null: it has none usable). */
  children: { unit: UnitRef; slug: string; renderId: string | null; quality: RenderQuality | null; fresh: boolean }[];
  /** An effect's file (a LUT) as a path, looked for in the unit and then in the film. */
  resolveFile: (file: string) => string;
}

export interface ResolveOptions {
  /** The quality the render will have: a final render reads final renders; a preview reads whatever is fresh. */
  quality: RenderQuality;
}

/**
 * A unit's render to nest, for a quality. A final cut reads only a final
 * render. A preview reads the unit's fresh render, final first, and failing
 * that whichever exists — a preview of a slightly old shot is still a preview.
 */
function nestedRender(root: string, unit: UnitRef, quality: RenderQuality): { pointer: RenderPointer; fresh: boolean } | null {
  const candidates: RenderQuality[] = quality === "final" ? ["final"] : ["final", "preview"];
  const found: { pointer: RenderPointer; fresh: boolean }[] = [];
  for (const candidate of candidates) {
    const pointer = readPointer(root, unit, candidate);
    if (!pointer) continue;
    found.push({ pointer, fresh: isFresh(root, unit, pointer) });
  }
  return found.find((entry) => entry.fresh) ?? found[0] ?? null;
}

/**
 * Resolve a unit's cut to the files it reads. Never throws for what is wrong
 * with the cut or its sources: every problem is in the result.
 */
export function resolveCut(root: string, ref: UnitRef, timeline: CutTimeline, options: ResolveOptions): ResolvedCut {
  const dir = unitDir(root, ref);
  const film = filmPath(root, ref.channel);
  const level = levelOf(ref);
  const problems: CutProblem[] = [];
  const children: ResolvedCut["children"] = [];
  const states: unknown[] = [];
  const add = (code: string, path: string, message: string, severity: CutProblem["severity"] = "error") => problems.push({ code, path, message, severity });

  const nested = new Map<string, { file: string; audioFile?: string } | null>();
  const nest = (slug: string, path: string): { file: string; audioFile?: string } | null => {
    if (nested.has(slug)) return nested.get(slug)!;
    let resolved: { file: string; audioFile?: string } | null = null;
    if (level === "shot") {
      add("clip-source", path, `a shot is cut from files: "${slug}" names a unit`);
    } else {
      const unit = childUnit(ref, slug);
      const what = level === "film" ? "scene" : "shot";
      if (!existsSync(unitDir(root, unit))) {
        add("unit-missing", path, `there is no ${what} "${slug}" in ${unitLabel(ref)}`);
        children.push({ unit, slug, renderId: null, quality: null, fresh: false });
      } else {
        const render = nestedRender(root, unit, options.quality);
        if (!render) {
          add("unit-not-rendered", path, `${what} "${slug}" has no ${options.quality === "final" ? "final " : ""}render yet: render it first`);
          children.push({ unit, slug, renderId: null, quality: null, fresh: false });
        } else {
          if (!render.fresh) add("unit-stale", path, `${what} "${slug}" changed since its render ${render.pointer.renderId}: render it again`, options.quality === "final" ? "error" : "warning");
          const output = join(unitDir(root, unit), "output");
          resolved = { file: join(output, render.pointer.path), ...(render.pointer.mix ? { audioFile: join(output, render.pointer.mix) } : {}) };
          children.push({ unit, slug, renderId: render.pointer.renderId, quality: render.pointer.quality, fresh: render.fresh });
        }
      }
    }
    nested.set(slug, resolved);
    return resolved;
  };

  const tracks = timeline.tracks.map((track, t) => ({
    id: track.id,
    kind: track.kind,
    ...(track.muted ? { muted: true } : {}),
    ...(track.gain !== undefined ? { gain: track.gain } : {}),
    ...(track.duck ? { duck: track.duck } : {}),
    ...(track.effects ? { effects: track.effects } : {}),
    clips: track.clips.flatMap((clip, c): RenderClip[] => {
      const path = `$.tracks[${t}].clips[${c}].source`;
      const kind = sourceKind(clip.source);
      let media: RenderClip["media"] | null = null;
      if (kind === "color") {
        media = { color: clip.source.color! };
      } else if (kind === "unit") {
        media = nest(clip.source.unit!, path);
      } else if (kind === "path" || kind === "project") {
        const file = kind === "path" ? join(dir, clip.source.path!) : join(film, clip.source.project!);
        const state = fileState(file);
        if (!state) add("missing-file", path, `${kind === "path" ? clip.source.path : `the film's ${clip.source.project}`} is not there`);
        else media = { file };
      }
      if (!media) return [];
      const { source: _source, label: _label, locked: _locked, note: _note, ...rest } = clip;
      return [{ ...rest, media }];
    }),
  }));

  const loudness = timeline.master?.loudness
    // Only the film is brought to a delivery loudness: a shot and a scene keep the levels they were mixed at.
    ?? (level === "film" ? readManifest<FilmManifest>(root, filmUnit(ref.channel)).manifest?.format?.loudness : undefined);
  const cut: Cut = {
    width: timeline.format.width,
    height: timeline.format.height,
    fps: timeline.format.fps,
    tracks,
    ...(timeline.master || loudness ? {
      master: {
        ...(timeline.master?.video ? { video: timeline.master.video } : {}),
        ...(timeline.master?.audio ? { audio: timeline.master.audio } : {}),
        ...(loudness ? { loudness: { integrated: loudness.integrated, truePeak: loudness.truePeak } } : {}),
      },
    } : {}),
  };

  const resolveFile = (file: string): string => {
    const own = join(dir, file);
    return existsSync(own) ? own : join(film, file);
  };

  // The fingerprint: the resolved cut with every file replaced by its place in the library and its state.
  const seen = new Set<string>();
  const stateOf = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    states.push([libraryRelative(root, file), fileState(file)]);
  };
  const portable = JSON.stringify(cut, (_key, value: unknown) => {
    if (typeof value === "string" && (value.startsWith(root) || value.startsWith(dir))) {
      stateOf(value);
      return libraryRelative(root, value);
    }
    return value;
  });
  for (const effects of [timeline.master?.video ?? [], ...timeline.tracks.flatMap((track) => track.clips.map((clip) => clip.effects ?? []))]) {
    for (const effect of effects) {
      const file = effect.params?.file;
      if (typeof file === "string") stateOf(resolveFile(file));
    }
  }
  const fingerprint = sha256(JSON.stringify([portable, states.sort((a, b) => String((a as unknown[])[0]).localeCompare(String((b as unknown[])[0])))]));
  return { cut, problems, fingerprint, children, resolveFile };
}

/** Whether a render is still what its unit would render: the cut and every file it read are as they were. */
export function isFresh(root: string, ref: UnitRef, pointer: RenderPointer): boolean {
  const stored = readCut(root, ref);
  if (!stored.cut || hasCutErrors(stored.problems)) return false;
  const resolved = resolveCut(root, ref, stored.cut, { quality: pointer.quality });
  if (hasCutErrors(resolved.problems)) return false;
  return resolved.fingerprint === pointer.fingerprint;
}

export type RenderState = "no-cut" | "invalid-cut" | "blocked" | "not-rendered" | "stale" | "preview" | "current";

export interface CutStatus {
  state: RenderState;
  /** One sentence a person or the agent can act on. */
  reason: string;
  cut: { exists: boolean; revision: number | null; frames: number; seconds: number; clips: number; tracks: number };
  problems: CutProblem[];
  final: (RenderPointer & { fresh: boolean }) | null;
  preview: (RenderPointer & { fresh: boolean }) | null;
  children: ResolvedCut["children"];
}

/**
 * Where a unit stands: whether it has a cut, whether the cut can be rendered,
 * and whether its renders are still what it would render.
 */
export function cutStatus(root: string, ref: UnitRef): CutStatus {
  const stored = readCut(root, ref);
  const pointers = { final: readPointer(root, ref, "final"), preview: readPointer(root, ref, "preview") };
  const empty = { exists: stored.exists, revision: stored.cut?.revision ?? null, frames: 0, seconds: 0, clips: 0, tracks: 0 };
  if (!stored.exists) {
    return { state: "no-cut", reason: `${unitLabel(ref)} has no cut yet (${CUT_TIMELINE_PATH})`, cut: empty, problems: [], final: null, preview: null, children: [] };
  }
  if (!stored.cut || hasCutErrors(stored.problems)) {
    const first = stored.problems.find((p) => p.severity === "error");
    return { state: "invalid-cut", reason: `the cut cannot be used: ${first ? `${first.path} ${first.message}` : "it is not a cut"}`, cut: empty, problems: stored.problems, final: null, preview: null, children: [] };
  }
  const timeline = stored.cut;
  const frames = cutDuration(timeline);
  const cut = {
    exists: true, revision: timeline.revision, frames, seconds: frames / timeline.format.fps,
    clips: timeline.tracks.reduce((count, track) => count + track.clips.length, 0), tracks: timeline.tracks.length,
  };
  const forFinal = resolveCut(root, ref, timeline, { quality: "final" });
  const forPreview = resolveCut(root, ref, timeline, { quality: "preview" });
  const final = pointers.final ? { ...pointers.final, fresh: !hasCutErrors(forFinal.problems) && forFinal.fingerprint === pointers.final.fingerprint } : null;
  const preview = pointers.preview ? { ...pointers.preview, fresh: !hasCutErrors(forPreview.problems) && forPreview.fingerprint === pointers.preview.fingerprint } : null;
  const problems = [...stored.problems, ...forFinal.problems];
  const base = { cut, problems, final, preview, children: forFinal.children };

  if (frames === 0) return { ...base, state: "no-cut", reason: "the cut has no clip yet" };
  if (final?.fresh) return { ...base, state: "current", reason: `rendered: ${final.renderId}` };
  const blocking = forFinal.problems.find((p) => p.severity === "error");
  if (blocking) {
    if (preview?.fresh) return { ...base, state: "preview", reason: `only a preview is current (${preview.renderId}); for a final render: ${blocking.message}` };
    return { ...base, state: "blocked", reason: blocking.message };
  }
  if (final) return { ...base, state: "stale", reason: `the cut or its sources changed since ${final.renderId}: render it again` };
  if (preview?.fresh) return { ...base, state: "preview", reason: `only a preview is current (${preview.renderId}): render it at final quality` };
  return { ...base, state: "not-rendered", reason: "the cut is ready to render" };
}

/** Every problem of a unit's cut, its files and its effects included: what a render would refuse or warn about. */
export async function checkUnitCut(root: string, ref: UnitRef, quality: RenderQuality = "final"): Promise<CutProblem[]> {
  const stored = readCut(root, ref);
  if (!stored.exists) return [{ code: "no-cut", path: "$", message: `${unitLabel(ref)} has no cut yet`, severity: "error" }];
  if (!stored.cut || hasCutErrors(stored.problems)) return stored.problems;
  const resolved = resolveCut(root, ref, stored.cut, { quality });
  if (hasCutErrors(resolved.problems)) return [...stored.problems, ...resolved.problems];
  const deep = await checkCut(resolved.cut);
  return [...stored.problems, ...resolved.problems, ...deep.map((p: RenderProblem) => ({ ...p }))];
}

export interface RenderUnitOptions {
  quality?: RenderQuality;
  /** Frames of the timeline to render: [from, to). A range never becomes the unit's render: it is a look at part of it. */
  range?: { from: number; to: number };
  /** Render first the units below that have no fresh render of this quality. Default true. */
  cascade?: boolean;
  /** Render even when the unit's render is fresh. */
  force?: boolean;
  /** Who asked, for the journal. */
  actor?: "pi" | "human" | "gateway" | "runtime" | "system";
  signal?: AbortSignal;
  onProgress?: (progress: RenderProgress & { unit: string }) => void;
}

export interface UnitRender {
  unit: UnitRef;
  renderId: string;
  quality: RenderQuality;
  /** The video, relative to the library root. */
  path: string;
  reportPath: string;
  /** True when the unit already had a fresh render and nothing was rendered. */
  reused: boolean;
  /** Whether output/current.json or output/preview.json now points at it. */
  current: boolean;
  frames: number;
  durationSeconds: number;
  result: RenderCutResult | null;
  warnings: CutProblem[];
  /** The units below that were rendered on the way, deepest first. */
  cascaded: UnitRender[];
}

function asUnitRender(root: string, ref: UnitRef, pointer: RenderPointer, cascaded: UnitRender[]): UnitRender {
  const output = join(unitDir(root, ref), "output");
  return {
    unit: ref, renderId: pointer.renderId, quality: pointer.quality,
    path: libraryRelative(root, join(output, pointer.path)),
    reportPath: libraryRelative(root, join(output, `${pointer.renderId}.report.json`)),
    reused: true, current: true, frames: pointer.frames, durationSeconds: pointer.durationSeconds, result: null, warnings: [], cascaded,
  };
}

/**
 * Render a unit's cut to output/<render-id>.mp4 and point the unit at it.
 *
 * With `cascade`, the units below that have no fresh render are rendered
 * first — a film render brings every scene and shot up to date, and renders
 * nothing that already is. A unit with a fresh render is not rendered again.
 */
export async function renderUnit(root: string, ref: UnitRef, options: RenderUnitOptions = {}): Promise<UnitRender> {
  const dir = existingUnitDir(root, ref);
  const quality = options.quality ?? "final";
  const stored = readCut(root, ref);
  if (!stored.exists || !stored.cut) throw new FilmError(`${unitLabel(ref)} has no cut to render: assemble or write ${CUT_TIMELINE_PATH} first`, "no-cut", stored.problems);
  if (hasCutErrors(stored.problems)) {
    const errors = stored.problems.filter((p) => p.severity === "error");
    throw new FilmError(`the cut of ${unitLabel(ref)} cannot be rendered: ${errors.map((p) => `${p.path} ${p.message}`).slice(0, 5).join("; ")}`, "invalid-cut", stored.problems);
  }
  const timeline = stored.cut;

  const cascaded: UnitRender[] = [];
  let resolved = resolveCut(root, ref, timeline, { quality });
  if (options.cascade !== false) {
    const due = resolved.children.filter((child) => !child.fresh && existsSync(unitDir(root, child.unit)));
    for (const child of due) {
      if (options.signal?.aborted) throw new FilmError("the render was cancelled", "cancelled");
      cascaded.push(await renderUnit(root, child.unit, { ...options, range: undefined, force: false }));
    }
    if (due.length > 0) resolved = resolveCut(root, ref, timeline, { quality });
  }
  const errors = resolved.problems.filter((p) => p.severity === "error");
  if (errors.length > 0) {
    throw new FilmError(`${unitLabel(ref)} cannot be rendered: ${errors.map((p) => p.message).slice(0, 5).join("; ")}${errors.length > 5 ? ` (and ${errors.length - 5} more)` : ""}`, "blocked", resolved.problems);
  }

  if (!options.range && !options.force) {
    const pointer = readPointer(root, ref, quality);
    if (pointer && pointer.fingerprint === resolved.fingerprint) return asUnitRender(root, ref, pointer, cascaded);
  }

  const outputDir = join(dir, "output");
  const renderId = `${options.range ? "range" : quality}-${Date.now()}-${resolved.fingerprint.slice(0, 8)}`;
  const output = join(outputDir, `${renderId}.mp4`);
  let result: RenderCutResult;
  try {
    result = await renderCut(resolved.cut, {
      output,
      workDir: join(dir, WORK_DIR),
      quality,
      // The mix is kept for a final render: the unit above reads it instead of the AAC.
      keepMix: quality === "final" && !options.range,
      resolveFile: resolved.resolveFile,
      ...(options.range ? { range: options.range } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onProgress ? { onProgress: (progress) => options.onProgress!({ ...progress, unit: unitLabel(ref) }) } : {}),
    });
  } catch (error) {
    if (error instanceof CutError) throw new FilmError(`${unitLabel(ref)}: ${error.message}`, error.code, error.problems as CutProblem[]);
    throw error;
  }

  const createdAt = new Date().toISOString();
  const reportPath = join(outputDir, `${renderId}.report.json`);
  writeAtomically(join(outputDir, `${renderId}.cut.json`), serialize(timeline));
  writeAtomically(reportPath, serialize({
    apiVersion: "studio.video/v1alpha1",
    kind: "CutRender",
    unit: ref,
    renderId,
    quality,
    ...(options.range ? { range: options.range } : {}),
    createdAt,
    cut: { path: CUT_TIMELINE_PATH, revision: timeline.revision, hash: `sha256:${stored.hash}` },
    fingerprint: resolved.fingerprint,
    children: resolved.children.map((child) => ({ unit: child.unit, renderId: child.renderId, quality: child.quality })),
    result: {
      ...result,
      output: `${renderId}.mp4`,
      mix: result.mix ? `${renderId}.mix.wav` : null,
      inputs: result.inputs.map((input) => ({ ...input, file: libraryRelative(root, input.file) })),
    },
  }));

  // A range is a look at part of the cut: the unit's render stays what it was.
  const current = !options.range;
  if (current) {
    const pointer: RenderPointer = {
      renderId, path: `${renderId}.mp4`, quality, fingerprint: resolved.fingerprint,
      frames: result.frames, durationSeconds: result.durationSeconds, createdAt,
      ...(result.mix ? { mix: `${renderId}.mix.wav` } : {}),
    };
    writeAtomically(join(outputDir, POINTER[quality]), serialize(pointer));
    if (quality === "final") {
      await appendJournalEvent(dir, {
        type: "deliverable-current-changed", actor: options.actor ?? "pi", episode: ref,
        data: { renderId, path: `output/${renderId}.mp4`, quality, frames: result.frames, cutRevision: timeline.revision },
      }).catch(() => undefined);
    }
  }
  return {
    unit: ref, renderId, quality, path: libraryRelative(root, output), reportPath: libraryRelative(root, reportPath),
    reused: false, current, frames: result.frames, durationSeconds: result.durationSeconds, result, warnings: [...resolved.problems, ...(result.warnings as CutProblem[])], cascaded,
  };
}

/** One frame of a unit's cut as an image under artifacts/frames/: what the timeline shows at an instant. */
export async function renderUnitFrame(
  root: string, ref: UnitRef, frame: number, options: { width?: number; quality?: RenderQuality } = {},
): Promise<{ path: string; frame: number }> {
  const dir = existingUnitDir(root, ref);
  const stored = readCut(root, ref);
  if (!stored.cut || hasCutErrors(stored.problems)) throw new FilmError(`${unitLabel(ref)} has no cut that can be shown`, "invalid-cut", stored.problems);
  const resolved = resolveCut(root, ref, stored.cut, { quality: options.quality ?? "preview" });
  const errors = resolved.problems.filter((p) => p.severity === "error");
  if (errors.length > 0) throw new FilmError(`${unitLabel(ref)} cannot be shown: ${errors[0]!.message}`, "blocked", resolved.problems);
  const at = Math.max(0, Math.min(cutDuration(stored.cut) - 1, Math.round(frame)));
  const output = join(dir, "artifacts", "frames", `frame-${String(at).padStart(6, "0")}-r${stored.cut.revision}.jpg`);
  try {
    await renderCutFrame(resolved.cut, at, output, { resolveFile: resolved.resolveFile, ...(options.width ? { width: options.width } : {}) });
  } catch (error) {
    if (error instanceof CutError) throw new FilmError(`${unitLabel(ref)}: ${error.message}`, error.code, error.problems as CutProblem[]);
    throw error;
  }
  return { path: libraryRelative(root, output), frame: at };
}
