// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The decisions the preview backfill makes about one row, apart from the
 * database and the Worker so they run under `node --test` (inner#1320).
 */

/**
 * The size to write back onto a row, when the read disagrees with it.
 *
 * Rows measured before the first frame's rotation was read hold a phone
 * photo's sensor pair the wrong way round, and a dedup hit copies that pair to
 * every node that reuses the row. A read that measured nothing says nothing
 * about the row, so it changes nothing.
 * @param {{ width: number | null, height: number | null }} row - What the row holds.
 * @param {{ width: number | null, height: number | null }} read - What the read measured.
 * @returns {{ width: number, height: number } | null} The size to write, or null.
 */
export function sizeCorrection(row, read) {
  if (read.width === null || read.height === null) return null;
  if (row.width === read.width && row.height === read.height) return null;
  return { width: read.width, height: read.height };
}

/**
 * The outcome to count for one read: what the Worker named, or `missing` for a
 * key whose original is no longer in the bucket (the Worker answers 404, and
 * no rerun changes that), or `failed` for any other read that came back
 * without one.
 * @param {{ preview?: string } | null} read - What the read answered, or null when it threw.
 * @param {unknown} [error] - What the read threw, when it threw.
 * @returns {string} The outcome to count.
 */
export function outcomeOf(read, error) {
  if (read === null) {
    const status = typeof error === "object" && error !== null ? error.status : undefined;
    return status === 404 ? "missing" : "failed";
  }
  return read.preview ?? "failed";
}
