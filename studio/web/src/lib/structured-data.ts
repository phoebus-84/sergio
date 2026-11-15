/**
 * A JSON or YAML file as a value that can be changed one field at a time, and
 * written back as the text it came from.
 *
 * Most of what a production keeps is structured: a brief's facts, a shot's
 * plan, a cue sheet, a timeline. Read as text they are indentation and
 * quotes; read as a value they are fields with names. This is the bridge: the
 * file is parsed, a field is set by its path, and the text that results
 * differs from the original only where the field is — for YAML, comments and
 * the order of keys survive, because the change is made to the document and
 * not to a copy of its data.
 */

import { Document, parseDocument, isMap, isSeq } from "yaml";

export type DataFormat = "json" | "yaml";
export type DataPath = readonly (string | number)[];
export type Scalar = string | number | boolean | null;

export interface ParsedData {
  format: DataFormat;
  /** The file's value, or undefined when it does not parse. */
  value: unknown;
  /** Why it does not parse, with the line when the parser gives one. */
  error: string | null;
}

/** What format a path's extension names, or null when it is neither. */
export function dataFormatOf(path: string | null | undefined, contentType?: string | null): DataFormat | null {
  const extension = path?.toLowerCase().split(".").pop() ?? "";
  if (extension === "json") return "json";
  if (extension === "yaml" || extension === "yml") return "yaml";
  const type = contentType?.toLowerCase() ?? "";
  if (type.includes("json") && !type.includes("jsonl")) return "json";
  if (type.includes("yaml")) return "yaml";
  return null;
}

export function parseData(text: string, format: DataFormat): ParsedData {
  if (text.trim() === "") return { format, value: undefined, error: "the file is empty" };
  try {
    if (format === "json") return { format, value: JSON.parse(text) as unknown, error: null };
    const document = parseDocument(text);
    const problem = document.errors[0];
    if (problem) return { format, value: undefined, error: problem.message };
    return { format, value: document.toJS() as unknown, error: null };
  } catch (error) {
    return { format, value: undefined, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The indentation a JSON text was written with: what it is written back with. */
function jsonIndent(text: string): number | string {
  const match = /\n([ \t]+)\S/.exec(text);
  if (!match) return text.includes("\n") ? 2 : 0;
  return match[1]!.includes("\t") ? "\t" : match[1]!.length;
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function setIn(root: unknown, path: DataPath, value: unknown): unknown {
  if (path.length === 0) return value;
  const copy = clone(root) as Record<string | number, unknown>;
  let at = copy;
  for (const key of path.slice(0, -1)) at = at[key] as Record<string | number, unknown>;
  at[path[path.length - 1]!] = value;
  return copy;
}

function removeIn(root: unknown, path: DataPath): unknown {
  const copy = clone(root) as Record<string | number, unknown>;
  let at = copy;
  for (const key of path.slice(0, -1)) at = at[key] as Record<string | number, unknown>;
  const last = path[path.length - 1]!;
  if (Array.isArray(at)) at.splice(Number(last), 1);
  else delete at[last];
  return copy;
}

function write(text: string, format: DataFormat, change: (document: Document) => void, plain: (value: unknown) => unknown): string {
  if (format === "json") {
    const next = plain(JSON.parse(text));
    return `${JSON.stringify(next, null, jsonIndent(text))}${text.endsWith("\n") ? "\n" : ""}`;
  }
  const document = parseDocument(text);
  change(document);
  return document.toString();
}

/** The text with one field set. The rest of the file is as it was. */
export function setField(text: string, format: DataFormat, path: DataPath, value: unknown): string {
  return write(text, format, (document) => document.setIn(path as unknown[], value), (root) => setIn(root, path, value));
}

/** The text without one field, or without one item of a list. */
export function removeField(text: string, format: DataFormat, path: DataPath): string {
  return write(text, format, (document) => void document.deleteIn(path as unknown[]), (root) => removeIn(root, path));
}

/** The text with an item added at the end of the list at `path`. */
export function appendItem(text: string, format: DataFormat, path: DataPath, item: unknown): string {
  return write(
    text,
    format,
    (document) => {
      const list = document.getIn(path as unknown[]);
      if (isSeq(list)) list.add(document.createNode(item));
      else if (!isMap(list)) document.setIn(path as unknown[], [item]);
    },
    (root) => {
      const copy = clone(root) as Record<string | number, unknown>;
      let at: unknown = copy;
      for (const key of path) at = (at as Record<string | number, unknown>)[key];
      if (Array.isArray(at)) at.push(item);
      return copy;
    },
  );
}

/** The text with the list at `path` reordered: the item at `from` moved to `to`. */
export function moveItem(text: string, format: DataFormat, path: DataPath, from: number, to: number): string {
  const parsed = parseData(text, format);
  let list: unknown = parsed.value;
  for (const key of path) list = (list as Record<string | number, unknown> | undefined)?.[key];
  if (!Array.isArray(list) || from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return text;
  if (format === "yaml") {
    const document = parseDocument(text);
    const node = document.getIn(path as unknown[]);
    if (!isSeq(node)) return text;
    const [item] = node.items.splice(from, 1);
    node.items.splice(to, 0, item!);
    return document.toString();
  }
  const next = [...(list as unknown[])];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return setField(text, format, path, next);
}

// ── Reading a value's shape, to choose how to draw it ────────────────────

export function isScalar(value: unknown): value is Scalar {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The columns of a list that reads as a table: every item a record of plain
 * values, and few enough keys between them to fit across. Null when the list
 * is better read item by item.
 */
export function tableColumns(list: readonly unknown[], limit = 7): string[] | null {
  if (list.length < 2) return null;
  const columns: string[] = [];
  for (const item of list) {
    if (!isRecord(item)) return null;
    for (const [key, value] of Object.entries(item)) {
      if (!isScalar(value)) return null;
      if (typeof value === "string" && (value.length > 120 || value.includes("\n"))) return null;
      if (!columns.includes(key)) columns.push(key);
    }
  }
  return columns.length > 0 && columns.length <= limit ? columns : null;
}

/** A few words that name an item of a list: what it calls itself, or what it holds. */
export function summarize(value: unknown): string {
  if (isScalar(value)) return String(value);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (isRecord(value)) {
    for (const key of ["title", "name", "label", "id", "slug", "key", "type", "kind", "heading", "text"]) {
      const named = value[key];
      if (typeof named === "string" && named.trim()) return named.length > 60 ? `${named.slice(0, 57)}…` : named;
      if (typeof named === "number") return String(named);
    }
    const count = Object.keys(value).length;
    return `${count} field${count === 1 ? "" : "s"}`;
  }
  return "";
}

/** A new item shaped like its neighbours: the same fields, emptied. */
export function blankLike(sample: unknown): unknown {
  if (typeof sample === "string") return "";
  if (typeof sample === "number") return 0;
  if (typeof sample === "boolean") return false;
  if (Array.isArray(sample)) return [];
  if (isRecord(sample)) return Object.fromEntries(Object.entries(sample).map(([key, value]) => [key, blankLike(value)]));
  return "";
}

/** How many fields and items a value has in all: whether opening every branch at once would bury the reader. */
export function weigh(value: unknown, cap = 400): number {
  let count = 0;
  const walk = (node: unknown): void => {
    if (count > cap) return;
    count += 1;
    if (Array.isArray(node)) node.forEach(walk);
    else if (isRecord(node)) Object.values(node).forEach(walk);
  };
  walk(value);
  return count;
}
