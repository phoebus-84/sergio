// ---------------------------------------------------------------------------
// The operator's machines in the agent's tools (ADR-0056)
// ---------------------------------------------------------------------------
// pva_capability_status, pva_config and pva_compose_video against a fake SSH:
// nothing leaves the machine. Machine names here are made up.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { TunnelPool, type Exec, type SpawnTunnel } from "@av/machines";
import { machinesCapabilities, machinesReport, setMachineDeps } from "../src/machines.js";

let root: string;
let calls: { destination: string; command: string }[];
const saved: Record<string, string | undefined> = {};
const ENV = ["AVG_LIBRARY_ROOT", "AVG_MACHINES", "AVG_RENDER_HOSTS"];

/** gpu-box answers, with a Blender; spare does not. */
const exec: Exec = async (destination, command) => {
  calls.push({ destination, command });
  if (destination === "me@spare.lan") return { code: 255, stdout: "", stderr: "ssh: connect to host spare.lan port 22: No route to host" };
  if (command === "true") return { code: 0, stdout: "", stderr: "" };
  return { code: 0, stdout: "system=Linux x86_64\ncores=32\nblender=Blender 5.2.1 LTS\n", stderr: "" };
};

const FILE = {
  machines: {
    "gpu-box": {
      ssh: "gpu-box",
      note: "a GPU",
      roles: {
        remotion: { repo: "~/sergio" },
        blender: { bin: "~/opt/blender-5.2.1-linux-x64/blender", gpuLock: "~/ai/generation.lock" },
        comfyui: { port: 8188 },
        "heavy-cpu": {},
      },
    },
    spare: { ssh: "me@spare.lan", roles: { remotion: {} } },
  },
  prefer: { blender: ["gpu-box", "local"] },
};

const write = (value: unknown, file = join(root, ".render", "machines.json")) => {
  mkdirSync(join(root, ".render"), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pva-machines-"));
  for (const name of ENV) saved[name] = process.env[name];
  process.env.AVG_LIBRARY_ROOT = root;
  delete process.env.AVG_MACHINES;
  delete process.env.AVG_RENDER_HOSTS;
  calls = [];
  // No ComfyUI behind gpu-box's tunnel: its ssh exits at once, as when the forward fails.
  const spawn: SpawnTunnel = () => {
    const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, stderr: null, kill: () => true });
    setImmediate(() => ((child.exitCode = 255), child.emit("exit", 255, null)));
    return child as never;
  };
  setMachineDeps({ exec, spawn, pool: new TunnelPool() });
});

afterEach(() => {
  setMachineDeps();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("the machines report", () => {
  it("says there is no file, and that everything runs here", async () => {
    const report = await machinesReport(root, {});
    expect(report).toMatchObject({ found: false, machines: [] });
    expect(machinesCapabilities(report)).toEqual({ machines: { available: true, detail: `no machines file (${join(root, ".render", "machines.json")}): everything runs on this machine` } });
    expect(calls).toHaveLength(0);
  });

  it("asks each machine whether it answers and what it is, and where each role goes", async () => {
    write(FILE);
    writeFileSync(join(root, ".render", "render-hosts.json"), "{}");
    const report = await machinesReport(root, {});
    expect(report.routes).toEqual({ remotion: ["local"], blender: ["gpu-box", "local"], comfyui: ["gpu-box"], "heavy-cpu": ["local"], "heavy-gpu": ["local"] });
    expect(report.fallbacks).toEqual([join(root, ".render", "render-hosts.json")]);
    expect(report.machines[0]).toMatchObject({ name: "gpu-box", reachable: true, system: "Linux x86_64", cores: 32, blender: "Blender 5.2.1 LTS", blenderSupported: true, note: "a GPU" });
    expect(report.machines[1]).toMatchObject({ name: "spare", reachable: false, reason: "ssh: connect to host spare.lan port 22: No route to host" });
    const caps = machinesCapabilities(report);
    expect(caps.machines!.available).toBe(false);
    expect(caps.machines!.detail).toContain("the tools route by it, never by hand: remotion → local; blender → gpu-box, local; comfyui → gpu-box");
    expect(caps["machine-gpu-box"]).toEqual({
      available: true,
      detail: "ssh gpu-box: answers (Linux x86_64, 32 cores); a GPU; roles remotion, blender (Blender 5.2.1 LTS, GPU lock ~/ai/generation.lock), comfyui (tunnel to 127.0.0.1:8188), heavy-cpu",
    });
    expect(caps["machine-spare"]!.available).toBe(false);
  });

  it("reports an invalid file and a missing AVG_MACHINES as errors, never as no machines", async () => {
    write({ machines: { "gpu-box": { ssh: "gpu-box", roles: { blender: {} } } } });
    expect(machinesCapabilities(await machinesReport(root, {})).machines).toEqual({ available: false, detail: expect.stringContaining("machines.gpu-box.roles.blender.bin: required") });
    const named = join(root, "elsewhere.json");
    expect((await machinesReport(root, { AVG_MACHINES: named })).error).toBe(`${named} does not exist`);
    write(FILE, named);
    expect((await machinesReport(root, { AVG_MACHINES: named })).machines).toHaveLength(2);
  });
});

describe("the tools", () => {
  async function tools() {
    const { registerCapabilityTools } = await import("../src/capability-tools.js");
    const map = new Map<string, { execute: (...a: unknown[]) => Promise<any> }>();
    registerCapabilityTools({ registerTool: (t: { name: string }) => map.set(t.name, t as never) } as never);
    return map;
  }

  it("pva_capability_status lists the machines", async () => {
    write(FILE);
    const result = await (await tools()).get("pva_capability_status")!.execute("c", {}, undefined, undefined, undefined);
    expect(result.details.capabilities["machine-gpu-box"].available).toBe(true);
    expect(result.details.capabilities.machines.detail).toContain("blender → gpu-box, local");
    expect(result.details.capabilities["text-to-speech-comfyui-qwen"]).toEqual({ available: false, detail: "no comfyui server answered: gpu-box: the tunnel to gpu-box:8188 closed (exit 255)" });
  }, 30_000);

  const REF = { channel: "sample-channel", series: "sample-series", episode: "ep" };
  const compose = async () => (await tools()).get("pva_compose_video")!.execute("c", { ...REF }, undefined, undefined, undefined);

  it("pva_compose_video refuses to render while the machines file is invalid", async () => {
    write("{ nope");
    const result = await compose();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/^❌ bad-machines-file: .*machines\.json is not JSON/);
  });

  it("pva_compose_video goes where prefer.remotion says, and says so when none answers", async () => {
    write({ ...FILE, prefer: { remotion: ["spare"] } });
    const result = await compose();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("❌ no-machine: no machine for remotion answered: spare: ssh: connect to host spare.lan port 22: No route to host");
    expect(calls).toEqual([{ destination: "me@spare.lan", command: "true" }]);
  });
});
