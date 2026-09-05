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
 * Both sides of the upload read it from here. The Worker judges a part before
 * it writes, which is the only moment the bound can still stop the bytes; the
 * instance judges it again before recording it, because "have they all
 * arrived?" is answered by counting rows and only holds while every non-final
 * row is exactly one part long.
 */

/** What a ticket signed about the shape of one upload. */
export interface PartLayout {
  /** Size of every part except the last. */
  partSize: number;
  /** How many parts this upload has. */
  totalParts: number;
}

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
  const fits = isFinal
    ? sizeBytes <= layout.partSize
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
