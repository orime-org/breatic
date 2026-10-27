// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { IsoBmffMetadata } from "@ingest/container/iso-bmff-metadata.js";
import { planUneditedVideoPresentation, type OwnedVideoPresentation } from "@ingest/container/iso-bmff-presentation.js";
import type { PhysicalVideoProbe } from "@ingest/container/physical-video-probe.js";

/**
 * Associate declared no-edit sample timing with the original selected physical video track.
 * @param iso - Complete bounded container metadata from the immutable source.
 * @param physical - Original exact source clock and dense physical frame identities.
 * @param maxOccurrences - Frozen occurrence ceiling, independent from metadata byte limits.
 * @returns Exact owned occurrences without fabricating an on-disk edit list.
 * @throws {Error} When the selected track, complete timing association or occurrence ceiling fails.
 */
export function assembleUneditedIsoVideoPresentation(
  iso: IsoBmffMetadata,
  physical: PhysicalVideoProbe,
  maxOccurrences: number,
): OwnedVideoPresentation {
  const matches = iso.tracks.filter((track) => track.trackId === physical.trackId);
  if (matches.length !== 1) throw new Error("Expected one ISO track matching the original physical video track");
  const track = matches[0]!;
  if (track.edits !== null) throw new Error("An explicit edit schedule requires the explicit presentation assembler");
  const timing = track.sampleTiming;
  if (!timing) throw new Error("Expected the selected track's declared sample timing");
  if (timing.compositionShift !== null) throw new Error("Composition-shift display windows require an explicit association contract");
  if (!Number.isSafeInteger(maxOccurrences) || maxOccurrences <= 0 || physical.frames.length > maxOccurrences) throw new Error("Invalid or insufficient occurrence ceiling");
  const count = timing.decodeRuns.reduce((sum, run) => sum + run.sampleCount, 0);
  if (count !== physical.frames.length || count === 0) throw new Error("Declared samples and physical frames must be complete");
  const offsets: bigint[] = [];
  if (timing.compositionRuns !== null) {
    const compositionCount = timing.compositionRuns.reduce((sum, run) => sum + run.sampleCount, 0);
    if (compositionCount !== count) throw new Error("Every declared sample requires its own composition offset");
    for (const run of timing.compositionRuns) {
      const offset = BigInt(run.offsetTicks);
      for (let index = 0; index < run.sampleCount; index += 1) offsets.push(offset);
    }
  }
  const sourceNumerator = BigInt(physical.sourceTimeBase.numerator);
  const sourceDenominator = BigInt(physical.sourceTimeBase.denominator);
  const mediaScale = BigInt(track.mediaTimescale);
  if (sourceNumerator <= 0n || sourceDenominator <= 0n || mediaScale <= 0n) throw new Error("Expected positive original clocks");
  // Both sides use the same integer product domain, so no Number conversion,
  // rounded seconds, or assumption that the two tick units are identical.
  const durationByCompositionTime = new Map<bigint, bigint>();
  let dts = 0n;
  let sample = 0;
  for (const run of timing.decodeRuns) {
    const delta = BigInt(run.deltaTicks);
    for (let index = 0; index < run.sampleCount; index += 1) {
      const key = (dts + (offsets[sample] ?? 0n)) * sourceDenominator;
      if (durationByCompositionTime.has(key)) throw new Error("Ambiguous declared composition time");
      durationByCompositionTime.set(key, delta);
      dts += delta;
      sample += 1;
    }
  }
  let terminalDuration: bigint | undefined;
  for (const frame of physical.frames) {
    const key = BigInt(frame.ptsTicks) * sourceNumerator * mediaScale;
    const delta = durationByCompositionTime.get(key);
    if (delta === undefined) throw new Error("Physical PTS has no declared sample association");
    durationByCompositionTime.delete(key);
    terminalDuration = delta;
  }
  if (durationByCompositionTime.size !== 0 || terminalDuration === undefined || terminalDuration <= 0n) throw new Error("Incomplete sample association or invalid final dwell");
  return planUneditedVideoPresentation(physical.frames, physical.sourceTimeBase, { numerator: terminalDuration.toString(), denominator: track.mediaTimescale }, maxOccurrences);
}
