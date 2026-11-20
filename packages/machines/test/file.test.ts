import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { candidates, gpuLockOf, MachineError, parseMachines, placeName, readMachines } from "../src/index.js";

const GPU_BOX = {
  machines: {
    "gpu-box": {
      ssh: "gpu-box",
      note: "32 cores, a GPU",
      roles: {
        remotion: { repo: "~/sergio", cache: "~/.cache/sergio/render" },
        blender: { bin: "~/opt/blender-5.2.1-linux-x64/blender", gpuLock: "~/ai/generation.lock" },
        comfyui: { port: 8188, gpuLock: "~/ai/generation.lock" },
        "heavy-cpu": {},
        "heavy-gpu": { gpuLock: "~/ai/generation.lock" },
      },
    },
    "old-tower": { ssh: "render@10.0.0.7", roles: { remotion: {} } },
  },
  prefer: { blender: ["gpu-box", "local"], remotion: ["local", "old-tower"] },
};

const problems = (value: unknown) => {
  try {
    parseMachines(value, "machines.json");
  } catch (e) {
    assert.ok(e instanceof MachineError && e.code === "bad-machines-file");
    return e.message;
  }
  return "";
};

test("a valid file is read with its machines in order and its preferences", () => {
  const machines = parseMachines(GPU_BOX, "machines.json");
  assert.deepEqual(machines.machines.map((m) => m.name), ["gpu-box", "old-tower"]);
  assert.equal(machines.machines[0]!.roles.blender!.bin, "~/opt/blender-5.2.1-linux-x64/blender");
  assert.equal(gpuLockOf(machines.machines[0]!, "comfyui"), "~/ai/generation.lock");
  assert.equal(gpuLockOf(machines.machines[0]!, "remotion"), undefined);
  assert.deepEqual(machines.prefer.blender, ["gpu-box", "local"]);
});

test("every problem is reported at once, with its path", () => {
  const message = problems({
    machines: {
      local: { ssh: "x" },
      a: { ssh: "-oProxyCommand=evil", roles: { blender: {}, render: {}, comfyui: { port: 99999, url: "ftp://x" } } },
      b: { ssh: "b", password: "hunter2", roles: { remotion: { token: "s3cret" } } },
    },
    prefer: { blender: ["a", "a", "nobody"], comfyui: ["local"], remotion: ["a"] },
    extra: true,
  });
  for (const expected of [
    "extra: unknown field",
    `machines.local: "local" is this machine`,
    "machines.a.ssh: an SSH alias",
    "machines.a.roles.blender.bin: required",
    "machines.a.roles.render: unknown role",
    "machines.a.roles.comfyui.port: is not a port",
    "machines.a.roles.comfyui.url: is not an http(s) URL",
    "machines.a.roles.comfyui: url, or port and host for a tunnel, not both",
    "machines.b.password: unknown field",
    "machines.b.roles.remotion.token: unknown field",
    "prefer.blender: a twice",
    "prefer.blender: no machine is called nobody",
    `prefer.comfyui: comfyui is a server on a machine; "local" is not one`,
    "prefer.remotion: a has no remotion role",
  ]) assert.ok(message.includes(expected), `${expected}\nnot in\n${message}`);
});

test("comments are allowed and the version must be 1", () => {
  assert.equal(problems({ $comment: "mine", machines: { a: { $why: "x", ssh: "a", roles: { "heavy-cpu": {} } } } }), "");
  assert.match(problems({ version: 2 }), /version: only 1/);
});

test("a missing default file is no machines; a missing named file is an error", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "machines-"));
  assert.deepEqual(readMachines(path.join(dir, "none.json")).machines, []);
  assert.deepEqual(readMachines(undefined).machines, []);
  assert.throws(() => readMachines(path.join(dir, "none.json"), { required: true }), { code: "bad-machines-file" });
  writeFileSync(path.join(dir, "bad.json"), "{ not json");
  assert.throws(() => readMachines(path.join(dir, "bad.json")), /is not JSON/);
  writeFileSync(path.join(dir, "ok.json"), JSON.stringify(GPU_BOX));
  assert.equal(readMachines(path.join(dir, "ok.json")).file, path.join(dir, "ok.json"));
});

test("without a preference a process runs here and a service is looked for on its machines", () => {
  const machines = parseMachines({ ...GPU_BOX, prefer: {} });
  assert.deepEqual(candidates(machines, "blender").map(placeName), ["local"]);
  assert.deepEqual(candidates(machines, "remotion").map(placeName), ["local"]);
  assert.deepEqual(candidates(machines, "comfyui").map(placeName), ["gpu-box"]);
  const preferred = parseMachines(GPU_BOX);
  assert.deepEqual(candidates(preferred, "blender").map(placeName), ["gpu-box", "local"]);
  assert.deepEqual(candidates(preferred, "remotion").map(placeName), ["local", "old-tower"]);
});
