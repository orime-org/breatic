// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The transfer file format (inner#1006 design §4.8): a signature line
 * `BREATIC-TRANSFER/1\n` followed by the request body's JSON as UTF-8, byte
 * for byte. Cases TF01–TF06, P01 and the decode half of P11 of the test spec.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import * as sharedEntry from "@shared/index.js";
import {
  TRANSFER_MEDIA_TYPE,
  TRANSFER_SIGNATURE,
  decodeTransferBody,
  encodeTransferBody,
} from "@shared/upload/transfer-format.js";

const SIG_BYTES = new TextEncoder().encode("BREATIC-TRANSFER/1\n");

/** First 64 bytes of a PNG ffmpeg wrote (same sample as sniff-samples.test.ts). */
const PNG_HEAD =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAKUlEQVR4nA==";

/** The spec's t0: markup, an ampersand, a C0 control, quote, backslash, newline, CJK. */
const T0 = "<svg onload=1>&\u0001\"\\\n中文" + "x".repeat(1_200_000);

/**
 * Concatenate byte arrays.
 * @param parts - The pieces, in order.
 * @returns One array holding them all.
 */
function cat(...parts: (Uint8Array | number[] | string)[]): Uint8Array {
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
 * Decode the PNG sample.
 * @returns Its bytes.
 */
function png(): Uint8Array {
  return Uint8Array.from(atob(PNG_HEAD), (c) => c.charCodeAt(0));
}

/**
 * Which of the two decode failures an error names. The spec leaves the error's
 * form to the implementation and asks the test to tell the two apart, so this
 * accepts the reason on `reason`, `code` or as the whole `message`.
 * @param run - The call expected to throw.
 * @returns The named reason, or `"none"` when nothing was thrown, or
 *   `"unrecognised"` when the error names neither reason.
 */
function failureOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    const e = err as { reason?: unknown; code?: unknown; message?: unknown };
    for (const candidate of [e.reason, e.code, e.message]) {
      if (candidate === "bad_format" || candidate === "bad_encoding") {
        return candidate;
      }
    }
    return "unrecognised";
  }
  return "none";
}

const BAD_FORMAT_INPUTS: [string, Uint8Array][] = [
  ["(a) empty", new Uint8Array(0)],
  ["(b) signature without its newline", cat("BREATIC-TRANSFER/1")],
  ["(c) version 2", cat("BREATIC-TRANSFER/2\n{}")],
  ["(d) lower-case signature", cat("breatic-transfer/1\n{}")],
  ["(e) BOM before the signature", cat([0xef, 0xbb, 0xbf], SIG_BYTES, "{}")],
  ["(f) a space before the signature", cat(" ", SIG_BYTES, "{}")],
  ["(g) a PNG file", png()],
  ["(h) JSON without a signature", cat("{}")],
];

const BAD_ENCODING_INPUTS: [string, Uint8Array][] = [
  ["C3 28", cat(SIG_BYTES, [0xc3, 0x28])],
  ["FF", cat(SIG_BYTES, [0xff])],
  ["a lone surrogate ED A0 80", cat(SIG_BYTES, [0xed, 0xa0, 0x80])],
];

describe("TF01 constants and main-entry exports", () => {
  it("exports the four names from the shared main entry", () => {
    const entry = sharedEntry as Record<string, unknown>;
    expect(entry.TRANSFER_MEDIA_TYPE).toBe("application/vnd.breatic.transfer");
    expect(entry.TRANSFER_SIGNATURE).toBe("BREATIC-TRANSFER/1\n");
    expect(typeof entry.encodeTransferBody).toBe("function");
    expect(typeof entry.decodeTransferBody).toBe("function");
  });

  it("holds the media type and a 19-byte signature", () => {
    expect(TRANSFER_MEDIA_TYPE).toBe("application/vnd.breatic.transfer");
    expect(TRANSFER_SIGNATURE).toBe("BREATIC-TRANSFER/1\n");
    expect(new TextEncoder().encode(TRANSFER_SIGNATURE).length).toBe(19);
  });
});

