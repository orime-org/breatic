// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The caller's signal reaches the delivery on every browser the web build
 * targets. `AbortSignal.any` arrived in Safari 17.4; on an older one a request
 * given a signal must still be sent. Cancelling it there is pinned with the
 * other cancellation promises in cancellation.integration.test.ts.
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
});
