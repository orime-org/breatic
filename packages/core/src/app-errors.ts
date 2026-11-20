// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Application error hierarchy.
 *
 * Service layer throws AppError subclasses; the global error-handler
 * middleware converts them to structured JSON responses.
 */

import { formatCredits, getActiveLocale, t } from "@breatic/shared";

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

/**
 * A service this one forwards to is out of reach (503). `reason` names which,
 * so the browser can tell it apart from other failures.
 */
export class UnavailableError extends AppError {
  /** Which service is unavailable, sent as `error.reason`. */
  public readonly reason: string;

  /**
   * Construct a 503 error.
   * @param message - What to tell the user, already in their language.
   * @param reason - Which service is unavailable.
   */
  constructor(message: string, reason: string) {
    super(503, message);
    this.name = "UnavailableError";
    this.reason = reason;
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


/** Refused until a known wait is over (429). */
export class TooManyRequestsError extends AppError {
  /** Whole seconds the caller must wait, rounded up so a retry never lands early. */
  public readonly retryAfterSeconds: number;

  /**
   * Construct a 429 error that says how long to wait.
   * @param message - human-readable description of why the request is refused
   * @param retryAfterSeconds - how long until the same request will be accepted
   */
  constructor(message: string, retryAfterSeconds: number) {
    super(429, message);
    this.name = "TooManyRequestsError";
    this.retryAfterSeconds = Math.ceil(retryAfterSeconds);
  }
}

/** A monthly spend limit work would pass: whose, how much, and when the month resets. */
export interface SpendCapLimit {
  /** The person's own limit, or the Studio's total. */
  scope: "member" | "studio";
  /** The limit, as a decimal string. */
  limit: string;
  /** The first instant of the next UTC month, as ISO text. */
  resetsAt: string;
}

/** Work refused by a Studio's monthly spend limit (402, inner#1968). */
export class SpendCapReachedError extends AppError {
  /** What the web client tells this refusal apart by, as `error.reason`. */
  public readonly reason = "spend_cap_reached";
  /** The person's own limit, or the Studio's total. */
  public readonly scope: SpendCapLimit["scope"];
  /** The limit, as a decimal string. */
  public readonly limit: string;
  /** When the month resets, as ISO text. */
  public readonly resetsAt: string;

  /**
   * Build the refusal, in the caller's language.
   * @param cap - The limit the work would pass.
   */
  constructor(cap: SpendCapLimit) {
    super(
      402,
      cap.scope === "member"
        ? t("server.spend_cap.member", { limit: formatCredits(cap.limit, getActiveLocale()) })
        : t("server.spend_cap.studio"),
    );
    this.name = "SpendCapReachedError";
    this.scope = cap.scope;
    this.limit = cap.limit;
    this.resetsAt = cap.resetsAt;
  }
}
