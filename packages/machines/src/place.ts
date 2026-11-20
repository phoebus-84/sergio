// Where to run a role: the places the file prefers, in order, and the first
// that answers. "local" is this machine and always answers. Without a
// preference, a role run as a process stays here (declaring a machine never
// moves work by itself); a service is looked for on the machines that offer it.

import { MachineError } from "./errors.js";
import { findMachine, LOCAL, machinesWith, SERVICE_ROLES, type Machine, type Machines, type Role } from "./file.js";

export type Place = { kind: "local" } | { kind: "machine"; machine: Machine };

export const HERE: Place = Object.freeze({ kind: "local" });

export function placeName(place: Place): string {
  return place.kind === "local" ? LOCAL : place.machine.name;
}

/** The places to try for `role`, in order. */
export function candidates(machines: Machines, role: Role): Place[] {
  const prefer = machines.prefer[role];
  if (prefer) {
    return prefer.map((name) => {
      if (name === LOCAL) return HERE;
      const machine = findMachine(machines, name);
      // parseMachines refuses a name it does not know; a hand-built Machines may not
      if (!machine) throw new MachineError("bad-machines-file", `prefer.${role} names ${name}, which is not declared`);
      return { kind: "machine", machine } as Place;
    });
  }
  if (SERVICE_ROLES.includes(role)) return machinesWith(machines, role).map((machine) => ({ kind: "machine", machine }));
  return [HERE];
}

export type Answer = { ok: true } | { ok: false; reason: string };

export interface Placement {
  place: Place;
  /** The places tried before it, and why each was passed over. */
  skipped: { name: string; reason: string }[];
}

/**
 * The first place for `role` that answers `probe`, tried in order (this
 * machine is not probed). Throws `no-machine` with every reason when none does.
 */
export async function place(machines: Machines, role: Role, probe: (machine: Machine) => Promise<Answer>): Promise<Placement> {
  const skipped: Placement["skipped"] = [];
  const places = candidates(machines, role);
  for (const p of places) {
    if (p.kind === "local") return { place: p, skipped };
    let answer: Answer;
    try {
      answer = await probe(p.machine);
    } catch (e) {
      answer = { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    if (answer.ok) return { place: p, skipped };
    skipped.push({ name: p.machine.name, reason: answer.reason });
  }
  throw new MachineError(
    "no-machine",
    places.length === 0
      ? `no machine has the ${role} role${machines.file ? ` in ${machines.file}` : " (no machines file)"}`
      : `no machine for ${role} answered: ${skipped.map((s) => `${s.name}: ${s.reason}`).join("; ")}`,
  );
}
