// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading a body under a budget, a ceiling, and the caller's own signal.
 *
 * The transport hands the response back with its deadline already spent, so
 * everything about how long the body may take and how large it may get is
 * decided here. All three limits have to work on the same read: a caller that
 * gave up is one of them, and it is the one that does not expire on its own.
 */

import { describe, it, expect } from "vitest";
import { readBytesWithin, readWithin, BodyTooLarge } from "@shared/http/read-within.js";

/**
 * A response whose body arrives in pieces, with a pause between them.
 * @param chunks - The pieces, in order.
 * @param gapMs - How long to wait before each piece.
 * @returns The response.
 */
function dripping(chunks: Uint8Array[], gapMs: number): Response {
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = chunks.shift();
      if (next === undefined) {
        controller.close();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, gapMs));
      controller.enqueue(next);
    },
  });
  return new Response(body, { status: 200 });
}

describe("readBytesWithin — a body that is not there", () => {
  it("refuses a response carrying no body", async () => {
    await expect(readBytesWithin(new Response(null, { status: 200 }), 1000)).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it("refuses a body that is empty", async () => {
    // Same fact as the one above, and the same next move: the service answered
    // and the answer was not there. Handing zero bytes back sends an empty
    // data uri to a paid model call that cannot do anything with it.
    await expect(readBytesWithin(new Response(new Uint8Array(), { status: 200 }), 1000))
      .rejects.toBeInstanceOf(TypeError);
  });
});

describe("readBytesWithin — the limits", () => {
  it("hands back what arrived", async () => {
    const bytes = await readBytesWithin(new Response(new Uint8Array([1, 2, 3])), 1000);

    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it("joins what arrived in pieces, in order", async () => {
    // A body of any size arrives in more than one chunk, so joining them is
    // the ordinary path rather than an edge of it — and a single-chunk case
    // says nothing about whether the pieces land where they belong.
    const res = dripping([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])], 1);

    expect([...(await readBytesWithin(res, 1000))]).toEqual([1, 2, 3, 4, 5]);
  });

  it("stops at the size ceiling and says what it saw", async () => {
    const call = readBytesWithin(new Response(new Uint8Array(50)), 1000, 10);

    await expect(call).rejects.toBeInstanceOf(BodyTooLarge);
    await expect(call).rejects.toMatchObject({ limit: 10 });
  });

  it("gives up when the body outlasts the budget", async () => {
    const res = dripping([new Uint8Array([1]), new Uint8Array([2])], 60);

    await expect(readBytesWithin(res, 30)).rejects.toBeTruthy();
  });

  it("stops when the caller stops wanting it", async () => {
    // The budget is the one that expires; a caller who has gone does not, and
    // a twenty megabyte read carries a five minute budget. Whoever asked for
    // this has to be able to end it.
    const controller = new AbortController();
    const res = dripping([new Uint8Array([1]), new Uint8Array([2])], 40);

    const call = readBytesWithin(res, 60_000, undefined, controller.signal);
    setTimeout(() => controller.abort(), 10);

    await expect(call).rejects.toBeTruthy();
  });
});

describe("readWithin — the same read, as text", () => {
  it("decodes what arrived", async () => {
    expect(await readWithin(new Response("hello"), 1000)).toBe("hello");
  });

  it("refuses a body that is only whitespace", async () => {
    await expect(readWithin(new Response("   \n "), 1000)).rejects.toBeInstanceOf(TypeError);
  });

  it("passes the caller's signal through", async () => {
    const controller = new AbortController();
    const res = dripping([new Uint8Array([104]), new Uint8Array([105])], 40);

    const call = readWithin(res, 60_000, controller.signal);
    setTimeout(() => controller.abort(), 10);

    await expect(call).rejects.toBeTruthy();
  });
});
