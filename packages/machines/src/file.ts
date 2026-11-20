// The machines file: which machines exist, how SSH reaches each, what each is
// for, and in which order to use them (ADR-0055). The caller names the file;
// this package reads no environment for it.
//
//   {
//     "machines": {
//       "<name>": {
//         "ssh": "<alias or [user@]host>",
//         "note": "…",
//         "roles": {
//           "remotion":  { "repo", "cache", "speed" },
//           "blender":   { "bin", "repo", "cache", "gpuLock" },
//           "comfyui":   { "port", "host", "url", "gpuLock" },
//           "heavy-cpu": {},
//           "heavy-gpu": { "gpuLock" }
//         }
//       }
//     },
//     "prefer": { "<role>": ["<name>" | "local", …] }
//   }
//
// A field the loader does not know is an error, so a secret pasted in by
// mistake is reported rather than kept. Keys starting with "$" are comments.

import { existsSync, readFileSync } from "node:fs";
import { MachineError } from "./errors.js";

export const ROLES = ["remotion", "blender", "comfyui", "heavy-cpu", "heavy-gpu"] as const;
export type Role = (typeof ROLES)[number];

/** Roles that are a server to reach rather than a process to run: never "local" by default. */
export const SERVICE_ROLES: readonly Role[] = ["comfyui"];

/** This machine, in a preference list. */
export const LOCAL = "local";

export interface RemotionRole {
  /** The engine's clone. */
  repo?: string;
  /** The engine's render cache root. */
  cache?: string;
  /** A fixed weight for shared renders, instead of the measured speed. */
  speed?: number;
}

export interface BlenderRole {
  /** The Blender to run there. */
  bin: string;
  repo?: string;
  cache?: string;
  gpuLock?: string;
}

export interface ComfyUiRole {
  /** The port it listens on there. Default 8188. */
  port?: number;
  /** The address it listens on there. Default 127.0.0.1. */
  host?: string;
  /** The server as reached directly from here: no tunnel. */
  url?: string;
  gpuLock?: string;
}

export interface HeavyRole {
  gpuLock?: string;
}

export interface RoleSettings {
  remotion: RemotionRole;
  blender: BlenderRole;
  comfyui: ComfyUiRole;
  "heavy-cpu": Record<string, never>;
  "heavy-gpu": HeavyRole;
}

export interface Machine {
  name: string;
  /** What ssh connects to: an alias of ~/.ssh/config or [user@]host. */
  ssh: string;
  note?: string;
  roles: { [R in Role]?: RoleSettings[R] };
}

export interface Machines {
  /** The file read; null when there was none. */
  file: string | null;
  /** In the file's order. */
  machines: Machine[];
  prefer: { [R in Role]?: string[] };
}

export const NO_MACHINES: Machines = Object.freeze({ file: null, machines: [], prefer: {} }) as Machines;

export const DEFAULT_COMFYUI_PORT = 8188;
export const DEFAULT_COMFYUI_HOST = "127.0.0.1";

