// The Retake benchmark is a specification before it is a harness. These keep
// the specification true: the subject program does what its facts say, and a
// task names no measure that is not defined.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const bench = join(root, "bench", "retake");
const tally = join(bench, "fixtures", "tally");
const { parse } = createRequire(join(root, "studio", "film", "package.json"))("yaml");

const facts = JSON.parse(readFileSync(join(tally, "facts.json"), "utf-8"));

for (const { run, stdout, exit } of facts.commands) {
  test(`tally: ${run}`, () => {
    const [command, ...args] = run.split(" ");
    assert.equal(command, "node");
    const result = spawnSync(process.execPath, args, { cwd: tally, encoding: "utf-8" });
    assert.equal(result.status, exit);
    assert.equal(result.stdout, stdout);
  });
}

test("tally reads standard input when no file is named", () => {
  const result = spawnSync(process.execPath, ["tally.mjs", "--top", "1"], { cwd: tally, encoding: "utf-8", input: "one two two" });
  assert.equal(result.stdout, "     2  two\n");
});

test("tally's README shows what tally prints", () => {
  const readme = readFileSync(join(tally, "README.md"), "utf-8");
  for (const { run, stdout, exit } of facts.commands) {
    if (exit !== 0 || !readme.includes(`$ ${run}\n`)) continue;
    assert.ok(readme.includes(`$ ${run}\n${stdout}`), `README shows another output for: ${run}`);
  }
});

const defined = new Set([...readFileSync(join(bench, "metrics.md"), "utf-8").matchAll(/^\| `([a-z_.]+)` \|/gm)].map((m) => m[1]));
defined.add("preference"); // defined in prose, under "Preference"

const tasks = readdirSync(join(bench, "tasks")).filter((name) => name.endsWith(".yaml")).sort();

test("every task is listed in the README", () => {
  const readme = readFileSync(join(bench, "README.md"), "utf-8");
  for (const name of tasks) assert.ok(readme.includes(`tasks/${name}`), `${name} is not in the README's table`);
});

for (const name of tasks) {
  test(`${name} names only measures that are defined, and facts that exist`, () => {
    const task = parse(readFileSync(join(bench, "tasks", name), "utf-8"));
    assert.match(name, new RegExp(`^0?${task.number}-${task.id}\\.yaml$`));
    const statements = new Set(facts.statements.map((s) => s.id));
    const named = [...task.measure.map((m) => (typeof m === "string" ? m : Object.keys(m)[0])), ...task.report.headline];
    for (const measure of named) assert.ok(defined.has(measure), `${measure} is not defined in metrics.md`);
    for (const m of task.measure) {
      for (const id of (typeof m === "object" && m["accuracy.coverage"]?.statements) || []) assert.ok(statements.has(id), `no statement "${id}" in facts.json`);
    }
    assert.ok(task.limits.spend_usd > 0 && task.limits.wall_clock_minutes > 0);
    assert.equal(typeof task.accepted_when, "string");
  });
}
