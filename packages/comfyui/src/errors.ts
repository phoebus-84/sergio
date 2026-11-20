/** Why a ComfyUI call failed; `code` is what callers branch on. */
export type ComfyUiErrorCode =
  | "not-configured" // no server address was given
  | "unreachable"    // no connection was made: nothing was queued
  | "bad-request"    // refused before anything ran: a wrong value, or a graph the server does not accept
  | "missing-node"   // the server has no node of a class the workflow needs
  | "missing-model"  // the server's loader node does not list a model file the workflow needs
  | "failed"         // the graph was queued and a node raised while it ran
  | "timeout"        // the graph did not finish in the time allowed
  | "aborted"        // the caller's signal stopped the wait
  | "no-output"      // the graph finished without a file it should have saved
  | "server";        // any other answer that is not a success

export class ComfyUiError extends Error {
  constructor(readonly code: ComfyUiErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = "ComfyUiError";
  }
}
