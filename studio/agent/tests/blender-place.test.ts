// ---------------------------------------------------------------------------
// Where the Blender tools run (blender-place.ts, ADR-0056)
// ---------------------------------------------------------------------------
// Against a fake SSH: nothing leaves the machine. The transport itself is
// tested in @av/render-worker (test/blender.test.ts). Machine names are made up.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TunnelPool, type Exec } from "@av/machines";
import { setMachineDeps } from "../src/machines.js";
import { blenderKey, blenderTarget, placeBlender, placeLines } from "../src/blender-place.js";

let root: string;
let blenders: Record<string, string>;
let engines: Record<string, "ok" | "none" | "down">;
const saved: Record<string, string | undefined> = {};

const exec: Exec = async (destination, command) => {
  if (engines[destination] === "down") return { code: 255, stdout: "", stderr: `ssh: connect to host ${destination}: No route to host` };
  if (command.includes("engine.sh")) {
    if (engines[destination] === "none") return { code: 127, stdout: "", stderr: "engine.sh: not found" };
    return { code: 0, stdout: JSON.stringify({ commit: null, synced: null, node: "v24", ffmpeg: null, bun: null, remotion: null, browser: false, mismatches: [] }), stderr: "" };
  }
  return { code: 0, stdout: `system=Linux x86_64\ncores=32\nblender=${blenders[destination] ?? ""}\n`, stderr: "" };
};

const write = (value: unknown) => {
  mkdirSync(join(root, ".render"), { recursive: true });
  writeFileSync(join(root, ".render", "machines.json"), JSON.stringify(value));
};
const box = (ssh: string, blender: Record<string, unknown> = { bin: "~/opt/blender/blender" }) => ({ ssh, roles: { blender, remotion: { repo: "~/clone", cache: "~/.cache/render" } } });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pva-blender-place-"));
  saved.AVG_MACHINES = process.env.AVG_MACHINES;
  delete process.env.AVG_MACHINES;
  blenders = { "gpu-box": "Blender 5.2.1 LTS", "old-box": "Blender 5.0.1" };
  engines = { "gpu-box": "ok", "old-box": "ok" };
  setMachineDeps({ exec, pool: new TunnelPool() });
});

afterEach(() => {
  setMachineDeps();
  if (saved.AVG_MACHINES === undefined) delete process.env.AVG_MACHINES;
  else process.env.AVG_MACHINES = saved.AVG_MACHINES;
  rmSync(root, { recursive: true, force: true });
});

describe("placeBlender", () => {
  it("runs here without a machines file, and without prefer.blender: declaring a machine moves nothing", async () => {
    expect((await placeBlender(root)).kind).toBe("local");
    expect(placeLines(await placeBlender(root))).toEqual([]);
    write({ machines: { "gpu-box": box("gpu-box") } });
    expect((await placeBlender(root)).kind).toBe("local");
  });

  it("takes the first machine of prefer.blender whose Blender the tools take, with its bin, lock and engine clone", async () => {
    write({ machines: { "gpu-box": box("gpu-box", { bin: "~/opt/blender/blender", gpuLock: "~/ai/gen.lock" }) }, prefer: { blender: ["gpu-box", "local"] } });
    const where = await placeBlender(root);
    expect(where.kind).toBe("machine");
    if (where.kind !== "machine") return;
    expect(where.bin).toBe("~/opt/blender/blender");
    expect(where.gpuLock).toBe("~/ai/gen.lock");
    // The blender role names no clone: the remotion role's is used.
    expect(where.target).toEqual({ name: "gpu-box", destination: "gpu-box", repo: "~/clone", cache: "~/.cache/render" });
    expect(placeLines(where).join()).toContain("Blender ran on gpu-box (~/opt/blender/blender, GPU lock ~/ai/gen.lock)");
  });

  it("passes over a machine whose Blender the tools refuse, or that does not answer, and says why", async () => {
    write({ machines: { "old-box": box("old-box"), "gpu-box": box("gpu-box") }, prefer: { blender: ["old-box", "gpu-box", "local"] } });
    engines["gpu-box"] = "down";
    const where = await placeBlender(root);
    expect(where.kind).toBe("local");
    expect(where.skipped.map((s) => s.name)).toEqual(["old-box", "gpu-box"]);
    expect(where.skipped[0]!.reason).toContain("Blender 5.0.1 is not a Blender the tools take");
    expect(where.skipped[1]!.reason).toContain("No route to host");
    expect(placeLines(where).join()).toContain("this machine; passed over old-box");
  });

  it("takes a clone that answers SSH but not yet as an engine: the job brings it to this commit", async () => {
    write({ machines: { "gpu-box": box("gpu-box") }, prefer: { blender: ["gpu-box"] } });
    engines["gpu-box"] = "none";
    expect((await placeBlender(root)).kind).toBe("machine");
  });

  it("goes where `machine` says, and refuses a machine that cannot", async () => {
    write({ machines: { "gpu-box": box("gpu-box"), "old-box": box("old-box"), plain: { ssh: "plain", roles: { "heavy-cpu": {} } } }, prefer: { blender: ["gpu-box"] } });
    expect((await placeBlender(root, "local")).kind).toBe("local");
    expect((await placeBlender(root, "gpu-box")).kind).toBe("machine");
    await expect(placeBlender(root, "old-box")).rejects.toThrow(/old-box cannot run Blender now: Blender 5\.0\.1/);
    await expect(placeBlender(root, "plain")).rejects.toThrow(/plain has no blender role/);
    await expect(placeBlender(root, "nowhere")).rejects.toThrow(/no machine "nowhere"/);
  });

  it("reads the blender role's own clone and cache over the remotion role's", () => {
    expect(blenderTarget({ name: "b", ssh: "me@b", roles: { blender: { bin: "blender", repo: "~/own", cache: "~/c" } } } as never))
      .toEqual({ name: "b", destination: "me@b", repo: "~/own", cache: "~/c" });
    expect(blenderTarget({ name: "b", ssh: "b", roles: { blender: { bin: "blender" } } } as never)).toEqual({ name: "b", destination: "b", repo: "~/sergio" });
  });
});

describe("blenderKey", () => {
  it("names a film's unit with plain names, as the engine's folders go", () => {
    expect(blenderKey("light-hours", "_", "_")).toBe("light-hours/u_/u_");
    expect(blenderKey("ch", "series-1", "ep-02")).toBe("ch/series-1/ep-02");
  });
});
