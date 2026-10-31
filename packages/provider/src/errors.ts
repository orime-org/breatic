// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Cost } from "@provider/cost.js";

/** Why one upstream could not serve a call. */
export type UnavailableReason =
  | { upstream: string; kind: "missing_key"; envVar: string }
  | { upstream: string; kind: "failed"; failure: string; /** The status, for an `http_status` failure. */ status?: number };

/** No upstream of a model could serve the call; each one says why. */
export class NoUpstreamAvailable extends Error {
  readonly model: string;
  readonly reasons: readonly UnavailableReason[];
  /** What the answers it moved past cost, in order, when an upstream billed them. */
  readonly costs: Cost[];

  /**
   * Record what the error carries.
   * @param model - Our model id.
   * @param reasons - One entry per upstream that was skipped or failed, in try order.
   * @param costs - The billed answers it moved past.
   */
  constructor(model: string, reasons: readonly UnavailableReason[], costs: Cost[] = []) {
    super(`No upstream can serve ${model}`);
    this.name = "NoUpstreamAvailable";
    this.model = model;
    this.reasons = reasons;
    this.costs = costs;
  }
}

/**
 * The request was refused, names an upstream the model has no binding for, names a model no
 * LLM route serves, or got an answer provider cannot use; no other upstream is tried.
 */
export class UpstreamRequestRejected extends Error {
  readonly model: string;
  readonly upstream: string;
  /** What the billed answers cost, in order: those moved past, then the refused one. */
  readonly costs: Cost[];
  /** The upstream's status for the refusal (an error carried in an answer gives its code). */
  readonly status?: number;

  /**
   * Record what the error carries.
   * @param model - Our model id.
   * @param upstream - The upstream that refused or answered, the one asked for, or "" when no route matches the model.
   * @param message - What was refused.
   * @param costs - What the billed answers cost; empty when none was billed.
   * @param refusal - The upstream's status and its own error, when an upstream refused.
   * @param refusal.status - The status.
   * @param refusal.cause - The upstream's error.
   */
  constructor(model: string, upstream: string, message: string, costs: Cost[] = [], refusal: { status?: number; cause?: unknown } = {}) {
    super(message, refusal.cause === undefined ? undefined : { cause: refusal.cause });
    this.name = "UpstreamRequestRejected";
    this.model = model;
    this.upstream = upstream;
    this.costs = costs;
    if (refusal.status !== undefined) this.status = refusal.status;
  }
}

/**
 * An understand call that ended other than by an answer, a refusal or running out of
 * upstreams (a deadline, an abort, a lost answer, an error form it cannot read); it carries
 * what the answers before it were billed, and the original error as its cause.
 */
export class UnderstandInterrupted extends Error {
  readonly model: string;
  /** What the billed answers cost, in order. */
  readonly costs: Cost[];

  /**
   * Record what the error carries.
   * @param model - Our model id.
   * @param costs - What the billed answers cost.
   * @param cause - What ended the call.
   */
  constructor(model: string, costs: Cost[], cause: unknown) {
    super(`The understand call of ${model} was interrupted`, { cause });
    this.name = "UnderstandInterrupted";
    this.model = model;
    this.costs = costs;
  }
}

/**
 * Every cost an error and its causes carry, in order from the outermost: the way to account
 * for a thrown understand call or describe step whatever it ended with.
 * @param error - What was thrown.
 * @returns The costs found.
 */
export function costsOf(error: unknown): Cost[] {
  const costs: Cost[] = [];
  const seen = new Set<unknown>();
  for (let current = error; typeof current === "object" && current !== null && !seen.has(current); current = (current as { cause?: unknown }).cause) {
    seen.add(current);
    const carried = (current as { costs?: unknown }).costs;
    if (Array.isArray(carried)) costs.push(...(carried as Cost[]));
  }
  return costs;
}

/**
 * A billed 2xx answer whose body could not be read (cut, not JSON, or missing what it
 * promised): it rides as the cause of the error that ends the call, carrying one missing
 * cost for costsOf.
 */
export class BilledAnswerLost extends Error {
  readonly costs: Cost[];

  /**
   * Record what the error carries.
   * @param reason - What could not be read.
   * @param cause - The read's own failure, when there was one.
   */
  constructor(reason: string, cause?: unknown) {
    super(reason, cause === undefined ? undefined : { cause });
    this.name = "BilledAnswerLost";
    this.costs = [{ state: "missing", reason }];
  }
}

/** A send that the upstream certainly did not accept and that cannot move to another upstream; the caller retries the same ticket. */
export class SendNotAccepted extends Error {
  readonly upstream: string;

  /**
   * Record what the error carries.
   * @param upstream - The upstream that did not accept it.
   * @param cause - The failure.
   */
  constructor(upstream: string, cause: unknown) {
    super(`${upstream} did not accept the request`, { cause });
    this.name = "SendNotAccepted";
    this.upstream = upstream;
  }
}

/** The upstream ran the work and said it failed. */
export class UpstreamTaskFailed extends Error {
  readonly upstream: string;
  /** The upstream's own words. */
  readonly upstreamError: string;

  /**
   * Record what the error carries.
   * @param upstream - The upstream.
   * @param upstreamError - What it said.
   */
  constructor(upstream: string, upstreamError: string) {
    super(`${upstream} failed the task: ${upstreamError}`);
    this.name = "UpstreamTaskFailed";
    this.upstream = upstream;
    this.upstreamError = upstreamError;
  }
}

/**
 * The caller's deadline passed, either before a request started (nothing was sent)
 * or while it was in flight; in the second case whether the upstream accepted it is unknown.
 */
export class DeadlinePassed extends Error {
  /**
   * Record what the error carries.
   * @param deadlineAt - The deadline, in epoch milliseconds.
   * @param cause - What the deadline cut short, when it cut a call.
   */
  constructor(deadlineAt: number, cause?: unknown) {
    super(`Deadline ${new Date(deadlineAt).toISOString()} has passed`, cause === undefined ? undefined : { cause });
    this.name = "DeadlinePassed";
  }
}

