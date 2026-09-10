// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The layout a ticket signed, and whether one part fits it (#173, design §4.2).
 *
 * `totalParts` parts of `partSize` each, the last one allowed to be short, is
 * a bound on how many bytes one upload may put into R2. R2 itself takes part
 * numbers far past `totalParts` and takes any length R2's own floor allows, so
 * this is the only thing that keeps an upload inside what its ticket
 * authorised.
 *
 * The Worker judges a part twice against it. Before the write, which is the
 * only moment the bound can still stop the bytes; and again at the end, over
 * the list the browser hands back, where what is left to judge is which
 * positions that list names.
 */

import type { PartLayout } from "@breatic/shared";

/**
 * Why one part does not fit the signed layout.
 *
 * The two reasons stay apart because they are different mistakes: a number
 * outside the layout is a caller addressing a part this upload does not have,
 * and a length that does not match is a caller sending something other than
 * what it signed up to send.
 * @param partNumber - Which part this claims to be, one-based.
 * @param sizeBytes - How many bytes arrived for it.
 * @param layout - What the ticket signed.
 * @returns The refusal, or null when it fits.
 */
export function partLayoutRefusal(
  partNumber: number,
  sizeBytes: number,
  layout: PartLayout,
): string | null {
  if (partNumber < 1 || partNumber > layout.totalParts) {
    return "Part number outside the signed layout";
  }
  const isFinal = partNumber === layout.totalParts;
  // The final part is the only short one, and its floor is one byte. An upload
  // that assembles to nothing is refused at registration, and that refusal
  // reaches no node — the lanes that can produce an empty object open their
  // grants without one. Judging the length here is what keeps a delivery that
  // does name a node from arriving at that refusal.
  const fits = isFinal
    ? sizeBytes > 0 && sizeBytes <= layout.partSize
    : sizeBytes === layout.partSize;
  return fits ? null : "Part length does not match the signed layout";
}

/**
 * Why the list handed back to finish an upload is not a list of this upload's
 * parts.
 *
 * Lengths are not in it and cannot be: the bytes were judged when they were
 * written, and this list is a record of what R2 accepted. What is left to
 * judge is which positions it names — every one inside the signed layout, and
 * each named once. Without the second check, one part sent twice counts as
 * two and a list that is missing a part passes for complete.
 *
 * How MANY it names is judged by the caller, because a short list is not a
 * malformed one: the upload is still open and sending what is missing
 * finishes it.
 * @param parts - The list the browser handed back.
 * @param layout - What the ticket signed.
 * @returns The refusal, or null when every entry fits.
 */
export function partListRefusal(
  parts: readonly { partNumber: number }[],
  layout: PartLayout,
): string | null {
  const seen = new Set<number>();
  for (const part of parts) {
    if (part.partNumber < 1 || part.partNumber > layout.totalParts) {
      return "Part number outside the signed layout";
    }
    if (seen.has(part.partNumber)) {
      return "Part number listed more than once";
    }
    seen.add(part.partNumber);
  }
  return null;
}
