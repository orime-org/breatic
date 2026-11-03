// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import type { MatroskaMetadata } from "@ingest/container/matroska-metadata.js";
import type { MatroskaPhysicalVideoProbe } from "@ingest/container/physical-video-probe.js";
import { exactPresentationTime, type OwnedVideoPresentation } from "@ingest/container/iso-bmff-presentation.js";

/**
 * Assemble complete rate-one Matroska occurrences from independently associated frames.
 * @param metadata - Complete bounded source-container facts.
 * @param physical - Original decoded frames with independently bound track and block identities.
 * @param maxOccurrences - Ceiling for returned occurrences; physical-only frames keep their input identities.
 * @returns Complete exact declared support without changing the physical clock or inventing edits.
 * @throws {Error} When complete association, timing provenance or the ceiling fails.
 */
export function assembleMatroskaVideoPresentation(metadata: MatroskaMetadata, physical: MatroskaPhysicalVideoProbe, maxOccurrences: number): OwnedVideoPresentation {
  if (!Number.isSafeInteger(maxOccurrences) || maxOccurrences <= 0) throw new Error("Occurrence ceiling must be a positive safe integer");
  const tracks = metadata.tracks.filter((track) => track.trackNumber === physical.trackNumber);
  if (tracks.length !== 1 || tracks[0]!.trackUid !== physical.trackUid || tracks[0]!.trackType !== "1") throw new Error("Expected one actual selected Matroska video track");
  const track = tracks[0]!;
  const scaleNumerator = exactInteger(track.trackTimestampScale.numerator);
  const scaleDenominator = positiveInteger(track.trackTimestampScale.denominator);
  if (scaleNumerator !== scaleDenominator) throw new Error("This assembler requires a declared rate-one track scale");
  const timestampScale = positiveInteger(metadata.timestampScaleNs);
  const sourceNumerator = positiveInteger(physical.sourceTimeBase.numerator);
  const sourceDenominator = positiveInteger(physical.sourceTimeBase.denominator);
  const delay = exactInteger(track.codecDelayNs);
  if (delay < 0n) throw new Error("Codec delay must be nonnegative");
  const blocks = metadata.blocks.filter((block) => block.trackNumber === track.trackNumber);
  const byOrdinal = new Map(blocks.map((block) => [block.blockOrdinal, block]));
  if (byOrdinal.size !== blocks.length || blocks.length === 0 || physical.frames.length !== blocks.length) throw new Error("Expected complete unique selected frame and block identities");
  const seen = new Set<number>();
  const selected = physical.frames.map((frame, index) => {
    const block = byOrdinal.get(frame.blockOrdinal);
    if (frame.rawDecodeOrdinal !== index || block === undefined || seen.has(frame.blockOrdinal) || block.lacing !== "none" || block.frameCount !== 1) throw new Error("Incomplete one-frame block association");
    seen.add(frame.blockOrdinal);
    const nanos = (exactInteger(block.clusterTimestampTicks) + exactInteger(block.relativeTimestampTicks)) * timestampScale - delay;
    if (exactInteger(frame.ptsTicks) * sourceNumerator * 1000000000n !== nanos * sourceDenominator) throw new Error("Physical PTS differs from its exact declared block time");
    if (block.discardPaddingNs !== null && exactInteger(block.discardPaddingNs) !== 0n) throw new Error("Video discard padding requires an explicit support-window contract");
    return { frame, block, nanos };
  });
  for (let index = 1; index < selected.length; index += 1) {
    if (selected[index]!.nanos <= selected[index - 1]!.nanos) throw new Error("Expected strictly increasing original physical presentation times");
  }
  const result: OwnedVideoPresentation = { edits: [], frames: [] };
  for (const [index, item] of selected.entries()) {
    // Physical-only frames have already passed the complete association check.
    if (item.nanos < 0n || item.block.invisible) continue;
    const next = selected[index + 1];
    const duration = item.block.blockDurationTicks !== null ? positiveInteger(item.block.blockDurationTicks) * timestampScale
      : track.defaultDurationNs !== null ? positiveInteger(track.defaultDurationNs)
        : next === undefined ? null : next.nanos - item.nanos;
    if (duration === null || duration <= 0n) throw new Error("The terminal display frame requires its own declared duration");
    if (result.frames.length >= maxOccurrences) throw new Error("Presentation occurrence ceiling exceeded");
    result.frames.push({ presentationOrdinal: result.frames.length, editOccurrence: 0, rawDecodeOrdinal: item.frame.rawDecodeOrdinal,
      sourcePtsTicks: item.frame.ptsTicks, mappedPts: exactPresentationTime(item.nanos, 1000000000n),
      displayStart: exactPresentationTime(item.nanos, 1000000000n), displayEnd: exactPresentationTime(item.nanos + duration, 1000000000n) });
  }
  return result;
}

/** Read an exact decimal metadata integer without rounding or accepting another radix.
 * @throws {Error} When the source fact is not an exact decimal integer.
 */
function exactInteger(value: string): bigint {
  if (!/^-?\d+$/u.test(value)) throw new Error("Expected an exact decimal source fact");
  return BigInt(value);
}

/** Read a positive declared clock or duration, without a fallback value.
 * @throws {Error} When a clock or duration is absent, malformed or nonpositive.
 */
function positiveInteger(value: string): bigint {
  const integer = exactInteger(value);
  if (integer <= 0n) throw new Error("Expected a positive original clock or duration");
  return integer;
}
