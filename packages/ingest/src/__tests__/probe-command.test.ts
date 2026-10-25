// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the media container asks ffprobe and ffmpeg, and how it reads back what
 * they say (#209 + #210, design §3.1 and §3.2).
 *
 * The commands are built here rather than inside the container's request
 * handler so they can be asserted without Docker: an argument list is the
 * whole of what the container does to a user's bytes, and it is where a source
 * URL could turn into something else.
 */

import { describe, it, expect } from "vitest";
import {
  probeArgs,
  coverArgs,
  previewArgs,
  readProbeOutput,
  peaksArgs,
} from "@ingest/probe-command.js";

const URL_FOR_KEY = "http://r2.local/video/2026-09-10/1_clip.mp4";

describe("what ffprobe is asked", () => {
  it("asks for the stream fields and the format duration in one call", () => {
    const args = probeArgs(URL_FOR_KEY);

    expect(args).toContain("-show_entries");
    const entries = args[args.indexOf("-show_entries") + 1];
    // The disposition is its own section name: asked for inside `stream=` it
    // comes back empty, and album art then reads as a video stream.
    expect(entries).toContain("stream_disposition=attached_pic");
    // So is the side data, which is where the display matrix lives. Without it
    // a portrait phone video is filed at its stored pair while the cover cut
    // in the same run comes out the other way round.
    expect(entries).toContain("stream_side_data=rotation");
    expect(entries).toContain("format=duration");
    expect(entries).toContain("start_pts");
    expect(entries).toContain("duration_ts");
    expect(entries).toContain("time_base");
    expect(entries).toContain("channel_layout");
    // The first frame carries the EXIF orientation of a JPEG, which the stream
    // section does not report.
    expect(entries).toContain("frame=stream_index");
    expect(entries).toContain("frame_side_data=rotation");
    expect(args[args.indexOf("-read_intervals") + 1]).toBe("%+#1");
    expect(args).toContain("-of");
    expect(args[args.indexOf("-of") + 1]).toBe("json");
  });

  it("names the object exactly once, as the last argument", () => {
    const args = probeArgs(URL_FOR_KEY);

    expect(args.filter((a) => a.includes("r2.local"))).toEqual([URL_FOR_KEY]);
    expect(args.at(-1)).toBe(URL_FOR_KEY);
  });

  it("allows no protocol but the one the object is served over", () => {
    // ffmpeg follows what a container format tells it to open — a playlist, a
    // concat script, a subtitle path. Whitelisting the protocols is what keeps
    // a crafted file from reaching a local file or another scheme (#215).
    const args = probeArgs(URL_FOR_KEY);

    expect(args).toContain("-protocol_whitelist");
    expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe("http,tcp");
  });

  // A mini-tool run reads back the file its own ffmpeg wrote; with only the
  // object's protocols allowed, ffprobe refuses it and the result is filed
  // with no size, no duration and no cover.
  it("reads a file the container wrote through the file protocol alone", () => {
    for (const args of [probeArgs("/tmp/run/out.mp4", "own-file"), coverArgs("/tmp/run/out.mp4", "own-file")]) {
      expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe("file");
    }
  });
});

describe("what ffmpeg is asked for the cover", () => {
  it("writes one PNG frame to stdout", () => {
    const args = coverArgs(URL_FOR_KEY);

    expect(args).toContain("-vframes");
    expect(args[args.indexOf("-vframes") + 1]).toBe("1");
    expect(args[args.indexOf("-vcodec") + 1]).toBe("png");
    expect(args.at(-1)).toBe("pipe:1");
  });

  // A PNG of a 4K frame runs past what the container may hand back: measured
  // on ffmpeg 8.0.1 — what the container ships — a grainy 3840x2160 frame
  // writes 22,148,799 bytes against a 10 MiB ceiling, and the run then
  // produces no cover at all. Capping the frame brings the same source to
  // 5,269,284, and leaves anything already inside the box untouched.
  //
  // Both edges carry a bound. On the same binary, with grainy sources already
  // 1920 wide, so nothing is resampled away, a width-only bound lets 1920x3840
  // write 19,711,839 bytes and 1920x5000 write 25,668,806 — past the ceiling,
  // and those two videos then have no cover. Bounding both brings the same
  // pair to 4,705,535 and 3,765,679.
  it("bounds both edges of the frame it writes", () => {
    const args = coverArgs(URL_FOR_KEY);

    expect(args).toContain("-vf");
    expect(args[args.indexOf("-vf") + 1]).toBe(
      "scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease",
    );
  });

  it("carries the same protocol whitelist", () => {
    const args = coverArgs(URL_FOR_KEY);

    expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe("http,tcp");
  });
});

// inner#1305 §4.4: one mono 8 kHz float stream on stdout. Damaged frames are
// decoded past; the reader tells a source that broke off from stderr.
describe("what ffmpeg is asked for the peaks", () => {
  it("writes the audio alone as mono 8 kHz floats to stdout", () => {
    const args = peaksArgs("http://media.local/object");
    expect(args.slice(args.indexOf("-i"))).toEqual([
      "-i",
      "http://media.local/object",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "8000",
      "-f",
      "f32le",
      "pipe:1",
    ]);
  });

  // A damaged frame in playable audio must not cut the peaks short; a source
  // that breaks off is told apart by what ffmpeg writes to stderr.
  it("decodes past a damaged frame", () => {
    expect(peaksArgs("http://media.local/object")).not.toContain("-xerror");
  });

  it("carries the same protocol whitelist", () => {
    const args = peaksArgs("http://media.local/object");
    expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe(
      probeArgs("http://media.local/object")[probeArgs("http://media.local/object").indexOf("-protocol_whitelist") + 1],
    );
  });
});

describe("what vips is asked for the preview", () => {
  it("reads the bytes from stdin and writes a WebP to stdout", () => {
    const args = previewArgs();

    expect(args[0]).toBe("thumbnail_source");
    expect(args[1]).toBe("[descriptor=0]");
    expect(args[2]).toMatch(/^\.webp\[/);
  });

  it("fits the picture in 576 by WebP's side limit and never enlarges it", () => {
    const args = previewArgs();

    expect(args[3]).toBe("576");
    // WebP holds at most 16383 pixels a side.
    expect(args[args.indexOf("--height") + 1]).toBe("16383");
    expect(args[args.indexOf("--size") + 1]).toBe("down");
  });

  it("keeps the colour profile and drops the rest of the metadata", () => {
    // A Display P3 picture shown without its profile reads as sRGB: duller.
    expect(previewArgs()[2]).toBe(".webp[Q=80,keep=icc]");
  });
});

describe("reading ffprobe's answer", () => {
  it("builds stable per-channel video inputs from measured stream timestamps", async () => {
    const { buildLongMediaProbeReport } = await import("@ingest/long-media-probe-report.js");
    const probeOutput = JSON.stringify({
      streams: [
        {
          index: 0,
          codec_type: "video",
          codec_name: "h264",
          width: 1920,
          height: 1080,
          start_pts: 0,
          duration_ts: 1080000,
          time_base: "1/90000",
          disposition: { attached_pic: 0 },
        },
        {
          index: 1,
          codec_type: "audio",
          codec_name: "aac",
          channels: 2,
          channel_layout: "stereo",
          sample_rate: "48000",
          start_pts: 96000,
          duration_ts: 288000,
          time_base: "1/48000",
        },
      ],
    });
    const report = buildLongMediaProbeReport(probeOutput, "a".repeat(64), "channel-v1");
    const replay = buildLongMediaProbeReport(probeOutput, "a".repeat(64), "channel-v1");

    expect(report).toMatchObject({
      version: 1,
      sourceFingerprint: "a".repeat(64),
      selectedVideoStreamIndex: 0,
      mediaInputs: [
        {
          descriptor: { inputKind: "video_channel", videoStreamIndex: 0, audioStreamIndex: 1, audioChannelIndex: 0 },
          videoRange: { startUs: "0", endUs: "12000000" },
          audioRange: { startUs: "2000000", endUs: "8000000" },
          sourceRange: { startUs: "0", endUs: "12000000" },
        },
        {
          descriptor: { inputKind: "video_channel", videoStreamIndex: 0, audioStreamIndex: 1, audioChannelIndex: 1 },
        },
      ],
    });
    expect(report.mediaInputs.map((input) => input.mediaInputId)).toEqual(replay.mediaInputs.map((input) => input.mediaInputId));
    expect(report.mediaInputs[0]?.mediaInputId).not.toBe(report.mediaInputs[1]?.mediaInputId);
  });

  it("refuses stream times that lack PTS or duration ticks", async () => {
    const { buildLongMediaProbeReport } = await import("@ingest/long-media-probe-report.js");

    expect(() => buildLongMediaProbeReport(JSON.stringify({
      streams: [{
        index: 0,
        codec_type: "audio",
        codec_name: "aac",
        channels: 1,
        channel_layout: "mono",
        sample_rate: "48000",
        start_pts: "N/A",
        duration_ts: "N/A",
        time_base: "1/48000",
      }],
    }), "b".repeat(64), "channel-v1")).toThrow(/stream time is not measured/i);
  });

  it("refuses numeric PTS values that JSON cannot represent without precision loss", async () => {
    const { buildLongMediaProbeReport } = await import("@ingest/long-media-probe-report.js");

    expect(() => buildLongMediaProbeReport(JSON.stringify({
      streams: [{
        index: 0,
        codec_type: "audio",
        codec_name: "aac",
        channels: 1,
        sample_rate: "48000",
        start_pts: Number.MAX_SAFE_INTEGER + 1,
        duration_ts: 1,
        time_base: "1/48000",
      }],
    }), "c".repeat(64), "channel-v1")).toThrow(/precision/i);
  });

  it("normalises the streams and the duration", () => {
    const out = readProbeOutput(
      JSON.stringify({
        streams: [
          {
            index: 0,
            codec_type: "video",
            codec_name: "h264",
            width: 1280,
            height: 720,
            disposition: { attached_pic: 0 },
          },
          { index: 1, codec_type: "audio", codec_name: "aac", disposition: {} },
        ],
        format: { duration: "60.500000" },
      }),
    );

    expect(out).toEqual({
      streams: [
        {
          index: 0,
          codecType: "video",
          codecName: "h264",
          width: 1280,
          height: 720,
          attachedPic: false,
        },
        {
          index: 1,
          codecType: "audio",
          codecName: "aac",
          width: null,
          height: null,
          attachedPic: false,
        },
      ],
      durationSeconds: 60.5,
    });
  });

  it("reads attached_pic as the flag it is", () => {
    const out = readProbeOutput(
      JSON.stringify({
        streams: [
          {
            index: 1,
            codec_type: "video",
            codec_name: "png",
            width: 300,
            height: 300,
            disposition: { attached_pic: 1 },
          },
        ],
        format: {},
      }),
    );

    expect(out.streams[0]?.attachedPic).toBe(true);
    expect(out.durationSeconds).toBeNull();
  });

  it("answers nothing at all for output it cannot read", () => {
    expect(readProbeOutput("not json")).toEqual({
      streams: [],
      durationSeconds: null,
    });
  });

  it("answers nothing for a duration ffprobe could not determine", () => {
    // ffprobe writes the string "N/A" for a stream it cannot measure.
    const out = readProbeOutput(
      JSON.stringify({ streams: [], format: { duration: "N/A" } }),
    );

    expect(out.durationSeconds).toBeNull();
  });
});

// ffprobe writes the display matrix in a section of its own: a stream that
// carries one gets a `side_data_list`, and a stream that does not has no list
// at all. Measured on ffmpeg 8.0.1 — what the container ships — against a file
// made with `-display_rotation 90`, using the production argument list.
describe("what the display matrix reads as", () => {
  it("carries the rotation a stream declares", () => {
    const read = readProbeOutput(
      JSON.stringify({
        streams: [
          {
            index: 0,
            codec_type: "video",
            codec_name: "h264",
            width: 1920,
            height: 1080,
            disposition: { attached_pic: 0 },
            side_data_list: [{ rotation: 90 }],
          },
        ],
        format: { duration: "2.000000" },
      }),
    );

    expect(read.streams[0]).toMatchObject({ rotation: 90 });
  });

  it("leaves the key off a stream that declares none", () => {
    const read = readProbeOutput(
      JSON.stringify({
        streams: [
          {
            index: 0,
            codec_type: "video",
            codec_name: "h264",
            width: 1920,
            height: 1080,
            disposition: { attached_pic: 0 },
          },
        ],
        format: { duration: "2.000000" },
      }),
    );

    expect(read.streams[0]).not.toHaveProperty("rotation");
  });

  // A stream may carry side data that is not a display matrix at all.
  it("looks past side data that names no rotation", () => {
    const read = readProbeOutput(
      JSON.stringify({
        streams: [
          {
            index: 0,
            codec_type: "video",
            width: 1920,
            height: 1080,
            disposition: { attached_pic: 0 },
            side_data_list: [{ side_data_type: "Content light level" }],
          },
        ],
        format: {},
      }),
    );

    expect(read.streams[0]).not.toHaveProperty("rotation");
  });
});

// The first frame's side data is where a JPEG's EXIF orientation shows up, and
// a video with a display matrix reports the same angle in both places.
// Measured on ffmpeg 8.0.1 — what the container ships — with the production
// argument list; the JSON below is that output with the empty sections dropped.
describe("what the first frame's rotation reads as", () => {
  it("takes a JPEG's orientation off its first frame", () => {
    const read = readProbeOutput(
      JSON.stringify({
        frames: [
          { stream_index: 0, width: 400, height: 200, side_data_list: [{ rotation: -90 }] },
        ],
        streams: [
          {
            index: 0,
            codec_name: "mjpeg",
            codec_type: "video",
            width: 400,
            height: 200,
            disposition: { attached_pic: 0 },
          },
        ],
        format: { duration: "0.040000" },
      }),
    );

    expect(read.streams[0]).toMatchObject({ rotation: -90 });
  });

  it("keeps one angle when the stream and its first frame both report it", () => {
    const read = readProbeOutput(
      JSON.stringify({
        frames: [
          { stream_index: 0, width: 320, height: 240, side_data_list: [{ rotation: 90 }, {}] },
        ],
        streams: [
          {
            index: 0,
            codec_name: "h264",
            codec_type: "video",
            width: 320,
            height: 240,
            disposition: { attached_pic: 0 },
            side_data_list: [{ rotation: 90 }],
          },
          { index: 1, codec_name: "aac", codec_type: "audio", disposition: { attached_pic: 0 } },
        ],
        format: { duration: "1.000000" },
      }),
    );

    expect(read.streams[0]).toMatchObject({ rotation: 90 });
    expect(read.streams[1]).not.toHaveProperty("rotation");
  });

  it("does not hand a frame's angle to a different stream", () => {
    const read = readProbeOutput(
      JSON.stringify({
        frames: [{ stream_index: 1, side_data_list: [{ rotation: -90 }] }],
        streams: [
          {
            index: 0,
            codec_type: "video",
            width: 320,
            height: 240,
            disposition: { attached_pic: 0 },
          },
          { index: 1, codec_type: "audio", disposition: { attached_pic: 0 } },
        ],
        format: {},
      }),
    );

    expect(read.streams[0]).not.toHaveProperty("rotation");
  });

  it("falls back to the stream's angle when the first frame reports none", () => {
    const read = readProbeOutput(
      JSON.stringify({
        frames: [{ stream_index: 0, width: 320, height: 240 }],
        streams: [
          {
            index: 0,
            codec_type: "video",
            width: 320,
            height: 240,
            disposition: { attached_pic: 0 },
            side_data_list: [{ rotation: 90 }],
          },
        ],
        format: {},
      }),
    );

    expect(read.streams[0]).toMatchObject({ rotation: 90 });
  });
});

// HDR reads the source as its own colour tags describe it.
describe("what the colour tags read as", () => {
  it("asks for them and carries the ones a stream names", () => {
    const entries = probeArgs(URL_FOR_KEY)[probeArgs(URL_FOR_KEY).indexOf("-show_entries") + 1];
    expect(entries).toContain("color_transfer,color_primaries,color_space");

    const read = readProbeOutput(
      JSON.stringify({
        streams: [
          { index: 0, codec_type: "video", color_transfer: "arib-std-b67", color_primaries: "bt2020", color_space: "bt2020nc" },
          { index: 1, codec_type: "audio" },
        ],
        format: {},
      }),
    );
    expect(read.streams[0]).toMatchObject({ colorTransfer: "arib-std-b67", colorPrimaries: "bt2020", colorSpace: "bt2020nc" });
    expect(read.streams[1]).not.toHaveProperty("colorTransfer");
  });
});

// The audio operations resample and judge Nyquist off the source (inner#1305 §7.1).
describe("what the audio fields read as", () => {
  it("asks for the sample rate and channel count and carries them as numbers", () => {
    const entries = probeArgs(URL_FOR_KEY)[probeArgs(URL_FOR_KEY).indexOf("-show_entries") + 1];
    expect(entries).toContain("sample_rate,channels");

    const read = readProbeOutput(
      JSON.stringify({
        streams: [
          { index: 0, codec_type: "audio", sample_rate: "44100", channels: 2 },
          { index: 1, codec_type: "video" },
          { index: 2, codec_type: "audio", sample_rate: "not a rate" },
        ],
        format: {},
      }),
    );
    expect(read.streams[0]).toMatchObject({ sampleRate: 44100, channels: 2 });
    expect(read.streams[1]).not.toHaveProperty("sampleRate");
    expect(read.streams[1]).not.toHaveProperty("channels");
    expect(read.streams[2]).not.toHaveProperty("sampleRate");
  });
});
