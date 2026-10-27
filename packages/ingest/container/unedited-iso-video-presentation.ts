// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { IsoBmffMetadata } from "@ingest/container/iso-bmff-metadata.js";
import type { OwnedVideoPresentation } from "@ingest/container/iso-bmff-presentation.js";
import type { PhysicalVideoProbe } from "@ingest/container/physical-video-probe.js";

/**
 * Associate declared no-edit sample timing with the original selected physical video track.
 * @param iso - Complete bounded container metadata from the immutable source.
 * @param physical - Original exact source clock and dense physical frame identities.
 * @param maxOccurrences - Frozen occurrence ceiling, independent from metadata byte limits.
 * @returns Exact owned occurrences without fabricating an on-disk edit list.
 * @throws {Error} Until the independent ordinary-source contract is implemented.
 */
export function assembleUneditedIsoVideoPresentation(
  iso: IsoBmffMetadata,
  physical: PhysicalVideoProbe,
  maxOccurrences: number,
): OwnedVideoPresentation {
  void iso;
  void physical;
  void maxOccurrences;
  throw new Error("Unimplemented ordinary ISO presentation assembly");
}
