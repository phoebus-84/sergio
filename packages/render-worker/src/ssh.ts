// The SSH transport lives in @av/machines, which every tool that reaches
// another machine shares. Here it keeps render-worker's error: an ssh that
// cannot run is no engine.

import { MachineError, sshExec as machineSshExec, type Exec, type SshOptions } from "@av/machines";
import { RenderWorkerError } from "./protocol.js";

export { shellPath, shellQuote, SSH_FAILED, sshArgs, type Exec, type ExecInput, type ExecResult, type SshOptions } from "@av/machines";

export function sshExec(options: SshOptions = {}): Exec {
  const exec = machineSshExec(options);
  return (destination, command, input) => exec(destination, command, input).catch((e: unknown) => {
    throw e instanceof MachineError ? new RenderWorkerError("no-engine", e.message) : e;
  });
}
