// ---------------------------------------------------------------------------
// The templates there are, and finding one by the name a person gives
// ---------------------------------------------------------------------------
// Templates come from three places, nearest first:
//
//   <library>/<project>/styles/<id>/   a channel's or a film's own (travels with it)
//   <library>/_styles/<id>/            the library's: what its people made
//   studio/style/templates/<id>/       shipped with the studio
//
// A nearer template with the same id shadows a farther one, so a library can
// adapt a built-in style under its own name or the same one. A person names a
// template the way they think of it — "usa 'Risograph'", "in the woodblock
// style" — so a name is matched by id, by title and, failing both, by the one
// template whose id or title contains it.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LIBRARY_STYLES_DIR, PROJECT_STYLES_DIR, STYLE_BRIEF, STYLE_MANIFEST, STYLE_PARAMS_DIR,
  checkStyle, swatchesOf,
  type StyleOrigin, type StyleParams, type StyleProblem, type StyleScaffold, type StyleTemplate,
} from "@studio/contracts/src/style.mjs";
import { channelPath } from "@studio/contracts/src/layout.mjs";
import { StyleError, assertSlug } from "./levels.js";

/** A template or a style/ folder, read. */
export interface StyleFolder {
  dir: string;
  template: StyleTemplate | null;
  brief: string | null;
  params: Record<string, StyleParams>;
  problems: StyleProblem[];
}

export interface StyleSummary {
  id: string;
  version: string;
  title: string;
  summary: string;
  tags: string[];
  levels: string[];
  origin: StyleOrigin;
  path: string;
  swatches: { name: string; value: string }[];
  scaffold: StyleScaffold;
  problems: StyleProblem[];
  /** Farther templates with the same id this one hides. */
  shadows: StyleOrigin[];
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** Where the studio's own templates are: beside the package, in source and when built. */
export function builtinStylesDir(): string {
  if (process.env.AVG_BUILTIN_STYLES) return process.env.AVG_BUILTIN_STYLES;
  for (const up of ["../templates", "../../templates"]) {
    const dir = fileURLToPath(new URL(up, import.meta.url));
    if (isDir(dir)) return dir;
  }
  return fileURLToPath(new URL("../templates", import.meta.url));
}

/** The folders templates are looked for in, nearest first. */
export function styleRoots(root: string, project?: string): { origin: StyleOrigin; dir: string }[] {
  const roots: { origin: StyleOrigin; dir: string }[] = [];
  if (project) roots.push({ origin: "project", dir: join(channelPath(root, project), PROJECT_STYLES_DIR) });
  roots.push({ origin: "library", dir: join(root, LIBRARY_STYLES_DIR) });
  roots.push({ origin: "builtin", dir: builtinStylesDir() });
  return roots;
}

const parseJson = (text: string, path: string, problems: StyleProblem[]): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    problems.push({ code: "json", path, message: `does not parse: ${error instanceof Error ? error.message : String(error)}` });
    return undefined;
  }
};

/** Read a template or a style/ folder: its manifest, its brief and its parameter files, checked together. */
export function readStyleFolder(dir: string): StyleFolder {
  const problems: StyleProblem[] = [];
  const manifestPath = join(dir, STYLE_MANIFEST);
  const template = existsSync(manifestPath) ? parseJson(readFileSync(manifestPath, "utf-8"), STYLE_MANIFEST, problems) : undefined;
  if (template === undefined && problems.length === 0) problems.push({ code: "missing", path: STYLE_MANIFEST, message: `${STYLE_MANIFEST} is not there` });
  const briefPath = join(dir, STYLE_BRIEF);
  const brief = existsSync(briefPath) ? readFileSync(briefPath, "utf-8") : null;
  const params: Record<string, unknown> = {};
  const paramsDir = join(dir, STYLE_PARAMS_DIR);
  if (isDir(paramsDir)) {
    for (const name of readdirSync(paramsDir).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort()) {
      const doc = parseJson(readFileSync(join(paramsDir, name), "utf-8"), `${STYLE_PARAMS_DIR}/${name}`, problems);
      if (doc !== undefined) params[name.slice(0, -".json".length)] = doc;
    }
  }
  if (template !== undefined) problems.push(...checkStyle({ template, brief, params }));
  const usable = template && typeof template === "object" && !Array.isArray(template) ? (template as StyleTemplate) : null;
  return { dir, template: usable, brief, params: params as Record<string, StyleParams>, problems };
}

