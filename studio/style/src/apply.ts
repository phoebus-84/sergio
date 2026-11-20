// ---------------------------------------------------------------------------
// Applying a style, reading it, changing it, keeping it as a template
// ---------------------------------------------------------------------------
// Applying a template to a level copies it into the level's style/ folder —
// the scaffold — and records where it came from in style.yaml. From then on
// the copy is the level's own: its parameters are edited there, and the
// template is never touched. A level that already has a style keeps it unless
// asked to replace it; the replaced one is moved aside, never deleted.
//
// Nothing here is required. A channel, a series, a film or a scene with no
// style is made exactly as before; a style is an easier road, not a gate.
// ---------------------------------------------------------------------------

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify } from "yaml";
import {
  LIBRARY_STYLES_DIR, PROJECT_STYLES_DIR, STYLE_API_VERSION, STYLE_BINDING, STYLE_BRIEF, STYLE_DIR, STYLE_LEVELS, STYLE_MANIFEST,
  paramFile, renderBrief, validateStyleBinding, validateStyleParams, validateStyleTemplate,
  type StyleBinding, type StyleParams, type StyleProblem, type StyleScaffold, type StyleTemplate,
} from "@studio/contracts/src/style.mjs";
import { channelPath } from "@studio/contracts/src/layout.mjs";
import { findStyle, folderFiles, folderHash, readStyleFolder, type StyleFolder, type StyleSummary } from "./catalog.js";
import {
  StyleError, assertSlug, hasStyle, inheritedTarget, nearestStyledTarget, normalTarget, parentTarget, styleDirOf, targetContext, targetDir,
  targetLabel, targetLevel, unitContext, unitLevel, type StyleTarget, type UnitRef,
} from "./levels.js";
import { STYLE_READERS, dependentsOf, syncStylePin, syncStylePins, type PinOutcome } from "./pins.js";

