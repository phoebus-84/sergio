import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMachines, parseProbe, place, placeName, probeCommand, probeMachine } from "../src/index.js";
import { localShell } from "./helpers.js";

const machines = parseMachines({
  machines: {
    "gpu-box": { ssh: "gpu-box", roles: { blender: { bin: "/opt/no-such-blender/blender" }, comfyui: {} } },
    "spare": { ssh: "spare", roles: { blender: { bin: "blender" }, comfyui: {} } },
  },
  prefer: { blender: ["gpu-box", "spare", "local"], "heavy-gpu": [] },
});

test("the first place that answers is chosen, and the ones skipped say why", async () => {
  const down = new Set(["gpu-box"]);
  const chosen = await place(machines, "blender", async (m) => (down.has(m.name) ? { ok: false, reason: "did not answer" } : { ok: true }));
  assert.equal(placeName(chosen.place), "spare");
  assert.deepEqual(chosen.skipped, [{ name: "gpu-box", reason: "did not answer" }]);
  down.add("spare");
  const here = await place(machines, "blender", async (m) => (down.has(m.name) ? { ok: false, reason: "down" } : { ok: true }));
  assert.equal(placeName(here.place), "local");
  assert.equal(here.skipped.length, 2);
});

test("a probe that throws is a machine that did not answer; none answering is no-machine", async () => {
  await assert.rejects(
    place(machines, "comfyui", async () => {
      throw new Error("boom");
    }),
    (e: Error & { code?: string }) => e.code === "no-machine" && /gpu-box: boom; spare: boom/.test(e.message),
  );
  await assert.rejects(place(machines, "heavy-gpu", async () => ({ ok: true })), { code: "no-machine" });
});

test("the probe says what a machine is, in one ssh command", async () => {
  const exec = localShell({ unreachable: new Set(["spare"]) });
  const probe = await probeMachine(exec, machines.machines[0]!);
  assert.equal(probe.reachable, true);
  assert.match(probe.system ?? "", /\S+ \S+/);
  assert.ok((probe.cores ?? 0) >= 1);
  assert.equal(probe.blender, null);
  assert.equal(exec.calls.length, 1);
  assert.match(exec.calls[0]!.command, /\/opt\/no-such-blender\/blender --version/);
  const unreachable = await probeMachine(exec, machines.machines[1]!);
  assert.deepEqual([unreachable.reachable, unreachable.reason], [false, "ssh: Could not resolve hostname spare: Name or service not known"]);
});

test("a Blender that answers is reported by its first line", () => {
  assert.deepEqual(parseProbe("system=Linux x86_64\ncores=32\nblender=Blender 5.2.1 LTS\n"), { system: "Linux x86_64", cores: 32, blender: "Blender 5.2.1 LTS" });
  assert.match(probeCommand({ name: "x", ssh: "x", roles: { blender: { bin: "~/opt/b 5/blender" } } }), /~\/'opt\/b 5\/blender' --version/);
});
