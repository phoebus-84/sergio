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

  constructor(status: number, responseBody: string, what: string, retryAfterSeconds: number | null = null) {
    super(`Atlas answered HTTP ${status} to ${what}: ${responseBody.slice(0, 400)}`, "ATLAS_HTTP", status === 429 || status === 502 || status === 503 || status === 504, { status });
    this.name = "AtlasHttpError";
    this.status = status;
    this.responseBody = responseBody;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  /** The provider refused the request as it was: it did no work. */
  get refused(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
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
  /** What the provider says the run was charged, in credits; null when it does not say. */
  public readonly credits: number | null;

  constructor(operationId: string, state: "failed" | "cancelled", providerCode: string | null, providerMessage: string, credits: number | null = null) {
    super(`Atlas operation ${operationId} ${state}: ${providerMessage}`, state === "failed" ? "ATLAS_OPERATION_FAILED" : "ATLAS_OPERATION_CANCELLED", false, { operationId, providerCode });
    this.name = "AtlasOperationError";
    this.operationId = operationId;
    this.credits = credits;
  }
}

/** An answer that could not be understood: the shapes in wire.ts need correcting. */
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
