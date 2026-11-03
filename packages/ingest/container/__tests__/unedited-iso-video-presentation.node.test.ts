// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from "vitest";
import { inspectIsoBmffMetadata, type IsoBmffMetadata } from "@ingest/container/iso-bmff-metadata.js";
import { parsePhysicalVideoProbe, type PhysicalVideoProbe } from "@ingest/container/physical-video-probe.js";
import type { ExactPresentationTime, OwnedVideoPresentation } from "@ingest/container/iso-bmff-presentation.js";
import { assembleUneditedIsoVideoPresentation } from "@ingest/container/unedited-iso-video-presentation.js";
import { SAMPLE_METADATA_LIMITS, sampleByteSource, sampleCtts, sampleMovie, sampleStts, sampleTrack } from "./helpers/iso-sample-timing-fixtures.js";

/** Encode an independent expected fraction without invoking production arithmetic.
 * @throws {never} Never.
 */
function time(numerator: string, denominator = "1"): ExactPresentationTime { return { numerator, denominator }; }

/** Construct complete ordinary metadata through the real bounded binary reader.
 * @throws {Error} When the metadata reader rejects the fixture.
 */
async function metadata(deltas: readonly string[] | null, offsets: readonly string[] | null = null): Promise<IsoBmffMetadata> {
  return inspectIsoBmffMetadata(sampleByteSource(sampleMovie([
    sampleTrack({ trackId: 11, mediaTimescale: 48000, mediaDuration: 192000, trackDuration: 4000, sampleBoxes: [sampleStts([{ sampleCount: 4, deltaTicks: "48000" }])] }),
    sampleTrack({ trackId: 7, mediaTimescale: 1000, mediaDuration: deltas === null ? 120 : Number(deltas.reduce((sum, delta) => sum + BigInt(delta), 0n)), sampleBoxes: [
      ...(deltas === null ? [] : [sampleStts(deltas.map((deltaTicks) => ({ sampleCount: 1, deltaTicks })))]),
      ...(offsets === null ? [] : [sampleCtts(1, offsets.map((offsetTicks) => ({ sampleCount: 1, offsetTicks })))]),
    ] }),
  ])), SAMPLE_METADATA_LIMITS);
}

/** Parse actual numeric JSON tokens with the existing selected physical-probe parser.
 * @throws {Error} When source clock or selected physical facts are rejected.
 */
function physical(pts: readonly string[], numerator = "1", denominator = "1000"): PhysicalVideoProbe {
  const frames = pts.map((value) => `{"media_type":"video","stream_index":3,"pts":${value}}`).join(",");
  return parsePhysicalVideoProbe({ streams: [
    { index: 0, codec_type: "audio", id: "0xb", time_base: "1/48000" },
    { index: 3, codec_type: "video", id: "0x7", time_base: `${numerator}/${denominator}` },
  ] }, Buffer.from(`{"frames":[${frames}]}`));
}

/** Materialize only independently supplied golden times and original raw identities.
 * @throws {never} Never.
 */
function expected(pts: readonly string[], starts: readonly ExactPresentationTime[], ends: readonly ExactPresentationTime[]): OwnedVideoPresentation {
  return { edits: [], frames: pts.map((sourcePtsTicks, rawDecodeOrdinal) => ({
    presentationOrdinal: rawDecodeOrdinal, editOccurrence: 0, rawDecodeOrdinal, sourcePtsTicks,
    mappedPts: starts[rawDecodeOrdinal]!, displayStart: starts[rawDecodeOrdinal]!, displayEnd: ends[rawDecodeOrdinal]!,
  })) };
}

const CFR_TIMES = [time("0"), time("1", "25"), time("2", "25"), time("3", "25")];

