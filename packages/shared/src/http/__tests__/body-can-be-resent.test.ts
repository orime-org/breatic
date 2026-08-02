// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Whether a body survives being handed to `fetch` a second time.
 *
 * Tested directly rather than through the loop because the interesting cases
 * cannot be driven through a real `fetch`: Node accepts only genuine platform
 * objects as a body, so the shape a Safari `ReadableStream` presents — no
 * async iterator, but a `getReader` — has no way of reaching the loop from a
 * test running under Node. The rule it exercises is the whole of item 2's
 * transport-owned half, so it is worth asserting where it can be asserted.
 */

import { describe, expect, it } from "vitest";

import { bodyCanBeResent } from "@shared/http/request.js";

/** A stream shaped the way Safari presents one: readable, but not iterable. */
const safariShapedStream = { getReader: (): unknown => ({ read: (): unknown => ({}) }) };

/** An async generator: the other single-use source a caller can hand over. */
async function* generated(): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode("chunk");
}

describe("bodyCanBeResent — what survives a second delivery", () => {
  it.each([
    ["no body at all", null],
    ["an explicit undefined", undefined],
    ["a string", "payload"],
    ["a Blob", new Blob(["payload"])],
    ["FormData", new FormData()],
    ["URLSearchParams", new URLSearchParams("a=1")],
    ["an ArrayBuffer that still holds its bytes", new ArrayBuffer(8)],
    ["a typed-array view", new Uint8Array([1, 2, 3])],
  ])("replays %s", (_label, body) => {
    expect(bodyCanBeResent(body as BodyInit | null | undefined)).toBe(true);
  });

  it("replays a plain object, which fetch re-serialises identically", () => {
    // Named types were the previous rule and got this one WRONG: an unnamed
    // value fell off the allow-list and silently lost its retries, even though
    // `fetch` turns it into the same bytes every time.
    expect(bodyCanBeResent({ hello: "world" } as unknown as BodyInit)).toBe(true);
  });

  it("refuses a ReadableStream, which the first delivery consumes", () => {
    expect(bodyCanBeResent(new ReadableStream() as unknown as BodyInit)).toBe(false);
  });

  it("refuses a stream shaped the way Safari presents one", () => {
    // Safari has not shipped async iteration on ReadableStream (Chrome 124+
    // and Firefox have), so a stream there answers `Symbol.asyncIterator in
    // body` with false — and this layer ships to browsers. Reading the
    // question off `getReader` instead asks what actually makes a stream
    // single-use, and every engine answers it the same way.
    expect(bodyCanBeResent(safariShapedStream as unknown as BodyInit)).toBe(false);
  });

  it("refuses an async generator, spent by the first walk", () => {
    expect(bodyCanBeResent(generated() as unknown as BodyInit)).toBe(false);
  });

  it("refuses a buffer whose bytes have been transferred away", () => {
    // A transferred buffer still passes `instanceof ArrayBuffer` while holding
    // nothing: not single-use, simply empty, so it needs its own question.
    const buffer = new ArrayBuffer(8);
    structuredClone(buffer, { transfer: [buffer] });
    expect(bodyCanBeResent(buffer)).toBe(false);
  });

  it("refuses a view onto a buffer that has been transferred away", () => {
    const buffer = new ArrayBuffer(8);
    const view = new Uint8Array(buffer);
    structuredClone(buffer, { transfer: [buffer] });
    expect(bodyCanBeResent(view)).toBe(false);
  });
});
