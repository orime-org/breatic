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
  /**
   * The message above came out of our own error envelope.
   *
   * False when it is the library's -- which happens whenever something other
   * than our server answers, a gateway timing out being the ordinary case.
   * That sentence is written in English, for a developer, and names transport
   * details; anything about to show a message to a reader has to be able to
   * tell the two apart. The SSE transport makes the same distinction.
   *
   * Optional because tests build this shape by hand; absent reads as false,
   * which is the safe way round. Production has one place that builds it --
   * `normalizeError` -- and that one always says.
   */
  fromServer?: boolean;
}

/**
 * Error thrown by the API helpers when a request fails, carrying the
 * normalized HTTP status and optional backend error code.
 */
export class ApiException extends Error {
  readonly status: number;
  readonly code?: string;
  /** Whether {@link Error.message} is a sentence our own server wrote. */
  readonly fromServer: boolean;

  /**
   * Build an `ApiException` from a normalized API error.
   * @param error - The normalized error with status, message, and optional code.
   */
  constructor(error: ApiError) {
    super(error.message);
    this.name = 'ApiException';
    this.status = error.status;
    this.code = error.code;
    this.fromServer = error.fromServer === true;
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
