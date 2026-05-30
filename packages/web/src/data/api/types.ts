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
}

export class ApiException extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(error: ApiError) {
    super(error.message);
    this.name = 'ApiException';
    this.status = error.status;
    this.code = error.code;
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
