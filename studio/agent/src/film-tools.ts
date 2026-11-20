// ---------------------------------------------------------------------------
// Films (ADR-0050): making one, bringing footage in, cutting and rendering it
// ---------------------------------------------------------------------------
// A film is produced at three levels — the shot, the scene, the film — and
// every tool here takes the level it works on as `film`, and optionally
// `scene` and `shot`. The same unit is `channel`/`series`/`episode` to every
// other tool of the studio, with `_` for the level itself: a shot is
// (film, scene, shot), a scene's own unit (film, scene, _), the film's
// (film, _, _). The pipeline, budget, approval, take and media tools all work
// on a film's units that way.
//
// Everything here is local and free: FFmpeg on this machine. What is paid —
// generating a shot's picture, a voice — goes through the tools that already
// reserve it on the spend ledger.
// ---------------------------------------------------------------------------

import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { join } from "node:path";
import { FILM_FORMATS, SCENE_SETTINGS, SHOT_ANGLES, SHOT_MOVEMENTS, SHOT_SIZES, SHOT_SOUNDS, SHOT_SOURCES, formatRuntime, timecode } from "@studio/contracts/src/film.mjs";
import { CUT_TIMELINE_PATH, TRANSITIONS, type CutProblem, type CutTimeline } from "@studio/contracts/src/cut-timeline.mjs";
import {
  FOOTAGE_ORIGINS, FilmError, annotateFootage, assembleCut, checkUnitCut, createFilm, createScene, createShot, cutPath, cutStatus, editCut,
  filmTree, ingestFootage, inspectMedia, levelOf, listEffects, listFilms, nextSteps, readCut, renderUnit, renderUnitFrame, searchFootage,
  setOrder, unitKey, unitLabel, unitOf, updateManifest, sceneNode,
  type CutOp, type CutStatus, type FilmTree, type SceneNode, type UnitNode, type UnitRef, type UnitRender,
} from "@studio/film";
import { resolveConfig } from "./config.js";
import { styleAfterCreate, styleFilmFormat } from "./style-tools.js";

const UNIT_PARAMS = {
  film: Type.String({ description: "The film's slug" }),
  scene: Type.Optional(Type.String({ description: "A scene's slug: the unit is the scene, or with shot, one of its shots. Omitted: the film itself" })),
  shot: Type.Optional(Type.String({ description: "A shot's slug, with scene" })),
};

interface UnitParams {
  film: string;
  scene?: string;
  shot?: string;
}

type ToolResult = { content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError?: boolean };

const ok = (text: string, details: Record<string, unknown> = {}): ToolResult => ({ content: [{ type: "text", text }], details });

function fail(error: unknown): ToolResult {
  const e = error as { message?: string; code?: string; problems?: { code: string; message: string; path?: string }[] };
  const problems = (e.problems ?? []).slice(0, 30).map((p) => `  - ${p.code}${p.path ? ` at ${p.path}` : ""}: ${p.message}`);
  return {
    content: [{ type: "text", text: [`❌ ${e.code ? `${e.code}: ` : ""}${e.message ?? String(error)}`, ...problems].join("\n") }],
    details: { code: e.code ?? null, problems: e.problems ?? [] },
    isError: true as unknown as boolean,
  };
}

const MARK: Record<CutStatus["state"], string> = {
  "no-cut": "·", "invalid-cut": "✗", blocked: "⏸", "not-rendered": "○", stale: "↻", preview: "◐", current: "●",
};

const address = (ref: UnitRef): string => `channel: ${ref.channel}, series: ${ref.series}, episode: ${ref.episode}`;

function unitLine(node: UnitNode<unknown>, indent: string): string {
  const { status } = node;
  const length = status.cut.seconds > 0 ? formatRuntime(status.cut.seconds) : "–";
  const flaws = node.manifestProblems.length > 0 ? ` ⚠️ manifest: ${node.manifestProblems[0]!.path} ${node.manifestProblems[0]!.message}` : "";
  return `${indent}${MARK[status.state]} ${node.slug} — ${node.title} · ${length} · ${status.state}${status.state === "current" ? "" : `: ${status.reason}`}${flaws}`;
}

