// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Shared API envelope + error types (mirrors backend `AppError`).
 *
 * Backend wraps all successful responses in `{ data: T }` envelope
 * (ApiResponse contract; per the API-response-envelope DD). Errors throw
 * `AppError(status, msg)` → handler returns JSON `{ error: { code, message } }`.
 * Helpers in `request.ts` unwrap the `data` envelope on success and the
 * `error` envelope on failure.
 */

export interface ApiEnvelope<T> {
  data: T;
}

export interface ApiError {
  /** HTTP status (4xx / 5xx). */
  status: number;
  /** Backend `error.message` or axios message. */
  message: string;
  /** Optional backend `error.code` for typed handling. */
  code?: string;
  /** The raw `Retry-After` header, when the server sent one. */
  retryAfter?: string;
}

/**
 * Error thrown by the API helpers when a request fails, carrying the
 * normalized HTTP status and optional backend error code.
 */
export class ApiException extends Error {
  readonly status: number;
  readonly code?: string;
  /**
   * The raw `Retry-After` the server sent, when it sent one.
   *
   * Kept because our own rate limiter sets it on every 429 and the shared
   * retry verdict reads it — without it, the presign half of an upload was
   * making that decision with the one input the server actually supplied
   * missing, and waiting a number of its own instead of the number it was
   * told.
   */
  readonly retryAfter?: string;

  /**
   * Build an `ApiException` from a normalized API error.
   * @param error - The normalized error with status, message, and optional code.
   */
  constructor(error: ApiError) {
    super(error.message);
    this.name = 'ApiException';
    this.status = error.status;
    this.code = error.code;
    this.retryAfter = error.retryAfter;
  }
}

/** Pagination query passed to `list` endpoints. */
export interface Pagination {
  page?: number;
  limit?: number;
}

/** Pagination meta returned by paginated endpoints. */
export interface PageMeta {
  total: number;
  page: number;
  limit: number;
}