type Field = "path" | "string" | "port" | "url" | "positive";
const ROLE_FIELDS: { [R in Role]: Record<string, Field> } = {
  remotion: { repo: "path", cache: "path", speed: "positive" },
  blender: { bin: "path", repo: "path", cache: "path", gpuLock: "path" },
  comfyui: { port: "port", host: "string", url: "url", gpuLock: "path" },
  "heavy-cpu": {},
  "heavy-gpu": { gpuLock: "path" },
};
const REQUIRED: { [R in Role]?: string[] } = { blender: ["bin"] };

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** An ssh destination, never an option: no leading "-", no spaces, nothing a shell would read. */
const DESTINATION = /^[A-Za-z0-9_[][A-Za-z0-9._@:%+[\]-]*$/;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (o: Record<string, unknown>) => Object.keys(o).filter((k) => !k.startsWith("$"));

function checkField(kind: Field, value: unknown): string | null {
  switch (kind) {
    case "path":
    case "string":
      return typeof value === "string" && value.trim() !== "" && !/[\n\0]/.test(value) ? null : "is not a non-empty string";
    case "port":
      return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535 ? null : "is not a port (1–65535)";
    case "positive":
      return typeof value === "number" && Number.isFinite(value) && value > 0 ? null : "is not a positive number";
    case "url":
      if (typeof value !== "string") return "is not a URL";
      try {
        return /^https?:$/.test(new URL(value).protocol) ? null : "is not an http(s) URL";
      } catch {
        return "is not a URL";
      }
  }
}

/** Checks a parsed file; every problem at once, each with its path. */
export function parseMachines(value: unknown, file: string | null = null): Machines {
  const problems: string[] = [];
  const machines: Machine[] = [];
  const prefer: Machines["prefer"] = {};
  if (!isObject(value)) throw new MachineError("bad-machines-file", `${file ?? "machines"}: not a JSON object`);
  for (const k of keys(value)) if (!["machines", "prefer", "version"].includes(k)) problems.push(`${k}: unknown field`);
  if (value.version !== undefined && value.version !== 1) problems.push("version: only 1 is known");

  const declared = value.machines ?? {};
  if (!isObject(declared)) problems.push("machines: not an object");
  else {
    for (const name of keys(declared)) {
      const at = `machines.${name}`;
      const raw = declared[name];
      if (!NAME.test(name)) problems.push(`${at}: a name is letters, digits, ".", "_" and "-"`);
      if (name.toLowerCase() === LOCAL) problems.push(`${at}: "${LOCAL}" is this machine, not a name to give another`);
      if (!isObject(raw)) {
        problems.push(`${at}: not an object`);
        continue;
      }
      for (const k of keys(raw)) if (!["ssh", "note", "roles"].includes(k)) problems.push(`${at}.${k}: unknown field`);
      if (typeof raw.ssh !== "string" || !DESTINATION.test(raw.ssh)) {
        problems.push(`${at}.ssh: an SSH alias or [user@]host, with no options (put those in ~/.ssh/config)`);
      }
      if (raw.note !== undefined && typeof raw.note !== "string") problems.push(`${at}.note: not a string`);
      const roles: Machine["roles"] = {};
      if (raw.roles !== undefined && !isObject(raw.roles)) problems.push(`${at}.roles: not an object`);
      else {
        for (const role of keys(raw.roles ?? {})) {
          const settings = (raw.roles as Record<string, unknown>)[role];
          const rat = `${at}.roles.${role}`;
          if (!(ROLES as readonly string[]).includes(role)) {
            problems.push(`${rat}: unknown role (${ROLES.join(", ")})`);
            continue;
          }
          if (!isObject(settings)) {
            problems.push(`${rat}: not an object ({} for no settings)`);
            continue;
          }
          const fields = ROLE_FIELDS[role as Role];
          for (const k of keys(settings)) {
            const kind = fields[k];
            if (!kind) {
              problems.push(`${rat}.${k}: unknown field${Object.keys(fields).length ? ` (${Object.keys(fields).join(", ")})` : ""}`);
              continue;
            }
            const wrong = checkField(kind, settings[k]);
            if (wrong) problems.push(`${rat}.${k}: ${wrong}`);
          }
          for (const k of REQUIRED[role as Role] ?? []) if (settings[k] === undefined) problems.push(`${rat}.${k}: required`);
          if (role === "comfyui" && settings.url !== undefined && (settings.port !== undefined || settings.host !== undefined)) {
            problems.push(`${rat}: url, or port and host for a tunnel, not both`);
          }
          const own = Object.fromEntries(keys(settings).map((k) => [k, settings[k]]));
          (roles as Record<string, unknown>)[role] = own;
        }
      }
      machines.push({ name, ssh: String(raw.ssh), ...(typeof raw.note === "string" ? { note: raw.note } : {}), roles });
    }
  }

  const wanted = value.prefer ?? {};
  if (!isObject(wanted)) problems.push("prefer: not an object");
  else {
    for (const role of keys(wanted)) {
      const at = `prefer.${role}`;
      const list = wanted[role];
      if (!(ROLES as readonly string[]).includes(role)) {
        problems.push(`${at}: unknown role (${ROLES.join(", ")})`);
        continue;
      }
      if (!Array.isArray(list) || list.some((n) => typeof n !== "string")) {
        problems.push(`${at}: a list of machine names and "${LOCAL}"`);
        continue;
      }
      const seen = new Set<string>();
      for (const name of list as string[]) {
        if (seen.has(name)) problems.push(`${at}: ${name} twice`);
        seen.add(name);
        if (name === LOCAL) {
          if (SERVICE_ROLES.includes(role as Role)) problems.push(`${at}: ${role} is a server on a machine; "${LOCAL}" is not one (name its address in the tool's own settings)`);
          continue;
        }
        const machine = machines.find((m) => m.name === name);
        if (!machine) problems.push(`${at}: no machine is called ${name}`);
        else if (!machine.roles[role as Role]) problems.push(`${at}: ${name} has no ${role} role`);
      }
      prefer[role as Role] = [...seen];
    }
  }

  if (problems.length > 0) {
    throw new MachineError("bad-machines-file", `${file ?? "machines"} is not valid: ${problems.join("; ")}`);
  }
  return { file, machines, prefer };
}

/**
 * The machines `file` declares. A missing file is no machines unless
 * `required` (a file the operator named explicitly must exist).
 */
export function readMachines(file: string | undefined, options: { required?: boolean } = {}): Machines {
  if (!file) return NO_MACHINES;
  if (!existsSync(file)) {
    if (options.required) throw new MachineError("bad-machines-file", `${file} does not exist`);
    return NO_MACHINES;
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf-8"));
  } catch (e) {
    throw new MachineError("bad-machines-file", `${file} is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseMachines(value, file);
}

export function findMachine(machines: Machines, name: string): Machine | undefined {
  return machines.machines.find((m) => m.name.toLowerCase() === name.toLowerCase());
}

/** The machines with `role`, in the file's order. */
export function machinesWith(machines: Machines, role: Role): Machine[] {
  return machines.machines.filter((m) => m.roles[role] !== undefined);
}

/** The GPU lock a role's work takes on a machine, if any. */
export function gpuLockOf(machine: Machine, role: Role): string | undefined {
  const settings = machine.roles[role] as { gpuLock?: string } | undefined;
  return settings?.gpuLock;
}
