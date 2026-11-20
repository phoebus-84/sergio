/**
 * Editing a level's style in the browser (ADR-0054): the requests to the
 * gateway, and the pure work of a draft — what changed, whether it holds, and
 * the brief as it would read — so a person sees the consequence before saving.
 *
 * The checks are the contract's own (`@studio/contracts/src/style.mjs`), the
 * same the gateway and the agent run: a value the studio accepts is one the
 * gateway will write.
 */

import {
  renderBrief, validateStyleParams,
  type PaletteParams, type StyleBinding, type StyleParams, type StyleProblem, type StyleScaffold, type StyleTemplate,
} from "@studio/contracts/src/style.mjs";
import { filmApi } from "./film-api";

export interface StyleSummary {
  id: string;
  version: string;
  title: string;
  summary: string;
  tags: string[];
  levels: string[];
  origin: "builtin" | "library" | "project";
  swatches: { name: string; value: string }[];
  scaffold: StyleScaffold;
  problems: StyleProblem[];
}

export interface StyleView {
  target: { project: string; series?: string };
  level: string;
  binding: StyleBinding | null;
  template: StyleTemplate | null;
  brief: string | null;
  params: Record<string, StyleParams>;
  rendered: string;
  problems: StyleProblem[];
  dependents: string[];
}

export interface LevelStyle {
  target: { project: string; series?: string };
  level: "channel" | "series" | "film" | "scene";
  own: StyleView | null;
  inherited: StyleView | null;
}

export interface Renewal {
  renewed: { unit: string; affected: string[] }[];
  failed: { unit: string; message: string }[];
}

const level = (project: string, series?: string | null) =>
  `/api/style/${encodeURIComponent(project)}/${encodeURIComponent(series && series !== "_" ? series : "_")}`;

export const styleApi = {
  list: (project?: string) => filmApi<StyleSummary[]>(`/api/styles${project ? `?project=${encodeURIComponent(project)}` : ""}`),
  read: (project: string, series?: string | null) => filmApi<LevelStyle>(level(project, series)),
  apply: (project: string, series: string | null | undefined, body: { style?: string; fromParent?: boolean; replace?: boolean; note?: string }) =>
    filmApi<{ template: { id: string; title: string }; units: { unit: string; outcome: string }[] }>(level(project, series), { method: "POST", body }),
  saveParams: (project: string, series: string | null | undefined, param: string, doc: StyleParams) =>
    filmApi<Renewal & { path: string }>(`${level(project, series)}/params/${encodeURIComponent(param)}`, { method: "PUT", body: { doc } }),
  saveBrief: (project: string, series: string | null | undefined, text: string) =>
    filmApi<Renewal & { path: string }>(`${level(project, series)}/brief`, { method: "PUT", body: { text } }),
  renew: (project: string, series: string | null | undefined) => filmApi<Renewal>(`${level(project, series)}/renew`, { method: "POST", body: {} }),
  keep: (body: { project: string; series?: string; id: string; title?: string; scope?: "library" | "project" }) =>
    filmApi<{ id: string; path: string; origin: string }>("/api/styles", { method: "POST", body }),
};

/** A draft of a style's parameter files, to edit without touching what was read. */
/** JSON round-trip, not structuredClone: what is read sits in reactive state, and a proxy cannot be cloned. */
export const draftOf = (params: Record<string, StyleParams>): Record<string, StyleParams> => JSON.parse(JSON.stringify(params));

/** The parameter files a draft changed, in the template's order. */
export function changedParams(original: Record<string, StyleParams>, draft: Record<string, StyleParams>, order: string[] = Object.keys(draft)): string[] {
  return order.filter((id) => draft[id] !== undefined && JSON.stringify(draft[id]) !== JSON.stringify(original[id]));
}

/** What does not hold in a draft, by parameter file. */
export function draftProblems(draft: Record<string, StyleParams>): Record<string, StyleProblem[]> {
  return Object.fromEntries(Object.entries(draft).map(([id, doc]) => [id, validateStyleParams(doc)]).filter(([, problems]) => (problems as StyleProblem[]).length > 0));
}

/** The brief as it would read with the draft's values, problems located. */
export function previewBrief(
  brief: string | null,
  draft: Record<string, StyleParams>,
  unit: { title?: string | undefined; idea?: string | undefined; level?: string | undefined } = {},
) {
  const known = Object.fromEntries(Object.entries(unit).filter(([, v]) => typeof v === "string")) as { title?: string; idea?: string; level?: string };
  return renderBrief(brief ?? "", draft, known);
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Black or white, whichever reads on a swatch of this colour. */
export function inkOn(hex: string): "#000000" | "#ffffff" {
  if (!HEX.test(hex)) return "#000000";
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const luminance = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  return luminance > 0.36 ? "#000000" : "#ffffff";
}

/** A colour id no other colour of the palette has. */
export function freshColorId(palette: PaletteParams): string {
  const taken = new Set(palette.colors.map((c) => c.id));
  for (let n = palette.colors.length + 1; ; n += 1) if (!taken.has(`color-${n}`)) return `color-${n}`;
}

/** A palette with one more colour, unless it is at its maximum. */
export function withColor(palette: PaletteParams, value = "#808080"): PaletteParams {
  if (typeof palette.max === "number" && palette.colors.length >= palette.max) return palette;
  const id = freshColorId(palette);
  return { ...palette, colors: [...palette.colors, { id, name: `Colour ${palette.colors.length + 1}`, value }] };
}

/** A palette without one colour, unless it is at its minimum. The brief may still name it: the check will say so. */
export function withoutColor(palette: PaletteParams, id: string): PaletteParams {
  if (typeof palette.min === "number" && palette.colors.length <= palette.min) return palette;
  return { ...palette, colors: palette.colors.filter((c) => c.id !== id) };
}

/** "3 units read this style: saving makes what they made from it stale." */
export function consequence(dependents: string[]): string {
  if (dependents.length === 0) return "Nothing reads this style yet: saving changes no work.";
  return `${dependents.length} unit${dependents.length === 1 ? "" : "s"} read${dependents.length === 1 ? "s" : ""} this style: saving makes what ${dependents.length === 1 ? "it" : "they"} made from it stale, down to the renders above.`;
}
