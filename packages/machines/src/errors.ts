/** A failure with a code a caller can act on: `ssh-unavailable`, `bad-machines-file`, `no-machine`, `tunnel-failed`, `lock-failed`. */
export class MachineError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "MachineError";
  }
}
