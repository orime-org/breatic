// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { ItemFieldControl } from '@web/spaces/canvas/generate/model-controls';

/** One stored entry of a list param: field name to value. */
export type Entry = Readonly<Record<string, unknown>>;

/**
 * The entries a node holds for a list param.
 * @param held - What the node holds; anything that is not a list reads as none.
 * @returns The entries that are objects, in order.
 */
export function entriesOf(held: unknown): Entry[] {
  return Array.isArray(held)
    ? held.filter((e): e is Entry => typeof e === 'object' && e !== null && !Array.isArray(e))
    : [];
}

/**
 * A new entry: text fields empty, choice fields on their first option.
 * @param fields - The fields of one entry.
 * @returns The entry.
 */
export function blankEntry(fields: readonly ItemFieldControl[]): Entry {
  return Object.fromEntries(
    fields.map((f) => [f.name, f.kind === 'choice' ? (f.options[0]?.value ?? '') : '']),
  );
}

/**
 * The entries of a list with a fixed number of rows (Gemini's two speakers):
 * what the node holds, cut or filled with blank entries to that number.
 * @param held - What the node holds.
 * @param size - How many rows the list has.
 * @param fields - The fields of one entry.
 * @returns Exactly `size` entries.
 */
export function fixedEntries(held: unknown, size: number, fields: readonly ItemFieldControl[]): Entry[] {
  const entries = entriesOf(held);
  return entries.length >= size
    ? entries.slice(0, size)
    : [...entries, ...Array.from({ length: size - entries.length }, () => blankEntry(fields))];
}
