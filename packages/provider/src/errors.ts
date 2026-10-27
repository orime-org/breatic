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
  /** What the answers it moved past cost, in order, when an upstream billed them (design 3.5). */
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

/** The request itself was refused, or names an upstream the model has no binding for; no other upstream is tried. */
export class UpstreamRequestRejected extends Error {
  readonly model: string;
  readonly upstream: string;
  /** What the billed answers cost, in order: those moved past, then the refused one (design 3.5, 5.4). */
  readonly costs: Cost[];

  /**
   * Record what the error carries.
   * @param model - Our model id.
   * @param upstream - The upstream that refused, or the one asked for.
   * @param message - What was refused.
   * @param costs - What the billed answers cost; empty when none was billed.
   */
  constructor(model: string, upstream: string, message: string, costs: Cost[] = []) {
    super(message);
    this.name = "UpstreamRequestRejected";
    this.model = model;
    this.upstream = upstream;
    this.costs = costs;
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
   */
  constructor(deadlineAt: number) {
    super(`Deadline ${new Date(deadlineAt).toISOString()} has passed`);
    this.name = "DeadlinePassed";
  }
}

