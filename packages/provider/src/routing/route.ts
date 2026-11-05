// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { NoUpstreamAvailable, UpstreamRequestRejected, type UnavailableReason } from "@provider/errors.js";
import { byPrice, type RejectedInput, type Route } from "@provider/pricing/estimate.js";

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
  /** Whether that estimate is only a lower bound (a source it bills by the length of has no known length); it then ranks after every known price. */
  estimateAtLeast?: boolean;
  /** Why the upstream cannot take this run (a param and value, one of its own limits, or a check that failed to evaluate); it is then skipped. */
  unsupported?: RejectedInput;
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
 * @throws {NoUpstreamAvailable} When no upstream of the route is configured and able to take the run.
 * @throws {UpstreamRequestRejected} When the route names an upstream the model has no binding for.
 */
export function planRoute(model: string, route: Route, candidates: readonly Candidate[]): RoutePlan {
  let pool = [...candidates].sort((a, b) => a.weight - b.weight);
  if (route.mode === "upstream") {
    pool = pool.filter((c) => c.upstream === route.upstream);
    if (pool.length === 0) {
      const bound = candidates.map((c) => c.upstream).join(", ");
      throw new UpstreamRequestRejected(model, route.upstream, `${model} has no binding to ${route.upstream}; it is bound to ${bound}`);
    }
  }
  if (route.mode === "cheapest") {
    pool.sort((a, b) => byPrice(
      // No estimate at all is no more known than a lower bound.
      { usd: a.estimateUsd ?? Infinity, atLeast: a.estimateAtLeast === true || a.estimateUsd === undefined, weight: a.weight },
      { usd: b.estimateUsd ?? Infinity, atLeast: b.estimateAtLeast === true || b.estimateUsd === undefined, weight: b.weight },
    ));
  }
  const skipped: UnavailableReason[] = pool.flatMap((c): UnavailableReason[] => {
    if (!c.configured) return [{ upstream: c.upstream, kind: "missing_key", envVar: c.envVar }];
    if (c.unsupported !== undefined) return [{ upstream: c.upstream, kind: "unsupported_input", ...c.unsupported }];
    return [];
  });
  const order = pool.filter((c) => c.configured && c.unsupported === undefined);
  if (order.length === 0) throw new NoUpstreamAvailable(model, skipped);
  return { model, order, skipped };
}
