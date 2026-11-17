// ---------------------------------------------------------------------------
// One render of a film at a time, across processes
// ---------------------------------------------------------------------------
// A film's renders share its units: rendering the film renders its scenes,
// and rendering a scene renders its shots. The gateway already let one render
// of a film run at a time, but it counted its own only, in memory. The agent
// renders from another process (`pva_render_cut`) and so do the stage
// adapters: two of them rendered the same shots twice over, and each then
// pointed the unit at its own result.
//
// The lease is a file in the film, taken with `wx` like the runtime's lock,
// so every process that renders sees it. Its holder touches it every few
// seconds while it renders; a lease nobody touched for LAPSE_MS, or whose
// process is gone, was left by a crash and is taken over. A render is not
// queued behind another: it is refused, and says what is being rendered.
// ---------------------------------------------------------------------------

import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { filmPath } from "@studio/contracts/src/layout.mjs";
import { FilmError, unitKey, unitLabel, type UnitRef } from "./units.js";

/** Where a film keeps what a render in progress needs, beside its units' own. */
const LEASE_PATH = join(".cut", "render.lease.json");
const BEAT_MS = 2_000;
const LAPSE_MS = 20_000;

export interface RenderLease {
  /** The unit being rendered, as `film/scene/shot`. */
  unit: string;
  quality: "final" | "preview";
  startedAt: string;
  pid: number;
  host: string;
}

interface Held extends RenderLease {
  token: string;
}

const leaseFile = (root: string, film: string): string => join(filmPath(root, film), LEASE_PATH);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: there is such a process, and it is someone else's.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The lease on disk when someone still holds it; null when there is none or it was left behind. */
function held(file: string): Held | null {
  let lease: Partial<Held>;
  let touched: number;
  try {
    touched = statSync(file).mtimeMs;
    lease = JSON.parse(readFileSync(file, "utf-8")) as Partial<Held>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Half a lease: its writer is between creating it and filling it, or crashed there.
    try {
      return Date.now() - statSync(file).mtimeMs < LAPSE_MS ? { token: "", unit: "?", quality: "final", startedAt: "", pid: 0, host: "" } : null;
    } catch {
      return null;
    }
  }
  if (typeof lease.token !== "string" || typeof lease.unit !== "string" || typeof lease.pid !== "number") return null;
  if (Date.now() - touched >= LAPSE_MS) return null;
  if (lease.host === hostname() && !alive(lease.pid)) return null;
  return lease as Held;
}

/** What is being rendered of a film right now, by any process on this machine; null when nothing is. */
export function readRenderLease(root: string, film: string): RenderLease | null {
  const lease = held(leaseFile(root, film));
  if (!lease) return null;
  const { token: _token, ...rest } = lease;
  return rest;
}

/**
 * Render `ref` as the only render of its film on this machine. Refused, with
 * what is being rendered, when another holds the film.
 */
export async function withRenderLease<T>(root: string, ref: UnitRef, quality: "final" | "preview", work: () => Promise<T>): Promise<T> {
  const file = leaseFile(root, ref.channel);
  const mine: Held = { token: randomUUID(), unit: unitKey(ref), quality, startedAt: new Date().toISOString(), pid: process.pid, host: hostname() };
  mkdirSync(dirname(file), { recursive: true });

  const take = (): boolean => {
    let descriptor: number;
    try {
      descriptor = openSync(file, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    try {
      writeSync(descriptor, JSON.stringify(mine));
    } finally {
      closeSync(descriptor);
    }
    return true;
  };

  if (!take()) {
    const other = held(file);
    if (other) {
      const who = other.pid === process.pid ? "this process" : `another process (${other.pid})`;
      throw new FilmError(
        `${other.unit} is being rendered (${other.quality}) by ${who} since ${other.startedAt || "a moment ago"}: ${unitLabel(ref)} is not rendered beside it. Wait for it, or stop it`,
        "render-in-progress",
      );
    }
    // Left behind by a crash. Of the renders that find it so, one wins the next `wx`.
    try {
      unlinkSync(file);
    } catch { /* another took it over first */ }
    if (!take()) {
      const winner = held(file);
      throw new FilmError(`${winner?.unit ?? "another unit"} is being rendered by another process: ${unitLabel(ref)} is not rendered beside it. Wait for it, or stop it`, "render-in-progress");
    }
  }

  const beat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(file, now, now);
    } catch { /* the lease is gone: the render finds out when it ends */ }
  }, BEAT_MS);
  beat.unref();
  try {
    return await work();
  } finally {
    clearInterval(beat);
    if (held(file)?.token === mine.token) {
      try {
        unlinkSync(file);
      } catch { /* already gone */ }
    }
  }
}
