// ---------------------------------------------------------------------------
// Clock and sleep, injectable
// ---------------------------------------------------------------------------
// A splat takes a quarter of an hour. A test of the wait must not.
// ---------------------------------------------------------------------------

import { AtlasCancelledError } from "./errors.js";
import type { Clock, Sleeper } from "./types.js";

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }
}

/** A clock a test moves by hand. */
export class ManualClock implements Clock {
  constructor(private ms = 0) {}

  nowMs(): number {
    return this.ms;
  }

  tick(ms: number): void {
    this.ms += ms;
  }
}

export class SystemSleeper implements Sleeper {
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new AtlasCancelledError("cancelled while waiting"));
      const onAbort = () => {
        clearTimeout(timer);
        reject(new AtlasCancelledError("cancelled while waiting"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, Math.max(0, ms));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/** Returns at once and remembers what it was asked; moves a ManualClock when given one. */
export class NoopSleeper implements Sleeper {
  public readonly slept: number[] = [];

  constructor(private readonly clock?: ManualClock) {}

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new AtlasCancelledError("cancelled while waiting");
    this.slept.push(ms);
    this.clock?.tick(ms);
  }
}
