// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type {
  VideoSourceLedgerCompanion, PhysicalVideoProbe, MatroskaPhysicalVideoProbe, OwnedVideoPresentation, VideoEditSpan, VideoSourceLedgerV2, VideoSourceRun,
} from "@shared/upload/video-source-ledger-types.js";
import { projectPresentationTable, type VideoPresentationTable } from "@shared/mini-tools/video-presentation-projection.js";
import type { IsoBmffEdit, IsoBmffMetadata } from "@ingest/container/iso-bmff-metadata.js";
import { exactPresentationTime } from "@ingest/container/iso-bmff-presentation.js";
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

/** Already admitted source identity and the complete facts the container parsed from it. */
export type VideoSourceLedgerV2Input = Omit<SourceLedgerAssemblyBase, "limits"> & ({
  kind: "iso_bmff";
  metadata: IsoBmffMetadata;
  physical: PhysicalVideoProbe;
  /** The selected audio track, or null when the source has no audio. */
  audioTrackId: number | null;
} | {
  kind: "matroska";
  metadata: MatroskaMetadata;
  physical: MatroskaPhysicalVideoProbe;
});

/** No frame ceiling: the stored ledger covers every upload (inner#1306), so the planners get the largest one they accept. */
const UNBOUNDED = Number.MAX_SAFE_INTEGER;

/**
 * Assemble the stored source ledger v2 and its compact presentation table in one pure call.
 * @param input - Accepted identity and the complete parsed container and physical facts.
 * @returns The ledger and the compact table, which is the ledger's own presentation.
 * @throws {Error} When the format owner rejects the source; `code` is `unsupported_rate` for a non-positive edit rate and `no_presented_frames` when nothing is presented.
 */
export function assembleVideoSourceLedgerV2(input: VideoSourceLedgerV2Input): { ledger: VideoSourceLedgerV2; table: VideoPresentationTable } {
  let presentation: OwnedVideoPresentation;
  let videoEdits: VideoEditSpan[] | null = null;
  let audioEdits: VideoEditSpan[] | null = null;
  if (input.kind === "matroska") presentation = assembleMatroskaVideoPresentation(input.metadata, input.physical, UNBOUNDED);
  else {
    const explicit = assembleExplicitIsoVideoPresentation(input.metadata, input.physical, UNBOUNDED);
    presentation = explicit ?? assembleUneditedIsoVideoPresentation(input.metadata, input.physical, UNBOUNDED);
    if (explicit !== null) {
      const video = trackOf(input.metadata, input.physical.trackId);
      videoEdits = editSpans(video.edits!, input.metadata.movieTimescale, video.mediaTimescale);
    }
    if (input.audioTrackId !== null) {
      const audio = trackOf(input.metadata, input.audioTrackId);
      audioEdits = audio.edits === null ? null : editSpans(audio.edits, input.metadata.movieTimescale, audio.mediaTimescale);
    }
  }
  if (presentation.frames.length === 0) throw ledgerError("no_presented_frames", "The edits present no frame");
  const table = projectPresentationTable(presentation.frames);
  const ledger: VideoSourceLedgerV2 = {
    schemaVersion: 2, sourceFingerprint: input.sourceFingerprint, producerVersion: 2, attempt: { ...input.attempt }, presentation: table,
    source: { timeBase: { ...input.physical.sourceTimeBase }, runs: sourceRuns(presentation.frames.map((frame) => sourceTick(frame.sourcePtsTicks))) },
    videoEdits, audioEdits,
  };
  return { ledger, table };
}

/**
 * The one ISO track with this id.
 * @param metadata - Parsed ISO metadata.
 * @param trackId - The track id.
 * @returns The track.
 * @throws {Error} When no track or more than one has this id.
 */
function trackOf(metadata: IsoBmffMetadata, trackId: number): IsoBmffMetadata["tracks"][number] {
  const matches = metadata.tracks.filter((track) => track.trackId === trackId);
  if (matches.length !== 1) throw new Error("Expected one ISO track with the selected id");
  return matches[0]!;
}

/**
 * The non-empty, non-zero edits of an ISO edit list as spans laid out in movie time.
 * @param edits - The track's edit list.
 * @param movieTimescale - Movie ticks per second.
 * @param mediaTimescale - The track's media ticks per second.
 * @returns Spans in presentation order.
 * @throws {Error} With `code` `unsupported_rate` for a non-positive rate.
 */
function editSpans(edits: readonly IsoBmffEdit[], movieTimescale: string, mediaTimescale: string): VideoEditSpan[] {
  const movie = BigInt(movieTimescale);
  const media = BigInt(mediaTimescale);
  const spans: VideoEditSpan[] = [];
  let at = 0n;
  for (const edit of edits) {
    const rate = BigInt(edit.mediaRateFixed16_16);
    if (rate <= 0n) throw ledgerError("unsupported_rate", "Edit rates must be positive");
    const duration = BigInt(edit.segmentDurationMovieTicks);
    const mediaTime = BigInt(edit.mediaTimeTrackTicks);
    if (mediaTime !== -1n && duration > 0n) {
      // The edit presents source [m, m + d·rate) from movie time `at`.
      spans.push({
        sourceStart: exactPresentationTime(mediaTime, media),
        sourceEnd: exactPresentationTime(mediaTime * movie * 65536n + duration * rate * media, media * movie * 65536n),
        presentationStart: exactPresentationTime(at, movie),
        rate: exactPresentationTime(rate, 65536n),
      });
    }
    at += duration;
  }
  return spans;
}

/**
 * A presented frame's source tick as a safe number.
 * @param ticks - The decimal tick string.
 * @returns The tick.
 * @throws {Error} With `code` `invalid_ledger` when the tick is not a safe integer.
 */
function sourceTick(ticks: string): number {
  const value = Number(ticks);
  if (!/^-?\d+$/u.test(ticks) || !Number.isSafeInteger(value)) throw ledgerError("invalid_ledger", "Source ticks must be safe integers");
  return value;
}

/**
 * Greedy canonical run-length encoding of source ticks: a tick extends the last run when it continues its progression, or when the last run has one frame and the tick increases.
 * @param ticks - One source tick per presented frame.
 * @returns The runs; a single-frame run steps by 0.
 * @throws {never} Never.
 */
function sourceRuns(ticks: readonly number[]): VideoSourceRun[] {
  const runs: VideoSourceRun[] = [];
  for (const tick of ticks) {
    const run = runs.at(-1);
    if (run !== undefined && run.count === 1 && tick > run.start) { run.step = tick - run.start; run.count = 2; } else if (run !== undefined && run.count > 1 && tick === run.start + run.count * run.step) run.count += 1;
    else runs.push({ start: tick, count: 1, step: 0 });
  }
  return runs;
}

/**
 * A producer failure carrying the code the ledger state stores.
 * @param code - The failure code.
 * @param message - What failed.
 * @returns The error.
 * @throws {never} Never.
 */
function ledgerError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
