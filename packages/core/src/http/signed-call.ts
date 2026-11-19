// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The client one service uses to call another service's internal listener
 * (inner#1993 §3.1): the request is signed with `signRequest` exactly as the
 * receiver's `verifyInternalRequest` checks it, sent with `httpRequest`, and
 * any answer outside 2xx becomes a `SignedCallError`.
 *
 * Each call is delivered once (`replaySafe: false`). The signature carries a
 * nonce, and the receiver refuses a nonce it has seen, so resending the same
 * signed request could only earn a 401; whether to try again, with a new
 * signature, is the caller's decision (a relay, a retry loop, a user's retry).
 */

import { randomBytes } from "node:crypto";
import { httpRequest } from "@breatic/shared";
import { signRequest } from "@core/http/internal-signature.js";

/** Where a call goes and who signs it. */
export interface SignedCallTarget {
  /** The other service's internal listener, without a trailing slash. */
  baseUrl: string;
  /** The secret shared with that listener for this signer. */
  secret: string;
  /** The signer named in `x-internal-admin`, such as `commerce` or `product`. */
  signer: string;
}

/** One call. */
export interface SignedCallRequest {
  method: "GET" | "POST" | "PUT";
  /** The path with its query string, exactly as it is signed and sent. */
  path: string;
  /** The JSON body; omitted for a request without one. */
  body?: unknown;
  /** Sent as `Idempotency-Key` and covered by the signature. */
  idempotencyKey?: string;
  /** How long the delivery may take. */
  timeoutMs: number;
}

/** A 2xx answer. */
export interface SignedCallResult {
  status: number;
  /** The parsed JSON body, or null when the body is empty. */
  body: unknown;
}

/**
 * The other side did not answer 2xx, or did not answer at all.
 */
export class SignedCallError extends Error {
  /** The status answered, or null when no answer arrived. */
  readonly status: number | null;
  /** The error code in the answer (`code`, or `error.code` for a public error body), when there is one. */
  readonly code: string | null;
  /** The parsed answer body, when there is one. */
  readonly body: unknown;

  /**
   * Build the error.
   * @param status - The status answered, or null.
   * @param code - The error code read from the body, or null.
   * @param body - The parsed body, or null.
   * @param cause - The failure that left no answer, when there was one.
   */
  constructor(status: number | null, code: string | null, body: unknown, cause?: unknown) {
    super(status === null ? "signed call got no answer" : `signed call answered ${status}${code === null ? "" : ` ${code}`}`, { cause });
    this.name = "SignedCallError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/**
 * Parse a response body as JSON.
 * @param text - The body text.
 * @returns The parsed value, null for an empty body, or the text itself when it is not JSON.
 */
function parseBody(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * The error code an answer body carries: an internal error body's `code`, or a
 * public error body's `error.code`.
 * @param body - The parsed body.
 * @returns The code, or null.
 */
function codeOf(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (typeof record.code === "string") return record.code;
  const error = record.error;
  if (typeof error === "object" && error !== null && typeof (error as Record<string, unknown>).code === "string") {
    return (error as Record<string, unknown>).code as string;
  }
  return null;
}

/**
 * Sign and send one call to another service's internal listener.
 * @param target - Where it goes and who signs it.
 * @param request - The call.
 * @returns The 2xx status and parsed body.
 * @throws {SignedCallError} When the answer is not 2xx, or no answer arrived.
 */
export async function signedCall(target: SignedCallTarget, request: SignedCallRequest): Promise<SignedCallResult> {
  const body = request.body === undefined ? "" : JSON.stringify(request.body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(18).toString("base64url");
  const signature = signRequest(target.secret, {
    method: request.method,
    pathWithQuery: request.path,
    timestamp,
    nonce,
    adminId: target.signer,
    idempotencyKey: request.idempotencyKey ?? null,
    body,
  });
  const headers: Record<string, string> = {
    "x-internal-admin": target.signer,
    "x-internal-timestamp": timestamp,
    "x-internal-nonce": nonce,
    "x-internal-signature": signature,
  };
  if (request.body !== undefined) headers["content-type"] = "application/json";
  if (request.idempotencyKey !== undefined) headers["idempotency-key"] = request.idempotencyKey;

  let response: Response;
  try {
    response = await httpRequest(
      `${target.baseUrl}${request.path}`,
      { method: request.method, headers, ...(request.body === undefined ? {} : { body }) },
      { replaySafe: false, timeoutMs: request.timeoutMs },
    );
  } catch (err) {
    throw new SignedCallError(null, null, null, err);
  }
  let parsed: unknown;
  try {
    parsed = parseBody(await response.text());
  } catch (err) {
    throw new SignedCallError(null, null, null, err);
  }
  if (!response.ok) throw new SignedCallError(response.status, codeOf(parsed), parsed);
  return { status: response.status, body: parsed };
}

/**
 * Whether a failed call means the other side cannot handle it right now, so
 * the same call may succeed later: no answer, 401 or 403 (including a secret
 * mid-rotation), 408, 429 or 5xx. 400, 404, 409 and 422 are definite answers
 * that a resend would only repeat.
 * @param err - What the call threw.
 * @returns True when the call may be tried again later.
 */
export function isUnavailable(err: unknown): boolean {
  if (!(err instanceof SignedCallError)) return false;
  const { status } = err;
  return status === null || status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;
}
