// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How many name tags fit on one row before the `+N` badge takes over.
 *
 * The badge only earns its place once something has to drop, so a row that
 * holds every tag is measured without it. Once one has to go, the badge has to
 * fit too — it is what carries the rest of the count, and the promise is that
 * what you see plus what the badge says is the number of people.
 *
 * A single tag that is too wide on its own stays: it is the whole truth about
 * who is there, and an ellipsis says more than a badge reading `+1`.
 * @param widths - Each tag's natural width, in px, in the order drawn.
 * @param badgeWidth - What the `+N` badge takes, in px.
 * @param maxWidth - The row's width limit, in px.
 * @param gap - The space between two neighbours, in px.
 * @returns How many of the leading tags to draw.
 */
export function countTagsThatFit(
  widths: readonly number[],
  badgeWidth: number,
  maxWidth: number,
  gap: number,
): number {
  if (widths.length === 1) return 1;

  const rowWidth = widths.reduce((sum, w, i) => sum + w + (i > 0 ? gap : 0), 0);
  if (rowWidth <= maxWidth) return widths.length;

  let used = 0;
  let fit = 0;
  for (const [i, width] of widths.entries()) {
    const withThis = used + width + (i > 0 ? gap : 0);
    if (withThis + gap + badgeWidth > maxWidth) break;
    used = withThis;
    fit += 1;
  }
  return fit;
}
