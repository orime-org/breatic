// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { NoUpstreamAvailable, type UnavailableReason } from "@provider/errors.js";
import { decide, type Failure, type Phase } from "@provider/routing/decide.js";
import type { Candidate, RoutePlan } from "@provider/routing/route.js";

/** What served the call. */
export interface Served<T> {
  value: T;
  servedBy: string;
}

/** How a caller runs one attempt and reads its failure. */
export interface Attempts<T> {
  phase: Phase;
  maxRetries: number;
  attempt: (candidate: Candidate) => Promise<T>;
  /** The failure class of an error the attempt on this upstream threw, or null when it is none of them (it is then rethrown as is). */
  classify: (error: unknown, candidate: Candidate) => Failure | null;
  /**
   * Waits before a retry on the same upstream; answers "switch" when the upstream
   * asked for longer than a retry may wait. Without it, the retry is immediate.
   */
  pause?: (error: unknown, retry: number) => Promise<"retry" | "switch">;
}

/**
 * Run a call on the planned upstreams in order, switching and retrying by {@link decide}.
 * @param plan - The ordered upstreams and the skipped ones.
 * @param attempts - How to attempt and classify.
 * @returns The first success and the upstream that served it.
 * @throws {NoUpstreamAvailable} When every upstream was skipped or failed in a switchable way.
 * @throws {unknown} The attempt's own error when the decision is to stop.
 */
export async function tryInOrder<T>(plan: RoutePlan, attempts: Attempts<T>): Promise<Served<T>> {
  const reasons: UnavailableReason[] = [...plan.skipped];
  for (const candidate of plan.order) {
    for (let retries = 0; ; retries++) {
      try {
        return { value: await attempts.attempt(candidate), servedBy: candidate.upstream };
      } catch (error) {
        const failure = attempts.classify(error, candidate);
        if (failure === null) throw error;
        let decision = decide(failure, attempts.phase, retries, attempts.maxRetries);
        if (decision === "stop") throw error;
        if (decision === "retry" && attempts.pause !== undefined) decision = await attempts.pause(error, retries + 1);
        if (decision === "retry") continue;
        reasons.push({ upstream: candidate.upstream, kind: "failed", failure: failure.kind });
        break;
      }
    }
  }
  throw new NoUpstreamAvailable(plan.model, reasons);
}
