// Whether a machine answers over SSH, and what it is: its system, its cores,
// and the version of the Blender its blender role names. One SSH command, so
// a report on several machines costs one connection each.

import type { Machine } from "./file.js";
import { shellPath, SSH_FAILED, type Exec } from "./ssh.js";

export interface MachineProbe {
  name: string;
  ssh: string;
  reachable: boolean;
  /** Why not, when it is not. */
  reason?: string;
  /** `uname -sm`. */
  system?: string;
  cores?: number;
  /** The first line of `<bin> --version`, or null when that Blender did not answer. */
  blender?: string | null;
}

export function probeCommand(machine: Machine): string {
  const lines = [
    `printf 'system=%s\\n' "$(uname -sm)"`,
    `printf 'cores=%s\\n' "$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null)"`,
  ];
  const blender = machine.roles.blender?.bin;
  if (blender) lines.push(`printf 'blender=%s\\n' "$(${shellPath(blender)} --version 2>/dev/null | head -n 1)"`);
  return lines.join("; ");
}

export function parseProbe(stdout: string): Pick<MachineProbe, "system" | "cores" | "blender"> {
  const facts: Pick<MachineProbe, "system" | "cores" | "blender"> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const [, key, value = ""] = /^(system|cores|blender)=(.*)$/.exec(line) ?? [];
    if (key === "system" && value) facts.system = value.trim();
    if (key === "cores" && /^\d+$/.test(value.trim())) facts.cores = Number(value.trim());
    if (key === "blender") facts.blender = value.trim() || null;
  }
  return facts;
}

/** Asks `machine` what it is. Never throws: an unreachable machine is a result. */
export async function probeMachine(exec: Exec, machine: Machine, options: { signal?: AbortSignal } = {}): Promise<MachineProbe> {
  const base = { name: machine.name, ssh: machine.ssh };
  try {
    const run = await exec(machine.ssh, probeCommand(machine), options.signal ? { signal: options.signal } : {});
    if (run.code === SSH_FAILED) {
      const said = run.stderr.split("\n").filter((l) => l.trim() && !l.startsWith("** ")).pop();
      return { ...base, reachable: false, reason: said ?? "ssh could not connect" };
    }
    return { ...base, reachable: true, ...parseProbe(run.stdout) };
  } catch (e) {
    return { ...base, reachable: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