let temporaries = 0;
function writeAtomically(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${(temporaries += 1)}.tmp`;
  writeFileSync(temporary, content, "utf-8");
  renameSync(temporary, target);
}

const jsonDocument = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const refuse = (what: string, problems: StyleProblem[], code = "bad-style"): never => {
  throw new StyleError(`${what}: ${problems.slice(0, 5).map((p) => `${p.path} ${p.message}`).join("; ")}`, code, problems);
};

/** A level's style, read: what it is, where it came from and what it says. */
export interface TargetStyle {
  target: StyleTarget;
  level: string;
  dir: string;
  binding: StyleBinding | null;
  folder: StyleFolder;
  /** The brief as this level reads it, every placeholder filled in. */
  rendered: string;
  problems: StyleProblem[];
}

function readBinding(dir: string): { binding: StyleBinding | null; problems: StyleProblem[] } {
  const file = join(dir, STYLE_BINDING);
  if (!existsSync(file)) return { binding: null, problems: [{ code: "missing", path: STYLE_BINDING, message: `${STYLE_BINDING} is not there: where the style came from is unknown` }] };
  try {
    const doc = parseYaml(readFileSync(file, "utf-8"));
    const problems = validateStyleBinding(doc).map((p) => ({ ...p, path: `${STYLE_BINDING}${p.path.slice(1)}` }));
    return { binding: problems.length === 0 ? (doc as StyleBinding) : null, problems };
  } catch (error) {
    return { binding: null, problems: [{ code: "yaml", path: STYLE_BINDING, message: `does not parse: ${error instanceof Error ? error.message : String(error)}` }] };
  }
}

/** The style applied at a level, or null when it has none of its own. */
export function readTargetStyle(root: string, target: StyleTarget, context?: { title?: string; idea?: string; level?: string }): TargetStyle | null {
  const t = normalTarget(target);
  if (!hasStyle(root, t)) return null;
  const dir = styleDirOf(root, t);
  const folder = readStyleFolder(dir);
  const { binding, problems: bindingProblems } = readBinding(dir);
  const { text, problems: renderProblems } = renderBrief(folder.brief ?? "", folder.params, context ?? targetContext(root, t));
  // The brief's own placeholder problems are already in the folder's; rendering only adds unit gaps.
  const problems = [...folder.problems, ...bindingProblems, ...renderProblems.filter((p) => p.code === "unknown-unit")];
  return { target: t, level: targetLevel(root, t), dir, binding, folder, rendered: text, problems };
}

/** The style a unit reads — its nearest — with the brief written for that unit. */
export function resolveUnitStyle(root: string, ref: UnitRef): (TargetStyle & { unit: UnitRef; readers: readonly string[] }) | null {
  const target = nearestStyledTarget(root, ref);
  if (!target) return null;
  const style = readTargetStyle(root, target, unitContext(root, ref));
  return style ? { ...style, unit: ref, readers: STYLE_READERS[unitLevel(root, ref)] } : null;
}

export interface ApplyInput {
  /** A template's id or title. Omitted with `fromParent`. */
  style?: string;
  /** Copy the level above's style instead of a template: a scene that starts from its film's look and changes it. */
  fromParent?: boolean;
  /** Replace a style the level already has; the old one is moved to .style-history/. */
  replace?: boolean;
  note?: string;
}

export interface ApplyResult {
  target: StyleTarget;
  level: string;
  dir: string;
  template: { id: string; version: string; title: string; origin: string };
  scaffold: StyleScaffold;
  replaced: string | null;
  units: { unit: UnitRef; outcome: PinOutcome }[];
  problems: StyleProblem[];
}

/** Move a level's style aside, where nothing reads it. Returns where it went. */
function setAside(root: string, target: StyleTarget, now: Date): string {
  const from = styleDirOf(root, target);
  const to = join(targetDir(root, target), ".style-history", now.toISOString().replace(/[:.]/g, "-"));
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
  return to;
}

/**
 * Apply a template (or the level above's style) to a channel, a series, a film
 * or a scene: copy it into the level's style/, record where it came from, and
 * pin it for every unit under the level that reads it.
 */
export async function applyStyle(root: string, target: StyleTarget, input: ApplyInput, now = new Date()): Promise<ApplyResult> {
  const t = normalTarget(target);
  targetDir(root, t);
  const level = targetLevel(root, t);
  const dir = styleDirOf(root, t);

  let source: { dir: string; template: StyleTemplate; origin: StyleBinding["template"]["origin"]; hash: string; copiedFrom?: string };
  if (input.fromParent) {
    const parent = parentTarget(t);
    if (!parent || !hasStyle(root, parent)) throw new StyleError(`${targetLabel(t)} has no level above it with a style to copy`, "no-parent-style");
    const parentStyle = readTargetStyle(root, parent);
    if (!parentStyle?.folder.template || !parentStyle.binding) refuse(`the style of ${targetLabel(parent)} cannot be copied`, parentStyle?.problems ?? []);
    source = {
      dir: parentStyle!.dir, template: parentStyle!.folder.template!, origin: parentStyle!.binding!.template.origin,
      hash: parentStyle!.binding!.template.hash, copiedFrom: targetLabel(parent),
    };
  } else {
    if (!input.style) throw new StyleError("name a style to apply, or copy the level above's", "bad-input");
    const found: StyleSummary = findStyle(root, input.style, { project: t.project });
    const folder = readStyleFolder(found.path);
    if (!folder.template || folder.problems.length > 0) refuse(`the style "${found.id}" does not hold`, folder.problems);
    source = { dir: found.path, template: folder.template!, origin: found.origin, hash: folderHash(found.path) };
  }

  const levels = source.template.levels ?? STYLE_LEVELS;
  if (!levels.includes(level)) {
    throw new StyleError(`"${source.template.title}" is made for ${levels.join(", ")}, not a ${level}`, "wrong-level");
  }

  let replaced: string | null = null;
  if (existsSync(dir)) {
    if (!input.replace) {
      const current = readTargetStyle(root, t);
      const id = current?.binding?.template.id ?? current?.folder.template?.id ?? "a style";
      throw new StyleError(`${targetLabel(t)} already has ${id}: change its parameters, or replace it`, "style-exists");
    }
    replaced = setAside(root, t, now);
  }

  mkdirSync(dir, { recursive: true });
  for (const path of folderFiles(source.dir)) {
    if (path === STYLE_BINDING) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    cpSync(join(source.dir, path), join(dir, path));
  }
  const binding: StyleBinding = {
    apiVersion: STYLE_API_VERSION,
    kind: "StyleBinding",
    template: { id: source.template.id, version: source.template.version, origin: source.origin, hash: source.hash },
    appliedAt: now.toISOString(),
    ...(source.copiedFrom ? { copiedFrom: source.copiedFrom } : {}),
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
  };
  writeAtomically(join(dir, STYLE_BINDING), [
    "# The style this level reads, copied from a template. Edit params/ and STYLE.md here: the template stays as it was.",
    "# What reads this style keeps a pin on it (source/pins/style.json): a change makes it stale until renewed.",
    stringify(binding),
  ].join("\n"));

  const units = await syncStylePins(root, t, now);
  const applied = readTargetStyle(root, t);
  return {
    target: t,
    level,
    dir,
    template: { id: source.template.id, version: source.template.version, title: source.template.title, origin: source.origin },
    scaffold: source.template.scaffold ?? {},
    replaced,
    units: units.filter((u) => u.outcome !== "unstyled").map(({ unit, outcome }) => ({ unit, outcome })),
    problems: applied?.problems ?? [],
  };
}

/** What a change to a level's style touches: the units that read it. */
export interface StyleChange {
  target: StyleTarget;
  path: string;
  dependents: UnitRef[];
}

function styleOrRefuse(root: string, target: StyleTarget): TargetStyle {
  const style = readTargetStyle(root, target);
  if (!style) {
    const inherited = inheritedTarget(root, target);
    throw new StyleError(
      `${targetLabel(normalTarget(target))} has no style of its own${inherited ? `: it reads ${targetLabel(inherited)}'s — change it there, or copy it here first` : ""}`,
      "no-style-here",
    );
  }
  return style;
}

/** Replace one parameter file of a level's style, checked. Returns the units the change makes stale. */
export function writeStyleParams(root: string, target: StyleTarget, param: string, doc: StyleParams): StyleChange {
  const style = styleOrRefuse(root, target);
  if (!style.folder.template?.parameters.includes(param)) {
    throw new StyleError(`the style has no parameter file "${param}": it has ${style.folder.template?.parameters.join(", ") || "none"}`, "unknown-param");
  }
  const problems = validateStyleParams(doc);
  if (problems.length > 0) refuse(`${paramFile(param)} cannot be written that way`, problems, "bad-params");
  const was = style.folder.params[param];
  if (was && was.kind !== doc.kind) throw new StyleError(`${paramFile(param)} is a ${was.kind} file, not ${doc.kind}`, "bad-params");
  const path = join(style.dir, paramFile(param));
  writeAtomically(path, jsonDocument(doc));
  return { target: style.target, path, dependents: dependentsOf(root, style.target) };
}

/** Replace the brief of a level's style; every placeholder must still name something. */
export function writeStyleBrief(root: string, target: StyleTarget, text: string): StyleChange {
  const style = styleOrRefuse(root, target);
  const { problems } = renderBrief(text, style.folder.params, { level: style.level });
  if (problems.length > 0) refuse(`${STYLE_BRIEF} cannot say that`, problems, "bad-brief");
  const path = join(style.dir, STYLE_BRIEF);
  writeAtomically(path, text.endsWith("\n") ? text : `${text}\n`);
  return { target: style.target, path, dependents: dependentsOf(root, style.target) };
}

export interface SaveTemplateInput {
  id: string;
  title?: string;
  summary?: string;
  version?: string;
  /** Where it is kept: the library's _styles/ (default), or the project's own styles/. */
  scope?: "library" | "project";
}

/**
 * Keep a level's style — with its edited parameters and brief — as a template
 * of its own, so another film, series or scene can be made with it by name.
 * Never overwrites a template.
 */
export function saveStyleAsTemplate(root: string, from: StyleTarget, input: SaveTemplateInput): { id: string; path: string; origin: "library" | "project" } {
  assertSlug("the template's id", input.id);
  const style = styleOrRefuse(root, from);
  if (!style.folder.template) refuse("the style has no style.json to start from", style.problems);
  const scope = input.scope ?? "library";
  const base = scope === "project" ? join(channelPath(root, style.target.project), "styles") : join(root, LIBRARY_STYLES_DIR);
  const dir = join(base, input.id);
  if (existsSync(dir)) throw new StyleError(`there is already a template "${input.id}" at ${dir}: choose another id`, "template-exists");
  const template: StyleTemplate = {
    ...style.folder.template!,
    id: input.id,
    version: input.version ?? "1.0.0",
    title: input.title?.trim() || style.folder.template!.title,
    summary: input.summary?.trim() || style.folder.template!.summary,
    credits: `Made from ${targetLabel(style.target)}'s style (${style.binding?.template.id ?? "unknown"} ${style.binding?.template.version ?? ""}).`.replace(" )", ")"),
  };
  const problems = validateStyleTemplate(template);
  if (problems.length > 0) refuse("the template cannot be described that way", problems);
  mkdirSync(dir, { recursive: true });
  for (const path of folderFiles(style.dir)) {
    if (path === STYLE_BINDING || path === STYLE_MANIFEST) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    cpSync(join(style.dir, path), join(dir, path));
  }
  writeAtomically(join(dir, STYLE_MANIFEST), jsonDocument(template));
  return { id: input.id, path: dir, origin: scope };
}

/** Pin the style for one unit (after creating it, or when its brief is read). */
export const pinStyleFor = (root: string, ref: UnitRef) => syncStylePin(root, ref);

export { PROJECT_STYLES_DIR, STYLE_DIR };
