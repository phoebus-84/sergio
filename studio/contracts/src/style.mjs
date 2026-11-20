// ---------------------------------------------------------------------------
// Style templates (ADR-0054)
// ---------------------------------------------------------------------------
// A style template is an optional, ready-made road: a look and a way of
// making things in it, which a channel, a series, a film or a scene may take
// — and nothing has to. It is a folder:
//
//   <template>/
//     style.json            StyleTemplate: identity, its parameter files, what it suggests
//     STYLE.md              the brief, written with {{placeholders}}
//     params/<id>.json      one file per parameter set: a palette, or named values
//
// The brief never writes a value inline. "Print it in {{palette}}" reads the
// colours from params/palette.json, so changing a colour is changing a file,
// and everything that read the style before sees it changed (the style pin,
// ADR-0035's mechanism, makes the stages that read it stale).
//
// Applied to a level, the template is copied into that level's style/ folder
// with a style.yaml (StyleBinding) recording where it came from. The copy is
// the level's own: editing it never touches the template.
//
// This module is pure and reads no file: the browser imports it to check a
// parameter file and to preview the brief while a person edits.
// ---------------------------------------------------------------------------

import schema from "../schemas/v1alpha1/style.schema.json" with { type: "json" };
import { check } from "./schema-lite.mjs";

export const STYLE_API_VERSION = "studio.video/v1alpha1";

/** A level's applied style, in its directory. */
export const STYLE_DIR = "style";
/** A template's manifest. */
export const STYLE_MANIFEST = "style.json";
/** A template's brief. */
export const STYLE_BRIEF = "STYLE.md";
/** What a level's style/ adds to a template's files: where it came from. */
export const STYLE_BINDING = "style.yaml";
/** Where a template keeps its parameter files. */
export const STYLE_PARAMS_DIR = "params";
/** Templates of the whole library, at its root (underscored: not a channel). */
export const LIBRARY_STYLES_DIR = "_styles";
/** Templates a channel or a film carries, in its folder. */
export const PROJECT_STYLES_DIR = "styles";
/** The id of the pin a unit keeps on the style it reads. */
export const STYLE_PIN_ID = "style";

export const STYLE_LEVELS = Object.freeze([...schema.$defs.Level.enum]);
export const STYLE_FIELD_TYPES = Object.freeze([...schema.$defs.ParamField.properties.type.enum]);
export const STYLE_ORIGINS = Object.freeze([...schema.$defs.TemplatePin.properties.origin.enum]);

/** The placeholders every brief may use beside its parameters: the unit it is read for. */
export const UNIT_PLACEHOLDERS = Object.freeze({
  title: "The title of the film, scene, series or episode the brief is read for",
  idea: "What it is about: a logline, a summary, a description — whatever the unit says of itself",
  level: "Which level it is: channel, series, episode, film, scene or shot",
});

/** The path of a parameter file inside a template or a style/ folder. */
export const paramFile = (id) => `${STYLE_PARAMS_DIR}/${id}.json`;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const validate = (def, what, doc) => {
  if (!isObject(doc)) return [{ code: "type", path: "$", message: `a ${what} must be a mapping` }];
  return check(schema, schema.$defs[def], doc);
};

function repeats(items, path, what) {
  const out = [];
  const seen = new Set();
  (Array.isArray(items) ? items : []).forEach((item, index) => {
    const id = item?.id;
    if (typeof id !== "string") return;
    if (seen.has(id)) out.push({ code: "duplicate", path: `${path}[${index}].id`, message: `${what} "${id}" is there twice` });
    seen.add(id);
  });
  return out;
}

/** Problems of a template's style.json; none when it holds. */
export function validateStyleTemplate(doc) {
  return validate("StyleTemplate", "style template", doc);
}