describe("ordinary no-elst ISO assembly from independent source-ledger fixtures", () => {
  it("N01 retains the declared CFR video extent independently from the four-second movie/audio tail", async () => {
    const iso = await metadata(["40", "40", "40"]); const probe = physical(["0", "40", "80"]);
    expect(iso.movieDurationTicks).toBe("4000"); expect(iso.tracks.map((track) => track.trackId)).toEqual([11, 7]);
    expect(assembleUneditedIsoVideoPresentation(iso, probe, 3)).toEqual(expected(["0", "40", "80"], CFR_TIMES.slice(0, 3), CFR_TIMES.slice(1)));
  });

  it("N02 uses the final displayed sample's declared duration for the VFR terminal dwell", async () => {
    const iso = await metadata(["40", "100", "60"]); const probe = physical(["0", "40", "140"]);
    expect(assembleUneditedIsoVideoPresentation(iso, probe, 3)).toEqual(expected(["0", "40", "140"], [time("0"), time("1", "25"), time("7", "50")], [time("1", "25"), time("7", "50"), time("1", "5")]));
  });

  it("N03 associates signed CTTS coded-sample order with the original physical display order", async () => {
    const iso = await metadata(["40", "40", "40"], ["0", "40", "-40"]); const probe = physical(["0", "40", "80"]);
    expect(assembleUneditedIsoVideoPresentation(iso, probe, 3)).toEqual(expected(["0", "40", "80"], CFR_TIMES.slice(0, 3), CFR_TIMES.slice(1)));
    expect(probe.frames).toEqual([{ rawDecodeOrdinal: 0, ptsTicks: "0" }, { rawDecodeOrdinal: 1, ptsTicks: "40" }, { rawDecodeOrdinal: 2, ptsTicks: "80" }]);
  });

  it("N04 cross-multiplies mdhd 1/1000 ticks and the original physical 2/1000 source clock", async () => {
    const iso = await metadata(["40", "40", "40"]); const probe = physical(["0", "20", "40"], "2");
    expect(iso.tracks.find((track) => track.trackId === 7)!.mediaTimescale).toBe("1000");
    expect(probe.sourceTimeBase).toEqual(time("2", "1000"));
    expect(assembleUneditedIsoVideoPresentation(iso, probe, 3)).toEqual(expected(["0", "20", "40"], CFR_TIMES.slice(0, 3), CFR_TIMES.slice(1)));
    expect(probe.sourceTimeBase).toEqual(time("2", "1000"));
  });

  it("N07 rejects missing selected-track sample timing instead of using mdhd/movie duration", async () => {
    const iso = await metadata(null); const probe = physical(["0", "40", "80"]);
    expect(iso.tracks.find((track) => track.trackId === 7)!.sampleTiming).toBeUndefined();
    expect(() => assembleUneditedIsoVideoPresentation(iso, probe, 3)).toThrow();
  });

  it("N08 rejects incomplete sample-to-physical association rather than publishing a prefix", async () => {
    const iso = await metadata(["40", "40"]); const probe = physical(["0", "40", "80"]);
    expect(() => assembleUneditedIsoVideoPresentation(iso, probe, 3)).toThrow();
  });

  it("rejects a CTTS count that leaves a declared sample without its composition offset", async () => {
    const iso = await metadata(["40", "40", "40"], ["0", "40"]);
    expect(() => assembleUneditedIsoVideoPresentation(iso, physical(["0", "40", "80"]), 3)).toThrow();
  });

  it("does not treat another track's valid timing as the selected video timing", async () => {
    const iso = await metadata(["40", "40", "40"]); const probe = physical(["0", "40", "80"]);
    probe.trackId = 99;
    expect(() => assembleUneditedIsoVideoPresentation(iso, probe, 3)).toThrow();
  });

  it("rejects a selected physical PTS that has no declared composition-time association", async () => {
    const iso = await metadata(["40", "40", "40"], ["0", "40", "-40"]);
    expect(() => assembleUneditedIsoVideoPresentation(iso, physical(["0", "41", "80"]), 3)).toThrow();
  });

  it("rejects an insufficient occurrence budget without truncating the complete source", async () => {
    const iso = await metadata(["40", "40", "40"]); const probe = physical(["0", "40", "80"]);
    expect(() => assembleUneditedIsoVideoPresentation(iso, probe, 2)).toThrow();
  });

  it("reuses frozen ordinary source facts without changing clocks or inventing source identities", async () => {
    const iso = await metadata(["40", "40", "40"]); const probe = physical(["0", "40", "80"]); const before = structuredClone({ iso, probe });
    for (const track of iso.tracks) {
      if (track.sampleTiming) { for (const run of track.sampleTiming.decodeRuns) Object.freeze(run); Object.freeze(track.sampleTiming.decodeRuns); Object.freeze(track.sampleTiming); }
      Object.freeze(track);
    }
    for (const frame of probe.frames) Object.freeze(frame);
    Object.freeze(iso.tracks); Object.freeze(iso); Object.freeze(probe.frames); Object.freeze(probe.sourceTimeBase); Object.freeze(probe);
    expect(assembleUneditedIsoVideoPresentation(iso, probe, 3)).toEqual(expected(["0", "40", "80"], CFR_TIMES.slice(0, 3), CFR_TIMES.slice(1)));
    expect({ iso, probe }).toEqual(before);
  });
});
