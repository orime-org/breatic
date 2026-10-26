// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parsePhysicalVideoProbe, type PhysicalVideoProbe } from "@ingest/container/physical-video-probe.js";

interface ProbeMetadata { streams: Record<string, unknown>[]; format: Record<string, unknown>; [key: string]: unknown }
const METADATA: ProbeMetadata = { streams: [
  { index: 0, codec_type: "audio", id: "0x5", time_base: "1/48000" },
  { index: 1, codec_type: "video", id: "0x2a", time_base: "2/16384" },
  { index: 2, codec_type: "video", id: "0x77", time_base: "1/90000" },
], format: { duration: "100.000000" } };
// M1/P1–P4: original integer tokens are literal text, never unsafe JS numbers.
const GOLDEN = '{"frames":[{"media_type":"video","stream_index":1,"pts":-9007199254740993,"pts_time":"999.1","best_effort_timestamp":0},{"media_type":"video","stream_index":1,"pts":9007199254740993,"pts_time":"-999.1"},{"media_type":"video","stream_index":1,"pts":"9007199254740993"},{"media_type":"video","stream_index":1,"pts":4096}]}';
const EXPECTED: PhysicalVideoProbe = { streamIndex: 1, trackId: 42, sourceTimeBase: { numerator: "2", denominator: "16384" }, frames: [
  { rawDecodeOrdinal: 0, ptsTicks: "-9007199254740993" }, { rawDecodeOrdinal: 1, ptsTicks: "9007199254740993" },
  { rawDecodeOrdinal: 2, ptsTicks: "9007199254740993" }, { rawDecodeOrdinal: 3, ptsTicks: "4096" },
] };

/** Build a fresh metadata object without changing the selected stream's other facts. @returns The original probe fixture with its finite mutation. */
function metadata(patch: Record<string, unknown> = {}): ProbeMetadata {
  const value = structuredClone(METADATA); value.streams[1] = { ...value.streams[1], ...patch }; return value;
}

/** Put exact numeric token text into the original frame array. @returns Raw frame JSON bytes without a Number roundtrip. */
function bytes(tokens: readonly string[] = ["4096"], streamIndex = 1): Buffer {
  return Buffer.from(`{"frames":[${tokens.map((pts) => `{"media_type":"video","stream_index":${streamIndex},"pts":${pts}}`).join(",")}]}`);
}

/** Project the given independent tick strings without inspecting parser output. @returns The exact owned result. */
function expected(ticks: readonly string[], streamIndex = 1): PhysicalVideoProbe {
  return { streamIndex, trackId: 42, sourceTimeBase: { numerator: "2", denominator: "16384" },
    frames: ticks.map((ptsTicks, rawDecodeOrdinal) => ({ rawDecodeOrdinal, ptsTicks })) };
}

// M1–M7/T1–T4/T7: v:0 is the first video in the original stream order.
describe("physical video stream and clock facts", () => {
  it("preserves the complete literal integer golden, including negative, repeated and descending PTS", () => {
    expect(parsePhysicalVideoProbe(metadata(), Buffer.from(GOLDEN))).toEqual(EXPECTED);
  });

  it("allows unrelated metadata without leaking derived fields into the physical contract", () => {
    const original = metadata(); original.programs = [{ streams: [{ index: 2 }] }]; original.stream_groups = [{ id: 999 }];
    original.tags = { comment: "unrelated probe facts" }; original.format.duration = "999999.000000";
    original.streams[1] = { ...original.streams[1], avg_frame_rate: "30000/1001", r_frame_rate: "24/1", width: 400, height: 200 };
    expect(parsePhysicalVideoProbe(original, bytes())).toEqual(expected(["4096"]));
  });

  it("distinguishes a selected total stream index2 from the first video ordinal", () => {
    const original = metadata(); original.streams = [original.streams[0]!, { index: 1, codec_type: "data" },
      { ...original.streams[1], index: 2 }, { ...original.streams[2], index: 3 }];
    expect(parsePhysicalVideoProbe(original, bytes(["4096"], 2))).toEqual(expected(["4096"], 2));
  });

  it("accepts a selected video at the original zero-based stream index0", () => {
    const original = metadata(); original.streams = [{ ...original.streams[1], index: 0 }];
    expect(parsePhysicalVideoProbe(original, bytes(["4096"], 0))).toEqual(expected(["4096"], 0));
  });

  it.each([{ disposition: { default: 0 } }, { disposition: { default: 0, attached_pic: 1 } }])("keeps the first video despite its disposition %j", ({ disposition }) => {
      const original = metadata({ disposition }); original.streams[2] = { ...original.streams[2], id: "0x1", disposition: { default: 1 } };
      expect(parsePhysicalVideoProbe(original, bytes())).toEqual(expected(["4096"]));
    });

  it.each([
    { id: "42", trackId: 42 }, { id: 42, trackId: 42 }, { id: "0X2A", trackId: 42 },
    { id: "0xFFFFFFFF", trackId: 4294967295 }, { id: "4294967295", trackId: 4294967295 },
    { id: "0x1", trackId: 1 }, { id: "1", trackId: 1 }, { id: 1, trackId: 1 },
  ])("reads a complete positive uint32 track ID $id", ({ id, trackId }) => {
    expect(parsePhysicalVideoProbe(metadata({ id }), bytes())).toEqual({ ...expected(["4096"]), trackId });
  });

  it.each([
    { time_base: "2/16384", numerator: "2", denominator: "16384" },
    { time_base: "1/90000", numerator: "1", denominator: "90000" },
    { time_base: "0002/016384", numerator: "0002", denominator: "016384" },
    { time_base: "9007199254740993/9007199254740995", numerator: "9007199254740993", denominator: "9007199254740995" },
  ])("retains the selected video rational exactly: $time_base", ({ time_base, numerator, denominator }) => {
    expect(parsePhysicalVideoProbe(metadata({ time_base }), bytes())).toEqual({ ...expected(["4096"]), sourceTimeBase: { numerator, denominator } });
  });
});