/** Problems of a level's style.yaml; none when it holds. */
export function validateStyleBinding(doc) {
  return validate("StyleBinding", "style binding", doc);
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Why a field's value does not fit its declaration, or null. */
export function fieldValueProblem(field, value) {
  switch (field.type) {
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return "must be a number";
      if (typeof field.min === "number" && value < field.min) return `must be at least ${field.min}`;
      if (typeof field.max === "number" && value > field.max) return `must be at most ${field.max}`;
      return null;
    case "boolean":
      return typeof value === "boolean" ? null : "must be true or false";
    case "color":
      return typeof value === "string" && HEX.test(value) ? null : "must be a colour as #rrggbb";
    case "enum":
      if (!Array.isArray(field.options)) return "an enum field needs its options";
      return field.options.includes(value) ? null : `must be one of ${field.options.join(", ")}`;
    case "text":
    case "font":
      if (typeof value !== "string") return "must be text";
      if (field.type === "font" && value.trim() === "") return "must name a font family";
      return null;
    default:
      return `has no type "${field.type}"`;
  }
}

/**
 * Problems of a parameter file (a palette or a set of values); none when it
 * holds. Beyond its shape: an id used twice, a palette outside the number of
 * colours it declares, a value that does not fit its field.
 */
export function validateStyleParams(doc) {
  if (!isObject(doc)) return [{ code: "type", path: "$", message: "a parameter file must be a mapping" }];
  if (doc.kind === "palette") {
    const problems = validate("PaletteParams", "palette", doc);
    if (problems.length > 0) return problems;
    problems.push(...repeats(doc.colors, "$.colors", "colour"));
    if (typeof doc.min === "number" && typeof doc.max === "number" && doc.min > doc.max) {
      problems.push({ code: "range", path: "$.min", message: `min (${doc.min}) is more than max (${doc.max})` });
    }
    if (typeof doc.min === "number" && doc.colors.length < doc.min) {
      problems.push({ code: "too-few", path: "$.colors", message: `the palette holds at least ${doc.min} colours, it has ${doc.colors.length}` });
    }
    if (typeof doc.max === "number" && doc.colors.length > doc.max) {
      problems.push({ code: "too-many", path: "$.colors", message: `the palette holds at most ${doc.max} colours, it has ${doc.colors.length}` });
    }
    return problems;
  }
  if (doc.kind === "values") {
    const problems = validate("ValuesParams", "set of values", doc);
    if (problems.length > 0) return problems;
    problems.push(...repeats(doc.fields, "$.fields", "field"));
    doc.fields.forEach((field, index) => {
      const problem = fieldValueProblem(field, field.value);
      if (problem) problems.push({ code: "value", path: `$.fields[${index}].value`, message: `${field.label} ${problem}` });
      if (field.type === "number" && typeof field.min === "number" && typeof field.max === "number" && field.min > field.max) {
        problems.push({ code: "range", path: `$.fields[${index}].min`, message: `${field.label}: min is more than max` });
      }
    });
    return problems;
  }
  return [{ code: "kind", path: "$.kind", message: `a parameter file is a "palette" or a set of "values", not ${JSON.stringify(doc.kind)}` }];
}

// ── Placeholders ────────────────────────────────────────────────────────────

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
const PATH = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){0,2}$/;

/** Every {{placeholder}} of a text, with the line it is on (1-based). */
export function placeholdersOf(text) {
  const out = [];
  for (const match of String(text ?? "").matchAll(PLACEHOLDER)) {
    const line = String(text).slice(0, match.index).split("\n").length;
    out.push({ path: match[1], raw: match[0], index: match.index, line });
  }
  return out;
}

const COLOR_ATTRIBUTES = ["value", "name", "role"];
const FIELD_ATTRIBUTES = ["value", "label"];

/** A field's value as a sentence reads it. */
export function formatFieldValue(field) {
  const { value } = field;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return field.unit ? `${value} ${field.unit}` : String(value);
  return String(value);
}

/** A whole parameter file as a brief reads it: "Prussian blue (#1f3b5c), …" or one line per field. */
export function formatParams(doc) {
  if (doc.kind === "palette") return doc.colors.map((c) => `${c.name} (${c.value})`).join(", ");
  return doc.fields.map((f) => `${f.label}: ${formatFieldValue(f)}`).join("; ");
}

/**
 * What one placeholder stands for, or the reason it stands for nothing.
 * @returns {{ value: string } | { problem: { code: string, message: string } }}
 */
export function resolvePlaceholder(path, params, unit = {}) {
  if (!PATH.test(path)) return { problem: { code: "placeholder", message: `{{${path}}} is not a placeholder: write {{param}}, {{param.entry}} or {{param.entry.attribute}}` } };
  const [head, entry, attribute] = path.split(".");
  if (head === "unit") {
    if (!entry || attribute || !Object.hasOwn(UNIT_PLACEHOLDERS, entry)) {
      return { problem: { code: "unknown-unit", message: `{{${path}}}: the unit offers ${Object.keys(UNIT_PLACEHOLDERS).map((k) => `unit.${k}`).join(", ")}` } };
    }
    const value = unit?.[entry];
    return { value: typeof value === "string" && value.trim() ? value.trim() : `[the ${entry} of this ${unit?.level ?? "unit"}]` };
  }
  const doc = params?.[head];
  if (!doc) return { problem: { code: "unknown-param", message: `{{${path}}}: there is no parameter file "${head}"` } };
  if (!entry) return { value: formatParams(doc) };
  if (doc.kind === "palette") {
    const color = doc.colors.find((c) => c.id === entry);
    if (!color) return { problem: { code: "unknown-entry", message: `{{${path}}}: the palette "${head}" has no colour "${entry}"` } };
    const which = attribute ?? "value";
    if (!COLOR_ATTRIBUTES.includes(which)) return { problem: { code: "unknown-attribute", message: `{{${path}}}: a colour offers ${COLOR_ATTRIBUTES.join(", ")}` } };
    return { value: String(color[which] ?? "") };
  }
  const field = doc.fields.find((f) => f.id === entry);
  if (!field) return { problem: { code: "unknown-entry", message: `{{${path}}}: "${head}" has no field "${entry}"` } };
  const which = attribute ?? "value";
  if (!FIELD_ATTRIBUTES.includes(which)) return { problem: { code: "unknown-attribute", message: `{{${path}}}: a field offers ${FIELD_ATTRIBUTES.join(", ")}` } };
  return { value: which === "label" ? field.label : formatFieldValue(field) };
}

