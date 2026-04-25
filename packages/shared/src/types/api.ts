/**
 * Shared API response types.
 *
 * Standard response envelope used by all backend endpoints.
 * Frontend and backend both import these to ensure consistency.
 */

/** Standard API response wrapper. */
export interface ApiResponse<T> {
  data: T;
}

/** Paginated API response with metadata. */
export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    total: number;
    limit: number;
    offset: number;
  };
}

/** Error response from the API. */
export interface ApiError {
  error: string;
  status: number;
}
