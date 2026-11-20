import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openTunnel, parseMachines, reachService, tunnelArgs, TunnelPool } from "../src/index.js";
import { comfyHealthy, fakeSsh } from "./helpers.js";

const pools: TunnelPool[] = [];
const pool = () => {
  const p = new TunnelPool();
  pools.push(p);
  return p;
};
after(() => pools.forEach((p) => p.closeAll()));

const machines = parseMachines({
  machines: {
    "gpu-box": { ssh: "gpu-box", roles: { comfyui: { port: 8188 } } },
    "spare": { ssh: "me@spare", roles: { comfyui: { host: "10.1.1.1", port: 9000 } } },
  },
});

test("the tunnel forwards a free loopback port and never asks for a password", () => {
  assert.deepEqual(tunnelArgs({ destination: "gpu-box", remoteHost: "127.0.0.1", remotePort: 8188 }, 40123), [
    "-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30",
    "-L", "127.0.0.1:40123:127.0.0.1:8188", "--", "gpu-box",
  ]);
});

test("a service on a machine's loopback is reached through a tunnel that answers, reused, and closed", async () => {
  const ssh = fakeSsh();
  const tunnels = pool();
  const reached = await reachService(machines, "comfyui", { healthy: comfyHealthy, spawn: ssh.spawn, pool: tunnels });
  assert.equal(reached.machine.name, "gpu-box");
  assert.equal(reached.via, "tunnel");
  assert.match(reached.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual(await (await fetch(`${reached.url}/system_stats`)).json(), { via: "gpu-box" });
  const again = await reachService(machines, "comfyui", { healthy: comfyHealthy, spawn: ssh.spawn, pool: tunnels });
  assert.equal(again.url, reached.url);
  assert.equal(ssh.spawned.length, 1, "the open tunnel is reused");
  tunnels.closeAll();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ssh.live(), 0);
});

test("a tunnel that died is opened again", async () => {
  const ssh = fakeSsh();
  const tunnels = pool();
  const spec = { destination: "gpu-box", remoteHost: "127.0.0.1", remotePort: 8188 };
  const first = await tunnels.get(spec, { healthy: comfyHealthy, spawn: ssh.spawn });
  first.close();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(first.alive(), false);
  const second = await tunnels.get(spec, { healthy: comfyHealthy, spawn: ssh.spawn });
  assert.equal(second.alive(), true);
  assert.equal(ssh.spawned.length, 2);
});

test("a machine whose tunnel fails is passed over for the next, with the reason", async () => {
  const ssh = fakeSsh();
  ssh.refuse.add("gpu-box");
  const reached = await reachService(machines, "comfyui", { healthy: comfyHealthy, spawn: ssh.spawn, pool: pool() });
  assert.equal(reached.machine.name, "spare");
  assert.match(ssh.spawned[1]!.join(" "), /-L 127\.0\.0\.1:\d+:10\.1\.1\.1:9000 -- me@spare/);
  assert.equal(reached.skipped[0]!.name, "gpu-box");
  assert.match(reached.skipped[0]!.reason, /closed \(exit 255\): .*Could not request local forwarding/);
});

test("a tunnel with nothing behind it times out, is closed, and says so", async () => {
  const ssh = fakeSsh();
  ssh.silent.add("gpu-box");
  await assert.rejects(
    openTunnel({ destination: "gpu-box", remoteHost: "127.0.0.1", remotePort: 8188 }, { healthy: comfyHealthy, spawn: ssh.spawn, timeoutMs: 300, intervalMs: 50 }),
    (e: Error & { code?: string }) => e.code === "tunnel-failed" && /did not answer through it/.test(e.message),
  );
});

test("a direct url is used without a tunnel when it answers", async () => {
  const ssh = fakeSsh();
  const direct = parseMachines({ machines: { lan: { ssh: "lan", roles: { comfyui: { url: "http://lan.test:8188/" } } } } });
  const reached = await reachService(direct, "comfyui", { healthy: async (u) => u === "http://lan.test:8188", spawn: ssh.spawn, pool: pool() });
  assert.deepEqual([reached.url, reached.via], ["http://lan.test:8188", "direct"]);
  assert.equal(ssh.spawned.length, 0);
  await assert.rejects(reachService(direct, "comfyui", { healthy: async () => false, spawn: ssh.spawn, pool: pool() }), /lan: http:\/\/lan\.test:8188 did not answer/);
});

test("with no machine for the service, the error says there is none", async () => {
  await assert.rejects(reachService(parseMachines({}), "comfyui", { healthy: comfyHealthy, pool: pool() }), { code: "no-machine", message: "no machine has the comfyui role (no machines file)" });
});

test("an ssh program that cannot run is a tunnel that failed, not a crash", async () => {
  await assert.rejects(
    openTunnel({ destination: "gpu-box", remoteHost: "127.0.0.1", remotePort: 8188 }, { healthy: comfyHealthy, program: "/nonexistent/ssh-program" }),
    (e: Error & { code?: string }) => e.code === "tunnel-failed" && /could not run: spawn \/nonexistent\/ssh-program ENOENT/.test(e.message),
  );
});
