// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A mode's picker names each model by its vendor's name, joining on a
 * `variant` only where two of them share one (`modelLabel` in shared). Two
 * namesakes in one mode without distinct variants would be two lines the
 * reader cannot tell apart, so the catalog refuses to load.
 */

/** The fields of an entry its name on screen is made from. */
export interface NamedEntry {
  readonly name: string;
  readonly display_name?: string;
  readonly variant?: string;
  readonly mode?: string | readonly string[];
}

/**
 * Refuse a bucket in which one mode offers two models it cannot tell apart.
 * @param bucket - The catalog bucket these models came from.
 * @param models - Its models.
 * @throws {Error} when two models in one mode share a name and a variant, or one of them has none.
 */
export function assertNamesTellApart(bucket: string, models: readonly NamedEntry[]): void {
  const byModeAndName = new Map<string, NamedEntry[]>();
  for (const model of models) {
    const label = model.display_name ?? model.name;
    for (const mode of [model.mode ?? []].flat()) {
      const key = `${mode}\u0000${label}`;
      byModeAndName.set(key, [...(byModeAndName.get(key) ?? []), model]);
    }
  }
  const faults = [...byModeAndName].flatMap(([key, group]) => {
    const variants = group.map((model) => model.variant);
    const apart = variants.every((variant) => variant !== undefined) && new Set(variants).size === group.length;
    if (group.length < 2 || apart) return [];
    const [mode, label] = key.split("\u0000");
    return [`${String(mode)}: "${String(label)}" on ${group.map((model) => model.name).join(", ")}`];
  });
  if (faults.length === 0) return;
  throw new Error(
    `config/models/${bucket}: models one mode offers under the same name each need a distinct variant; ` +
      faults.join("; "),
  );
}
