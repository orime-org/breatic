// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseMatroskaPhysicalVideoProbe, type MatroskaPhysicalVideoProbe } from "@ingest/container/physical-video-probe.js";
import type { MatroskaMetadata } from "@ingest/container/matroska-metadata.js";
import { MATROSKA_PRESENTATION_CASES } from "./helpers/matroska-presentation-fixtures.js";

const STREAMS = { streams: [{ index: 0, codec_type: "audio", time_base: "1/48000" }, { index: 3, codec_type: "video", time_base: "1/1000" }, { index: 4, codec_type: "video", time_base: "1/90000", id: "0x99" }], format: { duration: "4000" } };
const EXPECTED: MatroskaPhysicalVideoProbe = { streamIndex: 3, trackNumber: "3", trackUid: "9007199254740993", sourceTimeBase: { numerator: "1", denominator: "1000" }, frames: [{ rawDecodeOrdinal: 0, ptsTicks: "0", blockOrdinal: 0 }, { rawDecodeOrdinal: 1, ptsTicks: "40", blockOrdinal: 1 }, { rawDecodeOrdinal: 2, ptsTicks: "80", blockOrdinal: 2 }] };

/** Clone independent K01 metadata without deriving identity from a stream array.
 * @throws {never} Never.
 */
function metadata(): MatroskaMetadata { return structuredClone(MATROSKA_PRESENTATION_CASES[0]!.metadata); }

/** Preserve source JSON numeric tokens literally, before any Number conversion.
 * @throws {never} Never.
 */
function bytes(pts = ["0", "40", "80"], positions = ["205", "305", "405"], extra = ""): Buffer {
  return Buffer.from(`{"frames":[${pts.map((value, index) => `{"media_type":"video","stream_index":3,"pts":${value},"pkt_pos":${positions[index]}${extra}}`).join(",")}]}`);
}

