// The music skills hold only what was tried against the engine (ADR-0053).
// This keeps them so:
// - every ```strudel block in a strudel-* skill is a complete piece that
//   evaluates with nothing to report, and sounds;
// - every whole piece beside the forms skill is rendered from its first cycle
//   to its last, as its own first lines say to, and comes out as long as they
//   say, without a problem and under full scale.
// A block that stops working — a control a new Strudel renamed, a typo in an
// edit — fails here, not in a production. Without a Chrome to render with,
// only the skills' own bookkeeping is checked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILLS = join(root, "skills", "shared");
const built = existsSync(join(root, "packages", "strudel", "dist", "index.js"));
const strudel = built ? await import("@av/strudel") : null;
const chrome = (() => {
  try {
    return strudel ? strudel.findChrome() : null;
  } catch {
    return null;
  }
})();

/** The skills' documents: strudel-*.md, and the SKILL.md of a strudel-* directory. */
function documents() {
  return readdirSync(SKILLS, { withFileTypes: true })
    .filter((entry) => entry.name.startsWith("strudel-"))
    .flatMap((entry) => entry.isDirectory()
      ? [{ name: `${entry.name}/SKILL.md`, path: join(SKILLS, entry.name, "SKILL.md") }]
      : entry.name.endsWith(".md") ? [{ name: entry.name, path: join(SKILLS, entry.name) }] : [])
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** `// render: cycles 28, tail 4, loop = 60 s`, wherever it is in the first lines. */
function renderLine(code) {
  const line = code.split("\n").slice(0, 6).find((l) => /^\s*\/\/\s*render:/.test(l));
  if (!line) return null;
  const number = (pattern) => (pattern.exec(line) ? Number(pattern.exec(line)[1]) : undefined);
  return { cycles: number(/cycles\s+([\d.]+)/), tail: number(/tail\s+([\d.]+)/) ?? 0, loop: /\bloop\b/.test(line), seconds: number(/=\s*([\d.]+)\s*s\b/) };
}

function blocks() {
  const out = [];
  for (const { name, path } of documents()) {
    const lines = readFileSync(path, "utf-8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() !== "```strudel") continue;
      const end = lines.findIndex((line, at) => at > i && line.trim() === "```");
      assert.ok(end > i, `${name}:${i + 1}: a code block that never closes`);
      out.push({ where: `${name}:${i + 1}`, code: lines.slice(i + 1, end).join("\n") });
      i = end;
    }
  }
  return out;
}

const examplesDir = join(SKILLS, "strudel-forms", "examples");
const pieces = readdirSync(examplesDir).filter((name) => name.endsWith(".strudel")).sort()
  .map((name) => ({ name, code: readFileSync(join(examplesDir, name), "utf-8") }));

test("the music skills carry examples to try, in every one of them", () => {
  const all = blocks();
  assert.ok(all.length > 20, `${all.length} blocks`);
  for (const skill of ["strudel-music.md", "strudel-sounds.md", "strudel-forms/SKILL.md"]) {
    assert.ok(all.some((b) => b.where.startsWith(`${skill}:`)), `${skill} has no strudel block`);
  }
});

test("the forms skill names every whole piece beside it, and each says how it is rendered", () => {
  const text = readFileSync(join(SKILLS, "strudel-forms", "SKILL.md"), "utf-8");
  const named = [...new Set([...text.matchAll(/`examples\/([\w-]+\.strudel)`/g)].map((m) => m[1]))].sort();
  assert.deepEqual(named, pieces.map((p) => p.name));
  for (const piece of pieces) {
    const how = renderLine(piece.code);
    assert.ok(how && how.cycles > 0 && how.seconds > 0, `${piece.name}: no "// render: cycles N, tail S = T s" line`);
  }
});

const problemsOf = (found) => found.problems.map((p) => `${p.level}: ${p.message}`);

test("every block of the skills evaluates clean and sounds", { skip: chrome ? false : "no Chrome to render with", timeout: 600_000 }, async (t) => {
  const renderer = await strudel.StrudelRenderer.launch();
  try {
    for (const block of blocks()) {
      await t.test(block.where, async () => {
        const cycles = renderLine(block.code)?.cycles ?? 4;
        const seen = await renderer.inspect(block.code, { to: cycles });
        assert.deepEqual(problemsOf(seen), [], block.code);
        assert.ok(seen.events > 0);
        // A piece that loads samples of a workspace names files that are not here: it is checked, not rendered.
        if (/\bsamples\s*\(/.test(block.code)) return;
        const made = await renderer.render(block.code, { to: Math.min(cycles, 2), tail: 0.5 });
        assert.deepEqual(problemsOf(made), [], block.code);
        const measured = strudel.analyzeAudio(made.channels, made.sampleRate);
        assert.equal(measured.silent, false, `silent: ${block.code}`);
        assert.ok(measured.peak < 12, `peak ${measured.peak} dBFS: ${block.code}`);
      });
    }
  } finally {
    await renderer.close();
  }
});

test("every whole piece renders from end to end as its first lines say", { skip: chrome ? false : "no Chrome to render with", timeout: 1_800_000 }, async (t) => {
  const renderer = await strudel.StrudelRenderer.launch();
  try {
    for (const piece of pieces) {
      await t.test(piece.name, async () => {
        const how = renderLine(piece.code);
        const seen = await renderer.inspect(piece.code, { to: how.cycles });
        assert.deepEqual(problemsOf(seen), []);
        assert.ok(seen.parts.length >= 3 && seen.parts.every((p) => p.events > 0), "every part plays somewhere in the piece");
        const made = await renderer.render(piece.code, { to: how.cycles, tail: how.tail, loop: how.loop });
        assert.deepEqual(problemsOf(made), []);
        assert.ok(Math.abs(made.seconds - how.seconds) < 0.06, `${made.seconds.toFixed(2)} s rendered, ${how.seconds} s written`);
        const measured = strudel.analyzeAudio(made.channels, made.sampleRate);
        assert.equal(measured.silent, false);
        // Mixed with headroom: before any levelling the piece stays under full scale, and it holds together in mono.
        assert.ok(measured.peak <= 0, `peaks at ${measured.peak} dBFS before levelling`);
        assert.ok(measured.stereo.correlation > 0.2, `stereo correlation ${measured.stereo.correlation}`);
        assert.ok(measured.head < 0.5, `${measured.head} s of silence at the start`);
      });
    }
  } finally {
    await renderer.close();
  }
});
