// ---------------------------------------------------------------------------
// A rig, posed and looked at
// ---------------------------------------------------------------------------
// `pva_rig_sheet` is what "pose it and look" means for an agent. The exam a
// rig sits (rig-exam.ts) reads the rest pose and cannot see a rig that is
// right at rest and wrong the moment it moves — which is how the first two
// real rigs failed: one tore the coat's hem off with the leg, the other
// pulled the coat up with the arms like wings, and both passed the exam.
//
// So the body is put in known poses in Blender, each rendered from three
// sides on one sheet; its clips are played over six moments each; and how
// far every pose pulled the surface out of shape is measured, because a
// number can be compared between two attempts where two pictures cannot.
// Local, and free: nothing is sent anywhere.
// ---------------------------------------------------------------------------

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { RIG_AXES, RIG_FACINGS, RIG_SHEET_LIMITS, rigSheet, type RigAxis, type RigFacing, type RigClipThrough, type RigSheetReport, type RigStrain, type RigThrough } from "@av/blender/rig-sheet";
import { blenderKey, MACHINE_PARAM, placeBlender, placeLines, runBlenderAt } from "./blender-place.js";
import { episodePath } from "@studio/contracts/src/layout.mjs";
import { guardEpisodePath } from "./trust-guards.js";

export const RIG_SHEET_TOOL = "pva_rig_sheet";

/** Above these a pose is marked: the hand-made rigs measured stay well under both. */
export const RIG_STRAIN_MARKS = { strained: 0.02, tornShare: 0.002, fromEdges: 5000 };

const percent = (share: number) => `${(share * 100).toFixed(1)}%`;
const slug = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "clip";

/** A pose that pulled the surface further than a sound rig does. Not said of a body too coarse to tell. */
export function pulled(strain: RigStrain, edges: number): boolean {
  if (edges < RIG_STRAIN_MARKS.fromEdges) return false;
  return strain.strained > RIG_STRAIN_MARKS.strained || strain.torn / edges > RIG_STRAIN_MARKS.tornShare;
}

/** A part this deep in another, as a share of the body's height, is marked: a hand in the head. Less is a brush. */
export const THROUGH_MARK = 0.05;

/** How one part is in another, in words: "its right hand goes into its head (9% of its height) from 0.79s for 2.46s". */
export function throughText(through: RigThrough | RigClipThrough, depth: string): string {
  const [a, b] = through.parts;
  const how = through.depth >= THROUGH_MARK ? `goes into its ${b} (${depth})` : `brushes its ${b} (${depth})`;
  return `its ${a} ${how}${"from" in through ? ` from ${Number(through.from.toFixed(2))}s for ${Number(through.seconds.toFixed(2))}s` : ""}`;
}

const throughs = (found: readonly (RigThrough | RigClipThrough)[]) =>
  found.map((through) => throughText(through, `${Math.max(1, Math.round(through.depth * 100))}% of its height`));
const marked = (found: readonly RigThrough[]) => found.some((through) => through.depth >= THROUGH_MARK);

const strainText = (strain: RigStrain) => `${percent(strain.strained)} of the surface strained, ${strain.torn.toLocaleString("en-US")} edge${strain.torn === 1 ? "" : "s"} torn`;

