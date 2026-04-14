/**
 * Application error hierarchy.
 *
 * Service layer throws AppError subclasses; the global error-handler
 * middleware converts them to structured JSON responses.
 */

/** Base application error with an HTTP status code. */
export class AppError extends Error {
  /** HTTP status code to return. */
  public readonly statusCode: number;

  /**
   * @param statusCode - HTTP status code
   * @param message - Human-readable error message
   */
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
  }
}

/** Resource not found (404). */
export class NotFoundError extends AppError {
  constructor(message: string) {
    super(404, message);
    this.name = "NotFoundError";
  }
}

/** Resource conflict (409). */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, message);
    this.name = "ConflictError";
  }
}

/** Validation failed (422). */
export class ValidationError extends AppError {
  constructor(message: string) {
    super(422, message);
    this.name = "ValidationError";
  }
}

/** Access forbidden (403). */
export class ForbiddenError extends AppError {
  constructor(message: string) {
    super(403, message);
    this.name = "ForbiddenError";
  }
}

/** Not authenticated (401). */
export class UnauthorizedError extends AppError {
  constructor(message: string) {
    super(401, message);
    this.name = "UnauthorizedError";
  }
}
