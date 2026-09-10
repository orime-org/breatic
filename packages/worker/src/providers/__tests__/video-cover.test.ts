// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * extractVideoCover's output + format contract (#1826 §4.5 / §8, #181 lane ②).
 *
 * It hands back the frame and nothing else. Storing it belongs to the caller,
 * which sends it through the ingest Worker like every other asset — and that is
 * also where its hash is computed, over the bytes that really landed.
 *
 * Per the format convention (§8: images we produce ourselves are PNG) the frame
 * is encoded to PNG: ffmpeg emits an MJPEG frame, then Sharp encodes PNG (Sharp
 * ships its own PNG codec, so the cover's format never depends on the ffmpeg
 * binary having been built with one). Extraction stays best-effort: any failure
 * path (ffmpeg missing, no output, Sharp error) returns undefined (→ Film
 * icon), never throws.
 *
 * ffmpeg exec and Sharp are mocked — no real ffmpeg, no real codec.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

const mockExecFile = vi.hoisted(() => vi.fn());
const mockPngToBuffer = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ execFile: mockExecFile }));
vi.mock("sharp", () => ({
  default: (_input: Buffer) => ({
    png: () => ({ toBuffer: mockPngToBuffer }),
  }),
}));
import { extractVideoCover } from "@worker/providers/video-cover.js";

describe("extractVideoCover — the frame it hands back (#1826 §4.5 / §8)", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    mockPngToBuffer.mockReset();
  });

  it("hands back the PNG Sharp encoded, not the frame ffmpeg emitted", async () => {
    const frame = Buffer.from("raw-ffmpeg-frame-bytes");
    const png = Buffer.from("png-encoded"); // shorter → distinct length
    // node util.promisify without a custom impl resolves the single value
    // passed after the error arg — hand it the { stdout } shape the code reads.
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, { stdout: frame }));
    mockPngToBuffer.mockResolvedValue(png);

    const result = await extractVideoCover("https://cdn/video.mp4");

    expect(result).toEqual({
      png,
      // The cover owns its format (§8 PNG), so the type the object is stored
      // under comes from here rather than being restated at each call site.
      mimeType: "image/png",
    });
  });

  it("returns undefined when ffmpeg produces no bytes (non-fatal)", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, { stdout: Buffer.alloc(0) }));
    expect(await extractVideoCover("https://cdn/video.mp4")).toBeUndefined();
  });

  it("returns undefined when ffmpeg fails (missing / error — never throws)", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(new Error("ffmpeg not found")));
    expect(await extractVideoCover("https://cdn/video.mp4")).toBeUndefined();
  });

  it("returns undefined when PNG encoding fails (Sharp error — still best-effort)", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, { stdout: Buffer.from("frame") }));
    mockPngToBuffer.mockRejectedValue(new Error("sharp: unsupported input"));
    expect(await extractVideoCover("https://cdn/video.mp4")).toBeUndefined();
  });
});
