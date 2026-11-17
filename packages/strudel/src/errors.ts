export type StrudelErrorCode = "no-browser" | "bad-options" | "bad-code" | "render-failed" | "timeout" | "aborted";

export class StrudelError extends Error {
  constructor(readonly code: StrudelErrorCode, message: string) {
    super(message);
    this.name = "StrudelError";
  }
}
