// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** One registered segment in its source-time order. */
export interface LongMediaSegmentReference {
  /** The registered segment address understood by the model service. */
  url: string;
  /** The measured media type retained by the registered asset. */
  ledgerType?: string;
  /** The byte length measured when the segment was registered. */
  sizeBytes: number;
  /** Inclusive start of the segment's source-time interval, in microseconds. */
  startUs: string;
  /** Exclusive end of the segment's source-time interval, in microseconds. */
  endUs: string;
}

/** The limits of one caller's understanding request. */
export interface LongMediaBatchLimits {
  /** The maximum combined audio/video bytes accepted by one request. */
  maxBytes: number;
  /** The maximum number of ordered media items accepted by one request. */
  maxItems: number;
}

/**
 * Group consecutive source segments into requests that fit the caller's limits.
 * @param segments - Registered segments in source-time order.
 * @param limits - The caller's existing request limits.
 * @returns Consecutive batches in the same order as the source segments.
 * @throws {RangeError} When a limit or measured segment size is invalid.
 */
export function groupLongMediaSegments(
  segments: readonly LongMediaSegmentReference[],
  limits: LongMediaBatchLimits,
): LongMediaSegmentReference[][] {
  if (
    !Number.isSafeInteger(limits.maxBytes) || limits.maxBytes <= 0 ||
    !Number.isSafeInteger(limits.maxItems) || limits.maxItems <= 0
  ) {
    throw new RangeError("Long media request limits must be positive safe integers.");
  }

  const batches: LongMediaSegmentReference[][] = [];
  let batch: LongMediaSegmentReference[] = [];
  let batchBytes = 0;

  for (const segment of segments) {
    if (!Number.isSafeInteger(segment.sizeBytes) || segment.sizeBytes <= 0) {
      throw new RangeError("A registered segment must have a positive measured byte size.");
    }
    if (segment.sizeBytes > limits.maxBytes) {
      throw new RangeError("A registered segment exceeds the caller's request byte limit.");
    }

    if (batch.length > 0 && (batch.length >= limits.maxItems || batchBytes + segment.sizeBytes > limits.maxBytes)) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }

    batch.push(segment);
    batchBytes += segment.sizeBytes;
  }

  if (batch.length > 0) batches.push(batch);
  return batches;
}
