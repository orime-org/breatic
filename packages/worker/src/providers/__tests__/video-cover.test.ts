// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * extractVideoCover storage-identity + format contract (#1826 §4.5 / §8).
 *
 * The cover is a first-class studio_assets row, so extractVideoCover must
 * return the cover's STORAGE IDENTITY (url + key + sha256 + byte size) for the
 * caller (dispatch) to register it (source='cover'). Per the format convention
 * (§8: images we produce ourselves are PNG) the cover is encoded to PNG:
 * ffmpeg grabs the frame, then Sharp encodes PNG (Sharp ships its own codec,
 * so this never depends on how the ffmpeg binary was built). Extraction stays
 * best-effort: any failure path (ffmpeg missing, no output, Sharp error)
 * returns undefined (→ Film icon), never throws.
 *
 * ffmpeg exec, Sharp, and storage are mocked — no real ffmpeg / codec / storage.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

const mockExecFile = vi.hoisted(() => vi.fn());
const mockUpload = vi.hoisted(() => vi.fn());
const mockPngToBuffer = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ execFile: mockExecFile }));
vi.mock("sharp", () => ({
  default: (_input: Buffer) => ({
    png: () => ({ toBuffer: mockPngToBuffer }),
  }),
}));
vi.mock("@breatic/core", () => ({
  getStorageAdapter: vi.fn().mockResolvedValue({ upload: mockUpload }),
  storageKey: () => "video/2026-07-25/1234_cover.png",
  sha256Hex: (buf: Buffer) => `sha-${buf.length}`,
}));

import { extractVideoCover } from "@worker/providers/video-cover.js";

describe("extractVideoCover — PNG cover identity for ledger registration (#1826 §4.5 / §8)", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    mockUpload.mockReset();
    mockPngToBuffer.mockReset();
  });

  it("encodes the frame to PNG (Sharp) and returns url + key + sha256 + byte size", async () => {
    const frame = Buffer.from("raw-ffmpeg-frame-bytes");
    const png = Buffer.from("png-encoded"); // shorter → distinct length
    // node util.promisify without a custom impl resolves the single value
    // passed after the error arg — hand it the { stdout } shape the code reads.
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null, { stdout: frame }));
    mockPngToBuffer.mockResolvedValue(png);
    mockUpload.mockResolvedValue("https://cdn/cover.png");

    const result = await extractVideoCover("https://cdn/video.mp4");

    // The stored bytes + identity are the PNG output, not the raw ffmpeg frame.
    expect(mockUpload).toHaveBeenCalledWith(
      "video/2026-07-25/1234_cover.png",
      png,
      "image/png",
    );
    expect(result).toEqual({
      url: "https://cdn/cover.png",
      key: "video/2026-07-25/1234_cover.png",
      sha256: `sha-${png.length}`,
      sizeBytes: png.length,
      // The cover owns its format (§8 PNG) so the ledger register can't drift
      // to a stale mimeType — dispatch reads this, never hardcodes.
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
