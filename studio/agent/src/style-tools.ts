// ---------------------------------------------------------------------------
// Style templates (ADR-0054): ready-made roads to a look, never required
// ---------------------------------------------------------------------------
// A person may say "make this film in the risograph style", "prepare this
// scene using 'Tide riso'", or nothing at all. These tools find the template
// a name means, apply it to a channel, a series, a film or a scene (copying it
// into that level's style/), give the brief as a unit reads it, change its
// parameters, and keep an edited style as a template of its own.
//
// What reads a style keeps a pin on it: changing a parameter makes those
// stages, and what was made from them, stale. The renewal that accepts the
// change goes through the gateway, which runs the runtime; the files are
// written here, as the film tools write theirs.
// ---------------------------------------------------------------------------

import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import { formatFieldValue, paramFile, setParamValue, type StyleParams } from "@studio/contracts/src/style.mjs";
import {
  StyleError, applyStyle, dependentsOf, findStyle, inheritedTarget, listStyles, readStyleFolder, readTargetStyle,
  resolveUnitStyle, saveStyleAsTemplate, syncStylePin, targetLabel, unitLabel, writeStyleBrief, writeStyleParams,
  type ApplyResult, type StyleChange, type StyleSummary, type StyleTarget, type TargetStyle, type UnitRef,
} from "@studio/style";
import { projectKind } from "@studio/contracts/src/layout.mjs";
import { resolveConfig } from "./config.js";

type ToolResult = { content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError?: boolean };

const ok = (text: string, details: Record<string, unknown> = {}): ToolResult => ({ content: [{ type: "text", text }], details });

function fail(error: unknown): ToolResult {
  const e = error as { message?: string; code?: string; problems?: { code: string; message: string; path?: string }[] };
  const problems = (e.problems ?? []).slice(0, 20).map((p) => `  - ${p.code}${p.path ? ` at ${p.path}` : ""}: ${p.message}`);
  return {
    content: [{ type: "text", text: [`❌ ${e.code ? `${e.code}: ` : ""}${e.message ?? String(error)}`, ...problems].join("\n") }],
    details: { code: e.code ?? null, problems: e.problems ?? [] },
    isError: true as unknown as boolean,
  };
}

const libraryRoot = async (): Promise<string> => (await resolveConfig()).libraryRoot;

const TARGET_PARAMS = {
  channel: Type.String({ description: "The channel or the film" }),
  series: Type.Optional(Type.String({ description: "A series of the channel, or a scene of the film. Omitted (or _): the channel or film itself" })),
};

const targetOf = (params: { channel: string; series?: string }): StyleTarget =>
  params.series && params.series !== "_" ? { project: params.channel, series: params.series } : { project: params.channel };

const swatchLine = (s: StyleSummary): string => s.swatches.map((c) => c.value).join(" ");

function describeSummary(s: StyleSummary): string {
  const flags = [s.origin, ...(s.shadows.length > 0 ? [`shadows ${s.shadows.join(", ")}`] : []), ...(s.problems.length > 0 ? [`⚠️ ${s.problems.length} problem(s)`] : [])];
  const scaffold = [s.scaffold.filmFormat ? `film ${s.scaffold.filmFormat}` : "", s.scaffold.shotSource ? `shots: ${s.scaffold.shotSource}` : ""].filter(Boolean).join(", ");
  return `• ${s.id} — "${s.title}" (${flags.join(", ")}) ${swatchLine(s)}\n    ${s.summary}${scaffold ? `\n    suggests: ${scaffold}` : ""}`;
}

function describeParams(params: Record<string, StyleParams>, order: string[]): string[] {
  const lines: string[] = [];
  for (const id of order) {
    const doc = params[id];
    if (!doc) continue;
    lines.push(`  ${paramFile(id)} — ${doc.title} (${doc.kind})`);
    if (doc.kind === "palette") for (const c of doc.colors) lines.push(`    ${c.id}: ${c.value} ${c.name}${c.role ? ` — ${c.role}` : ""}`);
    else for (const f of doc.fields) lines.push(`    ${f.id}: ${formatFieldValue(f)} (${f.type}${f.options ? `: ${f.options.join(" | ")}` : ""})`);
  }
  return lines;
}