const toPosix = (p: string): string => p.split(sep).join("/");

/** Every file of a folder, but hidden ones, by POSIX path. */
export function folderFiles(dir: string): string[] {
  const out: string[] = [];
  const visit = (abs: string): void => {
    for (const name of readdirSync(abs).sort()) {
      if (name.startsWith(".")) continue;
      const path = join(abs, name);
      if (isDir(path)) visit(path);
      else out.push(toPosix(relative(dir, path)));
    }
  };
  if (isDir(dir)) visit(dir);
  return out.sort();
}

/** One hash for a folder's files and their contents: what a template was when it was applied. */
export function folderHash(dir: string, skip: (path: string) => boolean = () => false): string {
  const outer = createHash("sha256");
  for (const path of folderFiles(dir)) {
    if (skip(path)) continue;
    const inner = createHash("sha256").update(readFileSync(join(dir, path))).digest("hex");
    outer.update(`${path}\0${inner}\n`);
  }
  return `sha256:${outer.digest("hex")}`;
}

function summarize(folder: StyleFolder, origin: StyleOrigin, id: string): StyleSummary {
  const t = folder.template;
  return {
    id: t?.id ?? id,
    version: t?.version ?? "0.0.0",
    title: t?.title ?? id,
    summary: t?.summary ?? "",
    tags: t?.tags ?? [],
    levels: t?.levels ?? ["channel", "series", "film", "scene"],
    origin,
    path: folder.dir,
    swatches: swatchesOf(folder.params, t?.parameters),
    scaffold: t?.scaffold ?? {},
    problems: folder.problems,
    shadows: [],
  };
}

/** Every template a project can use, nearest wins; with problems shown, never hidden. */
export function listStyles(root: string, options: { project?: string } = {}): StyleSummary[] {
  const byId = new Map<string, StyleSummary>();
  for (const { origin, dir } of styleRoots(root, options.project)) {
    if (!isDir(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".") || name.startsWith("_") || !isDir(join(dir, name))) continue;
      const summary = summarize(readStyleFolder(join(dir, name)), origin, name);
      if (summary.id !== name) {
        summary.problems.push({ code: "id-mismatch", path: STYLE_MANIFEST, message: `the folder is "${name}" and style.json says "${summary.id}"` });
        summary.id = name;
      }
      const nearer = byId.get(name);
      if (nearer) nearer.shadows.push(origin);
      else byId.set(name, summary);
    }
  }
  return [...byId.values()].sort((a, b) => a.title.localeCompare(b.title));
}

const fold = (text: string): string =>
  text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * The template a name means: its id, its title, or the only one whose id or
 * title contains it. Refuses, naming the candidates, when it means none or
 * more than one.
 */
export function findStyle(root: string, name: string, options: { project?: string } = {}): StyleSummary {
  const all = listStyles(root, options);
  const wanted = fold(name);
  if (!wanted) throw new StyleError("a style is named by its id or its title", "bad-input");
  const exact = all.find((s) => s.id === wanted) ?? all.find((s) => fold(s.title) === wanted);
  if (exact) return exact;
  const partial = all.filter((s) => s.id.includes(wanted) || fold(s.title).includes(wanted) || s.tags.includes(wanted));
  if (partial.length === 1) return partial[0]!;
  const names = (list: StyleSummary[]) => list.map((s) => `${s.id} ("${s.title}", ${s.origin})`).join(", ");
  if (partial.length > 1) throw new StyleError(`"${name}" could be any of ${names(partial)}: name one`, "ambiguous-style");
  throw new StyleError(`there is no style "${name}". There are: ${names(all) || "none"}`, "no-style");
}

/** A template in full: its manifest, brief and parameter files. */
export function readStyle(root: string, name: string, options: { project?: string } = {}): StyleSummary & { folder: StyleFolder } {
  const summary = findStyle(root, name, options);
  return { ...summary, folder: readStyleFolder(summary.path) };
}

export { assertSlug };
