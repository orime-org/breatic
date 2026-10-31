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

import fc from "fast-check";
import { describe, it, expect } from "vitest";

import {
  SNIFF_WINDOW,
  sniffMimeType,
  sniffMimeTypeOfStream,
} from "@shared/upload/sniff-mime.js";

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

      expect(await sniffMimeTypeOfStream(stream, whole.subarray(0, SNIFF_WINDOW))).toBe(
        "audio/mpeg",
      );
    },
  );

  it("stops reading once it knows, rather than draining the object", async () => {
    // The object may be gigabytes. What matters is that the reader decides
    // when to stop, which a fixed window is what took away.
    const whole = mp3WithTag(100, 2_000_000);
    const { stream, pulled } = served(whole);

    await sniffMimeTypeOfStream(stream, whole.subarray(0, SNIFF_WINDOW));

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

// inner#1006 §4.8: the transfer file format. The two values are written out
// rather than imported so the cases below that hold on main (SN03–SN05) still
// load there; transfer-format.test.ts (TF01) pins both to the module's exports.

/** `TRANSFER_MEDIA_TYPE`. */
const TMT = "application/vnd.breatic.transfer";

/** `TRANSFER_SIGNATURE` as bytes: 19 ASCII bytes, version 1, then `\n`. */
const SIG = new TextEncoder().encode("BREATIC-TRANSFER/1\n");

/** First 64 bytes of real encoder output (same samples as sniff-samples.test.ts). */
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAKUlEQVR4nA=="),
  (c) => c.charCodeAt(0),
);
const JPEG = Uint8Array.from(
  atob("/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYxLjE5LjEwMQD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBg=="),
  (c) => c.charCodeAt(0),
);
const MP4 = Uint8Array.from(
  atob("AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAABCNtZGF0AAACrgYF//+q3EXpvebZSA=="),
  (c) => c.charCodeAt(0),
);

/**
 * Concatenate byte arrays and strings.
 * @param parts - The pieces, in order.
 * @returns One array holding them all.
 */
function join(...parts: (Uint8Array | number[] | string)[]): Uint8Array {
  const arrays = parts.map((p) =>
    typeof p === "string" ? new TextEncoder().encode(p) : Uint8Array.from(p),
  );
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

/**
 * Sniff an object the way the ingest Worker does (`ingest/src/stored-object.ts`
 * `sniffStoredObject`): the stream is the whole object, the head its first
 * `SNIFF_WINDOW` bytes.
 * @param whole - The object's bytes.
 * @returns What the bytes read as.
 */
async function sniffStored(whole: Uint8Array): Promise<string> {
  return sniffMimeTypeOfStream(served(whole).stream, whole.subarray(0, SNIFF_WINDOW));
}

/**
 * `encodeTransferBody(JSON.stringify(v))`, written out from the format's
 * definition so this file does not import the module under construction.
 * @param v - The request body.
 * @returns The transfer file's bytes.
 */
function enc(v: unknown): Uint8Array {
  return join(SIG, JSON.stringify(v));
}

describe("SN01 a transfer file whose body starts with <svg", () => {
  it("reads as the transfer type, not image/svg+xml", async () => {
    expect(await sniffStored(enc({ text: "<svg onload=1>" + "x".repeat(4096) }))).toBe(TMT);
  });
});

describe("SN02 the signature wins over whatever follows it", () => {
  it.each([
    ["a PNG", join(SIG, PNG)],
    ["<?xml", join(SIG, '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')],
    ["binary bytes", join(SIG, [0x00, 0x01, 0x02])],
  ])("reads signature + %s as the transfer type", async (_name, bytes) => {
    expect(await sniffStored(bytes)).toBe(TMT);
  });
});

describe("SN03 a signature not at byte 0 is not a transfer file", () => {
  it.each([
    ["(a) a BOM", join([0xef, 0xbb, 0xbf], SIG, "{}")],
    ["(b) a space", join(" ", SIG, "{}")],
    ["(c) a newline", join("\n", SIG, "{}")],
    ["(d) an x", join("x", SIG, "{}")],
  ])("reads %s + signature as text/plain", async (_name, bytes) => {
    expect(await sniffStored(bytes)).toBe("text/plain");
  });
});

describe("SN04 an incomplete or other-version signature", () => {
  it.each([
    ["the 18 bytes without the newline", join("BREATIC-TRANSFER/1")],
    ["version 2", join("BREATIC-TRANSFER/2\n{}")],
    ["CRLF", join("BREATIC-TRANSFER/1\r\n{}")],
  ])("does not read %s as the transfer type", async (_name, bytes) => {
    expect(await sniffStored(bytes)).not.toBe(TMT);
  });
});

describe("SN05 the existing decisions are unchanged", () => {
  it.each([
    ["PNG", PNG, "image/png"],
    ["JPEG", JPEG, "image/jpeg"],
    ["MP4", MP4, "video/mp4"],
    ["SVG", join('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'), "image/svg+xml"],
    ["plain text", join("just some words\n"), "text/plain"],
    ["empty", new Uint8Array(0), "application/octet-stream"],
  ])("reads %s as before", async (_name, bytes, expected) => {
    expect(await sniffStored(bytes)).toBe(expected);
  });
});

describe("SN06 the whole-bytes entry agrees", () => {
  it("reads a transfer file as the transfer type", async () => {
    expect(await sniffMimeType(enc({ a: 1 }))).toBe(TMT);
  });
});

describe("P02 any signed bytes read as the transfer type", () => {
  it("holds for arbitrary tails, markup, other formats' magic and control bytes", async () => {
    const tail = fc.oneof(
      fc.uint8Array({ maxLength: 8192 }),
      fc.string().map((s) => new TextEncoder().encode("<svg " + s)),
      fc.constantFrom(PNG, JPEG, MP4).chain((magic) =>
        fc.uint8Array({ maxLength: 1024 }).map((rest) => join(magic, rest)),
      ),
      fc.uint8Array({ min: 0x00, max: 0x1f, maxLength: 2048 }),
    );
    await fc.assert(
      fc.asyncProperty(tail, async (t) => {
        expect(await sniffStored(join(SIG, t))).toBe(TMT);
      }),
    );
  });
});

describe("P11 (sniff half) a signature after a prefix is not a transfer file", () => {
  it("never reads prefix + signature + tail as the transfer type", async () => {
    const prefix = fc.oneof(
      fc.uint8Array({ minLength: 1, maxLength: 8 }),
      fc.constantFrom(
        Uint8Array.of(0xef, 0xbb, 0xbf),
        Uint8Array.of(0x20),
        Uint8Array.of(0x09),
        Uint8Array.of(0x0a),
      ),
    );
    await fc.assert(
      fc.asyncProperty(prefix, fc.uint8Array({ maxLength: 8192 }), async (pre, t) => {
        expect(await sniffStored(join(pre, SIG, t))).not.toBe(TMT);
      }),
    );
  });
});
