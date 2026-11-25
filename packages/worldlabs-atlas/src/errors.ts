// ---------------------------------------------------------------------------
// Errors of the World Labs Atlas adapter
// ---------------------------------------------------------------------------
// Each failure says whether asking again could help (`retryable`) and, where
// money is at stake, whether a job was left running.
// ---------------------------------------------------------------------------

export class AtlasError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly details: Record<string, unknown>;

  constructor(message: string, code: string, retryable = false, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "AtlasError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, retryable: this.retryable, details: this.details };
  }
}

/** No key: a state a caller can branch on, not a failure of a call. */
export class AtlasUnavailableError extends AtlasError {
  constructor(reason: string) {
    super(`World Labs Atlas is unavailable: ${reason}`, "ATLAS_UNAVAILABLE", false, { reason });
    this.name = "AtlasUnavailableError";
  }
}

/** The request was wrong before it left: nothing was sent, nothing spent. */
export class AtlasValidationError extends AtlasError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message, "ATLAS_VALIDATION", false, details);
    this.name = "AtlasValidationError";
  }
}

export class AtlasHttpError extends AtlasError {
  public readonly status: number;
  public readonly responseBody: string;
  /** Seconds the provider asked to wait, from Retry-After. */
  public readonly retryAfterSeconds: number | null;
  /**
   * The provider's own stable word for the refusal, from the body's `code`:
   * RATE_LIMIT_EXCEEDED, CONCURRENCY_LIMIT_EXCEEDED, CREDITS_UNAVAILABLE,
   * SPEND_LIMIT_EXCEEDED, CONTENT_POLICY, REGION_NOT_DECLARED, … Branch on
   * this, never on the message.
   */
  public readonly providerCode: string | null;

  constructor(status: number, responseBody: string, what: string, retryAfterSeconds: number | null = null) {
    // 500 "retry safely", 503 capacity, 504 the gateway's 60 seconds, 429 a limit; 502 a gateway between.
    super(`Atlas answered HTTP ${status} to ${what}: ${responseBody.slice(0, 400)}`, "ATLAS_HTTP", [429, 500, 502, 503, 504].includes(status), { status });
    this.name = "AtlasHttpError";
    this.status = status;
    this.responseBody = responseBody;
    this.retryAfterSeconds = retryAfterSeconds;
    let code: unknown;
    try { code = (JSON.parse(responseBody) as { code?: unknown }).code; } catch { /* not JSON */ }
    this.providerCode = typeof code === "string" ? code : null;
  }

  /** The provider refused the request as it was: it did no work, and asking again unchanged will not help. */
  get refused(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }

  /** The provider turned the request away without taking it: refused, or told to come back later (429). Nothing was started. */
  get notAccepted(): boolean {
    return this.refused || this.status === 429;
  }

  /** The account cannot pay for it now: out of credits, or at a spend limit (402). */
  get unpaid(): boolean {
    return this.status === 402;
  }
}

export class AtlasNetworkError extends AtlasError {
  constructor(cause: string) {
    super(`No answer from Atlas: ${cause}`, "ATLAS_NETWORK", true, { cause });
    this.name = "AtlasNetworkError";
  }
}

export class AtlasCancelledError extends AtlasError {
  /** The job that was running when the caller gave up, if one was. */
  public readonly operationId: string | null;
  /** Whether the provider was asked to stop that job, and took the request. */
  public readonly cancelledThere: boolean;

  constructor(reason = "cancelled", operationId?: string, cancelledThere = false) {
    super(reason, "ATLAS_CANCELLED", false, operationId ? { operationId } : {});
    this.name = "AtlasCancelledError";
    this.operationId = operationId ?? null;
    this.cancelledThere = cancelledThere;
  }
}

/**
 * The wait ran out. A timeout stops the waiting, not the job: the operation
 * named here may still finish, and be charged.
 */
export class AtlasTimeoutError extends AtlasError {
  public readonly operationId: string;

  constructor(operationId: string, waitedMs: number) {
    super(
      `Atlas operation ${operationId} did not finish within ${Math.round(waitedMs / 1000)}s: it is still running there, and may be charged. Wait for it again or cancel it; do not submit it again`,
      "ATLAS_TIMEOUT", true, { operationId, waitedMs },
    );
    this.name = "AtlasTimeoutError";
    this.operationId = operationId;
  }
}

/** The operation ended, and not well. */
export class AtlasOperationError extends AtlasError {
  public readonly operationId: string;
  public readonly state: "failed" | "cancelled";
  /** The provider's specific reason: EXECUTION_FAILED, EXECUTION_TIMEOUT, THROTTLED, CONTENT_POLICY; null when it gave none. */
  public readonly reason: string | null;

  constructor(operationId: string, state: "failed" | "cancelled", reason: string | null, providerMessage: string, rpcCode: number | null = null) {
    super(`Atlas operation ${operationId} ${state}${reason ? ` (${reason})` : ""}: ${providerMessage}`, state === "failed" ? "ATLAS_OPERATION_FAILED" : "ATLAS_OPERATION_CANCELLED", false, { operationId, reason, rpcCode });
    this.name = "AtlasOperationError";
    this.operationId = operationId;
    this.state = state;
    this.reason = reason;
  }
}

/** An answer that is not what the documentation says it is: the shapes in wire.ts need correcting. */
export class AtlasContractError extends AtlasError {
  constructor(what: string, received: unknown) {
    super(`Atlas answered ${what} in a shape this client does not read: ${preview(received)}. Correct packages/worldlabs-atlas/src/wire.ts`, "ATLAS_CONTRACT", false, { what });
    this.name = "AtlasContractError";
  }
}

function preview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text ?? String(value)).slice(0, 300);
}
