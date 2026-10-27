// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { VideoSourceLedgerCompanion, PhysicalVideoProbe, MatroskaPhysicalVideoProbe } from "@shared/upload/video-source-ledger-types.js";
import type { IsoBmffMetadata } from "@ingest/container/iso-bmff-metadata.js";
import type { MatroskaMetadata } from "@ingest/container/matroska-metadata.js";
import { assembleExplicitIsoVideoPresentation } from "@ingest/container/explicit-iso-video-presentation.js";
import { assembleUneditedIsoVideoPresentation } from "@ingest/container/unedited-iso-video-presentation.js";
import { assembleMatroskaVideoPresentation } from "@ingest/container/matroska-video-presentation.js";

/** Already admitted source identity and frozen pure-planning ceilings. */
interface SourceLedgerAssemblyBase {
  sourceFingerprint: string;
  attempt: { jobId: string; deadlineAt: number };
  limits: { maxPhysicalFrames: number; maxOccurrences: number };
}
/** Complete same-source bounded reader/physical facts, not an IO request. */
export type VideoSourceLedgerAssemblyInput = SourceLedgerAssemblyBase & ({
  kind: "iso_bmff";
  metadata: IsoBmffMetadata;
  physical: PhysicalVideoProbe;
} | {
  kind: "matroska";
  metadata: MatroskaMetadata;
  physical: MatroskaPhysicalVideoProbe;
});

/**
 * Assemble the complete source companion by reusing the existing pure format owners.
 * @param input - Accepted immutable identity, original facts and mandatory limits.
 * @returns Complete selected-track provenance and the original owners' exact schedule.
 * @throws {Error} When mandatory limits, complete physical facts or the original format owner reject the source.
 */
export function assembleVideoSourceLedger(input: VideoSourceLedgerAssemblyInput): VideoSourceLedgerCompanion {
  const { maxPhysicalFrames, maxOccurrences } = input.limits;
  if (!Number.isSafeInteger(maxPhysicalFrames) || maxPhysicalFrames <= 0 || !Number.isSafeInteger(maxOccurrences) || maxOccurrences <= 0) {
    throw new Error("Source ledger ceilings must be positive safe integers");
  }
  if (input.physical.frames.length === 0 || input.physical.frames.length > maxPhysicalFrames) throw new Error("Complete physical source exceeds its frame ceiling or is empty");
  const identity = { schemaVersion: 1 as const, producerVersion: 1 as const, sourceFingerprint: input.sourceFingerprint, attempt: input.attempt };
  if (input.kind === "matroska") {
    const presentation = assembleMatroskaVideoPresentation(input.metadata, input.physical, maxOccurrences);
    return {
      ...identity, strategy: "matroska_rate_one", physical: input.physical, presentation,
      container: { kind: "matroska", timestampScaleNs: input.metadata.timestampScaleNs,
        track: input.metadata.tracks.find((track) => track.trackNumber === input.physical.trackNumber)!,
        blocks: input.metadata.blocks.filter((block) => block.trackNumber === input.physical.trackNumber) },
    };
  }
  const explicit = assembleExplicitIsoVideoPresentation(input.metadata, input.physical, maxOccurrences);
  const presentation = explicit === null ? assembleUneditedIsoVideoPresentation(input.metadata, input.physical, maxOccurrences) : explicit;
  return {
    ...identity, strategy: explicit === null ? "iso_unedited_rate_one" : "iso_explicit_rate_one", physical: input.physical, presentation,
    container: { kind: "iso_bmff", movieTimescale: input.metadata.movieTimescale, movieDurationTicks: input.metadata.movieDurationTicks,
      track: input.metadata.tracks.find((track) => track.trackId === input.physical.trackId)! },
  };
}
