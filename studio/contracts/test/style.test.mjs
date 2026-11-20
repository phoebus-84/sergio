// The style contract beyond its fixtures: how a brief is rendered from its
// parameter files, and what checking a whole template finds (ADR-0054).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  checkStyle, formatParams, paramFile, placeholdersOf, renderBrief, setParamValue, swatchesOf, validateStyleParams,
} from "../src/style.mjs";

const valid = JSON.parse(readFileSync(new URL("../fixtures/style/valid.json", import.meta.url), "utf-8"));
const [template] = valid.templates;
const [palette, print] = valid.params;
const params = { palette, print };

test("a brief reads its values from the parameter files, never inline", () => {
  const { text, problems } = renderBrief(
    "Print in {{palette}}. Key line {{palette.ink}} ({{palette.ink.name}}), one {{palette.accent.role}}. " +
      "Misregistration {{print.misregistration}}, on {{print.timing}}. Text: {{print.text}}. About: {{unit.idea}}.",
    params,
    { idea: "a storm at sea", level: "film" },
  );
  assert.deepEqual(problems, []);
  assert.equal(
    text,
    "Print in Indigo (#2b2f6b), Cream (#f3ead7), Red (#C8322B). Key line #2b2f6b (Indigo), one the one accent. " +
      "Misregistration 2 px, on twos. Text: no. About: a storm at sea.",
  );
});

test("a placeholder that names nothing stays in the text and is located", () => {
  const { text, problems } = renderBrief("ok\n{{palette.sky}} and {{nope}} and {{print.timing.colour}} and {{unit.size}}", params);
  assert.match(text, /\{\{palette\.sky\}\}/);
  assert.deepEqual(problems.map((p) => p.code), ["unknown-entry", "unknown-param", "unknown-attribute", "unknown-unit"]);
  assert.ok(problems.every((p) => p.path === "STYLE.md:2"));
});

test("an unknown unit value reads as a bracketed gap, not as nothing", () => {
  assert.equal(renderBrief("{{unit.title}}", {}, { level: "scene" }).text, "[the title of this scene]");
});

test("placeholders are found with their lines", () => {
  assert.deepEqual(placeholdersOf("a\n{{ palette }}\n{{print.timing}}").map((p) => [p.path, p.line]), [["palette", 2], ["print.timing", 3]]);
});

test("checking a template finds a missing file, an undeclared one and a broken placeholder", () => {
  assert.deepEqual(checkStyle({ template, brief: "{{palette}} {{print.timing}}", params }), []);
  const problems = checkStyle({ template, brief: "{{palette.sky}}", params: { palette, extra: print } });
  assert.deepEqual(problems.map((p) => p.code).sort(), ["missing-param", "undeclared-param", "unknown-entry"]);
  assert.equal(problems.find((p) => p.code === "missing-param").path, paramFile("print"));
  assert.equal(checkStyle({ template, brief: "", params }).at(-1).code, "missing-brief");
});

test("changing a value is checked, and leaves the file it was given alone", () => {
  const changed = setParamValue(palette, "ink", "#000000");
  assert.deepEqual(changed.problems, []);
  assert.equal(changed.doc.colors[0].value, "#000000");
  assert.equal(palette.colors[0].value, "#2b2f6b");
  assert.equal(setParamValue(print, "timing", "fours").problems[0].code, "value");
  assert.equal(setParamValue(print, "timing", "fours").doc, print);
  assert.equal(setParamValue(print, "nope", 1).problems[0].code, "unknown-entry");
  assert.deepEqual(validateStyleParams(setParamValue(print, "misregistration", 4).doc), []);
});

test("a template's swatches are its first palette", () => {
  assert.deepEqual(swatchesOf(params, ["print", "palette"]).map((s) => s.value), ["#2b2f6b", "#f3ead7", "#C8322B"]);
  assert.match(formatParams(print), /^Misregistration: 2 px; Animate on: twos;/);
});
