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
  readProbeOutput,
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
    expect(entries).toContain("format=duration");
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
});

describe("what ffmpeg is asked for the cover", () => {
  it("writes one PNG frame to stdout", () => {
    const args = coverArgs(URL_FOR_KEY);

    expect(args).toContain("-vframes");
    expect(args[args.indexOf("-vframes") + 1]).toBe("1");
    expect(args[args.indexOf("-vcodec") + 1]).toBe("png");
    expect(args.at(-1)).toBe("pipe:1");
  });

  it("carries the same protocol whitelist", () => {
    const args = coverArgs(URL_FOR_KEY);

    expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe("http,tcp");
  });
});

describe("reading ffprobe's answer", () => {
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