// M8–M14/T5–T6: bad selected facts cannot be repaired from a different stream.
describe("physical stream metadata rejection", () => {
  it.each([undefined, "N/A", null, true, "", 0, "0", "0x0", -1, "-1", 4294967296, "0x100000000",
    "42.0", "4.2e1", "42junk", "0x2ag", "+42", " 42", "42 ", 42.5].map((id) => ({ id })))("rejects an absent, malformed or out-of-domain selected ID $id", ({ id }) => {
      expect(() => parsePhysicalVideoProbe(metadata({ id }), bytes())).toThrow();
    });

  it.each([null, [], 0, "metadata", true, undefined, {}, { streams: null }, { streams: {} }, { streams: "streams" }, { streams: [] },
    { streams: [{ index: 0, codec_type: "audio", id: "0x5", time_base: "1/48000" }] }].map((value) => ({ value })))("requires original metadata with a selected video: $value", ({ value }) => {
      expect(() => parsePhysicalVideoProbe(value, bytes())).toThrow();
    });

  it.each([undefined, "1", -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null].map((index) => ({ index })))("does not infer the selected stream index from its array position: $index", ({ index }) => {
      expect(() => parsePhysicalVideoProbe(metadata({ index }), bytes())).toThrow();
    });

  it("rejects another stream occupying the selected stream index", () => {
    const original = metadata(); original.streams[0] = { ...original.streams[0], index: 1 };
    expect(() => parsePhysicalVideoProbe(original, bytes())).toThrow();
  });

  it.each([undefined, null, 1, "N/A", "", "0/1", "1/0", "-1/2", "1/-2", "1.0/2", "1e0/2", "1/2/3", " 1/2", "1/2 ", "+1/2"]
    .map((time_base) => ({ time_base })))("rejects a missing or non-positive exact clock: $time_base", ({ time_base }) => {
    expect(() => parsePhysicalVideoProbe(metadata({ time_base }), bytes())).toThrow();
  });
});

// P1–P7/P11/P12: ticks are signed integer token facts, not source seconds.
describe("exact physical PTS tokens", () => {
  it.each([
    { tokens: ["9007199254740993"], ticks: ["9007199254740993"] },
    { tokens: ["-9007199254740993"], ticks: ["-9007199254740993"] },
    { tokens: ["9007199254740992", "9007199254740993"], ticks: ["9007199254740992", "9007199254740993"] },
    { tokens: ['"9007199254740993"', '"-9007199254740993"'], ticks: ["9007199254740993", "-9007199254740993"] },
    { tokens: ["0", "4096", "-2048"], ticks: ["0", "4096", "-2048"] },
    { tokens: ["4096", "4096", "2048", "-1024"], ticks: ["4096", "4096", "2048", "-1024"] },
    { tokens: ['"0001"', '"-0"', "-0"], ticks: ["0001", "-0", "-0"] },
    { tokens: ["9223372036854775807", "-9223372036854775807"], ticks: ["9223372036854775807", "-9223372036854775807"] },
  ])("preserves original spelling and decode order for $tokens", ({ tokens, ticks }) => {
    expect(parsePhysicalVideoProbe(metadata(), bytes(tokens))).toEqual(expected(ticks));
  });

  it("ignores derived seconds, best effort and DTS instead of substituting physical PTS", () => {
    const original = Buffer.from('{"frames":[{"media_type":"video","stream_index":1,"pts":4096,"pts_time":"9.999999","best_effort_timestamp":123,"pkt_dts":0,"duration":123,"avg_frame_rate":"120/1"}]}');
    expect(parsePhysicalVideoProbe(metadata(), original)).toEqual(expected(["4096"]));
  });

  it("preserves arbitrary independent int64 decimal strings and the original complete frame sequence", () => {
    fc.assert(fc.property(fc.array(fc.bigInt({ min: -9223372036854775807n, max: 9223372036854775807n }), { minLength: 1, maxLength: 40 }), (values) => {
      const ticks = values.map((value) => value.toString());
      expect(parsePhysicalVideoProbe(metadata(), bytes(ticks))).toEqual(expected(ticks));
    }));
  });

  it("retains repeated and descending int64 arrays rather than adopting presentation planner ordering", () => {
    fc.assert(fc.property(fc.bigInt({ min: -9223372036854775807n, max: 9223372036854775807n }),
      fc.bigInt({ min: -9223372036854775807n, max: 9223372036854775807n }), (a, b) => {
        const high = (a >= b ? a : b).toString(); const low = (a >= b ? b : a).toString(); const ticks = [high, high, low];
        expect(parsePhysicalVideoProbe(metadata(), bytes(ticks))).toEqual(expected(ticks));
      }));
  });

  it("does not treat unrelated nested pts or pts-like string content as frame observations", () => {
    const original = Buffer.from(String.raw`{"pts":9007199254740993,"tags":{"comment":"\"pts\":9007199254740993"},"other":{"pts":1.0},"frames":[{"media_type":"video","stream_index":1,"pts":4096,"tags":{"pts":"N/A"},"side_data_list":[{"pts":1e3}]}]}`);
    expect(parsePhysicalVideoProbe(metadata(), original)).toEqual(expected(["4096"]));
  });

  it("returns identical owned facts on replay without mutating metadata or original bytes", () => {
    const original = metadata(); const buffer = Buffer.from(GOLDEN); const beforeMetadata = structuredClone(original); const beforeBytes = Buffer.from(buffer);
    expect(parsePhysicalVideoProbe(original, buffer)).toEqual(EXPECTED);
    expect(parsePhysicalVideoProbe(original, buffer)).toEqual(EXPECTED);
    expect(original).toEqual(beforeMetadata); expect(buffer).toEqual(beforeBytes);
  });
});