function describeTree(tree: FilmTree, focus?: SceneNode): string {
  const format = tree.manifest?.format;
  const lines = [
    `${tree.title} (${tree.slug}) — ${format ? `${format.width}×${format.height} at ${format.fps} fps` : "no format"} · ` +
      `${tree.totals.scenes} scene(s), ${tree.totals.shots} shot(s) · ${formatRuntime(tree.totals.seconds)}` +
      (tree.manifest?.runtimeTargetSeconds ? ` of ${formatRuntime(tree.manifest.runtimeTargetSeconds)} planned` : ""),
    unitLine(tree, ""),
  ];
  let sequence: string | null | undefined;
  for (const scene of focus ? [focus] : tree.scenes) {
    if (!focus && scene.sequence !== sequence) {
      sequence = scene.sequence;
      const declared = tree.manifest?.sequences?.find((s) => s.id === sequence);
      lines.push(`  ${sequence ? `▸ ${declared?.act ? `${declared.act} · ` : ""}${declared?.title ?? sequence}` : "▸ (in no sequence)"}`);
    }
    lines.push(unitLine(scene, "    "));
    for (const shot of scene.shots) lines.push(unitLine(shot, "      "));
    for (const missing of scene.missingShots) lines.push(`      ✗ ${missing} — named by scene.yaml, not on disk`);
  }
  for (const missing of tree.missingScenes) lines.push(`    ✗ ${missing} — named by film.yaml, not on disk`);
  const counts = Object.entries(tree.totals.byState).filter(([, count]) => count > 0).map(([state, count]) => `${count} ${state}`).join(", ");
  lines.push("", `● current ◐ preview only ↻ stale ○ ready to render ⏸ blocked · no cut ✗ invalid — ${counts || "no units yet"}`);
  return lines.join("\n");
}

function describeCut(cut: CutTimeline): string {
  const fps = cut.format.fps;
  const lines = [`cut revision ${cut.revision} · ${cut.format.width}×${cut.format.height} at ${fps} fps`];
  for (const track of cut.tracks) {
    const flags = [track.role, track.muted ? "muted" : "", track.locked ? "locked by a person" : "", track.gain ? `${track.gain} dB` : "",
      track.duck ? `ducks ${track.duck.gain} dB under ${track.duck.under.join(", ")}` : "", ...(track.effects ?? []).map((e) => e.type)].filter(Boolean).join(", ");
    lines.push(`  ${track.kind === "video" ? "▭" : "♪"} ${track.id}${track.name ? ` "${track.name}"` : ""}${flags ? ` (${flags})` : ""}`);
    for (const clip of track.clips) {
      const source = clip.source.unit ? `unit ${clip.source.unit}` : clip.source.path ?? (clip.source.project ? `film:${clip.source.project}` : clip.source.color ?? "?");
      const extras = [
        clip.in ? `in ${clip.in}s` : "", clip.speed && clip.speed !== 1 ? `×${clip.speed}` : "",
        clip.transitionIn ? `${clip.transitionIn.type} in ${clip.transitionIn.duration}f` : "", clip.transitionOut ? `${clip.transitionOut.type} out ${clip.transitionOut.duration}f` : "",
        ...(clip.effects ?? []).filter((e) => e.enabled !== false).map((e) => e.type),
        clip.gain ? `${clip.gain} dB` : "", clip.audio?.mute ? "sound muted" : "", clip.audio?.gain ? `sound ${clip.audio.gain} dB` : "", clip.locked ? "LOCKED" : "",
      ].filter(Boolean).join(", ");
      lines.push(`      ${timecode(clip.at, fps)} +${clip.duration}f  ${clip.id} ← ${source}${extras ? ` [${extras}]` : ""}`);
    }
  }
  if (cut.master) {
    const master = [...(cut.master.video ?? []).map((e) => `picture ${e.type}`), ...(cut.master.audio ?? []).map((e) => `sound ${e.type}`),
      cut.master.loudness ? `${cut.master.loudness.integrated} LUFS, ${cut.master.loudness.truePeak} dBTP` : ""].filter(Boolean);
    if (master.length > 0) lines.push(`  master: ${master.join(", ")}`);
  }
  return lines.join("\n");
}

const describeProblems = (problems: readonly CutProblem[]): string[] =>
  problems.map((p) => `${p.severity === "error" ? "✗" : "⚠️"} ${p.code}${p.path && p.path !== "$" ? ` at ${p.path}` : ""}: ${p.message}`);

function describeRender(render: UnitRender, depth = 0): string[] {
  const pad = "  ".repeat(depth);
  const lines = render.cascaded.flatMap((child) => describeRender(child, depth + 1));
  const size = render.result ? `, ${(render.result.size / 1024 / 1024).toFixed(1)} MB` : "";
  const work = render.result ? ` · picture ${render.result.work.pictureChunks - render.result.work.pictureReused}/${render.result.work.pictureChunks} windows rendered` : "";
  const loudness = render.result?.loudness?.after?.integrated != null ? ` · ${render.result.loudness.after.integrated.toFixed(1)} LUFS` : "";
  lines.push(`${pad}${render.reused ? "● kept" : "✅ rendered"} ${unitLabel(render.unit)} → ${render.path} (${render.quality}, ${formatRuntime(render.durationSeconds)}${size})${work}${loudness}`);
  for (const warning of render.warnings) lines.push(`${pad}  ⚠️ ${warning.message}`);
  return lines;
}

