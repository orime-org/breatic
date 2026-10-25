// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { IsoBmffEdit } from "@ingest/container/iso-bmff-metadata.js";

/** Exact owned seconds, reduced with a positive denominator. */
export interface ExactPresentationTime { numerator: string; denominator: string }
/** One actual physical frame in an explicitly unedited decoder clock. */
export interface PhysicalVideoFrame { rawDecodeOrdinal: number; ptsTicks: string }
/** A complete source ledger and its explicitly supplied edit schedule. */
export interface RateOnePresentationInput {
  movieTimescale: string;
  mediaTimescale: string;
  sourceTimeBase: ExactPresentationTime;
  edits: IsoBmffEdit[];
  frames: PhysicalVideoFrame[];
}
/** A movie-time interval declared by an edit, including empty intervals with no fabricated frame. */
export interface OwnedEditInterval { editOccurrence: number; empty: boolean; start: ExactPresentationTime; end: ExactPresentationTime }
/** A physical frame may occupy multiple distinct presentation occurrences. */
export interface OwnedPresentationOccurrence {
  presentationOrdinal: number;
  editOccurrence: number;
  rawDecodeOrdinal: number;
  sourcePtsTicks: string;
  mappedPts: ExactPresentationTime;
  displayStart: ExactPresentationTime;
  displayEnd: ExactPresentationTime;
}
/** A pure frozen schedule, distinct from native callbacks and media-clock transport schemas. */
export interface OwnedVideoPresentation { edits: OwnedEditInterval[]; frames: OwnedPresentationOccurrence[] }

/**
 * Project complete rate-one edits onto physical frames, including clipped overlap at an edit start.
 * @param input - Integer source facts and a complete explicitly supplied edit schedule.
 * @param maxOccurrences - Frozen maximum expansion, independent from raw-frame count.
 * @returns Exact movie intervals and stable occurrence-to-raw identities.
 * @throws {Error} When clocks, edits, ledger or resource ceilings cannot form this exact plan.
 */
export function planRateOnePresentation(input: RateOnePresentationInput, maxOccurrences: number): OwnedVideoPresentation {
  void input; void maxOccurrences;
  throw new Error("Rate-one occurrence planning awaits independent RED");
}
