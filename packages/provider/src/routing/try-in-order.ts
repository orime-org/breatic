// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { Failure, Phase } from "@provider/routing/decide.js";
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
  /** The failure class of a thrown error, or null when it is none of them (it is then rethrown as is). */
  classify: (error: unknown) => Failure | null;
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
  void plan; void attempts;
  throw new Error("tryInOrder is not implemented");
}
