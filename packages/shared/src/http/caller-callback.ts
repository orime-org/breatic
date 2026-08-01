// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Running the caller's own functions without letting a broken one decide the
 * fate of the request it was given to describe.
 *
 * This transport takes functions from its caller that are not the request:
 * a telemetry sink that says what happened, and a predicate that classifies
 * an error its fetch implementation raised. Both observe or judge; neither is
 * allowed to end anything. A sink whose serializer chokes, or a predicate
 * that reads a property off an error shape it did not anticipate, used to
 * propagate out in place of the vendor's real failure — so the caller was
 * handed its own bug instead of the network's, and in the predicate's case
 * the remaining replays were never attempted and no terminal event was
 * emitted at all.
 *
 * The rule was already written once, inline, for the telemetry sink in
 * `httpRequest` — and two other call sites of exactly the same kind were left
 * bare, one of them in the polling loop a hundred lines away. That is the
 * reason this is a module rather than a third `try` block: one rule kept in
 * three places is a rule that drifts, and this one had already drifted before
 * anyone had written a caller for it.
 */

/**
 * Run a caller-supplied callback, substituting a value when it throws.
 *
 * The fallback is what the transport does when the callback cannot answer,
 * and it is deliberately explicit at every call site: a predicate that fails
 * has not answered "yes", and a sink that fails has not produced a value at
 * all. Neither silence should be mistaken for a decision.
 * @param run - The caller's callback, already bound to its arguments.
 * @param whenBroken - What to use if the callback throws.
 * @returns The callback's own value, or `whenBroken`.
 */
export function shieldCaller<T>(run: () => T, whenBroken: T): T {
  try {
    return run();
  } catch {
    // Deliberately swallowed. This is the one rule in the transport that
    // requires it: the caller's broken callback is the caller's bug, this
    // layer cannot log it (library packages must not), and letting it out
    // would replace the failure the caller actually needs to see.
    return whenBroken;
  }
}
