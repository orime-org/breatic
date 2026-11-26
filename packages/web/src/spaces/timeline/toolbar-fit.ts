// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * How many of a toolbar's leading entries fit in one row, leaving room for the More button whenever any entry
 * does not fit (inner#1709).
 * @param widths - Each entry's width in toolbar order, the separator before it included.
 * @param room - The toolbar's content width.
 * @param gap - The space between two neighbouring entries, and between the last shown entry and More.
 * @param more - The More button's width.
 * @returns The number of leading entries to show; the rest go behind More.
 * @throws {never} Never.
 */
export function fittingEntryCount(widths: readonly number[], room: number, gap: number, more: number): number {
  let used = 0;
  for (let shown = 0; shown < widths.length; shown += 1) used += (shown > 0 ? gap : 0) + widths[shown]!;
  if (used <= room) return widths.length;
  let count = widths.length - 1;
  for (; count > 0; count -= 1) {
    used -= widths[count]! + gap;
    if (used + gap + more <= room) return count;
  }
  return 0;
}
