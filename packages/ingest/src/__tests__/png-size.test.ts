// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How big the frame the container cut actually is (#209 + #210).
 *
 * A cover is its own asset row, and that row states pixel dimensions. They
 * cannot be the video's: the frame is capped on the way out, so anything shot
 * larger comes back smaller. The bytes themselves say what they are, and a PNG
 * says it in its first chunk.
 */

import { describe, it, expect } from "vitest";
import { pngSize } from "@ingest/png-size.js";

/** A PNG header for `width` x `height`, which is all this reads. */
function header(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe("the size a cut frame declares", () => {
  it("reads the pair out of the header chunk", () => {
    expect(pngSize(header(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  it.each([
    ["bytes that are not a PNG at all", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])],
    ["a PNG signature with nothing after it", header(1, 1).slice(0, 8)],
    ["a header cut short", header(1920, 1080).slice(0, 20)],
    ["nothing", new Uint8Array()],
  ])("answers nothing for %s", (_case, bytes) => {
    expect(pngSize(bytes)).toBeNull();
  });

  it("answers nothing for a chunk that is not IHDR", () => {
    const bytes = header(10, 10);
    bytes.set([0x49, 0x45, 0x4e, 0x44], 12);

    expect(pngSize(bytes)).toBeNull();
  });

  it("answers nothing for a frame with no pixels", () => {
    expect(pngSize(header(0, 10))).toBeNull();
    expect(pngSize(header(10, 0))).toBeNull();
  });
});
