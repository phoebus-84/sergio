import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { holdLock, lockCommand, withLock } from "../src/index.js";
import { localShell } from "./helpers.js";

const lockPath = () => path.join(mkdtempSync(path.join(tmpdir(), "machines-lock-")), "gpu", "generation.lock");

test("the lock is flock on the machine, its folder made, ~ left to the shell", () => {
  assert.equal(lockCommand("~/ai/generation.lock", 900), "mkdir -p ~/ai && exec flock -x -w 900 ~/ai/generation.lock sh -c 'echo locked; exec cat >/dev/null'");
});

test("a held lock makes the next one wait, and releasing lets it through", async () => {
  const exec = localShell();
  const file = lockPath();
  const first = await holdLock(exec, "gpu-box", file);
  let second = false;
  const waiting = holdLock(exec, "gpu-box", file).then((l) => {
    second = true;
    return l;
  });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(second, false, "the second waits while the first holds it");
  await first.release();
  const next = await waiting;
  assert.equal(second, true);
  await next.release();
});

test("a lock held past the wait fails with lock-failed", async () => {
  const exec = localShell();
  const file = lockPath();
  const held = await holdLock(exec, "gpu-box", file);
  await assert.rejects(holdLock(exec, "gpu-box", file, { waitSeconds: 0 }), (e: Error & { code?: string }) => e.code === "lock-failed" && /stayed held by another job for 0 s/.test(e.message));
  await held.release();
});

test("an unreachable machine cannot be locked", async () => {
  await assert.rejects(holdLock(localShell({ unreachable: new Set(["gpu-box"]) }), "gpu-box", "~/x.lock"), /ssh could not connect/);
});

test("withLock holds it for the work, even when the work fails, and skips it without a path", async () => {
  const exec = localShell();
  const file = lockPath();
  await assert.rejects(withLock(exec, "gpu-box", file, async () => {
    throw new Error("work failed");
  }), /work failed/);
  assert.equal(await withLock(exec, "gpu-box", file, async () => "done", { waitSeconds: 0 }), "done");
  const before = exec.calls.length;
  assert.equal(await withLock(exec, "gpu-box", undefined, async () => 7), 7);
  assert.equal(exec.calls.length, before);
});
