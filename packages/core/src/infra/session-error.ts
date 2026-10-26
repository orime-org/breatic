// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Diagnostics that can cross the session-store boundary into application logs. */
export interface RedactedSessionError extends Error {
  sourceType: string;
  code?: string | number;
  cause?: RedactedSessionError;
}

/**
 * Construct the diagnostic structure before its cause is copied recursively.
 * @param message - The redacted diagnostic message.
 * @param sourceType - The redacted type of the original rejected value.
 * @returns An Error with an explicitly initialized safe cause.
 */
function diagnosticError(message: string, sourceType: string): RedactedSessionError {
  return Object.assign(new Error(message), { sourceType, cause: undefined });
}

/**
 * Copy session-error diagnostics into the fields application loggers serialize.
 * @param error - The value rejected by a session operation.
 * @param secrets - Credentials and Cookie headers held by that operation.
 * @returns An independent Error with redacted diagnostic fields and causes.
 * @throws {URIError} When a supplied secret contains an unpaired surrogate.
 */
export function redactSessionError(error: unknown, secrets: readonly string[]): RedactedSessionError {
  const sensitive = [...new Set(secrets.filter((secret) => secret.length > 0)
    .flatMap((secret) => [secret, encodeURIComponent(secret)]))]
    .sort((left, right) => right.length - left.length);
  const visited = new Set<Error>();

  /**
   * Redact each literal credential form in one diagnostic string.
   * @param value - The original diagnostic text.
   * @returns Its credential-redacted form.
   */
  function redact(value: string): string {
    let result = value;
    for (const secret of sensitive) result = result.replaceAll(secret, "[Redacted]");
    return result;
  }

  /**
   * Copy the diagnostic whitelist and terminate repeated cause references.
   * @param value - One error or cause in the rejected value's chain.
   * @returns A separately allocated safe Error.
   */
  function copy(value: unknown): RedactedSessionError {
    if (!(value instanceof Error)) {
      const type = value === null ? "null" : typeof value;
      const message = value !== null && (typeof value === "object" || typeof value === "function")
        ? `Session operation rejected with ${type}`
        : String(value);
      return diagnosticError(redact(message), redact(type));
    }
    if (visited.has(value)) {
      return diagnosticError("Circular error cause", "Error");
    }
    visited.add(value);
    const safe = diagnosticError(redact(value.message), redact(value.constructor.name));
    safe.name = redact(value.name);
    if (typeof value.stack === "string") safe.stack = redact(value.stack);
    else delete safe.stack;
    const code: unknown = Reflect.get(value, "code");
    if (typeof code === "string") safe.code = redact(code);
    else if (typeof code === "number") safe.code = code;
    if (value.cause !== undefined) safe.cause = copy(value.cause);
    return safe;
  }

  return copy(error);
}
