// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Why one upstream could not serve a call. */
export type UnavailableReason =
  | { upstream: string; kind: "missing_key"; envVar: string }
  | { upstream: string; kind: "failed"; failure: string };

/** No upstream of a model could serve the call; each one says why. */
export class NoUpstreamAvailable extends Error {
  readonly model: string;
  readonly reasons: readonly UnavailableReason[];

  /**
   * @param model - Our model id.
   * @param reasons - One entry per upstream that was skipped or failed, in try order.
   */
  constructor(model: string, reasons: readonly UnavailableReason[]) {
    super(`No upstream can serve ${model}`);
    this.name = "NoUpstreamAvailable";
    this.model = model;
    this.reasons = reasons;
  }
}

/** The request itself was refused, or names an upstream the model has no binding for; no other upstream is tried. */
export class UpstreamRequestRejected extends Error {
  readonly model: string;
  readonly upstream: string;

  /**
   * @param model - Our model id.
   * @param upstream - The upstream that refused, or the one asked for.
   * @param message - What was refused.
   */
  constructor(model: string, upstream: string, message: string) {
    super(message);
    this.name = "UpstreamRequestRejected";
    this.model = model;
    this.upstream = upstream;
  }
}
