// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

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
   * Build an application error carrying an HTTP status and message.
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
  /**
   * Construct a 404 error.
   * @param message - human-readable description of the missing resource
   */
  constructor(message: string) {
    super(404, message);
    this.name = "NotFoundError";
  }
}

/** Resource conflict (409). */
export class ConflictError extends AppError {
  /**
   * Construct a 409 error.
   * @param message - human-readable description of the conflicting state
   */
  constructor(message: string) {
    super(409, message);
    this.name = "ConflictError";
  }
}

/** Validation failed (422). */
export class ValidationError extends AppError {
  /**
   * Construct a 422 error.
   * @param message - human-readable description of the validation failure
   */
  constructor(message: string) {
    super(422, message);
    this.name = "ValidationError";
  }
}

/** Access forbidden (403). */
export class ForbiddenError extends AppError {
  /**
   * Construct a 403 error.
   * @param message - human-readable description of why access is denied
   */
  constructor(message: string) {
    super(403, message);
    this.name = "ForbiddenError";
  }
}

/** Not authenticated (401). */
export class UnauthorizedError extends AppError {
  /**
   * Construct a 401 error.
   * @param message - human-readable description of the authentication failure
   */
  constructor(message: string) {
    super(401, message);
    this.name = "UnauthorizedError";
  }
}

