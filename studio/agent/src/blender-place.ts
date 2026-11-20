// ---------------------------------------------------------------------------
// Where the Blender tools run (ADR-0056)
// ---------------------------------------------------------------------------
// pva_stage_shot, pva_rig_shot, pva_rig_sheet and pva_blender_render run on
// the first place of the machines file's prefer.blender that can: a machine
// with the blender role whose Blender is one the tools take, or "local" (this
// machine). Without prefer.blender they run here, as before the file existed.
// A tool's `machine` parameter names the place instead.
//
// On a machine, the job goes through @av/render-worker: the code by git push
// to its engine clone, the files by content, the machine's own Blender and
// GPU lock, the output brought back whole and checked. The tool then does
// exactly what it does with a local result, and records where it ran.
// ---------------------------------------------------------------------------

import { Type } from "typebox";
import { blenderVersionSupport } from "@av/blender";
import { findMachine, LOCAL, place, probeMachine, type Machine } from "@av/machines";
import { DEFAULT_REPO, probeEngine, runBlenderRemote, type BlenderKind, type BlenderMachine, type EngineTarget } from "@av/render-worker";
import { machineDeps, studioMachines } from "./machines.js";

/** How long a Blender job waits for a machine's GPU lock: as long as a long staged shot may hold it. */
export const BLENDER_LOCK_WAIT_SECONDS = 3600;

export const MACHINE_PARAM = Type.Optional(Type.String({
  description: "Where Blender runs: \"local\" (this machine) or a machine of the library's machines file with the blender role. " +
    "Omitted, the file's prefer.blender decides (here when it says nothing). Pass it only when the operator asks for a place",
}));

export type BlenderPlace =
  | { kind: "local"; skipped: { name: string; reason: string }[] }
  | { kind: "machine"; machine: Machine; target: EngineTarget; bin: string; gpuLock?: string; skipped: { name: string; reason: string }[] };

/** The engine a blender machine runs jobs with: its role's clone and cache, else its remotion role's. */
export function blenderTarget(machine: Machine): EngineTarget {
  const role = machine.roles.blender!;
  const remotion = machine.roles.remotion ?? {};
  const cache = role.cache ?? remotion.cache;
  return { name: machine.name, destination: machine.ssh, repo: role.repo ?? remotion.repo ?? DEFAULT_REPO, ...(cache ? { cache } : {}) };
}

/** Whether a blender machine can take a job now: it answers, its Blender is one the tools take, and its clone is there. */
export async function blenderMachineAnswers(machine: Machine, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { exec } = machineDeps();
  const probe = await probeMachine(exec, machine, signal ? { signal } : {});
  if (!probe.reachable) return { ok: false, reason: probe.reason ?? "does not answer over SSH" };
  if (!probe.blender) return { ok: false, reason: `${machine.roles.blender!.bin} did not answer there` };
  const support = blenderVersionSupport(probe.blender);
  if (!support.supported) return { ok: false, reason: `${probe.blender} is not a Blender the tools take (4.2–4.x or 5.2.x LTS)` };
  const engine = await probeEngine(exec, blenderTarget(machine));
  // A clone that answers SSH but not yet as an engine is brought to this commit by the job.
  if (!engine.ok && !engine.reachable) return { ok: false, reason: engine.reason };
  return { ok: true };
}

/** Where a Blender job runs: `asked` ("local" or a machine), else prefer.blender, else here. */
export async function placeBlender(libraryRoot: string, asked?: string, signal?: AbortSignal): Promise<BlenderPlace> {
  const machines = studioMachines(libraryRoot);
  const chosen = (machine: Machine, skipped: { name: string; reason: string }[]): BlenderPlace => {
    const role = machine.roles.blender!;
    return { kind: "machine", machine, target: blenderTarget(machine), bin: role.bin, ...(role.gpuLock ? { gpuLock: role.gpuLock } : {}), skipped };
  };
  const wanted = asked?.trim();
  if (wanted === LOCAL) return { kind: "local", skipped: [] };
  if (wanted) {
    const machine = findMachine(machines, wanted);
    if (!machine) throw new Error(`there is no machine "${wanted}" in the library's machines file`);
    if (!machine.roles.blender) throw new Error(`${wanted} has no blender role in the library's machines file`);
    const answer = await blenderMachineAnswers(machine, signal);
    if (!answer.ok) throw new Error(`${wanted} cannot run Blender now: ${answer.reason}`);
    return chosen(machine, []);
  }
  const placed = await place(machines, "blender", (m) => (m.roles.blender ? blenderMachineAnswers(m, signal) : Promise.resolve({ ok: false as const, reason: "no blender role" })));
  return placed.place.kind === "local" ? { kind: "local", skipped: placed.skipped } : chosen(placed.place.machine, placed.skipped);
}

/** A unit's folder on the engine: three plain names, as render-worker keys go. */
export function blenderKey(channel: string, series: string, episode: string): string {
  const plain = (s: string) => (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s) && !s.includes("..") ? s : `u${s.replace(/[^A-Za-z0-9._-]/g, "-")}`);
  return [channel, series, episode].map(plain).join("/");
}

/** What a tool says about where its Blender ran: nothing when it ran here and no machine was passed over. */
export function placeLines(where: BlenderPlace, ran?: BlenderMachine): string[] {
  const skipped = where.skipped.length > 0 ? `; passed over ${where.skipped.map((s) => `${s.name} (${s.reason})`).join(", ")}` : "";
  if (where.kind === "local") return skipped ? [`   Blender ran on this machine${skipped}`] : [];
  const sent = ran && ran.sentFiles > 0 ? `, ${ran.sentFiles} file(s) sent` : "";
  return [`   Blender ran on ${where.machine.name} (${ran?.blender ?? where.bin}${where.gpuLock ? `, GPU lock ${where.gpuLock}` : ""}${sent})${skipped}`];
}

/**
 * Runs `kind` where `where` says: `local` is the @av/blender function itself;
 * a machine runs the same function there. The result is the function's, plus
 * `machine` when it ran elsewhere.
 */
export async function runBlenderAt<T extends object>(
  where: BlenderPlace,
  kind: BlenderKind,
  request: object & { outputDir: string },
  local: () => Promise<T>,
  options: { key: string; allowedRoots: string[]; signal?: AbortSignal; onLog?: (line: string) => void; timeoutMs?: number | undefined },
): Promise<T & { machine?: BlenderMachine }> {
  if (where.kind === "local") return local();
  return runBlenderRemote<T>(kind, request, {
    target: where.target, key: options.key, bin: where.bin,
    ...(where.gpuLock ? { gpuLock: where.gpuLock, lockWaitSeconds: BLENDER_LOCK_WAIT_SECONDS } : {}),
    allowedRoots: options.allowedRoots, exec: machineDeps().exec,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onLog ? { onLog: options.onLog } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}