describe("Matroska selected physical frames with original block provenance", () => {
  it("binds the original first video by unique packet position without an ISO stream id", () => {
    expect(parseMatroskaPhysicalVideoProbe(STREAMS, bytes(), metadata())).toEqual(EXPECTED);
  });

  it("allows a missing packet size and a different demuxed packet size", () => {
    expect(parseMatroskaPhysicalVideoProbe(STREAMS, bytes(), metadata())).toEqual(EXPECTED);
    expect(parseMatroskaPhysicalVideoProbe(STREAMS, bytes(undefined, undefined, ',"pkt_size":"98765"'), metadata())).toEqual(EXPECTED);
  });

  it("selects actual stream index rather than video ordinal, label, disposition or track array order", () => {
    const source = structuredClone(STREAMS); Object.assign(source.streams[1]!, { id: "0x99", tags: { title: "Track 999" }, disposition: { default: 0 } });
    const input = metadata(); input.tracks.unshift({ ...input.tracks[0]!, trackNumber: "99", trackUid: "999" });
    expect(parseMatroskaPhysicalVideoProbe(source, bytes(), input)).toEqual(EXPECTED);
  });

  it("accepts full show_frames with audio and other video while preserving dense selected raw ordinals", () => {
    const mixed = Buffer.from('{"frames":[{"media_type":"audio","stream_index":0,"pts":0},{"media_type":"video","stream_index":3,"pts":0,"pkt_pos":"205"},{"media_type":"video","stream_index":4,"pts":0},{"media_type":"audio","stream_index":0,"pts":40},{"media_type":"video","stream_index":3,"pts":"40","pkt_pos":305},{"media_type":"video","stream_index":3,"pts":80,"pkt_pos":405}]}');
    expect(parseMatroskaPhysicalVideoProbe(STREAMS, mixed, metadata())).toEqual(EXPECTED);
  });

  it("keeps global physical block ordinals across interleaved audio blocks", () => {
    const input = metadata(); const audio = { ...input.tracks[0]!, trackNumber: "2", trackUid: "8", trackType: "2", codecId: "A_OPUS" }; input.tracks.unshift(audio);
    const audioBlock = { ...input.blocks[0]!, blockOrdinal: 0, elementOffset: "100", dataOffset: "110", trackNumber: "2" };
    input.blocks = [audioBlock, ...input.blocks.map((block, index) => ({ ...block, blockOrdinal: index + 1 }))];
    expect(parseMatroskaPhysicalVideoProbe(STREAMS, bytes(), input)).toEqual({ ...EXPECTED, frames: [{ rawDecodeOrdinal: 0, ptsTicks: "0", blockOrdinal: 1 }, { rawDecodeOrdinal: 1, ptsTicks: "40", blockOrdinal: 2 }, { rawDecodeOrdinal: 2, ptsTicks: "80", blockOrdinal: 3 }] });
  });

  it("does not impose a codec-name whitelist on actual single-frame decoded associations", () => {
    const input = metadata(); input.tracks[0]!.codecId = "V_SOURCE_CODEC";
    expect(parseMatroskaPhysicalVideoProbe(STREAMS, bytes(), input)).toEqual(EXPECTED);
  });

  it("keeps negative and invisible frames in the complete physical ledger", () => {
    const input = metadata(); input.blocks[0]!.invisible = true;
    expect(parseMatroskaPhysicalVideoProbe(STREAMS, bytes(["-10", "30", "70"]), input)).toEqual({ ...EXPECTED, frames: [{ rawDecodeOrdinal: 0, ptsTicks: "-10", blockOrdinal: 0 }, { rawDecodeOrdinal: 1, ptsTicks: "30", blockOrdinal: 1 }, { rawDecodeOrdinal: 2, ptsTicks: "70", blockOrdinal: 2 }] });
  });

  it("retains original numerator/denominator without reducing or replacing the source clock", () => {
    const source = structuredClone(STREAMS); source.streams[1]!.time_base = "0002/01000";
    expect(parseMatroskaPhysicalVideoProbe(source, bytes(), metadata())).toEqual({ ...EXPECTED, sourceTimeBase: { numerator: "0002", denominator: "01000" } });
  });

  it("preserves numeric and string PTS and packet-position tokens beyond 2^53", () => {
    const input = metadata(); input.blocks[0]!.elementOffset = "9007199254740990"; input.blocks[0]!.dataOffset = "9007199254741000";
    input.blocks[1]!.elementOffset = "9007199254741010"; input.blocks[1]!.dataOffset = "9007199254741020";
    input.blocks[2]!.elementOffset = "9007199254741030"; input.blocks[2]!.dataOffset = "9007199254741040";
    expect(parseMatroskaPhysicalVideoProbe(STREAMS, bytes(["-9007199254740993", '"9007199254740993"', "9007199254740995"], ["9007199254740993", '"9007199254741013"', "9007199254741033"]), input)).toEqual({ ...EXPECTED, frames: [{ rawDecodeOrdinal: 0, ptsTicks: "-9007199254740993", blockOrdinal: 0 }, { rawDecodeOrdinal: 1, ptsTicks: "9007199254740993", blockOrdinal: 1 }, { rawDecodeOrdinal: 2, ptsTicks: "9007199254740995", blockOrdinal: 2 }] });
  });

  it.each([undefined, null, "N/A", "", "0/1", "1/0", "-1/1000", "1.5/1000"])("rejects an invalid selected time base %s", (time_base) => {
    const source = structuredClone(STREAMS); Object.assign(source.streams[1]!, { time_base });
    expect(() => parseMatroskaPhysicalVideoProbe(source, bytes(), metadata())).toThrow(TypeError);
  });

  it.each([{}, { streams: [] }, { streams: [{ index: 0, codec_type: "audio" }] }, { streams: [{ index: "3", codec_type: "video", time_base: "1/1000" }] }, { streams: [{ index: 3, codec_type: "video", time_base: "1/1000" }, { index: 3, codec_type: "audio" }] }])("rejects absent or ambiguous original selected metadata %j", (source) => {
    expect(() => parseMatroskaPhysicalVideoProbe(source, bytes(), metadata())).toThrow(TypeError);
  });

  it.each(["null", '"205.0"', '"205junk"', "205.5", "2.05e2", '"N/A"', "-1", "200", "210", "211"])("rejects missing, non-integer or non-header packet position %s", (position) => {
    expect(() => parseMatroskaPhysicalVideoProbe(STREAMS, bytes(undefined, [position, "305", "405"]), metadata())).toThrow(TypeError);
  });

  it("rejects absent packet position without substituting PTS, index or packet size", () => {
    expect(() => parseMatroskaPhysicalVideoProbe(STREAMS, Buffer.from('{"frames":[{"media_type":"video","stream_index":3,"pts":0,"pkt_size":3}]}'), metadata())).toThrow(TypeError);
  });

  it("rejects a position matching two actual block headers", () => {
    const input = metadata(); input.blocks.push({ ...input.blocks[0]!, blockOrdinal: 3 });
    expect(() => parseMatroskaPhysicalVideoProbe(STREAMS, bytes(), input)).toThrow(TypeError);
  });

  it("rejects frames mapped across two different actual tracks", () => {
    const input = metadata(); input.tracks.push({ ...input.tracks[0]!, trackNumber: "4", trackUid: "44" }); input.blocks[1]!.trackNumber = "4";
    expect(() => parseMatroskaPhysicalVideoProbe(STREAMS, bytes(), input)).toThrow(TypeError);
  });

  it("rejects a selected video frame bound to a non-video Matroska track", () => {
    const input = metadata(); input.tracks[0]!.trackType = "2"; input.tracks[0]!.codecId = "A_OPUS";
    expect(() => parseMatroskaPhysicalVideoProbe(STREAMS, bytes(), input)).toThrow(TypeError);
  });

  it("rejects a non-video frame claiming the selected video stream index", () => {
    expect(() => parseMatroskaPhysicalVideoProbe(STREAMS, Buffer.from('{"frames":[{"media_type":"audio","stream_index":3,"pts":0,"pkt_pos":205}]}'), metadata())).toThrow(TypeError);
  });

  it.each([bytes(["0", "40"], ["205", "305"]), bytes(["0", "40", "80"], ["205", "205", "405"])])("rejects incomplete or repeated one-frame block association", (frames) => {
    expect(() => parseMatroskaPhysicalVideoProbe(STREAMS, frames, metadata())).toThrow(TypeError);
  });

  it.each(["xiph", "fixed", "ebml"] as const)("does not pretend a %s lace has the one-block/one-frame association", (lacing) => {
    const input = metadata(); input.blocks[0]!.lacing = lacing; input.blocks[0]!.frameCount = 2;
    expect(() => parseMatroskaPhysicalVideoProbe(STREAMS, bytes(), input)).toThrow(TypeError);
  });

  it.each(["null", '"N/A"', "1.5", "1e3"])("rejects malformed original selected PTS %s", (pts) => {
    expect(() => parseMatroskaPhysicalVideoProbe(STREAMS, bytes([pts, "40", "80"]), metadata())).toThrow(TypeError);
  });

  it("does not replace incomplete original JSON with a prefix ledger", () => {
    expect(() => parseMatroskaPhysicalVideoProbe(STREAMS, Buffer.from('{"frames":['), metadata())).toThrow(SyntaxError);
  });

  it("keeps identity exact across uint64 UID and safe source packet offsets", () => {
    fc.assert(fc.property(fc.bigInt({ min: 1n, max: 18446744073709551615n }), fc.integer({ min: 202, max: 209 }), (uid, position) => {
      const input = metadata(); input.tracks[0]!.trackUid = uid.toString();
      expect(parseMatroskaPhysicalVideoProbe(STREAMS, bytes(undefined, [String(position), "305", "405"]), input)).toEqual({ ...EXPECTED, trackUid: uid.toString() });
    }), { seed: 1306, numRuns: 64 });
  });
});
