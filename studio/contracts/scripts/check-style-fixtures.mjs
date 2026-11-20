#!/usr/bin/env node

/**
 * Validate the style fixtures (ADR-0054): every valid template, parameter file
 * and binding is accepted, every invalid one refused with the code it names.
 * Each document is also read by ajv from the same schema, so the browser-safe
 * reader (src/schema-lite.mjs) cannot drift from the standard.
 * Usage: node scripts/check-style-fixtures.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { validateStyleBinding, validateStyleParams, validateStyleTemplate } from "../src/style.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => JSON.parse(readFileSync(resolve(root, rel), "utf-8"));

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const schema = read("schemas/v1alpha1/style.schema.json");
ajv.addSchema(schema);
const shapeOf = (def) => ajv.getSchema(`${schema.$id}#/$defs/${def}`);

/** Codes only the schema can give: when one is expected, ajv must refuse the document too. */
const SCHEMA_CODES = new Set([
  "required", "const", "enum", "type", "pattern", "minimum", "maximum", "minItems", "maxItems", "uniqueItems",
  "minLength", "maxLength", "additionalProperties", "format", "oneOf",
]);

let failures = 0;
let checked = 0;
const fail = (message) => {
  failures += 1;
  console.error(`FAIL ${message}`);
};

const valid = read("fixtures/style/valid.json");
const invalid = read("fixtures/style/invalid.json");
for (const [group, def, validate] of [
  ["templates", "StyleTemplate", validateStyleTemplate],
  ["params", "StyleParams", validateStyleParams],
  ["bindings", "StyleBinding", validateStyleBinding],
]) {
  const shape = shapeOf(def);
  valid[group].forEach((doc, i) => {
    checked += 1;
    const problems = validate(doc);
    if (problems.length > 0) fail(`valid ${def} ${i}: ${problems.map((p) => `${p.path} ${p.message}`).join("; ")}`);
    if (!shape(doc)) fail(`valid ${def} ${i}: ajv refuses it: ${ajv.errorsText(shape.errors)}`);
  });
  for (const entry of invalid[group]) {
    checked += 1;
    const problems = validate(entry.doc);
    if (!problems.some((p) => p.code === entry.code)) {
      fail(`invalid ${def} "${entry.name}": expected ${entry.code}, got ${problems.map((p) => p.code).join(", ") || "nothing"}`);
    }
    const ajvAccepts = shape(entry.doc) === true;
    // The parameter files' kind is told apart before the schema is read, so "kind" is the reader's and the schema's alike.
    if ((SCHEMA_CODES.has(entry.code) || entry.code === "kind") && ajvAccepts) fail(`invalid ${def} "${entry.name}": the reader refuses it (${entry.code}) and ajv accepts it`);
    if (!SCHEMA_CODES.has(entry.code) && entry.code !== "kind" && !ajvAccepts) fail(`invalid ${def} "${entry.name}": meant to break a rule beyond the schema, and ajv refuses its shape: ${ajv.errorsText(shape.errors)}`);
  }
}

if (failures) {
  console.error(`\n${failures} style check(s) failed`);
  process.exitCode = 1;
} else {
  console.log(`${checked} style fixtures passed`);
}