/** What the sheet shows and measured, as lines the agent reads before it opens the picture. */
export function describeRigSheet(report: RigSheetReport, files: { poses: string; clips: Record<string, string> }): string[] {
  const edges = report.rig.edges;
  const shown = report.poses.list.slice(1);
  const lines = [
    `✅ ${files.poses} — ${report.poses.columns} columns (rest${shown.length ? `, ${shown.map((pose) => pose.name).join(", ")}` : ""}) × ${report.views.length} rows (${report.views.join(", ")})`,
    `   ${report.rig.bones} bones, ${report.rig.vertices.toLocaleString("en-US")} vertices; ` +
      (report.rig.skeleton === "biped" ? "its bones' names were read as a two-legged body's" : "its bones' names were not read as a two-legged body's"),
  ];
  for (const pose of shown) {
    const through = pose.through ?? [];
    lines.push(`   ${pulled(pose, edges) || marked(through) ? "⚠️ " : ""}${pose.name}: ${[strainText(pose), ...throughs(through)].join("; ")}`);
  }
  for (const clip of report.clips) {
    const through = clip.through ?? [];
    lines.push(
      `   ${marked(through) ? "⚠️ " : ""}clip ${clip.name}: ${files.clips[clip.name] ?? clip.sheet} — ${clip.seconds}s, at its worst ${strainText(clip)}, ` +
        (clip.travel < 0.1 ? "played on the spot" : `the body travels ${clip.travel} of its height`) +
        (through.length ? `; ${throughs(through).join("; ")}` : ""),
    );
  }
  const unseen = report.actionsInside.filter((name) => !report.clips.some((clip) => clip.from === "rig" && clip.name === name));
  if (unseen.length > 0) {
    lines.push(`   clips inside the rig not played: ${unseen.slice(0, 12).join(", ")}${unseen.length > 12 ? ` and ${unseen.length - 12} more` : ""} — name up to ${RIG_SHEET_LIMITS.clips} in \`actions\``);
  }
  for (const note of report.notes) lines.push(`   ${note}`);
  if (report.rig.skeleton !== "biped") {
    lines.push(`   bones: ${report.bones.slice(0, 60).map((bone) => bone.name).join(", ")}${report.bones.length > 60 ? ` and ${report.bones.length - 60} more` : ""}`);
  }
  const strained = shown.filter((pose) => pulled(pose, edges)).map((pose) => pose.name);
  const passing = report.clips.filter((clip) => marked(clip.through ?? [])).map((clip) => `clip ${clip.name}`);
  const parts = (report.rig.parts ?? []).length > 0;
  lines.push(
    "   open the sheet and read it tile by tile: where a limb meets the body, and whatever the character wears. " +
      (strained.length > 0
        ? `Start at ${strained.join(", ")}: a sound rig of a body this fine strains under ${percent(RIG_STRAIN_MARKS.strained)} of its surface in these poses and tears almost none`
        : edges < RIG_STRAIN_MARKS.fromEdges
          ? "The body is too coarse for the numbers to mark a pose: they compare two rigs of it, no more"
          : `No pose pulled the surface further than a sound rig does; the numbers do not see ${parts ? "" : "a limb passing through the body, or "}a face that no longer looks like itself`),
  );
  if (passing.length > 0) {
    lines.push(
      `   ${passing.join(" and ")} put${passing.length === 1 ? "s" : ""} a part of the body into another: a motion made for other proportions does that. ` +
        "Look at the moments said on its sheet before it is filmed; ask for another motion, or film it where that part is out of the picture",
    );
  }
  return lines;
}

