// Type declarations for style templates and their parameter files (ADR-0054).

export interface StyleProblem {
  code: string;
  path: string;
  message: string;
}

export type StyleLevel = "channel" | "series" | "film" | "scene";
export type StyleFieldType = "text" | "number" | "enum" | "boolean" | "color" | "font";
export type StyleOrigin = "builtin" | "library" | "project";
export type ShotSourceSuggestion = "footage" | "stock" | "generated" | "animation" | "graphics" | "screen" | "mixed";

export interface StyleScaffold {
  filmFormat?: string;
  shotSource?: ShotSourceSuggestion;
  skills?: string[];
  durationSeconds?: { min: number; max: number };
}

export interface StyleTemplate {
  apiVersion: "studio.video/v1alpha1";
  kind: "StyleTemplate";
  id: string;
  version: string;
  title: string;
  summary: string;
  tags?: string[];
  levels?: StyleLevel[];
  parameters: string[];
  scaffold?: StyleScaffold;
  credits?: string;
}

export interface PaletteColor {
  id: string;
  name: string;
  value: string;
  role?: string;
}

export interface PaletteParams {
  kind: "palette";
  title: string;
  description?: string;
  min?: number;
  max?: number;
  colors: PaletteColor[];
}

export interface ParamField {
  id: string;
  label: string;
  description?: string;
  type: StyleFieldType;
  value: string | number | boolean;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  multiline?: boolean;
}

export interface ValuesParams {
  kind: "values";
  title: string;
  description?: string;
  fields: ParamField[];
}

export type StyleParams = PaletteParams | ValuesParams;

export interface StyleBinding {
  apiVersion: "studio.video/v1alpha1";
  kind: "StyleBinding";
  template: { id: string; version: string; origin: StyleOrigin; hash: string };
  appliedAt: string;
  copiedFrom?: string;
  note?: string;
}

export interface UnitContext {
  title?: string;
  idea?: string;
  level?: string;
}

export const STYLE_API_VERSION: "studio.video/v1alpha1";
export const STYLE_DIR: "style";
export const STYLE_MANIFEST: "style.json";
export const STYLE_BRIEF: "STYLE.md";
export const STYLE_BINDING: "style.yaml";
export const STYLE_PARAMS_DIR: "params";
export const LIBRARY_STYLES_DIR: "_styles";
export const PROJECT_STYLES_DIR: "styles";
export const STYLE_PIN_ID: "style";
export const STYLE_LEVELS: readonly StyleLevel[];
export const STYLE_FIELD_TYPES: readonly StyleFieldType[];
export const STYLE_ORIGINS: readonly StyleOrigin[];
export const UNIT_PLACEHOLDERS: Readonly<Record<"title" | "idea" | "level", string>>;

export function paramFile(id: string): string;
export function validateStyleTemplate(doc: unknown): StyleProblem[];
export function validateStyleBinding(doc: unknown): StyleProblem[];
export function validateStyleParams(doc: unknown): StyleProblem[];
export function fieldValueProblem(field: ParamField, value: unknown): string | null;
export function placeholdersOf(text: string): { path: string; raw: string; index: number; line: number }[];
export function formatFieldValue(field: ParamField): string;
export function formatParams(doc: StyleParams): string;
export function resolvePlaceholder(
  path: string,
  params: Record<string, StyleParams>,
  unit?: UnitContext,
): { value: string } | { problem: { code: string; message: string } };
export function renderBrief(text: string, params: Record<string, StyleParams>, unit?: UnitContext): { text: string; problems: StyleProblem[] };
export function checkStyle(folder: { template: unknown; brief: string | null; params: Record<string, unknown>; binding?: unknown }): StyleProblem[];
export function swatchesOf(params: Record<string, StyleParams>, parameters?: string[]): { name: string; value: string }[];
export function setParamValue(doc: StyleParams, entry: string, value: unknown): { doc: StyleParams; problems: StyleProblem[] };
