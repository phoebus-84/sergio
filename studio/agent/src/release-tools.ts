// ---------------------------------------------------------------------------
// A 3D model or a rig, released as a character's form in one step
// ---------------------------------------------------------------------------
// A model and a rig are made in an episode, where the budget is. Making one
// the character's was a list of things done by hand: copy the file, its
// clips, its sheets and its records into the character's folder, write what
// the form can do, record the release — and then, in every scene, turn the
// figure to face the camera and lift it onto the floor again.
//
// `pva_release_model` does it once. The figure is stood (facing +z, feet on
// y 0, over the origin, as tall as it is said to be) by one node above its
// scene's roots, so the body, its textures and its clips stay the bytes the
// services returned; a rig is refused when its exam fails or when it was
// never posed; a clip becomes an action only when it was played on a sheet.
// What is released says what it was made from, file by file and hash by
// hash, in form.json beside the entry.
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { FORMS_DIR, type FormLicence, type FormMaker } from "@studio/contracts/src/character.mjs";
import { episodePath } from "@studio/contracts/src/layout.mjs";
import { CastError, findCharacter, ownerLabel, releaseForm, updateCharacter, type Owner } from "@studio/cast";
import { FACINGS, readGlb, type Facing } from "./glb.js";
import { examineRig } from "./rig-exam.js";
import { RIG_STRAIN_MARKS } from "./rig-sheet-tools.js";
import { applyStand, standFigure, type Stand } from "./stand.js";
import { guardEpisodePath } from "./trust-guards.js";

export const RELEASE_TOOL = "pva_release_model";

/** The record a released model keeps of itself, beside its entry. */
export const RELEASED_FORM_FILE = "form.json";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VIEWS = ["front", "three-quarter", "side", "back"];
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const round = (value: number, places = 3) => Math.round(value * 10 ** places) / 10 ** places + 0;

export interface ReleasedClip {
  name: string;
  /** In the release's folder. */
  file: string;
  seconds: number | null;
  /** How far the body travels, in its own heights; 0 is played on the spot. */
  travel: number | null;
  /** What made it: came with the rig, carried from another skeleton, generated from a sentence. */
  made: string;
  sheet: string | null;
  from: { path: string; sha256: string };
}

/** form.json: what a released model is, where it came from and what was done to it. */
export interface ReleasedForm {
  version: 1;
  tool: typeof RELEASE_TOOL;
  medium: "rig-3d" | "model-3d";
  entry: string;
  from: { channel: string; series: string; episode: string; path: string; sha256: string };
  /** How it stands in the entry file, whatever it was before: every scene can rely on it. */
  faces: "+z";
  floor: 0;
  /** Across, tall, front to back, in the file's units. */
  size: [number, number, number];
  stand: Stand & { faced: Facing };
  skeleton?: { joints: number; kind: "biped" | "unknown"; influences: number };
  clips: ReleasedClip[];
  leftOut: { name: string; why: string }[];
  sheet?: { poses: string; report: string; pulled: string[] };
  files: { file: string; from: string; sha256: string }[];
  madeAt: string;
}

/** A released model's own record, or null when the folder is not one this tool made. */
export function readReleasedForm(folder: string): ReleasedForm | null {
  try {
    const record = JSON.parse(readFileSync(join(folder, RELEASED_FORM_FILE), "utf8")) as ReleasedForm;
    return record && record.version === 1 && typeof record.entry === "string" && Array.isArray(record.clips) ? record : null;
  } catch {
    return null;
  }
}

interface SheetRecord {
  rigSha256?: string;
  rig?: { edges?: number; skeleton?: "biped" | "unknown" };
  poses?: { sheet?: string; list?: { name: string; strained: number; torn: number }[] };
  clips?: { name: string; from?: string; sheet?: string; seconds?: number; travel?: number }[];
}

const readJson = <T,>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
};

const jointNames = (bytes: Uint8Array): string[] => {
  const gltf = readGlb(bytes)?.json;
  return [...new Set((gltf?.skins ?? []).flatMap((skin) => skin.joints))].map((index) => gltf?.nodes?.[index]?.name ?? `joint ${index}`).sort();
};

