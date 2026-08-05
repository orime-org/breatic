// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What `downloadValidated` tells the shared transport, and what it stops
 * doing itself.
 *
 * Two things a source check cannot see, and the reason this file is
 * behavioural rather than structural:
 *
 *   - `replaySafe: true` is the whole point of the migration here. A
 *     download is a pure idempotent GET, so the transport may replay it —
 *     including on a dropped connection, which the hand-rolled loop never
 *     retried because `fetch`'s own connection errors are not
 *     `TransientDownloadError`. That is the CDN blip that used to kill a
 *     user's job outright.
 *   - The 120s figure must survive as a PER-DELIVERY deadline. It was per
 *     attempt in the old loop; if it arrives as anything else, or not at
 *     all, a slow vendor transfer starts behaving differently and nothing
 *     else in the suite would notice.
 *
 * The business guards (truncation, zero-byte, encoding exemption) are NOT
 * retested here — they live in download-validated.test.ts and are unchanged
 * by the migration. This file only pins the handover.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as sharedModule from "@breatic/shared";

const httpRequestMock = vi.fn();

vi.mock("@breatic/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof sharedModule>();
  return {
    ...actual,
    httpRequest: (...args: unknown[]) => httpRequestMock(...args),
  };
});

import { downloadValidated } from "@core/infra/storage/index.js";

/**
 * A complete, well-formed download response.
 * @param body - The bytes the "server" returns.
 * @returns A real Response carrying a matching content-length.
 */
const completeResponse = (body: Buffer): Response =>
  new Response(body, {
    status: 200,
    headers: {
      "content-type": "image/png",
      "content-length": String(body.length),
    },
  });

describe("downloadValidated hands the request to the shared transport", () => {
  beforeEach(() => {
    httpRequestMock.mockReset();
    httpRequestMock.mockImplementation(async () =>
      completeResponse(Buffer.from("payload bytes")),
    );
  });

  it("declares the download replay-safe and keeps the 120s per-delivery deadline", async () => {
    await downloadValidated("https://cdn.test/asset.png");

    // Strict equality on the whole options object: a replaySafe that flipped
    // to false would silently stop retrying dropped connections, and a
    // missing timeoutMs would swap 120s for the transport's 300s default.
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
    expect(httpRequestMock.mock.calls[0]![2]).toStrictEqual({
      replaySafe: true,
      timeoutMs: 120_000,
    });
  });

  it("still asks for an identity transfer, so the truncation guard stays meaningful", async () => {
    // Without this header a server may send a compressed body, and
    // content-length then describes the compressed size — the completeness
    // check downstream would compare two different quantities.
    await downloadValidated("https://cdn.test/asset.png");

    expect(httpRequestMock.mock.calls[0]![0]).toBe("https://cdn.test/asset.png");
    expect(httpRequestMock.mock.calls[0]![1]).toStrictEqual({
      headers: { "accept-encoding": "identity" },
    });
  });

  it("makes exactly one call — retrying is the transport's job now", async () => {
    // The old loop retried 5xx itself. If that machinery is still in place,
    // a transport-level failure would produce more than one call here.
    httpRequestMock.mockImplementation(
      async () => new Response("upstream unavailable", { status: 503 }),
    );

    await expect(downloadValidated("https://cdn.test/asset.png")).rejects.toThrow();
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
  });
});
