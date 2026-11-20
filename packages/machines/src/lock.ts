// A GPU lock on another machine: flock(1) on a path there, held by an SSH
// session for as long as the work lasts. Closing the session releases it,
// so a crash here cannot leave it held. It means something only if the
// machine's other GPU jobs take the same lock with flock.

import { PassThrough, Writable } from "node:stream";
import { MachineError } from "./errors.js";
import { shellPath, SSH_FAILED, type Exec, type ExecResult } from "./ssh.js";

export interface HeldLock {
  /** Releases the lock and waits for the session to end. */
  release(): Promise<void>;
}

export const DEFAULT_LOCK_WAIT_SECONDS = 900;
const LOCKED = "locked";

export function lockCommand(path: string, waitSeconds: number): string {
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) || "/" : ".";
  return [
    `mkdir -p ${shellPath(parent)}`,
    `exec flock -x -w ${Math.max(0, Math.floor(waitSeconds))} ${shellPath(path)} sh -c 'echo ${LOCKED}; exec cat >/dev/null'`,
  ].join(" && ");
}

/**
 * Takes the lock at `path` on `destination`, waiting up to `waitSeconds`
 * for whoever holds it.
 */
export async function holdLock(
  exec: Exec,
  destination: string,
  path: string,
  options: { waitSeconds?: number; signal?: AbortSignal; onWaiting?: () => void } = {},
): Promise<HeldLock> {
  const waitSeconds = options.waitSeconds ?? DEFAULT_LOCK_WAIT_SECONDS;
  const stdin = new PassThrough();
  let output = "";
  let onLocked: () => void = () => undefined;
  const locked = new Promise<void>((resolve) => (onLocked = resolve));
  const stdout = new Writable({
    write(chunk: Buffer, _encoding, done) {
      output += chunk.toString("utf-8");
      if (output.split("\n").some((l) => l.trim() === LOCKED)) onLocked();
      done();
    },
  });
  const waiting = setTimeout(() => options.onWaiting?.(), 1000);
  const session: Promise<ExecResult> = exec(destination, lockCommand(path, waitSeconds), {
    stdin,
    stdout,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const ended = session.then(
    (run) => ({ run, error: null as unknown }),
    (error: unknown) => ({ run: null, error }),
  );
  const first = await Promise.race([locked.then(() => "locked" as const), ended]);
  clearTimeout(waiting);
  if (first !== "locked") {
    stdin.end();
    if (first.error) throw first.error;
    const run = first.run!;
    const said = run.stderr.split("\n").filter((l) => l.trim() && !l.startsWith("** ")).pop();
    throw new MachineError(
      "lock-failed",
      run.code === 1 && !said
        ? `${destination}: ${path} stayed held by another job for ${waitSeconds} s`
        : `${destination}: could not take the lock ${path} (exit ${run.code}${run.code === SSH_FAILED ? ", ssh could not connect" : ""})${said ? `: ${said}` : ""}`,
    );
  }
  return {
    async release() {
      stdin.end();
      await ended;
    },
  };
}

/** Runs `work` holding the lock at `path` on `destination`, or without a lock when there is no path. */
export async function withLock<T>(
  exec: Exec,
  destination: string,
  path: string | undefined,
  work: () => Promise<T>,
  options: { waitSeconds?: number; signal?: AbortSignal; onWaiting?: () => void } = {},
): Promise<T> {
  if (!path) return work();
  const lock = await holdLock(exec, destination, path, options);
  try {
    return await work();
  } finally {
    await lock.release();
  }
}
