// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { IsoBmffMetadata } from "@ingest/container/iso-bmff-metadata.js";
import type { OwnedVideoPresentation } from "@ingest/container/iso-bmff-presentation.js";
import type { PhysicalVideoProbe } from "@ingest/container/physical-video-probe.js";

/**
 * Assemble a selected physical track's complete explicit edit schedule without IO or implicit edits.
 * @param iso - Container metadata from the same immutable source as the physical probe.
 * @param physical - The selected video track's exact unedited clock and complete frame ledger.
 * @param maxOccurrences - Caller-frozen expansion ceiling passed to the rate-one planner.
 * @returns The owned explicit schedule, or null when the matched track has no explicit edit list.
 * @throws {Error} When track association, exact planning or the caller's ceiling fails.
 */
export function assembleExplicitIsoVideoPresentation(
  iso: IsoBmffMetadata,
  physical: PhysicalVideoProbe,
  maxOccurrences: number,
): OwnedVideoPresentation | null {
  void iso; void physical; void maxOccurrences;
  throw new Error("Explicit ISO video presentation assembly is not implemented");
}
