// The other machine, in this process. `localShell` is an Exec that runs the
// remote command in a local sh (so flock and the probe's printf are real);
// `fakeSsh` stands in for `ssh -N -L`: it serves an HTTP "service" on the
// forwarded local port until it is killed. Machine names here are made up.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import type { Exec, ExecInput, ExecResult } from "../src/ssh.js";
import type { SpawnTunnel, TunnelProcess } from "../src/tunnel.js";

/** Runs the command in a local sh; destinations in `unreachable` answer as ssh does when it cannot connect. */
export function localShell(options: { unreachable?: Set<string>; rewrite?: (command: string) => string } = {}): Exec & { calls: { destination: string; command: string }[] } {
  const calls: { destination: string; command: string }[] = [];
  const exec = ((destination: string, command: string, input: ExecInput = {}) => {
    calls.push({ destination, command });
    if (options.unreachable?.has(destination)) {
      return Promise.resolve<ExecResult>({ code: 255, stdout: "", stderr: `ssh: Could not resolve hostname ${destination}: Name or service not known` });
    }
    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn("sh", ["-c", options.rewrite ? options.rewrite(command) : command], { stdio: ["pipe", "pipe", "pipe"], ...(input.signal ? { signal: input.signal } : {}) });
      const out: Buffer[] = [];
      let err = "";
      if (input.stdout) child.stdout.pipe(input.stdout);
      else child.stdout.on("data", (b: Buffer) => out.push(b));
      child.stderr.on("data", (b: Buffer) => (err += b.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString(), stderr: err }));
      child.stdin.on("error", () => undefined);
      if (input.stdin === undefined) child.stdin.end();
      else if (typeof input.stdin === "string" || Buffer.isBuffer(input.stdin)) child.stdin.end(input.stdin);
      else Readable.from(input.stdin).pipe(child.stdin);
    });
  }) as Exec & { calls: { destination: string; command: string }[] };
  exec.calls = calls;
  return exec;
}

export interface FakeSsh {
  spawn: SpawnTunnel;
  /** Every tunnel asked for: the ssh arguments. */
  spawned: string[][];
  /** Destinations whose ssh exits at once, as when the forward fails. */
  refuse: Set<string>;
  /** Destinations where nothing listens behind the tunnel. */
  silent: Set<string>;
  live(): number;
}

/** An `ssh -N -L 127.0.0.1:P:host:port dest` whose service answers /system_stats on P. */
export function fakeSsh(): FakeSsh {
  const spawned: string[][] = [];
  const refuse = new Set<string>();
  const silent = new Set<string>();
  let live = 0;
  const fake: FakeSsh = {
    spawned,
    refuse,
    silent,
    live: () => live,
    spawn: (_program, args) => {
      spawned.push(args);
      const destination = args[args.length - 1]!;
      const forward = args[args.indexOf("-L") + 1]!;
      const port = Number(forward.split(":")[1]);
      const child = new EventEmitter() as EventEmitter & TunnelProcess & { exitCode: number | null };
      const stderr = new EventEmitter() as EventEmitter & { setEncoding(): void };
      stderr.setEncoding = () => undefined;
      (child as { stderr: unknown }).stderr = stderr;
      child.exitCode = null;
      let server: Server | null = null;
      const exit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (child.exitCode !== null) return;
        child.exitCode = code ?? 143;
        if (server) {
          live--;
          server.close();
          server.closeAllConnections();
        }
        child.emit("exit", code, signal);
      };
      child.kill = (signal?: NodeJS.Signals) => {
        setImmediate(() => exit(null, signal ?? "SIGTERM"));
        return true;
      };
      if (refuse.has(destination)) {
        setImmediate(() => {
          stderr.emit("data", `channel_setup_fwd_listener_tcpip: cannot listen to port: ${port}\nCould not request local forwarding.\n`);
          exit(255, null);
        });
      } else if (!silent.has(destination)) {
        live++;
        server = createServer((req, res) => {
          res.writeHead(req.url === "/system_stats" ? 200 : 404, { "content-type": "application/json" });
          res.end(JSON.stringify({ via: destination }));
        }).listen(port, "127.0.0.1");
      }
      return child;
    },
  };
  return fake;
}

export const comfyHealthy = async (url: string) => (await fetch(`${url}/system_stats`, { signal: AbortSignal.timeout(1000) })).ok;
