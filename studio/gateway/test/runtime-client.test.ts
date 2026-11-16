import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeClient } from "../src/runtime/client.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("RuntimeClient", () => {
  it("passes an explicitly resolved pipeline to snapshot resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "gateway-runtime-client-"));
    roots.push(root);
    const cliPath = join(root, "fake-vpr.mjs");
    await writeFile(cliPath, "process.stdout.write(JSON.stringify({args: process.argv.slice(2)}));\n", "utf-8");
    const client = new RuntimeClient({ cliPath, libraryRoot: root });

    const result = await client.resolve({ channel: "wordless-comedy", series: "give-me-time", episode: "the-run-up" }, "wordless-rigged-short");

    expect(result.ok).toBe(true);
    // --library is passed explicitly: the CLI requires it and does not read
    // AVG_LIBRARY_ROOT.
    expect(result.data?.args).toEqual([
      "resolve",
      "wordless-comedy/give-me-time/the-run-up",
      "--pipeline",
      "wordless-rigged-short",
      "--library",
      root,
      "--json",
    ]);
  });
  it("is reachable when the doctor answered, even with findings about the library", async () => {
    // The doctor exits 1 when the library has an error. That is the library's
    // state: the runtime ran and answered, and health must not call it down.
    const root = await mkdtemp(join(tmpdir(), "gateway-runtime-client-"));
    roots.push(root);
    const cliPath = join(root, "fake-vpr.mjs");
    const report = { ok: false, findings: [{ code: "E_MISSING_REQUIRED" }, { code: "E_MISSING_REQUIRED" }, { code: "W_MISSING_CONTRACT" }] };
    await writeFile(cliPath, `process.stdout.write(${JSON.stringify(JSON.stringify(report))}); process.exitCode = 1;\n`, "utf-8");

    expect(await new RuntimeClient({ cliPath, libraryRoot: root }).health()).toEqual({ reachable: true, library: { errors: 2, warnings: 1 } });
  });

  it("is not reachable when the command fails without a report", async () => {
    const root = await mkdtemp(join(tmpdir(), "gateway-runtime-client-"));
    roots.push(root);
    const cliPath = join(root, "fake-vpr.mjs");
    await writeFile(cliPath, "process.stderr.write('cannot start'); process.exitCode = 1;\n", "utf-8");

    const health = await new RuntimeClient({ cliPath, libraryRoot: root }).health();
    expect(health.reachable).toBe(false);
    expect(health.error).toBe("cannot start");
  });
});
