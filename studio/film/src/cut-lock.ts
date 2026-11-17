// ---------------------------------------------------------------------------
// One writer at a time on a unit's cut, across processes
// ---------------------------------------------------------------------------
// The gateway writes a person's edit and the agent writes its own, from two
// processes, sometimes in the same second. A revision check and a write that
// are not held together let both read revision 5, both pass, and both write
// revision 6: the second replaces the first and nobody is told.
//
// `wx` is the arbitration, as in the runtime's FileLock: the filesystem
// decides who holds the cut, not the caller. The lock is held for the few
// milliseconds a read, a check and a write take, so a holder that waited
// longer than HOLD_MS crashed; its lockfile is then reclaimed. A holder
// verifies it still holds the lock before it writes, so a reclaimed holder
// that was only slow refuses its own write rather than land on top of the
// one that replaced it.
//
// Per-machine, like the runtime's lock. Synchronous, because every write of
// a cut is.
// ---------------------------------------------------------------------------

import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { FilmError } from "./units.js";

/** Longer than any write of a cut takes; a lockfile older than this was left by a crash. */
const HOLD_MS = 15_000;
/** How long a writer waits for another to finish before it gives up. */
const WAIT_MS = 10_000;
const STEP_MS = 15;

interface Holder {
  token: string;
  pid: number;
  expiresAt: number;
}

const pause = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms: number): void => void Atomics.wait(pause, 0, 0, ms);

/** When the lockfile stops counting, or null when there is none. A file that cannot be read counts from when it was written. */
function heldUntil(file: string): { until: number; token: string | null } | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const holder = JSON.parse(raw) as Partial<Holder>;
    if (typeof holder.token === "string" && typeof holder.expiresAt === "number" && Number.isFinite(holder.expiresAt)) {
      return { until: holder.expiresAt, token: holder.token };
    }
  } catch {
    // Half a lockfile: its writer was between creating it and filling it, or crashed there.
  }
  try {
    return { until: statSync(file).mtimeMs + HOLD_MS, token: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function take(file: string, token: string): boolean {
  let descriptor: number;
  try {
    descriptor = openSync(file, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(descriptor, JSON.stringify({ token, pid: process.pid, expiresAt: Date.now() + HOLD_MS } satisfies Holder));
  } finally {
    closeSync(descriptor);
  }
  return true;
}

export interface CutLockOptions {
  /** How long to wait for another writer. Default ten seconds. */
  waitMs?: number;
}

/**
 * Run `work` as the only writer of `target` on this machine. `work` is given
 * `stillHeld`, to call just before it writes: it throws when the lock was
 * taken from a holder that overstayed.
 */
export function withCutLock<T>(target: string, label: string, work: (stillHeld: () => void) => T, options: CutLockOptions = {}): T {
  const file = `${target}.lock`;
  const token = randomUUID();
  const deadline = Date.now() + (options.waitMs ?? WAIT_MS);
  mkdirSync(dirname(target), { recursive: true });

  while (!take(file, token)) {
    const held = heldUntil(file);
    if (held && held.until <= Date.now()) {
      // Left by a crash. Whoever removes it, exactly one of the waiting writers wins the next `wx`.
      try {
        unlinkSync(file);
      } catch { /* another writer removed it first */ }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new FilmError(`the cut of ${label} is being written by someone else and did not come free: try again`, "cut-busy");
    }
    sleep(STEP_MS);
  }

  const stillHeld = (): void => {
    if (heldUntil(file)?.token !== token) {
      throw new FilmError(`the cut of ${label} was not written: this write took too long and another took its place. Read the cut again and repeat the edit`, "cut-busy");
    }
  };
  try {
    return work(stillHeld);
  } finally {
    if (heldUntil(file)?.token === token) {
      try {
        unlinkSync(file);
      } catch { /* already gone */ }
    }
  }
}
