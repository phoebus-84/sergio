#!/usr/bin/env node

/**
 * Validate music-render fixtures: every record in fixtures/music-render/valid.json is
 * accepted, every one in invalid.json refused.
 * Usage: node scripts/check-music-render-fixtures.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { validateMusicRender } from "../src/music-renders.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => JSON.parse(readFileSync(resolve(root, rel), "utf-8"));
const valid = read("fixtures/music-render/valid.json");
const invalid = read("fixtures/music-render/invalid.json");
let failures = 0;

valid.forEach((record, i) => {
  const problems = validateMusicRender(record);
  if (problems.length > 0) {
    failures += 1;
    console.error(`FAIL valid record ${i}:`, problems.map((p) => `${p.path} ${p.message}`).join("; "));
  }
});
invalid.forEach((record, i) => {
  if (validateMusicRender(record).length === 0) {
    failures += 1;
    console.error(`FAIL invalid record ${i} was accepted`);
  }
});

if (failures) {
  console.error(`\n${failures} music-render check(s) failed`);
  process.exitCode = 1;
} else {
  console.log(`${valid.length} valid and ${invalid.length} invalid music-render fixtures passed`);
}