/**
 * The brief with every placeholder replaced by its value. A placeholder that
 * resolves to nothing stays as written and is a problem, located by line:
 * the brief is never silently rendered with a hole in it.
 *
 * @param {string} text the brief, STYLE.md
 * @param {Record<string, object>} params parameter files by id
 * @param {{title?: string, idea?: string, level?: string}} [unit]
 */
export function renderBrief(text, params, unit = {}) {
  const problems = [];
  const rendered = String(text ?? "").replace(PLACEHOLDER, (raw, path, offset) => {
    const resolved = resolvePlaceholder(path, params, unit);
    if ("value" in resolved) return resolved.value;
    const line = String(text).slice(0, offset).split("\n").length;
    problems.push({ ...resolved.problem, path: `STYLE.md:${line}` });
    return raw;
  });
  return { text: rendered, problems };
}

/**
 * Problems of a whole template or style/ folder, read: its manifest, each
 * parameter file it declares (missing, or not holding), the brief's
 * placeholders, and parameter files it has but does not declare.
 *
 * @param {{ template: unknown, brief: string | null, params: Record<string, unknown>, binding?: unknown }} folder
 */
export function checkStyle({ template, brief, params, binding }) {
  const problems = validateStyleTemplate(template).map((p) => ({ ...p, path: `style.json${p.path.slice(1)}` }));
  if (binding !== undefined) problems.push(...validateStyleBinding(binding).map((p) => ({ ...p, path: `style.yaml${p.path.slice(1)}` })));
  const declared = Array.isArray(template?.parameters) ? template.parameters : [];
  const usable = {};
  for (const id of declared) {
    const doc = params?.[id];
    if (doc === undefined) {
      problems.push({ code: "missing-param", path: paramFile(id), message: `style.json declares "${id}" and ${paramFile(id)} is not there` });
      continue;
    }
    const found = validateStyleParams(doc);
    problems.push(...found.map((p) => ({ ...p, path: `${paramFile(id)}${p.path.slice(1)}` })));
    if (found.length === 0) usable[id] = doc;
  }
  for (const id of Object.keys(params ?? {})) {
    if (!declared.includes(id)) problems.push({ code: "undeclared-param", path: paramFile(id), message: `${paramFile(id)} is not among style.json's parameters: the brief cannot use it` });
  }
  if (typeof brief !== "string" || brief.trim() === "") {
    problems.push({ code: "missing-brief", path: STYLE_BRIEF, message: `${STYLE_BRIEF} is missing or empty` });
  } else {
    // Only placeholders that name a declared file are checked against it: a broken file is its own problem above.
    const known = Object.fromEntries(declared.filter((id) => usable[id]).map((id) => [id, usable[id]]));
    const { problems: unresolved } = renderBrief(brief, known, { level: "unit" });
    problems.push(...unresolved.filter((p) => !(p.code === "unknown-param" && declared.some((id) => p.message.includes(`no parameter file "${id}"`)))));
  }
  return problems;
}

/** The colours a template shows as its swatches: its first palette's. */
export function swatchesOf(params, parameters = Object.keys(params ?? {})) {
  for (const id of parameters) {
    const doc = params?.[id];
    if (doc?.kind === "palette" && Array.isArray(doc.colors)) return doc.colors.map((c) => ({ name: c.name, value: c.value }));
  }
  return [];
}

/**
 * A parameter file with one entry's value changed, checked; the input is not
 * modified. A palette's entry is a colour (its value, or `{name, value, role}`
 * to change more of it); a values file's entry is a field.
 *
 * @returns {{ doc: object, problems: {code: string, path: string, message: string}[] }}
 */
export function setParamValue(doc, entry, value) {
  const next = structuredClone(doc);
  if (next?.kind === "palette") {
    const color = next.colors.find((c) => c.id === entry);
    if (!color) return { doc, problems: [{ code: "unknown-entry", path: "$.colors", message: `the palette has no colour "${entry}"` }] };
    if (isObject(value)) Object.assign(color, value, { id: color.id });
    else color.value = typeof value === "string" ? value.toLowerCase() : value;
  } else if (next?.kind === "values") {
    const field = next.fields.find((f) => f.id === entry);
    if (!field) return { doc, problems: [{ code: "unknown-entry", path: "$.fields", message: `there is no field "${entry}"` }] };
    field.value = value;
  } else {
    return { doc, problems: [{ code: "kind", path: "$.kind", message: "not a parameter file" }] };
  }
  const problems = validateStyleParams(next);
  return problems.length > 0 ? { doc, problems } : { doc: next, problems: [] };
}
