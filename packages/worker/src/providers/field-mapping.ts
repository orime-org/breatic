// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Our param names → the names one provider takes for them.
 *
 * Our own names travel our API and land on every model; when a request goes
 * out to a provider, that provider has its own names for the same things. The
 * conversion belongs to the model on that provider, because only it knows
 * what its fields are called there (user 2026-08-10).
 *
 * A mapping is written out even when both sides use the same word. That is
 * the point of the table: it keeps our vocabulary and a vendor's independent,
 * so a vendor rename is one line here rather than a hunt through the code for
 * a name that was riding along by coincidence.
 */

/** Our param name → the name one provider takes it under. */
export type FieldNames = Readonly<Record<string, string>>;

/**
 * Rewrites a param set into one provider's field names.
 *
 * A param the request does not carry (absent, `null` or `undefined`) leaves no
 * key behind: providers read a source field's PRESENCE, so an empty end frame
 * must not arrive as an empty value. Params outside the table pass through
 * untouched — a table states the names that differ or that a model has claimed
 * for itself, not the whole payload.
 * @param params - The params under our own names.
 * @param fieldNames - This (model, provider) pair's name table.
 * @returns A new param object under the provider's names.
 */
export function applyFieldNames(
  params: Record<string, unknown>,
  fieldNames: FieldNames,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...params };

  // Lift every mapped param out first, so an identity entry (`image` →
  // `image`) and a pair that swaps names both land correctly.
  const carried = new Map<string, unknown>();
  for (const ours of Object.keys(fieldNames)) {
    if (ours in out) {
      carried.set(ours, out[ours]);
      delete out[ours];
    }
  }

  for (const [ours, theirs] of Object.entries(fieldNames)) {
    const value = carried.get(ours);
    if (value != null) out[theirs] = value;
  }

  return out;
}
