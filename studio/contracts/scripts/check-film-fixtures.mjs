#!/usr/bin/env node

/**
 * Validate the film, scene and shot fixtures and the cut-timeline fixtures:
 * every valid one is accepted, every invalid one refused with the code it
 * names. Each document is also read by ajv from the same schema, so the
 * browser-safe reader (src/schema-lite.mjs) cannot drift from the standard.
 * Usage: node scripts/check-film-fixtures.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { validateFilm, validateScene, validateShot } from "../src/film.mjs";
import { validateCutTimeline, hasCutErrors } from "../src/cut-timeline.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => JSON.parse(readFileSync(resolve(root, rel), "utf-8"));

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const filmSchema = read("schemas/v1alpha1/film.schema.json");
const cutSchema = read("schemas/v1alpha1/cut-timeline.schema.json");
ajv.addSchema(filmSchema);
ajv.addSchema(cutSchema);
const shapeOf = (schema, def) => ajv.getSchema(`${schema.$id}#/$defs/${def}`);

/** Codes only the schema can give: when one is expected, ajv must refuse the document too. */
const SCHEMA_CODES = new Set([
  "required", "const", "enum", "type", "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  "multipleOf", "minItems", "maxItems", "uniqueItems", "minLength", "maxLength", "additionalProperties", "format", "anyOf", "oneOf",
]);

let failures = 0;
let checked = 0;
const fail = (message) => {
  failures += 1;
  console.error(`FAIL ${message}`);
};

function checkValid(label, doc, validate, shape) {
  checked += 1;
  const problems = validate(doc).filter((p) => p.severity !== "warning");
  if (problems.length > 0) fail(`${label}: ${problems.map((p) => `${p.path} ${p.message}`).join("; ")}`);
  if (!shape(doc)) fail(`${label}: ajv refuses it: ${ajv.errorsText(shape.errors)}`);
}

function checkInvalid(label, entry, validate, shape) {
  checked += 1;
  const problems = validate(entry.doc);
  if (!problems.some((p) => p.code === entry.code)) {
    fail(`${label} "${entry.name}": expected ${entry.code}, got ${problems.map((p) => p.code).join(", ") || "nothing"}`);
  }
  const ajvAccepts = shape(entry.doc) === true;
  if (SCHEMA_CODES.has(entry.code) && ajvAccepts) fail(`${label} "${entry.name}": the schema reader refuses it (${entry.code}) and ajv accepts it`);
  if (!SCHEMA_CODES.has(entry.code) && !ajvAccepts) fail(`${label} "${entry.name}": meant to break a rule beyond the schema, and ajv refuses its shape: ${ajv.errorsText(shape.errors)}`);
}

const film = { valid: read("fixtures/film/valid.json"), invalid: read("fixtures/film/invalid.json") };
for (const [group, def, validate] of [["films", "Film", validateFilm], ["scenes", "Scene", validateScene], ["shots", "Shot", validateShot]]) {
  const shape = shapeOf(filmSchema, def);
  film.valid[group].forEach((doc, i) => checkValid(`valid ${def} ${i}`, doc, validate, shape));
  film.invalid[group].forEach((entry) => checkInvalid(`invalid ${def}`, entry, validate, shape));
}

const cutShape = shapeOf(cutSchema, "CutTimeline");
read("fixtures/cut-timeline/valid.json").forEach((doc, i) => checkValid(`valid cut ${i}`, doc, validateCutTimeline, cutShape));
for (const entry of read("fixtures/cut-timeline/invalid.json")) {
  checkInvalid("invalid cut", entry, validateCutTimeline, cutShape);
  if (!hasCutErrors(validateCutTimeline(entry.doc))) fail(`invalid cut "${entry.name}" has no error`);
}

if (failures) {
  console.error(`\n${failures} film check(s) failed`);
  process.exitCode = 1;
} else {
  console.log(`${checked} film, scene, shot and cut fixtures passed`);
}
