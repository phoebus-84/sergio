import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budgetSettingsFiles, budgetLedgerDir, resolveBudgetEnvelope, reserveSpend, readBudget } from "../src/budget.mjs";
import { episodePath, scenePath, filmPath, SELF, FILM_MANIFEST } from "../src/layout.mjs";

const parse = (text) => JSON.parse(text);
const budget = (limitMicros) => JSON.stringify({ budget: { currency: "USD", limitMicros } });

describe("a film's budget (ADR-0050)", () => {
  let root;
  const shot = (scene, name) => ({ channel: "tide", series: scene, episode: name });
  before(() => {
    root = mkdtempSync(join(tmpdir(), "film-budget-"));
    mkdirSync(join(root, "tide", "scenes", "010", "shots", "a"), { recursive: true });
    mkdirSync(join(root, "tide", "scenes", "010", "shots", "b"), { recursive: true });
    mkdirSync(join(root, "tide", "scenes", "020", "shots", "c"), { recursive: true });
    writeFileSync(join(root, "tide", FILM_MANIFEST), "kind: Film\n");
    writeFileSync(join(root, "tide", "settings.yaml"), budget(1_000_000));
    mkdirSync(join(root, "lessons", "series", "poems", "episodes", "ep01"), { recursive: true });
    writeFileSync(join(root, "lessons", "settings.yaml"), budget(1_000_000));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("is declared at the shot, its scene or the film", () => {
    assert.deepEqual(budgetSettingsFiles(root, shot("010", "a")).map((f) => f.level), ["shot", "scene", "film"]);
    assert.deepEqual(budgetSettingsFiles(root, shot("010", SELF)).map((f) => f.level), ["scene", "film"]);
    assert.deepEqual(budgetSettingsFiles(root, shot(SELF, SELF)).map((f) => f.level), ["film"]);
    assert.deepEqual(budgetSettingsFiles(root, { channel: "lessons", series: "poems", episode: "ep01" }).map((f) => f.level), ["episode", "series", "channel"]);
  });

  it("is one purse: every shot's spend is recorded in the film's ledger", async () => {
    for (const ref of [shot("010", "a"), shot("010", "b"), shot("020", "c")]) {
      const { envelope, from, ledgerDir } = await resolveBudgetEnvelope(root, ref, parse);
      assert.equal(from, "film");
      assert.equal(ledgerDir, filmPath(root, "tide"));
      const reserved = await reserveSpend(ledgerDir, { episode: ref, capability: "video.generate", provider: "fal", estimate: { currency: "USD", micros: 400_000 }, envelope });
      // Two shots fit a dollar; the third is refused, though it spent nothing itself.
      assert.equal(reserved.ok, ref.episode !== "c", reserved.reason);
      if (!reserved.ok) assert.equal(reserved.code, "BUDGET_EXCEEDED");
    }
    assert.equal((await readBudget(filmPath(root, "tide"))).committedMicros, 800_000);
  });

  it("lets a scene keep its own allowance in its own ledger", async () => {
    writeFileSync(join(scenePath(root, "tide", "020"), "settings.yaml"), budget(500_000));
    const { from, ledgerDir, envelope } = await resolveBudgetEnvelope(root, shot("020", "c"), parse);
    assert.equal(from, "scene");
    assert.equal(ledgerDir, scenePath(root, "tide", "020"));
    assert.equal(envelope.limitMicros, 500_000);
    assert.equal(budgetLedgerDir(root, shot("020", "c"), "shot"), episodePath(root, "tide", "020", "c"));
  });

  it("leaves an episode's ledger in the episode: a channel's budget is each episode's allowance", async () => {
    const ref = { channel: "lessons", series: "poems", episode: "ep01" };
    const { from, ledgerDir } = await resolveBudgetEnvelope(root, ref, parse);
    assert.equal(from, "channel");
    assert.equal(ledgerDir, episodePath(root, "lessons", "poems", "ep01"));
  });
});