export function registerRigSheetTools(pi: ExtensionAPI): void {
  const LIBRARY_ROOT = process.env.AVG_LIBRARY_ROOT || join(process.cwd(), "library");

  pi.registerTool({
    name: RIG_SHEET_TOOL,
    label: "Rig Pose Sheet",
    description:
      "Pose a rigged 3D model and look at it: the step between a rig and its release. Local (Blender), free, repeatable. " +
      "Puts the body in known poses — for a two-legged body: arms up, arms down, reach, step, wide, head turn, bow; for any other, each of its largest limbs swung, or poses of your own — " +
      "and renders every pose from the front, three-quarter and the side on one sheet beside the rig (<rig>.poses.png). " +
      "Plays clips over six moments each (<rig>.clip.<name>.sheet.png): the clip files pva_rig_model left beside the rig, unless you name others, and clips inside the rig named in `actions`. " +
      "Measures how far each pose pulled the surface out of shape (edges strained, edges torn) and marks the poses that went further than a sound rig does; " +
      "for a two-legged body it also finds, in each pose and through each clip, a part that goes into another it is not joined to — a hand into the head, the body or the other hand, a leg through the other — and says how deep and when: a motion made for other proportions does that. Writes it all to <rig>.sheet.json. " +
      "Open the sheet and read it: the numbers say where to look, not whether the character still looks right. " +
      "Use the same poses on two attempts to choose between them. A rig from pva_rig_model faces +z.",
    parameters: Type.Object({
      channel: Type.String({ description: "Channel slug" }),
      series: Type.String({ description: "Series slug" }),
      episode: Type.String({ description: "Episode slug" }),
      rigPath: Type.String({ description: "The rigged model, episode-relative: assets/models/<rigId>.glb" }),
      faces: Type.Optional(StringEnum(RIG_FACINGS as unknown as [RigFacing, ...RigFacing[]], { default: "+z", description: "Which way the body faces in its file: the poses and the views are laid out from it" })),
      poses: Type.Optional(Type.Array(Type.Object({
        name: Type.String({ description: "What the pose is called on the sheet" }),
        turns: Type.Array(Type.Object({
          bone: Type.String({ description: "A bone's name, as the tool lists them" }),
          about: StringEnum(RIG_AXES as unknown as [RigAxis, ...RigAxis[]], { description: "The body's own axis the bone is turned about, through its head: front (the way the body faces), up, side (towards its left)" }),
          degrees: Type.Number({ minimum: -360, maximum: 360 }),
        }), { minItems: 1, maxItems: RIG_SHEET_LIMITS.turns }),
      }), { maxItems: RIG_SHEET_LIMITS.poses, description: "Poses of your own, in place of the ones chosen for the body. Needed for a body that is not two-legged" })),
      actions: Type.Optional(Type.Array(Type.String(), { description: "Clips inside the rig to play, by name" })),
      clips: Type.Optional(Type.Array(Type.String(), { description: "Clip files to play, episode-relative .glb, each the body with one motion. Default: the <rig>.clip.<name>.glb files beside the rig; [] for none" })),
      machine: MACHINE_PARAM,
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const dir = episodePath(LIBRARY_ROOT, params.channel, params.series, params.episode);
      const inEpisode = async (path: string, what: string): Promise<string> => {
        const guard = await guardEpisodePath(LIBRARY_ROOT, params.channel, params.series, params.episode, path);
        if (!guard.allowed) throw new Error(guard.reason ?? `${what} path rejected: ${path}`);
        const full = join(dir, path);
        if (!existsSync(full) || !statSync(full).isFile()) throw new Error(`${what} not found: ${path}`);
        if (!/\.glb$/i.test(full)) throw new Error(`${what} must be a binary glTF (.glb): ${path}`);
        return full;
      };
      const rigFull = await inEpisode(params.rigPath, "Rig");
      const home = dirname(rigFull);
      const base = basename(rigFull).replace(/\.glb$/i, "");

      const clipPrefix = `${base}.clip.`;
      const clips = params.clips !== undefined
        ? await Promise.all(params.clips.map(async (path) => {
            const full = await inEpisode(path, "Clip");
            const file = basename(full).replace(/\.glb$/i, "");
            return { name: file.startsWith(clipPrefix) ? file.slice(clipPrefix.length) : file, path: full };
          }))
        : readdirSync(home).filter((file) => file.startsWith(clipPrefix) && /\.glb$/i.test(file)).sort()
            .map((file) => ({ name: file.slice(clipPrefix.length).replace(/\.glb$/i, ""), path: join(home, file) }))
            .slice(0, Math.max(0, RIG_SHEET_LIMITS.clips - (params.actions?.length ?? 0)));

      const where = await placeBlender(LIBRARY_ROOT, params.machine, signal);
      const say = (text: string) => onUpdate?.({ content: [{ type: "text" as const, text }], details: { rigPath: params.rigPath } });
      say(`Posing ${params.rigPath} in Blender${where.kind === "machine" ? ` on ${where.machine.name}` : ""}…`);
      const work = mkdtempSync(join(tmpdir(), "rig-sheet-"));
      try {
        const sheet = {
          rigPath: rigFull, outputDir: join(work, "sheet"), clips,
          ...(params.faces ? { faces: params.faces } : {}), ...(params.poses ? { poses: params.poses } : {}), ...(params.actions ? { actions: params.actions } : {}),
        };
        const { report, outputDir, machine } = await runBlenderAt(where, "rig-sheet", sheet, () => rigSheet(sheet, { signal }), {
          key: blenderKey(params.channel, params.series, params.episode), allowedRoots: [join(LIBRARY_ROOT, params.channel)], ...(signal ? { signal } : {}), onLog: say,
        });

        // The sheets are views of the rig, remade whenever asked: the last ones are replaced.
        for (const file of readdirSync(home)) {
          if (file === `${base}.poses.png` || file === `${base}.sheet.json` || (file.startsWith(clipPrefix) && file.endsWith(".sheet.png"))) rmSync(join(home, file), { force: true });
        }
        const posesFile = `${base}.poses.png`;
        copyFileSync(join(outputDir, report.poses.sheet), join(home, posesFile));
        const clipFiles: Record<string, string> = {};
        for (const clip of report.clips) {
          const file = `${clipPrefix}${slug(clip.name)}.sheet.png`;
          copyFileSync(join(outputDir, clip.sheet), join(home, file));
          clipFiles[clip.name] = file;
        }
        const kept: RigSheetReport = {
          ...report,
          poses: { ...report.poses, sheet: posesFile },
          clips: report.clips.map((clip) => ({ ...clip, sheet: clipFiles[clip.name]! })),
        };
        const sheetPath = join(home, `${base}.sheet.json`);
        writeFileSync(sheetPath, `${JSON.stringify({
          version: 1,
          rigFile: basename(rigFull),
          rigSha256: createHash("sha256").update(readFileSync(rigFull)).digest("hex"),
          faces: params.faces ?? "+z",
          marks: RIG_STRAIN_MARKS,
          ...(machine ? { machine } : {}),
          madeAt: new Date().toISOString(),
          ...kept,
        }, null, 2)}\n`);

        const shown = (file: string) => relative(dir, join(home, file));
        return {
          content: [{
            type: "text" as const,
            text: [...describeRigSheet(kept, { poses: shown(posesFile), clips: Object.fromEntries(Object.entries(clipFiles).map(([name, file]) => [name, shown(file)])) }), ...placeLines(where, machine)].join("\n"),
          }],
          details: {
            sheetPath: join(home, posesFile),
            clipSheets: Object.fromEntries(Object.entries(clipFiles).map(([name, file]) => [name, join(home, file)])),
            reportPath: sheetPath,
            report: kept,
          },
        };
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  });
}
