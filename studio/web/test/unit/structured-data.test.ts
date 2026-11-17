import { expect, test, vi } from "vitest";
import {
  appendItem, blankLike, dataFormatOf, moveItem, parseData, removeField, setField, summarize, tableColumns,
} from "$lib/structured-data";

/* The registry imports the viewers, and one of them reads the browser's storage as it loads. */
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
const { resolveViewer } = await import("$lib/viewer-registry");

test("a file's format is read from its name, and a .jsonl log is neither", () => {
  expect(dataFormatOf("artifacts/cut.json")).toBe("json");
  expect(dataFormatOf("film.yaml")).toBe("yaml");
  expect(dataFormatOf("format.YML")).toBe("yaml");
  expect(dataFormatOf("journal/events.jsonl")).toBeNull();
  expect(dataFormatOf("notes.md", "text/markdown")).toBeNull();
  expect(dataFormatOf("state", "application/json")).toBe("json");
});

test("a text that does not parse says why and has no value", () => {
  const broken = parseData('{"a": 1,}', "json");
  expect(broken.value).toBeUndefined();
  expect(broken.error).toBeTruthy();
  expect(parseData("a: [1, 2", "yaml").error).toBeTruthy();
  expect(parseData("  \n", "json").error).toBe("the file is empty");
});

test("setting a JSON field changes that field and keeps the file's indentation", () => {
  const text = '{\n    "title": "The Lens",\n    "scenes": [{ "id": "s1", "seconds": 4 }]\n}\n';
  const next = setField(text, "json", ["scenes", 0, "seconds"], 6);
  expect(JSON.parse(next)).toEqual({ title: "The Lens", scenes: [{ id: "s1", seconds: 6 }] });
  expect(next).toContain('\n    "title"');
  expect(next.endsWith("}\n")).toBe(true);
});

test("setting a YAML field keeps the comments and the order of the keys", () => {
  const text = "# The film's plan\ntitle: The Long Shift   # working title\nformat:\n  fps: 24\n  width: 1280\n";
  const next = setField(text, "yaml", ["format", "fps"], 25);
  expect(next).toContain("# The film's plan");
  expect(next).toContain("# working title");
  expect(next.indexOf("fps")).toBeLessThan(next.indexOf("width"));
  expect(parseData(next, "yaml").value).toEqual({ title: "The Long Shift", format: { fps: 25, width: 1280 } });
});

test("a field and a list item are removed by their path", () => {
  expect(JSON.parse(removeField('{"a":1,"b":[1,2,3]}', "json", ["b", 1]))).toEqual({ a: 1, b: [1, 3] });
  expect(JSON.parse(removeField('{"a":1,"b":2}', "json", ["a"]))).toEqual({ b: 2 });
  expect(parseData(removeField("tags:\n  - night\n  - ward\nnote: x\n", "yaml", ["tags", 0]), "yaml").value).toEqual({ tags: ["ward"], note: "x" });
});

test("an item is added at the end of a list, in both formats", () => {
  expect(JSON.parse(appendItem('{"tags":["a"]}', "json", ["tags"], "b"))).toEqual({ tags: ["a", "b"] });
  const yaml = appendItem("shots:\n  - slug: wide\n    seconds: 3\n", "yaml", ["shots"], { slug: "", seconds: 0 });
  expect(parseData(yaml, "yaml").value).toEqual({ shots: [{ slug: "wide", seconds: 3 }, { slug: "", seconds: 0 }] });
});

test("an item is moved within its list, and a move that goes nowhere changes nothing", () => {
  expect(JSON.parse(moveItem('{"order":["a","b","c"]}', "json", ["order"], 2, 0))).toEqual({ order: ["c", "a", "b"] });
  const yaml = "order:\n  - a # first\n  - b\n";
  expect(parseData(moveItem(yaml, "yaml", ["order"], 0, 1), "yaml").value).toEqual({ order: ["b", "a"] });
  expect(moveItem(yaml, "yaml", ["order"], 0, 0)).toBe(yaml);
  expect(moveItem(yaml, "yaml", ["order"], 0, 5)).toBe(yaml);
});

test("a list of small records reads as a table; anything else does not", () => {
  expect(tableColumns([{ id: "a", seconds: 2 }, { id: "b", seconds: 3, note: "hold" }])).toEqual(["id", "seconds", "note"]);
  expect(tableColumns([{ id: "a" }])).toBeNull();
  expect(tableColumns([{ id: "a", inner: { x: 1 } }, { id: "b" }])).toBeNull();
  expect(tableColumns(["a", "b"])).toBeNull();
  expect(tableColumns([{ text: "x".repeat(200) }, { text: "y" }])).toBeNull();
});

test("an item is named by what it calls itself, and a new one is shaped like its neighbours", () => {
  expect(summarize({ id: "s1", title: "Car park" })).toBe("Car park");
  expect(summarize({ at: 0, duration: 24 })).toBe("2 fields");
  expect(summarize([1, 2, 3])).toBe("3 items");
  expect(blankLike({ slug: "wide", seconds: 3, locked: true, tags: ["a"], format: { fps: 24 } }))
    .toEqual({ slug: "", seconds: 0, locked: false, tags: [], format: { fps: 0 } });
});

test("text that is one JSON value is shown as fields; a log of lines stays text", () => {
  expect(resolveViewer("text", "application/json", "artifacts/cut.json")).toBe("data");
  expect(resolveViewer("text", "application/jsonl", "journal/events.jsonl")).toBe("text");
  expect(resolveViewer("text", null, "film.yaml")).toBe("yaml");
  expect(resolveViewer("markdown", "text/markdown", "brief.md")).toBe("markdown");
  // A piece of music is text with a player.
  expect(resolveViewer("text", "text/x-strudel", "music/theme.strudel")).toBe("strudel");
  // An artifact that asked for a viewer keeps it.
  expect(resolveViewer("download", "application/json", "data.json")).toBe("download");
});
