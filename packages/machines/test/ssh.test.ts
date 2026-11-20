import assert from "node:assert/strict";
import { test } from "node:test";
import { MachineError, shellPath, shellQuote, sshArgs, sshExec } from "../src/index.js";

test("words for a remote shell are quoted unless plainly safe", () => {
  assert.equal(shellQuote("plain/path-1.2"), "plain/path-1.2");
  assert.equal(shellQuote("it's here"), `'it'\\''s here'`);
  assert.equal(shellQuote("$(rm -rf /)"), `'$(rm -rf /)'`);
  assert.equal(shellPath("~/my studio"), "~/'my studio'");
  assert.equal(shellPath("~"), "~");
});

test("ssh never asks for a password and ends the options before the destination", () => {
  const args = sshArgs("gpu-box", "true", { connectTimeoutSeconds: 3 });
  assert.deepEqual(args.slice(0, 4), ["-o", "BatchMode=yes", "-o", "ConnectTimeout=3"]);
  assert.deepEqual(args.slice(-3), ["--", "gpu-box", "true"]);
});

test("an ssh that cannot run is a MachineError", async () => {
  const exec = sshExec({ program: "/nonexistent/ssh-program" });
  await assert.rejects(exec("gpu-box", "true"), (e: unknown) => e instanceof MachineError && e.code === "ssh-unavailable");
});
