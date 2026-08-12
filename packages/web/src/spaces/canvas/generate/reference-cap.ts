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

/**
 * Whether a submit carries more reference images than the model takes.
 *
 * The rule lives here rather than in each panel because it only works when the
 * two agree: both refuse at the same threshold and both report the same
 * number, and a later change to what it means — a different comparison, a
 * count alongside the limit, a mode that opts out — has to land in both or the
 * same catalog figure would be enforced two ways. The server re-checks before
 * enqueue; this is what turns that into something the user can act on.
 *
 * The MESSAGE stays at the call sites, spelled out. A key handed back from
 * here would be a key no `t("…")` call names, and the check that every id
 * reaches a real message in all five catalogs only sees ids written out inside
 * that call — measured: with the key returned from here, deleting
 * `errorTooManyReferences` from a catalog left all 24 repo-lint checks green,
 * while deleting a key that still had a literal call failed one.
 * @param count - How many references the submit carries.
 * @param cap - The model's cap, already normalized by {@link positiveCap}.
 * @returns The values the message interpolates, or null when within the cap or uncapped.
 */
export function referenceCapExceeded(
  count: number,
  cap: number | undefined,
): { limit: number } | null {
  if (typeof cap !== 'number' || count <= cap) return null;
  return { limit: cap };
}