function describeTargetStyle(style: TargetStyle, root: string): string {
  const b = style.binding;
  const lines = [
    `${targetLabel(style.target)} (${style.level}) reads ${b ? `${b.template.id} ${b.template.version} (${b.template.origin}${b.copiedFrom ? `, copied from ${b.copiedFrom}` : ""})` : "a style with no style.yaml"} — ${style.dir}`,
    ...(b?.note ? [`note: ${b.note}`] : []),
    `read by ${dependentsOf(root, style.target).length} unit(s)`,
    "",
    "Parameters (edit with pva_set_style; the brief reads them, never inline):",
    ...describeParams(style.folder.params, style.folder.template?.parameters ?? Object.keys(style.folder.params)),
  ];
  const scaffold = style.folder.template?.scaffold;
  if (scaffold?.skills?.length) lines.push("", `Load before making anything in it: ${scaffold.skills.join(", ")}`);
  if (scaffold?.shotSource) lines.push(`Shots in this style usually come from: ${scaffold.shotSource}`);
  if (style.problems.length > 0) lines.push("", "⚠️ Problems:", ...style.problems.map((p) => `  - ${p.code} at ${p.path}: ${p.message}`));
  return lines.join("\n");
}

function describeApply(result: ApplyResult): string {
  const counts = result.units.reduce<Record<string, number>>((acc, u) => ({ ...acc, [u.outcome]: (acc[u.outcome] ?? 0) + 1 }), {});
  return [
    `✅ ${targetLabel(result.target)} (${result.level}) now reads "${result.template.title}" (${result.template.id} ${result.template.version}, ${result.template.origin}) — its own copy in ${result.dir}`,
    ...(result.replaced ? [`The style it had was set aside in ${result.replaced}.`] : []),
    result.units.length > 0
      ? `Pinned for ${result.units.length} unit(s): ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ")}${counts.moved ? " — moved pins keep what those units read before, so they show stale until renewed" : ""}.`
      : "No unit under it yet: each one made from now on reads it.",
    ...(result.scaffold.skills?.length ? [`Load before making anything in it: ${result.scaffold.skills.join(", ")}.`] : []),
    ...(result.problems.length > 0 ? ["⚠️ " + result.problems.map((p) => `${p.path} ${p.message}`).join("; ")] : []),
    "Read the brief for a unit with pva_style; change a colour or a value with pva_set_style.",
  ].join("\n");
}

/** Accept a style change for the units that read it, through the gateway; say so honestly when it cannot. */
async function renewThroughGateway(target: StyleTarget, change: StyleChange): Promise<string> {
  if (change.dependents.length === 0) return "No unit reads this style yet: nothing to make stale.";
  try {
    const config = await resolveConfig();
    const series = target.series ?? "_";
    const res = await fetch(`${config.gatewayUrl}/api/style/${encodeURIComponent(target.project)}/${encodeURIComponent(series)}/renew`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(config.gatewayToken ? { Authorization: `Bearer ${config.gatewayToken}` } : {}) },
      body: JSON.stringify({ actor: "pi" }),
    });
    const body = (await res.json().catch(() => ({}))) as { renewed?: { unit: string; affected: string[] }[]; failed?: { unit: string; message: string }[] };
    if (!res.ok) throw new Error(`gateway ${res.status}`);
    const lines = (body.renewed ?? []).filter((r) => r.affected.length > 0).map((r) => `  ↻ ${r.unit}: ${r.affected.join(", ")} must be redone`);
    const failed = (body.failed ?? []).map((f) => `  ⚠️ ${f.unit}: ${f.message}`);
    return [`The change is accepted for ${change.dependents.length} unit(s) that read this style; what they made from it is stale:`, ...lines, ...failed].join("\n");
  } catch (error) {
    return `${change.dependents.length} unit(s) read this style and now show it changed (stale until renewed). The gateway could not renew their pins (${error instanceof Error ? error.message : String(error)}): ` +
      `start it, or renew each with \`vpr pin renew <unit> style\`.`;
  }
}