// P8–P10/P13–P16: safe structural fixtures may stringify; exact large PTS above never do.
describe("invalid physical frame contracts", () => {
  it.each([undefined, "N/A", null, true, false, [], {}, { value: 4096 }].map((pts) => ({ pts })))("does not invent PTS from seconds or best effort when pts=$pts", ({ pts }) => {
      const frame = { media_type: "video", stream_index: 1, pts, pts_time: "0.250000", best_effort_timestamp: 4096 };
      expect(() => parsePhysicalVideoProbe(metadata(), Buffer.from(JSON.stringify({ frames: [frame] })))).toThrow();
    });

  it.each(["1.5", "1.0", "1e3", "1E0"].map((token) => ({ token })))("rejects a valid JSON numeric token outside the integer PTS spelling: $token", ({ token }) => {
      expect(() => parsePhysicalVideoProbe(metadata(), bytes([token]))).toThrow();
    });

  it.each(['"1.0"', '"1e3"', '"+1"', '"0x10"', '" 1"', '"1 "', '""'].map((token) => ({ token })))("rejects a non-decimal quoted PTS spelling $token", ({ token }) => {
      expect(() => parsePhysicalVideoProbe(metadata(), bytes([token]))).toThrow();
    });

  it.each(["", '{"frames":[', '{"frames":[]}', '{"frames":null}', '{"frames":{}}', '{}', 'null', '[]', 'true', '123', '"frames"',
    '{"frames":[{"media_type":"video","stream_index":1,"pts":4096}]} trailing',
    ...["N/A", "NaN", "Infinity", "+1", "01"].map((token) => `{"frames":[{"media_type":"video","stream_index":1,"pts":${token}}]}`)].map((text) => ({ text })))("rejects an incomplete or malformed complete JSON frame response: $text", ({ text }) => {
      expect(() => parsePhysicalVideoProbe(metadata(), Buffer.from(text))).toThrow();
    });

  it.each([null, [], 1, "frame", true].map((frame) => ({ frame })))("rejects any non-object frame without returning its valid prefix: $frame", ({ frame }) => {
      const valid = { media_type: "video", stream_index: 1, pts: 4096 };
      expect(() => parsePhysicalVideoProbe(metadata(), Buffer.from(JSON.stringify({ frames: [valid, frame] })))).toThrow();
    });

  it.each(["audio", "subtitle", undefined, null].map((media_type) => ({ media_type })))("requires every physical frame to name video media: $media_type", ({ media_type }) => {
      const valid = { media_type: "video", stream_index: 1, pts: 4096 };
      expect(() => parsePhysicalVideoProbe(metadata(), Buffer.from(JSON.stringify({ frames: [valid, { ...valid, media_type }] })))).toThrow();
    });

  it.each([0, 2, undefined, -1, 1.5, "1", null].map((stream_index) => ({ stream_index })))("rejects an entire mixed or incorrectly bound stream without filtering: $stream_index", ({ stream_index }) => {
      const valid = { media_type: "video", stream_index: 1, pts: 4096 };
      expect(() => parsePhysicalVideoProbe(metadata(), Buffer.from(JSON.stringify({ frames: [valid, { ...valid, stream_index }] })))).toThrow();
    });

  it("rejects the entire frame response when only its last PTS is malformed", () => {
    expect(() => parsePhysicalVideoProbe(metadata(), bytes(["4096", '"N/A"']))).toThrow();
  });
});