export function registerFilmTools(pi: ExtensionAPI): void {
  const root = async (): Promise<string> => (await resolveConfig()).libraryRoot;
  const unit = (params: UnitParams): UnitRef => unitOf(params.film, params.scene, params.shot);

  // --- Making a film ------------------------------------------------------

  pi.registerTool({
    name: "pva_create_film",
    label: "Create Film",
    description:
      "Create a film: a self-contained work, short or feature length, beside the library's channels (library/<film>/ with film.yaml). " +
      "It is produced at three levels — the film, its scenes, their shots — each with its own cut and renders. Never overwrites. " +
      `Formats: ${FILM_FORMATS.map((f) => `${f.id} (${f.title})`).join(", ")}. Load the film-producer skill first.`,
    parameters: Type.Object({
      slug: Type.String({ description: "Lowercase kebab-case slug; not the name of a channel" }),
      title: Type.String(),
      logline: Type.Optional(Type.String({ description: "The film in one or two sentences" })),
      synopsis: Type.Optional(Type.String()),
      genre: Type.Optional(Type.String()),
      language: Type.Optional(Type.String({ description: "BCP 47 tag of the film's language: en, it" })),
      runtimeTargetSeconds: Type.Optional(Type.Number({ description: "How long the film is meant to run" })),
      format: Type.Optional(StringEnum(FILM_FORMATS.map((f) => f.id), { description: "Delivery format. Default: the style's, else hd-24" })),
      style: Type.Optional(Type.String({
        description: "Optional: a style template the person asked for, by id or title (pva_styles). Copied into the film's style/; every scene and shot reads it",
      })),
    }),
    async execute(_id, params) {
      try {
        const library = await root();
        return await withFileMutationQueue(join(library, params.slug, "film.yaml"), async () => {
          const { style, ...film } = params;
          const result = createFilm(library, { ...film, format: film.format ?? styleFilmFormat(library, style, params.slug) });
          const styled = result.createdFiles.length > 0 ? await styleAfterCreate(library, { target: { project: params.slug }, style }) : [];
          return ok(
            `${result.createdFiles.length > 0 ? "✅ film created" : "● film already there, nothing changed"}: ${params.slug}\n` +
            `Its own unit, for the pipeline, budget and approval tools: ${address(result.ref)}\n` +
            (styled.length > 0 ? `${styled.join("\n")}\n` : "") +
            `Next: pva_create_scene for each scene, pva_create_shot for each shot; pva_ingest_footage for material shot or recorded for it.`,
            { workspace: result },
          );
        });
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "pva_create_scene",
    label: "Create Scene",
    description:
      "Create a scene of a film (library/<film>/scenes/<scene>/ with scene.yaml). `sequence` puts it at the end of that sequence of the film's " +
      "running order, creating the sequence if the film has none by that id. Number slugs so they sort: 010-kitchen-dawn. Never overwrites.",
    parameters: Type.Object({
      film: Type.String(),
      slug: Type.String({ description: "Lowercase kebab-case, e.g. 010-kitchen-dawn" }),
      title: Type.String(),
      number: Type.Optional(Type.String({ description: "The scene number as the script writes it: 12, 12A" })),
      heading: Type.Optional(Type.String({ description: "The slugline: INT. KITCHEN - DAWN" })),
      setting: Type.Optional(StringEnum([...SCENE_SETTINGS])),
      location: Type.Optional(Type.String({ description: "A location of the film's locations/" })),
      timeOfDay: Type.Optional(Type.String()),
      summary: Type.Optional(Type.String({ description: "What happens, and what the scene is for" })),
      characters: Type.Optional(Type.Array(Type.String())),
      durationTargetSeconds: Type.Optional(Type.Number()),
      sequence: Type.Optional(Type.String({ description: "The id of the sequence it joins" })),
      sequenceTitle: Type.Optional(Type.String({ description: "With a new sequence: its title" })),
      act: Type.Optional(Type.String({ description: "With a new sequence: the act it is in" })),
      style: Type.Optional(Type.String({
        description: "Optional: a style template for this scene alone, by id or title. Omitted, the scene reads the film's style if it has one",
      })),
    }),
    async execute(_id, params) {
      try {
        const library = await root();
        return await withFileMutationQueue(join(library, params.film, "film.yaml"), async () => {
          const { style, ...scene } = params;
          const result = createScene(library, scene);
          const styled = await styleAfterCreate(library, {
            ...(style && result.createdFiles.length > 0 ? { target: { project: params.film, series: params.slug }, style } : {}),
            unit: result.ref,
          });
          return ok([`${result.createdFiles.length > 0 ? "✅ scene created" : "● scene already there"}: ${unitLabel(result.ref)}\nIts own unit: ${address(result.ref)}`, ...styled].join("\n"), { workspace: result });
        });
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "pva_create_shot",
    label: "Create Shot",
    description:
      "Create a shot of a scene (…/scenes/<scene>/shots/<shot>/ with shot.yaml). `source` says where its picture comes from: " +
      `${SHOT_SOURCES.join(", ")}. Its takes go under the shot's assets/ — made with the image, video, Blender, graphics and terminal tools ` +
      "(channel: the film, series: the scene, episode: the shot), fetched with the archive tools, or cut from the film's footage. Never overwrites.",
    parameters: Type.Object({
      film: Type.String(),
      scene: Type.String(),
      slug: Type.String({ description: "Lowercase kebab-case, e.g. 020-close-anna" }),
      title: Type.String(),
      source: StringEnum([...SHOT_SOURCES], { description: "Where its picture comes from" }),
      number: Type.Optional(Type.String()),
      description: Type.Optional(Type.String({ description: "What the shot shows and what happens in it" })),
      size: Type.Optional(StringEnum([...SHOT_SIZES])),
      angle: Type.Optional(StringEnum([...SHOT_ANGLES])),
      movement: Type.Optional(StringEnum([...SHOT_MOVEMENTS])),
      lens: Type.Optional(Type.String()),
      durationSeconds: Type.Optional(Type.Number({ description: "How long it is meant to hold in the cut" })),
      sound: Type.Optional(StringEnum([...SHOT_SOUNDS], { description: "sync: recorded with the picture; silent; generated: made afterwards" })),
      characters: Type.Optional(Type.Array(Type.String())),
      dialogue: Type.Optional(Type.Array(Type.Object({
        character: Type.String(), line: Type.String(), delivery: Type.Optional(Type.String()), offscreen: Type.Optional(Type.Boolean()),
      }))),
      notes: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      try {
        const library = await root();
        const result = createShot(library, params);
        const styled = await styleAfterCreate(library, { unit: result.ref });
        return ok([`${result.createdFiles.length > 0 ? "✅ shot created" : "● shot already there"}: ${unitLabel(result.ref)}\nIts unit: ${address(result.ref)}`, ...styled].join("\n"), { workspace: result });
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "pva_film",
    label: "Film Status",
    description:
      "Without `film`: the library's films. With one: the whole film in running order — each scene and shot with its length and where it stands " +
      "(no cut, blocked, ready to render, stale, current) — and what stands between it and its final render, first things first. " +
      "With `scene`: that scene and its shots only. Read it before deciding what to do next.",
    parameters: Type.Object({
      film: Type.Optional(Type.String()),
      scene: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      try {
        const library = await root();
        if (!params.film) {
          const films = listFilms(library);
          return ok(films.length > 0 ? `Films: ${films.join(", ")}` : "This library has no film yet: pva_create_film makes one.", { films });
        }
        const tree = filmTree(library, params.film);
        const focus = params.scene ? sceneNode(library, params.film, params.scene) : undefined;
        const steps = nextSteps(tree);
        const lines = [describeTree(tree, focus)];
        if (steps.length > 0) {
          lines.push("", "Next, in order:");
          for (const step of steps) lines.push(`  ${step.unit} — ${step.todo}`);
        } else if (tree.status.state === "current") {
          lines.push("", `The film is rendered: ${tree.render?.path}`);
        }
        return ok(lines.join("\n"), { tree: focus ?? tree, next: steps });
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "pva_update_unit",
    label: "Update Film Unit",
    description:
      "Change a film's, a scene's or a shot's manifest (film.yaml, scene.yaml, shot.yaml): `set` gives the fields to set, null removing one; " +
      "`order` gives the film's scenes or the scene's shots in the order they are cut. The result must hold under the manifest's contract or " +
      "nothing is written; the file's comments are kept. Then pva_assemble_cut brings the unit's cut in step.",
    parameters: Type.Object({
      ...UNIT_PARAMS,
      set: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Fields of the manifest to set; null removes a field. Not slug, kind or apiVersion" })),
      order: Type.Optional(Type.Array(Type.String(), { description: "The film's scenes in running order, or the scene's shots in cutting order" })),
    }),
    async execute(_id, params) {
      try {
        const library = await root();
        const ref = unit(params);
        const changed: string[] = [];
        if (params.set && Object.keys(params.set).length > 0) {
          for (const key of ["slug", "kind", "apiVersion"]) if (key in params.set) throw new Error(`"${key}" is what the unit is: it is not changed`);
          updateManifest(library, ref, (manifest) => {
            const next = { ...manifest } as Record<string, unknown>;
            for (const [key, value] of Object.entries(params.set!)) {
              if (value === null) delete next[key];
              else next[key] = value;
            }
            return next as unknown as typeof manifest;
          });
          changed.push(`set ${Object.keys(params.set).join(", ")}`);
        }
        if (params.order) {
          setOrder(library, ref, params.order);
          changed.push(`order: ${params.order.join(" → ")}`);
        }
        if (changed.length === 0) throw new Error("give set, order, or both");
        return ok(`✅ ${unitLabel(ref)}: ${changed.join("; ")}`, { unit: ref });
      } catch (error) {
        return fail(error);
      }
    },
  });

  // --- Footage -------------------------------------------------------------

  pi.registerTool({
    name: "pva_ingest_footage",
    label: "Ingest Footage",
    description:
      "Bring files shot, recorded or bought for a film into its footage/: camera originals, location sound, stock clips, a composer's stems. " +
      "Each is copied (or linked, for originals too large to keep twice), named by its content, measured and logged in footage/catalog.json, " +
      "with a contact sheet (footage/sheets/, open it to see the clip), the instants its picture cuts, a proxy a browser plays and its loudness. " +
      "The same file brought in twice is found, not copied. A cut uses a clip as { \"project\": \"footage/media/<file>\" }. $0, local.",
    parameters: Type.Object({
      film: Type.String(),
      files: Type.Array(Type.String({ description: "Full path of a file on this machine" }), { minItems: 1, maxItems: 50 }),
      origin: Type.Optional(StringEnum([...FOOTAGE_ORIGINS], { description: "camera (default), recording, stock, generated, other" })),
      link: Type.Optional(Type.Boolean({ description: "Link to the files where they are instead of copying them" })),
      tags: Type.Optional(Type.Array(Type.String())),
      notes: Type.Optional(Type.String()),
      licence: Type.Optional(Type.String({ description: "For material that is not the film's own: who made it, and its terms" })),
      scene: Type.Optional(Type.String({ description: "The scene it was shot for" })),
      shot: Type.Optional(Type.String({ description: "The shot it was shot for" })),
    }),
    async execute(_id, params, signal, onUpdate) {
      try {
        const library = await root();
        const lines: string[] = [];
        const clips = [];
        for (const file of params.files) {
          if (signal?.aborted) throw new Error("cancelled");
          onUpdate?.({ content: [{ type: "text" as const, text: `Reading ${file}…` }], details: {} });
          const { film, files: _files, ...options } = params;
          const result = await withFileMutationQueue(join(library, film, "footage", "catalog.json"), () =>
            ingestFootage(library, film, file, { ...options, ...(signal ? { signal } : {}) }));
          const clip = result.clip;
          clips.push(clip);
          const what = clip.kind === "audio"
            ? `sound, ${formatRuntime(clip.durationSeconds ?? 0)}`
            : `${clip.width}×${clip.height}${clip.fps ? ` at ${clip.fps} fps` : ""}${clip.durationSeconds ? `, ${formatRuntime(clip.durationSeconds)}` : ""}${clip.audio ? ", with sound" : ", silent"}`;
          lines.push(`${result.added ? "✅" : "●"} ${clip.id} — ${what}${clip.segments && clip.segments.length > 1 ? `, ${clip.segments.length} segments` : ""}` +
            `\n   project: ${clip.path}${clip.sheet ? `\n   sheet: ${film}/${clip.sheet}` : ""}`);
          for (const warning of result.warnings) lines.push(`   ⚠️ ${warning}`);
        }
        return ok(lines.join("\n"), { clips });
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "pva_footage",
    label: "Footage",
    description:
      "Search a film's footage log: every word of `query` in a clip's name, tags, notes, scene or shot; filtered by kind, origin or scene. " +
      "With `annotate`, change what the log says about one clip — its tags, notes, licence, origin, the scene and shot it is for — after looking at it.",
    parameters: Type.Object({
      film: Type.String(),
      query: Type.Optional(Type.String()),
      kind: Type.Optional(StringEnum(["video", "audio", "image"])),
      origin: Type.Optional(StringEnum([...FOOTAGE_ORIGINS])),
      scene: Type.Optional(Type.String()),
      annotate: Type.Optional(Type.Object({
        id: Type.String(),
        tags: Type.Optional(Type.Array(Type.String())),
        notes: Type.Optional(Type.String()),
        licence: Type.Optional(Type.String()),
        origin: Type.Optional(StringEnum([...FOOTAGE_ORIGINS])),
        scene: Type.Optional(Type.String()),
        shot: Type.Optional(Type.String()),
      })),
    }),
    async execute(_id, params) {
      try {
        const library = await root();
        if (params.annotate) {
          const { id, ...change } = params.annotate;
          const clip = await withFileMutationQueue(join(library, params.film, "footage", "catalog.json"), async () => annotateFootage(library, params.film, id, change));
          return ok(`✅ ${clip.id}: ${Object.keys(change).join(", ")} updated`, { clip });
        }
        const clips = searchFootage(library, params.film, params.query ?? "", {
          ...(params.kind ? { kind: params.kind as "video" | "audio" | "image" } : {}),
          ...(params.origin ? { origin: params.origin as (typeof FOOTAGE_ORIGINS)[number] } : {}),
          ...(params.scene ? { scene: params.scene } : {}),
        });
        if (clips.length === 0) return ok("No footage matches.", { clips });
        const lines = clips.slice(0, 80).map((clip) =>
          `${clip.id} — ${clip.kind}${clip.durationSeconds ? `, ${formatRuntime(clip.durationSeconds)}` : ""}, ${clip.origin}` +
          `${clip.scene ? `, for ${clip.scene}${clip.shot ? `/${clip.shot}` : ""}` : ""}${clip.tags.length ? ` [${clip.tags.join(", ")}]` : ""}` +
          `${clip.notes ? ` — ${clip.notes}` : ""}\n   project: ${clip.path}`);
        if (clips.length > 80) lines.push(`… and ${clips.length - 80} more: narrow the query`);
        return ok(lines.join("\n"), { clips });
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "pva_inspect_media",
    label: "Inspect Media",
    description:
      "Look at a picture or sound file of a film unit before using it: its streams, size, rate and length; a stamped contact sheet under the " +
      "unit's artifacts/inspect/ (open it: it is how you see a take); with `segments`, where its picture cuts; its loudness. `path` is relative to " +
      "the unit, or `project:<path>` for a file of the film (footage/…, music/…).",
    parameters: Type.Object({
      ...UNIT_PARAMS,
      path: Type.String({ description: "Relative to the unit, or project:<path> for a file of the film" }),
      segments: Type.Optional(Type.Boolean({ description: "Find where the picture cuts" })),
      columns: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, default: 4 })),
      rows: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, default: 3 })),
    }),
    async execute(_id, params) {
      try {
        const inspection = await inspectMedia(await root(), unit(params), params.path, {
          ...(params.segments ? { segments: true } : {}), ...(params.columns ? { columns: params.columns } : {}), ...(params.rows ? { rows: params.rows } : {}),
        });
        const m = inspection.media;
        const lines = [
          `${inspection.file}: ${m.kind}${m.width ? `, ${m.width}×${m.height}` : ""}${m.fps ? ` at ${Math.round(m.fps * 100) / 100} fps` : ""}` +
            `${m.duration ? `, ${m.duration.toFixed(2)} s` : ""}${m.videoCodec ? `, ${m.videoCodec}` : ""}${m.hasAudio ? `, sound ${m.audioCodec} ${m.audioChannels}ch` : ", no sound"}${m.hasAlpha ? ", transparent" : ""}`,
        ];
        if (inspection.sheet) lines.push(`sheet: ${inspection.sheet} — tiles at ${inspection.sheetInstants.map((t) => `${t.toFixed(1)}s`).join(", ")}`);
        if (inspection.segments) lines.push(`segments: ${inspection.segments.map((s) => `${s.start}–${s.end}s`).join(", ")}`);
        if (inspection.loudness) lines.push(`loudness: ${inspection.loudness.integrated ?? "silent"} LUFS, true peak ${inspection.loudness.truePeak ?? "–"} dBTP, range ${inspection.loudness.range ?? "–"} LU`);
        return ok(lines.join("\n"), { inspection });
      } catch (error) {
        return fail(error);
      }
    },
  });

  // --- The cut --------------------------------------------------------------

  pi.registerTool({
    name: "pva_assemble_cut",
    label: "Assemble Cut",
    description:
      `Make or bring up to date a unit's cut (${CUT_TIMELINE_PATH}). A shot: one clip of its media — the newest video or image under its assets/, ` +
      "or `media` (a path in the shot, or project:<path> for the film's footage), from `in` seconds, for `seconds`. A scene: its shots in cutting " +
      "order; the film: its scenes in running order. Only the picture track's unit clips are touched: sound, titles, effects, trims and anything a " +
      "person locked stay. Run it again after a shot or scene is added, removed, reordered or changes length.",
    parameters: Type.Object({
      ...UNIT_PARAMS,
      transition: Type.Optional(Type.Object({
        type: StringEnum([...TRANSITIONS]),
        duration: Type.Integer({ minimum: 1, description: "Frames" }),
      }, { description: "A scene or the film: join the clips with this instead of a cut" })),
      media: Type.Optional(Type.String({ description: "A shot: the file to cut it from" })),
      in: Type.Optional(Type.Number({ minimum: 0, description: "A shot: where the clip starts in its media, seconds" })),
      seconds: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "A shot: how long the clip holds" })),
      replace: Type.Optional(Type.Boolean({ description: "A shot: replace a cut that already has clips" })),
    }),
    async execute(_id, params) {
      try {
        const library = await root();
        const ref = unit(params);
        return await withFileMutationQueue(cutPath(library, ref), async () => {
          const { film: _film, scene: _scene, shot: _shot, ...options } = params;
          const result = await assembleCut(library, ref, options as Parameters<typeof assembleCut>[2]);
          return ok([`✅ ${unitLabel(ref)}: cut revision ${result.cut.revision}, ${formatRuntime(result.seconds)} (${result.frames} frames)`, ...result.notes.map((n) => `  ${n}`)].join("\n"),
            { cut: result.cut, notes: result.notes });
        });
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "pva_edit_cut",
    label: "Edit Cut",
    description:
      "Edit a unit's cut with a list of operations, applied together or not at all; the result must be a valid cut. Positions and lengths are frames, " +
      "positions in a source are seconds, gains are dB. Operations: " +
      "add-track { track: { id, kind: video|audio, name?, role?, gain?, duck?: { under: [trackIds], gain }, effects? }, index? } · remove-track { track } · " +
      "set-track { track, set } · add-clip { track, clip: { id, source: { unit } | { path } | { project } | { color }, duration, at?, in?, speed?, fit?, opacity?, " +
      "transitionIn?, transitionOut?, effects?, audio?: { mute?, gain?, fadeIn?, fadeOut?, effects? }, gain?, fadeIn?, fadeOut? }, after?: clipId, ripple? } · " +
      "set-clip { clip, set } · remove-clip { clip, ripple? } · move-clip { clip, at?, track?, after?, ripple? } · split-clip { clip, at, newId } · " +
      "set-master { set: { video?, audio?, loudness? } } · set-marker { marker: { id, at, label?, note? } } · remove-marker { marker }. In `set`, null removes a field. " +
      "An effect is { type, params } from pva_cut_effects. A clip or track a person locked is theirs: an operation on it is refused. " +
      "Say which cut you are editing: expectedRevision, the `cut revision N` that pva_check_cut and every edit print (0 for a unit with no cut yet). " +
      "The edit is refused if a person changed the cut since. Load the film-editing skill.",
    parameters: Type.Object({
      ...UNIT_PARAMS,
      ops: Type.Array(Type.Any(), { minItems: 1, description: "The operations, in order" }),
      expectedRevision: Type.Optional(Type.Integer({ minimum: 0, description: "The revision you read: the edit is refused if the cut moved on since. Required, unless latest is true" })),
      latest: Type.Optional(Type.Boolean({ description: "Edit the cut as it now is, whatever its revision. Only for an edit that is right on any revision, such as adding a marker" })),
    }),
    async execute(_id, params) {
      try {
        const library = await root();
        const ref = unit(params);
        if (params.expectedRevision === undefined && params.latest !== true) {
          throw new FilmError(
            `pva_edit_cut needs the revision of the cut you read: pass expectedRevision (pva_check_cut prints it as "cut revision N"; 0 when ${unitLabel(ref)} has no cut yet), ` +
            "so the edit is refused rather than laid over a change a person made meanwhile. Pass latest: true only for an edit that is right on any revision",
            "revision-required",
          );
        }
        return await withFileMutationQueue(cutPath(library, ref), async () => {
          const result = editCut(library, ref, params.ops as CutOp[], {
            editor: "agent", ...(params.expectedRevision !== undefined ? { expectedRevision: params.expectedRevision } : {}),
          });
          return ok([`✅ ${unitLabel(ref)}: ${params.ops.length} operation(s) applied`, describeCut(result.cut), ...describeProblems(result.problems)].join("\n"), { cut: result.cut });
        });
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "pva_check_cut",
    label: "Check Cut",
    description:
      "Read a unit's cut and say what a render of it would refuse or warn about, without rendering: the cut's shape, its effects, every source file, " +
      "and whether the units it is cut from have a render that is still current. Shows the cut track by track.",
    parameters: Type.Object({
      ...UNIT_PARAMS,
      quality: Type.Optional(StringEnum(["final", "preview"], { description: "The render it is checked for. Default final" })),
    }),
    async execute(_id, params) {
      try {
        const library = await root();
        const ref = unit(params);
        const stored = readCut(library, ref);
        const status = cutStatus(library, ref);
        const problems = await checkUnitCut(library, ref, (params.quality as "final" | "preview" | undefined) ?? "final");
        const errors = problems.filter((p) => p.severity === "error").length;
        const lines = [
          `${errors === 0 ? "✅" : "❌"} ${unitLabel(ref)} — ${status.state}: ${status.reason}`,
          ...(stored.cut ? [describeCut(stored.cut)] : []),
          ...describeProblems(problems),
        ];
        return { ...ok(lines.join("\n"), { status, problems }), ...(errors > 0 ? { isError: true as unknown as boolean } : {}) };
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "pva_render_cut",
    label: "Render Cut",
    description:
      "Render a unit's cut with FFmpeg to output/<render-id>.mp4: a shot, a scene from its shots' renders, or the film from its scenes'. " +
      "The units below that changed are rendered first (cascade), and nothing that is still current is rendered again — a film render does exactly the " +
      "work a change needs. quality: final (the unit's render, output/current.json) or preview (at most 960 wide, fast, output/preview.json). " +
      "`from`/`to` in seconds render part of the timeline, to look at an edit; a part never becomes the unit's render. $0, local.",
    parameters: Type.Object({
      ...UNIT_PARAMS,
      quality: Type.Optional(StringEnum(["final", "preview"], { description: "Default final" })),
      from: Type.Optional(Type.Number({ minimum: 0, description: "Seconds: render from here" })),
      to: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Seconds: render up to here" })),
      cascade: Type.Optional(Type.Boolean({ description: "Render first the units below that are not current. Default true" })),
      force: Type.Optional(Type.Boolean({ description: "Render even when the unit's render is current" })),
    }),
    async execute(_id, params, signal, onUpdate) {
      try {
        const library = await root();
        const ref = unit(params);
        const stored = readCut(library, ref);
        const fps = stored.cut?.format.fps ?? 24;
        const range = params.from !== undefined || params.to !== undefined
          ? { from: Math.round((params.from ?? 0) * fps), to: params.to !== undefined ? Math.round(params.to * fps) : Number.MAX_SAFE_INTEGER }
          : undefined;
        return await withFileMutationQueue(join(library, params.film, "output", ".render"), async () => {
          let last = "";
          const render = await renderUnit(library, ref, {
            quality: (params.quality as "final" | "preview" | undefined) ?? "final",
            actor: "pi",
            ...(range ? { range } : {}),
            ...(params.cascade === false ? { cascade: false } : {}),
            ...(params.force ? { force: true } : {}),
            ...(signal ? { signal } : {}),
            onProgress(progress) {
              const line = `${progress.unit}: ${progress.phase} ${progress.done}/${progress.total}`;
              // One line per step of picture, and one per phase otherwise: a film has hundreds of windows.
              if (line !== last && (progress.phase !== "picture" || progress.done === progress.total || progress.done % 5 === 0)) {
                last = line;
                onUpdate?.({ content: [{ type: "text" as const, text: line }], details: { progress } });
              }
            },
          });
          const lines = describeRender(render);
          if (!render.current) lines.push("A part of the cut: the unit's render is what it was.");
          return ok(lines.join("\n"), { render });
        });
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "pva_cut_frame",
    label: "Cut Frame",
    description:
      "One frame of a unit's cut as an image, with every effect and transition, without rendering anything else: what the timeline shows at an instant. " +
      "Written under the unit's artifacts/frames/; open it to judge a grade, a framing or a dissolve before a render.",
    parameters: Type.Object({
      ...UNIT_PARAMS,
      seconds: Type.Optional(Type.Number({ minimum: 0, description: "The instant, seconds from the cut's start" })),
      frame: Type.Optional(Type.Integer({ minimum: 0, description: "Or the frame" })),
      width: Type.Optional(Type.Integer({ minimum: 64, maximum: 3840, description: "Pixels wide. Default: the cut's own width" })),
    }),
    async execute(_id, params) {
      try {
        const library = await root();
        const ref = unit(params);
        const fps = readCut(library, ref).cut?.format.fps ?? 24;
        const frame = params.frame ?? Math.round((params.seconds ?? 0) * fps);
        const result = await renderUnitFrame(library, ref, frame, params.width ? { width: params.width } : {});
        return ok(`✅ frame ${result.frame} (${timecode(result.frame, fps)}) of ${unitLabel(ref)} → ${result.path}`, { ...result });
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "pva_cut_effects",
    label: "Cut Effects",
    description: "The picture and sound effects a cut can use, with each parameter's range, default and meaning. An effect in a cut is { type, params }.",
    parameters: Type.Object({
      domain: Type.Optional(StringEnum(["video", "audio"], { description: "Picture or sound only" })),
    }),
    async execute(_id, params) {
      const effects = listEffects(params.domain as "video" | "audio" | undefined);
      const lines: string[] = [];
      let group = "";
      for (const effect of effects) {
        const heading = `${effect.domain === "video" ? "Picture" : "Sound"} · ${effect.group}`;
        if (heading !== group) {
          group = heading;
          lines.push("", heading);
        }
        const parameters = Object.entries(effect.params).map(([name, p]) =>
          p.kind === "number" ? `${name} ${p.min}…${p.max}${p.unit ? ` ${p.unit}` : ""} (default ${p.default})`
            : p.kind === "enum" ? `${name}: ${p.values.join("|")} (default ${p.default})`
              : p.kind === "file" ? `${name}: a ${p.extensions.join(" or ")} file of the unit or the film`
                : `${name} (default ${String(p.default)})`);
        lines.push(`  ${effect.type} — ${effect.description}${parameters.length ? `. ${parameters.join("; ")}` : ""}`);
      }
      return ok(lines.join("\n").trim(), { effects });
    },
  });
}

export { unitKey, levelOf };
