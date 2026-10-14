// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The caller's signal reaches the delivery on every browser the web build
 * targets. `AbortSignal.any` arrived in Safari 17.4; on an older one a request
 * given a signal must still be sent, and still be cancellable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { httpRequest } from "../request.js";

const realAny = AbortSignal.any;

beforeEach(() => {
  // As on Safari before 17.4.
  Object.defineProperty(AbortSignal, "any", { configurable: true, writable: true, value: undefined });
});

afterEach(() => {
  Object.defineProperty(AbortSignal, "any", { configurable: true, writable: true, value: realAny });
  vi.unstubAllGlobals();
});

describe("a caller's signal without AbortSignal.any", () => {
  it("sends the request", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await httpRequest("https://example.test/x", {}, { replaySafe: true, signal: new AbortController().signal });
    expect(response.status).toBe(204);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels the delivery when the caller aborts", async () => {
    let delivered: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            delivered = init.signal ?? undefined;
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
    );
    const caller = new AbortController();
    const pending = httpRequest("https://example.test/x", {}, { replaySafe: true, signal: caller.signal });
    await vi.waitFor(() => expect(delivered).toBeDefined());
    caller.abort(new Error("superseded"));
    await expect(pending).rejects.toThrow("superseded");
    expect(delivered?.aborted).toBe(true);
  });
});
