// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * How many reference images a model takes, read the same way by both Generate
 * panels.
 *
 * The rule is only worth anything if every layer agrees on it, so it is stated
 * once here and read by both view models (#1927) rather than written out again
 * for the video panel.
 */

/**
 * Normalizes a wire `max_items` to a real cap: a positive finite number, else
 * undefined (uncapped). Mirrors the server rule's `limit >= 1` guard and the
 * worker's truthy `spec.max_items`, so the frontend count gate agrees with
 * both — a frontend that honoured a cap of 0 would refuse every submit with a
 * "at most 0 reference images" toast neither of the other two ever meant.
 * @param cap - The `max_items` read off the wire ParamDescriptor (may be 0 / negative / NaN / undefined).
 * @returns The positive cap, or undefined when the param is effectively uncapped.
 */
export function positiveCap(cap: number | undefined): number | undefined {
  return typeof cap === 'number' && Number.isFinite(cap) && cap >= 1
    ? cap
    : undefined;
}
