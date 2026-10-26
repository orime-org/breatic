// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { UnavailableReason } from "@provider/errors.js";
import type { Route } from "@provider/pricing/estimate.js";

export type { Route } from "@provider/pricing/estimate.js";

/** One upstream a model is bound to, as this deployment sees it. */
export interface Candidate {
  upstream: string;
  /** Effective weight after the deployment override; lower is tried first, unique per model. */
  weight: number;
  /** Whether this deployment has the upstream's key. */
  configured: boolean;
  /** The environment variable that holds the key. */
  envVar: string;
  /** This call's estimate on this upstream, in USD; used by the cheapest mode. */
  estimateUsd?: number;
}

/** The upstreams to try, in order, and the ones skipped before trying. */
export interface RoutePlan {
  model: string;
  order: Candidate[];
  skipped: UnavailableReason[];
}

/**
 * Order a model's upstreams for one call.
 * @param model - Our model id.
 * @param route - The caller's mode.
 * @param candidates - Every upstream the model is bound to.
 * @returns The configured upstreams in try order, and the unconfigured ones as reasons.
 * @throws {NoUpstreamAvailable} When no upstream of the route is configured.
 * @throws {UpstreamRequestRejected} When the route names an upstream the model has no binding for.
 */
export function planRoute(model: string, route: Route, candidates: readonly Candidate[]): RoutePlan {
  void model; void route; void candidates;
  throw new Error("planRoute is not implemented");
}
