// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Naming an object whose whole content nobody holds (#240).
 *
 * The edge has bytes in R2, not in memory. Handing a reader a fixed window of
 * them makes it answer as though that window were the entire file, and
 * `file-type` decides an MP3 by skipping the ID3 tag and reading the frame
 * sync behind it: a tag that ends just inside the window leaves too few bytes
 * for that read, and a valid MP3 comes back unnamed. Measured on
 * file-type@22.0.1 — an ID3 payload of 4089 or 4090 bytes does it to a 4100
 * byte window, and every window size has its own such values.
 *
 * So the signature layer reads the object itself and stops when it knows,
 * while the content-aware layer keeps working off the leading bytes, which is
 * all an `<svg` root or a run of text needs.
 */

import { describe, it, expect } from "vitest";

import { sniffMimeTypeOfStream } from "@shared/upload/sniff-mime.js";

/**
 * An MP3 carrying an ID3v2 tag of exactly this payload size.
 * @param payload - How many bytes the tag holds.
 * @param audio - How many bytes of audio follow the tag. Large by default, so
 *   a case about how far the reader goes is not answered by the file ending.
 * @returns The file's bytes.
 */
function mp3WithTag(payload: number, audio = 8192): Uint8Array {
  const header = Buffer.alloc(10);
  header.write("ID3", 0, "ascii");
  header[3] = 4;
  header[6] = (payload >> 21) & 0x7f;
  header[7] = (payload >> 14) & 0x7f;
  header[8] = (payload >> 7) & 0x7f;
  header[9] = payload & 0x7f;
  const frame = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
  return new Uint8Array(
    Buffer.concat([header, Buffer.alloc(payload), frame, Buffer.alloc(audio)]),
  );
}

/**
 * Serve bytes the way R2 does, in chunks, and count what was pulled.
 * @param whole - The object's content.
 * @returns The stream and a reader of how far it got.
 */
function served(whole: Uint8Array): {
  stream: ReadableStream<Uint8Array>;
  pulled: () => number;
} {
  let sent = 0;
  let at = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= whole.length) {
        controller.close();
        return;
      }
      const end = Math.min(at + 4096, whole.length);
      controller.enqueue(whole.subarray(at, end));
      sent += end - at;
      at = end;
    },
  });
  return { stream, pulled: () => sent };
}

describe("sniffMimeTypeOfStream — a tag that ends inside the window", () => {
  it.each([4087, 4088, 4089, 4090, 4091])(
    "names an MP3 whose ID3 payload is %i bytes",
    async (payload) => {
      const whole = mp3WithTag(payload);
      const { stream } = served(whole);

      expect(await sniffMimeTypeOfStream(stream, whole.subarray(0, 4100))).toBe(
        "audio/mpeg",
      );
    },
  );

  it("stops reading once it knows, rather than draining the object", async () => {
    // The object may be gigabytes. What matters is that the reader decides
    // when to stop, which a fixed window is what took away.
    const whole = mp3WithTag(100, 2_000_000);
    const { stream, pulled } = served(whole);

    await sniffMimeTypeOfStream(stream, whole.subarray(0, 4100));

    expect(pulled()).toBeLessThan(whole.length);
  });
});

describe("sniffMimeTypeOfStream — what has no signature at all", () => {
  it("reads an SVG root out of the leading bytes", async () => {
    const svg = new Uint8Array(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'),
    );

    expect(await sniffMimeTypeOfStream(served(svg).stream, svg)).toBe(
      "image/svg+xml",
    );
  });

  it("reads a run of text as text", async () => {
    const text = new Uint8Array(Buffer.from('{"summary":"a description"}'));

    expect(await sniffMimeTypeOfStream(served(text).stream, text)).toBe(
      "text/plain",
    );
  });

  it("answers octet-stream for bytes that are nothing", async () => {
    const junk = new Uint8Array([0x00, 0x01, 0x02, 0x03]);

    expect(await sniffMimeTypeOfStream(served(junk).stream, junk)).toBe(
      "application/octet-stream",
    );
  });
});