describe("TF02 byte layout", () => {
  it("writes the signature then the JSON's UTF-8 bytes unchanged", () => {
    const json = '{"a":"<svg>中"}';
    const out = encodeTransferBody(json);

    expect(out.length).toBe(35);
    expect(Array.from(out.subarray(0, 19))).toEqual(Array.from(SIG_BYTES));
    expect(Array.from(out.subarray(19))).toEqual(
      Array.from(new TextEncoder().encode(json)),
    );
  });
});

describe("TF03 round trip", () => {
  it.each([
    ["empty", ""],
    ["{}", "{}"],
    ["t0 as JSON", JSON.stringify({ t: T0 })],
  ])("decodes what it encoded (%s)", (_name, s) => {
    expect(decodeTransferBody(encodeTransferBody(s))).toBe(s);
  });
});

describe("TF04 bad_format", () => {
  it.each(BAD_FORMAT_INPUTS)("refuses %s as bad_format", (_name, bytes) => {
    expect(failureOf(() => decodeTransferBody(bytes))).toBe("bad_format");
  });
});

describe("TF05 bad_encoding", () => {
  it.each(BAD_ENCODING_INPUTS)(
    "refuses signature + %s as bad_encoding, not bad_format",
    (_name, bytes) => {
      expect(failureOf(() => decodeTransferBody(bytes))).toBe("bad_encoding");
    },
  );
});

describe("TF06 only these two errors", () => {
  it("raises nothing but bad_format or bad_encoding for the refused inputs", () => {
    const seen = new Set(
      [...BAD_FORMAT_INPUTS, ...BAD_ENCODING_INPUTS].map(([, bytes]) =>
        failureOf(() => decodeTransferBody(bytes)),
      ),
    );
    expect([...seen].sort()).toEqual(["bad_encoding", "bad_format"]);
  });

  it("returns valid UTF-8 after the signature as is, JSON or not", () => {
    expect(decodeTransferBody(cat(SIG_BYTES, "hello"))).toBe("hello");
  });
});

describe("P01 encode/decode round trip over any JSON", () => {
  it("decodes to the same text, adds exactly 19 bytes and rewrites nothing", () => {
    const markup = fc.oneof(
      ...["<svg ", "<SVG/", "&amp;", "\u0000"].map((prefix) =>
        fc.string({ unit: "binary" }).map((s) => prefix + s),
      ),
    );
    const value = fc.oneof(
      fc.jsonValue(),
      markup,
      fc.dictionary(fc.string({ unit: "binary" }), fc.oneof(markup, fc.string({ unit: "binary" }))),
      fc.array(fc.oneof(markup, fc.string({ unit: "binary" }))),
    );
    fc.assert(
      fc.property(value, (v) => {
        const s = JSON.stringify(v);
        const utf8 = new TextEncoder().encode(s);
        const out = encodeTransferBody(s);
        expect(decodeTransferBody(out)).toBe(s);
        expect(out.length).toBe(19 + utf8.length);
        expect(Array.from(out.subarray(19))).toEqual(Array.from(utf8));
      }),
    );
  });
});

describe("P11 (decode half) a signature not at byte 0 is not a transfer file", () => {
  it("refuses prefix + signature + anything as bad_format", () => {
    const prefix = fc.oneof(
      fc.uint8Array({ minLength: 1, maxLength: 8 }),
      fc.constantFrom(
        Uint8Array.of(0xef, 0xbb, 0xbf),
        Uint8Array.of(0x20),
        Uint8Array.of(0x09),
        Uint8Array.of(0x0a),
      ),
    );
    fc.assert(
      fc.property(prefix, fc.uint8Array({ maxLength: 8192 }), (pre, tail) => {
        expect(failureOf(() => decodeTransferBody(cat(pre, SIG_BYTES, tail)))).toBe(
          "bad_format",
        );
      }),
    );
  });
});