export function registerStyleTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pva_styles",
    label: "Style Templates",
    description:
      "The style templates there are — ready-made looks with their way of making (woodblock print, risograph, cut paper, chalkboard explainer…) — " +
      "from the studio, the library's _styles/ and the project's own styles/. With `name`, one in full: its brief and its parameter files. " +
      "A person may name one in any words ('in the woodblock style', \"usando 'Tide riso'\"): pass what they said as `name`. A style is always optional.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "A template's id or title, or words from it" })),
      project: Type.Optional(Type.String({ description: "The channel or film it is for: its own templates are included and win" })),
    }),
    async execute(_id, params) {
      try {
        const root = await libraryRoot();
        if (!params.name) {
          const all = listStyles(root, { project: params.project });
          return ok(all.length > 0 ? [`${all.length} style template(s):`, ...all.map(describeSummary), "", "Apply one with pva_apply_style; or make the work with no style at all."].join("\n") : "No style templates.", { styles: all });
        }
        const found = findStyle(root, params.name, { project: params.project });
        const folder = readStyleFolder(found.path);
        return ok([
          describeSummary(found), "",
          "Parameters:", ...describeParams(folder.params, folder.template?.parameters ?? []), "",
          "The brief (STYLE.md), with its placeholders:", folder.brief ?? "(none)",
        ].join("\n"), { style: found, folder });
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "pva_apply_style",
    label: "Apply Style",
    description:
      "Apply a style template to a channel, a series, a film or a scene: its own copy goes in that level's style/ (brief, params/, style.yaml), " +
      "and every unit under it reads it — a scene's or a series' style wins over its project's. `fromParent` copies the level above's style instead, " +
      "to change it for one scene or series. Never overwrites a style unless `replace`. Only when the person asked for a style or agreed to one.",
    parameters: Type.Object({
      ...TARGET_PARAMS,
      style: Type.Optional(Type.String({ description: "The template's id or title, as the person named it" })),
      fromParent: Type.Optional(Type.Boolean({ description: "Copy the level above's style rather than a template" })),
      replace: Type.Optional(Type.Boolean({ description: "Replace a style the level already has (the old one is set aside, not deleted)" })),
      note: Type.Optional(Type.String({ description: "Why, in a sentence: kept in style.yaml" })),
    }),
    async execute(_id, params) {
      try {
        const root = await libraryRoot();
        const target = targetOf(params);
        return await withFileMutationQueue(join(root, params.channel, "style"), async () => ok(describeApply(await applyStyle(root, target, params)), { target }));
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "pva_style",
    label: "Style Brief",
    description:
      "The style a unit reads, with its brief written for that unit — every {{placeholder}} filled from the parameter files and the unit's own " +
      "title and idea — its parameters, the skills it asks for and where shots in it come from. Read it before writing a bible, a direction, a " +
      "shot plan, an art direction or a prompt in a styled film or series, and carry it into what you make. Reading it pins the style for the unit, " +
      "so a later change makes the unit's work stale. Unit addressing as everywhere (`_` for a level's own unit); with a channel and no episode, the " +
      "level's style itself.",
    parameters: Type.Object({
      ...TARGET_PARAMS,
      episode: Type.Optional(Type.String({ description: "An episode or a shot; _ for a scene's or a film's own unit" })),
    }),
    async execute(_id, params) {
      try {
        const root = await libraryRoot();
        const film = projectKind(root, params.channel) === "film";
        const unit: UnitRef | null = params.episode
          ? { channel: params.channel, series: params.series ?? "_", episode: params.episode }
          : film ? { channel: params.channel, series: params.series ?? "_", episode: "_" } : null;
        if (unit) {
          const style = resolveUnitStyle(root, unit);
          if (!style) return ok(`${unitLabel(unit)} reads no style. That is fine: it is made as the person and its bible say. (pva_styles lists templates if one is wanted.)`, { style: null });
          const pin = await syncStylePin(root, unit);
          return ok([
            describeTargetStyle(style, root),
            `Pin: ${pin.outcome} (source/pins/style.json, read by ${style.readers.join(", ")})`,
            "", `── The brief, for ${unitLabel(unit)} ──`, style.rendered,
          ].join("\n"), { style, pin: pin.outcome });
        }
        const target = targetOf(params);
        const style = readTargetStyle(root, target);
        if (!style) {
          const inherited = inheritedTarget(root, target);
          return ok(`${targetLabel(target)} has no style of its own${inherited ? `; its units read ${targetLabel(inherited)}'s` : ", and reads none"}.`, { style: null });
        }
        return ok([describeTargetStyle(style, root), "", "── The brief ──", style.rendered].join("\n"), { style });
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "pva_set_style",
    label: "Change Style",
    description:
      "Change a level's style: one parameter file's values by entry id — a palette's colours (#rrggbb) or a values file's fields — or the brief " +
      "(STYLE.md, which must keep naming values by {{placeholder}}, never inline). Checked before it is written. Everything that read the style " +
      "becomes stale, with what was made from it: say so to the person. Only when they asked for the change.",
    parameters: Type.Object({
      ...TARGET_PARAMS,
      param: Type.Optional(Type.String({ description: "The parameter file: palette, print, sound…" })),
      set: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Entry id → new value: { \"accent\": \"#d43a2f\", \"timing\": \"threes\" }" })),
      brief: Type.Optional(Type.String({ description: "The whole new STYLE.md" })),
    }),
    async execute(_id, params) {
      try {
        const root = await libraryRoot();
        const target = targetOf(params);
        return await withFileMutationQueue(join(root, params.channel, "style"), async () => {
          let change: StyleChange;
          let what: string;
          if (params.brief !== undefined) {
            change = writeStyleBrief(root, target, params.brief);
            what = "STYLE.md";
          } else {
            if (!params.param || !params.set || Object.keys(params.set).length === 0) throw new StyleError("say which parameter file and which values, or give a new brief", "bad-input");
            const style = readTargetStyle(root, target);
            if (!style) throw new StyleError(`${targetLabel(target)} has no style of its own to change`, "no-style-here");
            let doc = style.folder.params[params.param];
            if (!doc) throw new StyleError(`there is no ${paramFile(params.param)}: the style has ${Object.keys(style.folder.params).join(", ")}`, "unknown-param");
            for (const [entry, value] of Object.entries(params.set)) {
              const next = setParamValue(doc, entry, value);
              if (next.problems.length > 0) throw new StyleError(`${entry} cannot be ${JSON.stringify(value)}`, "bad-params", next.problems);
              doc = next.doc;
            }
            change = writeStyleParams(root, target, params.param, doc);
            what = `${paramFile(params.param)}: ${Object.entries(params.set).map(([k, v]) => `${k} → ${String(v)}`).join(", ")}`;
          }
          return ok(`✅ ${targetLabel(target)}'s style changed (${what}).\n${await renewThroughGateway(target, change)}`, { dependents: change.dependents });
        });
      } catch (error) {
        return fail(error);
      }
    },
  });

  pi.registerTool({
    name: "pva_save_style",
    label: "Save Style as Template",
    description:
      "Keep a level's style — with the parameters and brief as they were edited there — as a template of its own, so another film, series or " +
      "scene can be made with it by name. `scope: library` (default) puts it in the library's _styles/, `project` in the channel's or film's styles/. " +
      "Never overwrites a template.",
    parameters: Type.Object({
      ...TARGET_PARAMS,
      id: Type.String({ description: "The new template's id: lowercase words joined by -" }),
      title: Type.Optional(Type.String()),
      summary: Type.Optional(Type.String({ description: "The style in one sentence" })),
      scope: Type.Optional(Type.Union([Type.Literal("library"), Type.Literal("project")])),
    }),
    async execute(_id, params) {
      try {
        const root = await libraryRoot();
        const saved = saveStyleAsTemplate(root, targetOf(params), params);
        return ok(`✅ template "${saved.id}" kept in ${saved.path} (${saved.origin}). It can now be named in any request: "make it using '${params.title ?? saved.id}'".`, { saved });
      } catch (error) {
        return fail(error);
      }
    },
  });
}

/**
 * For the creation tools: apply a style when one was asked for, and pin the
 * style a new unit inherits. Returns lines to add to the tool's answer.
 */
export async function styleAfterCreate(root: string, input: { target?: StyleTarget; style?: string; unit?: UnitRef }): Promise<string[]> {
  const lines: string[] = [];
  if (input.target && input.style) {
    try {
      lines.push(describeApply(await applyStyle(root, input.target, { style: input.style })));
    } catch (error) {
      lines.push(`⚠️ The style was not applied: ${error instanceof Error ? error.message : String(error)}. Everything else was made.`);
    }
  }
  if (input.unit) {
    const pin = await syncStylePin(root, input.unit);
    if (pin.target) lines.push(`Reads ${targetLabel(pin.target)}'s style (pin ${pin.outcome}): read it with pva_style before making anything.`);
  }
  return lines;
}

/** The film format a style suggests, when the person asked for none. */
export function styleFilmFormat(root: string, style: string | undefined, project: string): string | undefined {
  if (!style) return undefined;
  try {
    return findStyle(root, style, { project }).scaffold.filmFormat;
  } catch {
    return undefined;
  }
}