/** The first vN a form has neither on record nor on disk. */
function nextRelease(taken: ReadonlySet<string>, formDir: string): string {
  for (let n = 1; n < 10_000; n++) if (!taken.has(`v${n}`) && !existsSync(join(formDir, `v${n}`))) return `v${n}`;
  throw new Error("no free release id: name one with `release`");
}

export function registerReleaseTools(pi: ExtensionAPI): void {
  const LIBRARY_ROOT = process.env.AVG_LIBRARY_ROOT || join(process.cwd(), "library");

  pi.registerTool({
    name: RELEASE_TOOL,
    label: "Release a 3D Model as a Form",
    description:
      "Release a 3D model or a rig made in an episode as a form of a character, in one step. Local, free. " +
      "Stands the figure once, in its file — facing +z, its feet on y 0, its middle over the origin, and as tall as `height` says — by one node above its scene's roots: " +
      "the body, its textures and its clips are the bytes the services returned, and no scene has to turn or lift it again. " +
      "Copies it into characters/<id>/forms/<form>/<release>/ with its clips, its pose sheets, the records of what made each and a form.json that says what was done; " +
      "gives the character the form (rig-3d for a body with a skeleton, model-3d for one without) with what it can do, and records the release with the hash of every file. " +
      "A rig is refused when its exam fails, and when it was not posed: run pva_rig_sheet first and look at the sheet. " +
      "A clip is released as an action only when it was played on that sheet; the others are left out and named. " +
      "A model with no skeleton must be told which way it `faces` (look at its preview); a rig from pva_rig_model faces +z. " +
      "The character is found as a cast finds one: in the episode's series, then in its channel, or another owner's as owner/id. " +
      "Then cast it (pva_cast) and film it by its role (pva_rig_shot { role }).",
    parameters: Type.Object({
      channel: Type.String({ description: "Channel slug of the episode the model was made in" }),
      series: Type.String({ description: "Series slug" }),
      episode: Type.String({ description: "Episode slug" }),
      modelPath: Type.String({ description: "The model or the rig, episode-relative: assets/models/<id>.glb" }),
      character: Type.String({ description: "The character it is a form of, by id; another owner's as owner/id" }),
      form: Type.Optional(Type.String({ description: "The form's id. Default: rig for a body with a skeleton, model for one without" })),
      release: Type.Optional(Type.String({ description: "The release's id. Default: the next of v1, v2, …" })),
      faces: Type.Optional(StringEnum(FACINGS as unknown as [Facing, ...Facing[]], { description: "Which way the figure faces in its file. Default +z for a rig; required for a model with no skeleton" })),
      height: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1000, description: "How tall the character stands, in metres: the figure is sized to it. Default: as tall as it is in its file (a generated model is one unit)" })),
      clips: Type.Optional(Type.Array(Type.String(), { description: "The rig's clips to release, by name. Default: every clip beside the rig that was played on its sheet; [] for none" })),
      licence: Type.Optional(Type.Object({
        id: Type.String({ description: "SPDX id where there is one: CC0-1.0, CC-BY-4.0; or the channel's own terms" }),
        holder: Type.Optional(Type.String()), url: Type.Optional(Type.String()),
        attribution: Type.Optional(Type.String({ description: "The credit it requires, as it must appear" })),
        redistributable: Type.Optional(Type.Boolean({ description: "Whether its files may be published with the channel" })),
      })),
      note: Type.Optional(Type.String({ description: "What this release is, or what changed since the last" })),
      current: Type.Optional(Type.Boolean({ default: true, description: "Make it the form's current release" })),
    }),
    async execute(_toolCallId, params) {
      const dir = episodePath(LIBRARY_ROOT, params.channel, params.series, params.episode);
      const guard = await guardEpisodePath(LIBRARY_ROOT, params.channel, params.series, params.episode, params.modelPath);
      if (!guard.allowed) throw new Error(guard.reason ?? `Model path rejected: ${params.modelPath}`);
      const modelFull = join(dir, params.modelPath);
      if (!existsSync(modelFull) || !statSync(modelFull).isFile()) throw new Error(`Model not found: ${params.modelPath}`);
      if (!/\.glb$/i.test(modelFull)) throw new Error(`a model is released from a binary glTF (.glb): ${params.modelPath}`);
      const bytes = readFileSync(modelFull);
      if (!readGlb(bytes)) throw new Error(`${params.modelPath} could not be read as a binary glTF`);
      const home = dirname(modelFull);
      const base = basename(modelFull).replace(/\.glb$/i, "");
      const shown = (full: string) => relative(dir, full);

      const found = findCharacter(LIBRARY_ROOT, { channel: params.channel, series: params.series }, params.character);
      if ("missing" in found) throw new Error(`${found.missing}: make the character first (pva_create_character)`);
      const owner: Owner = found.owner;
      const id = found.manifest.id;

      const exam = examineRig(bytes);
      const rigged = exam.joints > 0;
      const medium = rigged ? "rig-3d" as const : "model-3d" as const;
      const formId = params.form ?? (rigged ? "rig" : "model");
      if (!SLUG.test(formId)) throw new Error(`the form's id "${formId}" must be lowercase letters, digits and single hyphens`);
      const existing = found.manifest.forms?.find((entry) => entry.id === formId);
      if (existing && existing.medium !== medium) {
        throw new Error(`${id} already has a form "${formId}" and it is ${existing.medium}: this file is ${medium}. Give it another form id`);
      }
      const formDir = join(found.dir, FORMS_DIR, formId);
      const releaseId = params.release ?? nextRelease(new Set((existing?.releases ?? []).map((entry) => entry.id)), formDir);
      if (!SLUG.test(releaseId)) throw new Error(`the release's id "${releaseId}" must be lowercase letters, digits and single hyphens`);
      const folder = join(formDir, releaseId);
      if (existing?.releases?.some((entry) => entry.id === releaseId) || existsSync(folder)) {
        throw new Error(`the release "${releaseId}" of ${id}'s form "${formId}" is already there: a release is never edited. Leave \`release\` out to take the next one`);
      }

      // ── What may be released ────────────────────────────────────────────
      let sheet: SheetRecord | null = null;
      const sheetPath = join(home, `${base}.sheet.json`);
      if (rigged) {
        if (!exam.ok) {
          throw new Error([`the rig failed its exam and is not released:`, ...exam.findings.filter((finding) => finding.level === "fail").map((finding) => `  - ${finding.message}`), "make another attempt (pva_rig_model)"].join("\n"));
        }
        sheet = readJson<SheetRecord>(sheetPath);
        if (!sheet) throw new Error(`the rig was never posed: ${shown(sheetPath)} is not there. Run pva_rig_sheet, look at the sheet, then release it`);
        if (sheet.rigSha256 !== sha256(bytes)) throw new Error(`the rig changed since it was posed: ${shown(sheetPath)} is of another file. Run pva_rig_sheet again, look at the sheet, then release it`);
      } else if (!params.faces) {
        throw new Error("say which way the model faces in its file (`faces`: +z, +x, -x or -z): look at its preview. A model from pva_generate_model has faced +x");
      }
      if (!rigged && params.clips?.length) throw new Error("a model with no skeleton has no clips to release");

      const faced: Facing = params.faces ?? "+z";
      const stood = standFigure(bytes, { faces: faced, ...(params.height !== undefined ? { height: params.height } : {}) });
      if (!stood) throw new Error(`${params.modelPath} could not be read as a binary glTF`);
      if (rigged) {
        const again = examineRig(stood.bytes);
        if (!again.ok || again.floor === null || Math.abs(again.floor) > (again.size?.[1] ?? 1) * 0.02) {
          throw new Error("the stood rig does not pass the exam the rig passed: it was not released. Release the file as it is with a scene that places it, and report this");
        }
      }

      // ── The clips: beside the rig, played on its sheet ──────────────────
      const clipPrefix = `${base}.clip.`;
      const beside = rigged
        ? readdirSync(home).filter((file) => file.startsWith(clipPrefix) && /\.glb$/i.test(file)).map((file) => file.slice(clipPrefix.length).replace(/\.glb$/i, "")).sort()
        : [];
      const played = new Map((sheet?.clips ?? []).filter((clip) => clip.from !== "rig").map((clip) => [clip.name, clip]));
      const wasPlayed = (name: string) => played.has(name) && Boolean(played.get(name)!.sheet) && existsSync(join(home, played.get(name)!.sheet!));
      const asked = params.clips ?? beside.filter(wasPlayed);
      const leftOut: { name: string; why: string }[] = [];
      for (const name of new Set(asked)) {
        if (!beside.includes(name)) throw new Error(`the rig has no clip named ${name}: ${shown(join(home, `${clipPrefix}${name}.glb`))} is not there` + (beside.length ? `. It has: ${beside.join(", ")}` : ""));
        if (!wasPlayed(name)) throw new Error(`the clip ${name} was not played on the rig's sheet: run pva_rig_sheet, look at ${clipPrefix}${name}.sheet.png, then release it`);
      }
      if (params.clips === undefined) for (const name of beside) if (!wasPlayed(name)) leftOut.push({ name, why: "not played on the rig's sheet" });
      const rigJoints = rigged ? jointNames(bytes).join("\n") : "";
      const rigRecord = readJson<{ modelPath?: string; engine?: string; skinning?: string; provider?: string; model?: string; clips?: { name: string }[] }>(join(home, `${base}.provenance.json`));
      const cameWithRig = new Set((rigRecord?.clips ?? []).map((clip) => clip.name));

      // ── Assemble the release beside where it will stand, then put it there ──
      const work = join(formDir, `.${releaseId}.making-${process.pid}`);
      rmSync(work, { recursive: true, force: true });
      mkdirSync(work, { recursive: true });
      const files: ReleasedForm["files"] = [];
      const makers: FormMaker[] = [];
      const keep = (from: string, to: string, content?: Uint8Array): void => {
        mkdirSync(dirname(join(work, to)), { recursive: true });
        if (content) writeFileSync(join(work, to), content);
        else copyFileSync(from, join(work, to));
        files.push({ file: to, from: shown(from), sha256: sha256(readFileSync(from)) });
      };
      try {
        const entry = rigged ? "rig.glb" : "model.glb";
        keep(modelFull, entry, stood.bytes);

        const clips: ReleasedClip[] = [];
        for (const name of [...new Set(asked)].sort()) {
          const clipFull = join(home, `${clipPrefix}${name}.glb`);
          const clipBytes = readFileSync(clipFull);
          if (jointNames(clipBytes).join("\n") !== rigJoints) {
            if (params.clips !== undefined) throw new Error(`the clip ${name} is not of this rig: its skeleton has other bones. Carry it to the rig with pva_retarget_clip`);
            leftOut.push({ name, why: "its skeleton is not this rig's" });
            continue;
          }
          const stoodClip = applyStand(clipBytes, stood.stand);
          if (!stoodClip) throw new Error(`${shown(clipFull)} could not be read as a binary glTF`);
          keep(clipFull, `clips/${name}.glb`, stoodClip);
          const record = played.get(name)!;
          keep(join(home, record.sheet!), `sheets/clip.${name}.png`);
          const clipRecordPath = join(home, `${clipPrefix}${name}.provenance.json`);
          const clipRecord = readJson<{ tool?: string; source?: string; generation?: { provider?: string; model?: string; prompt?: string } }>(clipRecordPath);
          if (clipRecord) keep(clipRecordPath, `provenance/${basename(clipRecordPath)}`);
          const made = clipRecord?.tool === "pva_generate_motion" ? "generated from a sentence"
            : clipRecord?.tool === "pva_retarget_clip" ? "carried from another skeleton"
              : cameWithRig.has(name) ? "came with the rig" : "unrecorded";
          if (clipRecord?.tool === "pva_generate_motion") {
            makers.push({ tool: "pva_generate_motion", ...(clipRecord.generation?.provider ? { provider: clipRecord.generation.provider } : {}), ...(clipRecord.generation?.model ? { model: clipRecord.generation.model } : {}), note: `the clip ${name}${clipRecord.generation?.prompt ? `: "${clipRecord.generation.prompt}"` : ""}` });
          } else if (clipRecord?.tool === "pva_retarget_clip") {
            makers.push({ tool: "pva_retarget_clip", note: `the clip ${name}${clipRecord.source ? `, carried from ${clipRecord.source}` : ""}` });
          }
          clips.push({
            name, file: `clips/${name}.glb`, seconds: record.seconds ?? null, travel: record.travel ?? null, made, sheet: `sheets/clip.${name}.png`,
            from: { path: shown(clipFull), sha256: sha256(clipBytes) },
          });
        }

        let pulledPoses: string[] = [];
        if (sheet) {
          const posesFull = join(home, sheet.poses?.sheet ?? `${base}.poses.png`);
          if (!existsSync(posesFull)) throw new Error(`the rig's pose sheet ${shown(posesFull)} is not there: run pva_rig_sheet again`);
          keep(posesFull, "sheets/poses.png");
          keep(sheetPath, "sheets/sheet.json");
          const edges = sheet.rig?.edges ?? 0;
          pulledPoses = edges < RIG_STRAIN_MARKS.fromEdges ? [] : (sheet.poses?.list ?? [])
            .filter((pose) => pose.strained > RIG_STRAIN_MARKS.strained || pose.torn / edges > RIG_STRAIN_MARKS.tornShare).map((pose) => pose.name);
        }

        // What made it, as far back as the episode's records go: the rig, the model it was made from, the picture.
        const recordOf = (path: string) => join(home, `${basename(path).replace(/\.[^.]+$/, "")}.provenance.json`);
        const ownRecordPath = join(home, `${base}.provenance.json`);
        if (existsSync(ownRecordPath)) keep(ownRecordPath, `provenance/${basename(ownRecordPath)}`);
        const modelRecordPath = rigged && rigRecord?.modelPath ? recordOf(rigRecord.modelPath) : ownRecordPath;
        const modelRecord = readJson<{ provider?: string; model?: string; imagePath?: string; preview?: string | { file?: string } }>(modelRecordPath);
        if (rigged && modelRecord && modelRecordPath !== ownRecordPath) keep(modelRecordPath, `provenance/${basename(modelRecordPath)}`);
        if (modelRecord && !(rigged && modelRecordPath === ownRecordPath)) {
          makers.unshift({ tool: "pva_generate_model", ...(modelRecord.provider ? { provider: modelRecord.provider } : {}), ...(modelRecord.model ? { model: modelRecord.model } : {}) });
        }
        if (rigged && rigRecord) {
          const insert = makers.findIndex((maker) => maker.tool !== "pva_generate_model");
          makers.splice(insert < 0 ? makers.length : insert, 0, {
            tool: "pva_rig_model", ...(rigRecord.provider ? { provider: rigRecord.provider } : {}), ...(rigRecord.model ? { model: rigRecord.model } : {}),
            ...(rigRecord.engine ? { note: `engine ${rigRecord.engine}${rigRecord.skinning ? `, ${rigRecord.skinning} skinning` : ""}${cameWithRig.size ? `; clips that came with it: ${[...cameWithRig].join(", ")}` : ""}` } : {}),
          });
        }
        if (modelRecord?.imagePath) {
          const picture = join(dir, modelRecord.imagePath);
          const allowed = await guardEpisodePath(LIBRARY_ROOT, params.channel, params.series, params.episode, modelRecord.imagePath);
          if (allowed.allowed && existsSync(picture) && statSync(picture).isFile()) keep(picture, `reference/picture${extname(picture).toLowerCase()}`);
        }
        const previewBase = rigged && rigRecord?.modelPath ? basename(rigRecord.modelPath).replace(/\.[^.]+$/, "") : base;
        const preview = readdirSync(home).find((file) => file.startsWith(`${previewBase}.preview.`));
        if (preview) keep(join(home, preview), `reference/preview${extname(preview).toLowerCase()}`);

        const size = [0, 1, 2].map((axis) => round(stood.after.max[axis]! - stood.after.min[axis]!)) as [number, number, number];
        const turned = stood.stand.degrees !== 0 ? `turned ${stood.stand.degrees}°` : null;
        const sized = stood.stand.scale !== 1 ? `sized ×${round(stood.stand.scale)}` : null;
        const movedBy = stood.stand.move.some((value) => Math.abs(value) > 1e-4) ? `moved ${stood.stand.move.map((value) => round(value)).join(", ")}` : null;
        const did = [turned, sized, movedBy].filter(Boolean).join(", ");
        makers.push({ tool: RELEASE_TOOL, note: stood.changed ? `stood: ${did}` : "it stood already: the file is as it was made" });

        const record: ReleasedForm = {
          version: 1, tool: RELEASE_TOOL, medium, entry,
          from: { channel: params.channel, series: params.series, episode: params.episode, path: params.modelPath, sha256: sha256(bytes) },
          faces: "+z", floor: 0, size,
          stand: { ...stood.stand, faced },
          ...(rigged ? { skeleton: { joints: exam.joints, kind: sheet?.rig?.skeleton ?? "unknown", influences: exam.influences } } : {}),
          clips, leftOut,
          ...(sheet ? { sheet: { poses: "sheets/poses.png", report: "sheets/sheet.json", pulled: pulledPoses } } : {}),
          files,
          madeAt: new Date().toISOString(),
        };
        writeFileSync(join(work, RELEASED_FORM_FILE), `${JSON.stringify(record, null, 2)}\n`);

        renameSync(work, folder);
        let recorded;
        try {
          const can = { ...(existing?.can ?? {}), actions: clips.map((clip) => clip.name), views: VIEWS };
          if (can.actions.length === 0) delete (can as { actions?: string[] }).actions;
          updateCharacter(LIBRARY_ROOT, owner, id, { form: { id: formId, ...(existing ? {} : { medium }), can } });
          recorded = releaseForm(LIBRARY_ROOT, owner, id, {
            form: formId, release: releaseId, entry, madeWith: makers,
            ...(params.licence ? { licence: params.licence as FormLicence } : {}), ...(params.note ? { note: params.note } : {}),
            ...(params.current === false ? { current: false } : {}),
          });
        } catch (error) {
          // Nothing is on record: what was put there is taken away again.
          rmSync(folder, { recursive: true, force: true });
          throw error instanceof CastError ? new Error(`${error.code}: ${error.message}`) : error;
        }

        const tree = recorded.release.tree;
        const lines = [
          `✅ ${found.manifest.name} (${ownerLabel(owner)}/${id}): "${formId}" ${releaseId} released — ${medium}, ${tree.files} files, ${(tree.bytes / 1024 / 1024).toFixed(1)}MB, tree ${tree.sha256.slice(0, 12)}…`,
          `   ${stood.changed ? `stood (${did})` : "it stood already"}: faces +z, feet on y 0, ${size[0]} wide × ${size[1]} tall × ${size[2]} deep`,
          `   in ${relative(LIBRARY_ROOT, folder)}: open ${entry}` + (clips.length ? `; clips in clips/` : ""),
        ];
        if (rigged) lines.push(clips.length ? `   actions: ${clips.map((clip) => clip.name).join(", ")}` : "   no actions: it has no clip that was played on its sheet. It can stand");
        if (leftOut.length) lines.push(`   left out: ${leftOut.map((clip) => `${clip.name} (${clip.why})`).join(", ")}`);
        if (pulledPoses.length) lines.push(`   ⚠️ on its sheet these poses pulled the surface further than a sound rig does: ${pulledPoses.join(", ")}. It was released as it is; look at sheets/poses.png`);
        if (!params.licence) lines.push("   no licence was stated: say whose it is and whether it may be published with pva_update_character before the channel is shared");
        lines.push(
          rigged
            ? `   next: give it a role — pva_cast { channel, series, role, character: "${params.character}" } — then film it by its role: pva_rig_shot { role }`
            : `   next: give it a role — pva_cast { channel, series, role, character: "${params.character}" }. It is a statue: it can be placed, turned and lit`,
        );
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { folder, entry: join(folder, entry), character: recorded.manifest, release: recorded.release, form: record } as unknown as Record<string, unknown>,
        };
      } finally {
        rmSync(work, { recursive: true, force: true });
        // Folders made for a release that did not happen are not left behind empty.
        for (const made of [formDir, dirname(formDir)]) {
          try {
            rmdirSync(made);
          } catch {
            // It holds a release: as it should.
            break;
          }
        }
      }
    },
  });
}
