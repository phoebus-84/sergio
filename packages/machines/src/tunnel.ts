// A service that listens only on another machine's loopback, reached through
// `ssh -N -L` on a free port of this machine's loopback. The tunnel is opened
// on demand, used once its health check answers, kept while its ssh lives,
// and closed when this process exits. No port is fixed, so two studios on one
// machine do not collide.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { MachineError } from "./errors.js";
import { DEFAULT_COMFYUI_HOST, DEFAULT_COMFYUI_PORT, type Machine, type Machines, type Role } from "./file.js";
import { candidates } from "./place.js";

export interface TunnelSpec {
  /** What ssh connects to. */
  destination: string;
  /** The address the service listens on, as seen from that machine. */
  remoteHost: string;
  remotePort: number;
}

/** What the tunnel needs of a child process; a fake in tests. */
export interface TunnelProcess {
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  stderr?: NodeJS.ReadableStream | null;
}
export type SpawnTunnel = (program: string, args: string[]) => TunnelProcess;

export interface TunnelOptions {
  /** Whether the service answers at this base URL (http://127.0.0.1:<port>). */
  healthy: (baseUrl: string) => Promise<boolean>;
  /** The ssh program; AVG_RENDER_SSH, else "ssh". */
  program?: string;
  spawn?: SpawnTunnel;
  /** How long the service has to answer through the new tunnel. Default 20 s. */
  timeoutMs?: number;
  intervalMs?: number;
  /** The local port; a free one by default. */
  port?: number;
}

export interface Tunnel {
  spec: TunnelSpec;
  localPort: number;
  /** http://127.0.0.1:<localPort> */
  url: string;
  alive(): boolean;
  close(): void;
}

export function tunnelArgs(spec: TunnelSpec, localPort: number): string[] {
  return [
    "-N",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=30",
    "-L", `127.0.0.1:${localPort}:${spec.remoteHost}:${spec.remotePort}`,
    "--", spec.destination,
  ];
}

/** A port nothing on this machine's loopback listens on, now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

const spawnSsh: SpawnTunnel = (program, args) => spawn(program, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Opens a tunnel and waits for the service to answer through it. */
export async function openTunnel(spec: TunnelSpec, options: TunnelOptions): Promise<Tunnel> {
  const program = options.program ?? process.env.AVG_RENDER_SSH ?? "ssh";
  const localPort = options.port ?? await freePort();
  const url = `http://127.0.0.1:${localPort}`;
  const child = (options.spawn ?? spawnSsh)(program, tunnelArgs(spec, localPort));
  const where = `${spec.destination}:${spec.remotePort}`;
  let stderr = "";
  child.stderr?.setEncoding?.("utf-8");
  child.stderr?.on("data", (chunk: string | Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const kill = () => {
    if (!exited) child.kill("SIGTERM");
  };
  child.once("exit", (code, signal) => {
    exited = { code, signal };
    process.removeListener("exit", kill);
  });
  // No ssh program, or it could not start: a tunnel that closed, never an unhandled error.
  child.once("error", (e) => {
    stderr += `\n${program} could not run: ${e.message}`;
    exited ??= { code: null, signal: null };
    process.removeListener("exit", kill);
  });
  // An ssh left behind would hold the port and the connection: it goes with this process.
  process.once("exit", kill);
  const tunnel: Tunnel = {
    spec,
    localPort,
    url,
    alive: () => exited === null && (child.exitCode ?? null) === null,
    close: () => {
      process.removeListener("exit", kill);
      kill();
    },
  };

  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  for (;;) {
    if (!tunnel.alive()) {
      const said = stderr.split("\n").filter((l) => l.trim() && !l.startsWith("** ")).slice(-3).join(" | ");
      const ended = exited as { code: number | null; signal: NodeJS.Signals | null } | null;
      throw new MachineError("tunnel-failed", `the tunnel to ${where} closed (exit ${ended?.code ?? ended?.signal ?? "?"})${said ? `: ${said}` : ""}`);
    }
    if (await options.healthy(url).catch(() => false)) return tunnel;
    if (Date.now() >= deadline) {
      tunnel.close();
      throw new MachineError("tunnel-failed", `the tunnel to ${where} opened, but the service did not answer through it within ${Math.round((options.timeoutMs ?? 20_000) / 1000)} s: is it running there?`);
    }
    await sleep(options.intervalMs ?? 250);
  }
}

const specKey = (s: TunnelSpec) => `${s.destination}|${s.remoteHost}|${s.remotePort}`;

/** The tunnels this process has open, one per service, reused while they live. */
export class TunnelPool {
  private readonly open = new Map<string, Promise<Tunnel>>();

  /** A live tunnel to `spec` whose service answers: the one open, or a new one. */
  async get(spec: TunnelSpec, options: TunnelOptions): Promise<Tunnel> {
    const key = specKey(spec);
    const pending = this.open.get(key);
    if (pending) {
      const tunnel = await pending.catch(() => null);
      if (tunnel?.alive() && await options.healthy(tunnel.url).catch(() => false)) return tunnel;
      tunnel?.close();
      if (this.open.get(key) === pending) this.open.delete(key);
    }
    const opening = openTunnel(spec, options);
    this.open.set(key, opening);
    opening.catch(() => {
      if (this.open.get(key) === opening) this.open.delete(key);
    });
    return opening;
  }

  closeAll(): void {
    for (const pending of this.open.values()) void pending.then((t) => t.close(), () => undefined);
    this.open.clear();
  }
}

/** The pool a process shares when the caller brings none. */
export const tunnels = new TunnelPool();

export interface Reached {
  /** The service's base URL, as reached from here. */
  url: string;
  machine: Machine;
  via: "direct" | "tunnel";
  /** The machines tried first, and why each was passed over. */
  skipped: { name: string; reason: string }[];
}

/**
 * The first machine offering `role` (a service) whose server answers: its
 * `url` when the file gives one, else through a tunnel to its `host:port`.
 * ComfyUI's settings name the port and address; another service would add
 * its own here.
 */
export async function reachService(
  machines: Machines,
  role: Extract<Role, "comfyui">,
  options: Omit<TunnelOptions, "port"> & { pool?: TunnelPool },
): Promise<Reached> {
  const pool = options.pool ?? tunnels;
  const skipped: Reached["skipped"] = [];
  const places = candidates(machines, role);
  for (const p of places) {
    if (p.kind !== "machine") continue;
    const machine = p.machine;
    const settings = machine.roles[role] ?? {};
    try {
      if (settings.url) {
        const url = settings.url.replace(/\/+$/, "");
        if (await options.healthy(url).catch(() => false)) return { url, machine, via: "direct", skipped };
        skipped.push({ name: machine.name, reason: `${url} did not answer` });
        continue;
      }
      const tunnel = await pool.get({
        destination: machine.ssh,
        remoteHost: settings.host ?? DEFAULT_COMFYUI_HOST,
        remotePort: settings.port ?? DEFAULT_COMFYUI_PORT,
      }, options);
      return { url: tunnel.url, machine, via: "tunnel", skipped };
    } catch (e) {
      skipped.push({ name: machine.name, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  throw new MachineError(
    "no-machine",
    places.length === 0
      ? `no machine has the ${role} role${machines.file ? ` in ${machines.file}` : " (no machines file)"}`
      : `no ${role} server answered: ${skipped.map((s) => `${s.name}: ${s.reason}`).join("; ")}`,
  );
}
