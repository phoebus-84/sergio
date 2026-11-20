// ---------------------------------------------------------------------------
// The operator's machines, for the studio's tools (ADR-0056)
// ---------------------------------------------------------------------------
// One library file, library/.render/machines.json (AVG_MACHINES names
// another), says which machines exist, how SSH reaches them, what each is
// for, and in which order to use them. @av/machines reads it; this module
// finds it in the library and reports it. The tools route by it: the agent
// never opens a tunnel, copies code or runs a script on a machine by hand.
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { join } from "node:path";
import { blenderVersionSupport } from "@av/blender";
import {
  candidates, gpuLockOf, placeName, probeMachine, readMachines, ROLES, sshExec, tunnels,
  type Exec, type Machine, type MachineProbe, type Machines, type Role, type SpawnTunnel, type TunnelPool,
} from "@av/machines";

export const MACHINES_ENV = "AVG_MACHINES";
export const MACHINES_RELATIVE = join(".render", "machines.json");

/** What the machine tools reach the machines with; tests put fakes here. */
export interface MachineDeps {
  exec: Exec;
  spawn?: SpawnTunnel;
  pool: TunnelPool;
}

const defaults = (): MachineDeps => ({ exec: sshExec(), pool: tunnels });
let deps: MachineDeps = defaults();

export function machineDeps(): MachineDeps {
  return deps;
}

/** Replaces what the tools reach machines with, for tests; no argument restores SSH. */
export function setMachineDeps(next?: Partial<MachineDeps>): void {
  deps = next ? { ...defaults(), ...next } : defaults();
}

/** The machines file: AVG_MACHINES (which must exist), else the library's. */
export function machinesFile(libraryRoot: string, env: NodeJS.ProcessEnv = process.env): { file: string; explicit: boolean } {
  const named = env[MACHINES_ENV]?.trim();
  return named ? { file: named, explicit: true } : { file: join(libraryRoot, MACHINES_RELATIVE), explicit: false };
}

/** The library's machines; none without a file. An invalid file throws, with each problem's path. */
export function studioMachines(libraryRoot: string, env: NodeJS.ProcessEnv = process.env): Machines {
  const { file, explicit } = machinesFile(libraryRoot, env);
  return readMachines(file, { required: explicit });
}

export interface MachineReport extends MachineProbe {
  note?: string;
  roles: Partial<Record<Role, Record<string, unknown>>>;
  /** For a blender machine whose Blender answered: whether @av/blender takes that version. */
  blenderSupported?: boolean;
}

export interface MachinesReport {
  file: string;
  /** Whether the file was there. */
  found: boolean;
  /** Why it could not be read, when it could not. */
  error?: string;
  machines: MachineReport[];
  /** Per role, the places tried in order ("local" is this machine). */
  routes: Partial<Record<Role, string[]>>;
  /** The older files still read as fallbacks, when present. */
  fallbacks: string[];
}

function report(machine: Machine, probe: MachineProbe): MachineReport {
  const blender = probe.blender ? blenderVersionSupport(probe.blender) : null;
  return {
    ...probe,
    ...(machine.note ? { note: machine.note } : {}),
    roles: machine.roles as MachineReport["roles"],
    ...(blender ? { blenderSupported: blender.supported } : {}),
  };
}

/** The machines, each asked over SSH whether it answers and what it is, and where each role goes. */
export async function machinesReport(libraryRoot: string, env: NodeJS.ProcessEnv = process.env, options: { signal?: AbortSignal } = {}): Promise<MachinesReport> {
  const { file } = machinesFile(libraryRoot, env);
  const fallbacks = [join(libraryRoot, ".render", "render-hosts.json"), join(libraryRoot, ".render", "comfyui.json")]
    .filter((f) => existsSync(f));
  const base = { file, found: existsSync(file), fallbacks };
  let machines: Machines;
  try {
    machines = studioMachines(libraryRoot, env);
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e), machines: [], routes: {} };
  }
  const probes = await Promise.all(machines.machines.map((m) => probeMachine(deps.exec, m, options.signal ? { signal: options.signal } : {})));
  const routes: MachinesReport["routes"] = {};
  for (const role of ROLES) {
    const places = candidates(machines, role).map(placeName);
    if (places.length > 0) routes[role] = places;
  }
  return { ...base, machines: machines.machines.map((m, i) => report(m, probes[i]!)), routes };
}

/** One line per machine and one for the routes, as pva_capability_status lists capabilities. */
export function machinesCapabilities(r: MachinesReport): Record<string, { available: boolean; detail: string }> {
  if (r.error) return { machines: { available: false, detail: r.error } };
  if (!r.found && r.machines.length === 0) {
    return { machines: { available: true, detail: `no machines file (${r.file}): everything runs on this machine` } };
  }
  const caps: Record<string, { available: boolean; detail: string }> = {
    machines: {
      available: r.machines.every((m) => m.reachable),
      detail: `${r.file}; the tools route by it, never by hand: ` +
        Object.entries(r.routes).map(([role, places]) => `${role} → ${places.join(", ")}`).join("; ") +
        (r.fallbacks.length > 0 ? `; also read as fallbacks: ${r.fallbacks.join(", ")}` : ""),
    },
  };
  for (const m of r.machines) {
    const roles = Object.entries(m.roles).map(([role, settings]) => {
      const facts: string[] = [];
      if (role === "blender") {
        facts.push(m.blender ? `${m.blender}${m.blenderSupported === false ? ", not a version the Blender tools take" : ""}` : m.reachable ? `${(settings as { bin?: string }).bin} did not answer` : "");
      }
      if (role === "comfyui") {
        const s = settings as { url?: string; host?: string; port?: number };
        facts.push(s.url ? s.url : `tunnel to ${s.host ?? "127.0.0.1"}:${s.port ?? 8188}`);
      }
      const lock = (settings as { gpuLock?: string }).gpuLock;
      if (lock) facts.push(`GPU lock ${lock}`);
      const said = facts.filter(Boolean);
      return said.length > 0 ? `${role} (${said.join(", ")})` : role;
    });
    const what = [m.system, m.cores ? `${m.cores} cores` : ""].filter(Boolean).join(", ");
    caps[`machine-${m.name}`] = {
      available: m.reachable,
      detail: `ssh ${m.ssh}: ${m.reachable ? `answers${what ? ` (${what})` : ""}` : `does not answer: ${m.reason}`}` +
        `${m.note ? `; ${m.note}` : ""}; roles ${roles.join(", ") || "none"}`,
    };
  }
  return caps;
}

/** Whether a machine answers over SSH at all: what a role's preference order is tried with. */
export async function sshAnswers(machine: Machine, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const run = await deps.exec(machine.ssh, "true", signal ? { signal } : {});
    if (run.code === 0) return { ok: true };
    return { ok: false, reason: run.stderr.split("\n").filter((l) => l.trim() && !l.startsWith("** ")).pop() ?? `exit ${run.code}` };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export { gpuLockOf };
