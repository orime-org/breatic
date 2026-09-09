// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Getting the media an address points at, and refusing it early where that is
 * possible.
 *
 * The size limit is checked twice on purpose. A server that states
 * `Content-Length` lets the refusal happen before a single byte is read, which
 * is what "check the size, and if it is over, do not call the model at all"
 * asks for; a server that states nothing is caught while the bytes arrive.
 *
 * The type is settled in two steps for a reason that shows up in our own
 * storage: `Content-Type` is what the server says, not what the bytes are, and
 * an object store answers `application/octet-stream` for anything whose
 * extension it never registered. So the address itself is the second source.
 * There is no third: bytes are not sniffed here, because a signature that
 * disagrees with the declaration is exactly the trap that made the SDK path
 * send `data:image/png` for a video.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as sharedModule from "@breatic/shared";
import { fetchMedia, MediaUnavailable } from "@domain/understand/index.js";

const httpRequestMock = vi.fn();

vi.mock("@breatic/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof sharedModule>();
  return {
    ...actual,
    httpRequest: (...args: unknown[]) => httpRequestMock(...args),
  };
});

/** A response carrying only the headers a HEAD would bring back. */
function head(headers: Record<string, string>, status = 200): Response {
  return new Response(null, { status, headers });
}

/** A response carrying bytes. */
function body(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(bytes, { status: 200, headers });
}

/** The inputs every test varies from. */
const base = {
  maxBytes: 20_000_000,
  fetchTimeoutMs: 30_000,
  minBytesPerSec: 65_536,
};

/** Which method the nth request used. */
function methodOf(index: number): string {
  const init = httpRequestMock.mock.calls[index][1] as RequestInit;
  return (init.method ?? "GET").toUpperCase();
}

beforeEach(() => {
  httpRequestMock.mockReset();
});

describe("fetchMedia — an image stays an address", () => {
  it("hands the url over without reading a byte of it", async () => {
    httpRequestMock.mockResolvedValueOnce(
      head({ "content-type": "image/jpeg", "content-length": "120000" }),
    );

    const media = await fetchMedia({ ...base, url: "https://example.com/dog.jpg" });

    expect(media).toEqual({
      kind: "image",
      url: "https://example.com/dog.jpg",
      mediaType: "image/jpeg",
    });
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
    expect(methodOf(0)).toBe("HEAD");
  });
});

describe("fetchMedia — video and audio become bytes", () => {
  it("downloads a video and reports its type", async () => {
    httpRequestMock
      .mockResolvedValueOnce(head({ "content-type": "video/mp4", "content-length": "4" }))
      .mockResolvedValueOnce(body(new Uint8Array([1, 2, 3, 4])));

    const media = await fetchMedia({ ...base, url: "https://example.com/clip.mp4" });

    expect(media.kind).toBe("video");
    expect(media.mediaType).toBe("video/mp4");
    expect(media.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(methodOf(1)).toBe("GET");
  });

  it("downloads audio and reports its type", async () => {
    httpRequestMock
      .mockResolvedValueOnce(head({ "content-type": "audio/mpeg" }))
      .mockResolvedValueOnce(body(new Uint8Array([9, 9])));

    const media = await fetchMedia({ ...base, url: "https://example.com/talk.mp3" });

    expect(media.kind).toBe("audio");
    expect(media.mediaType).toBe("audio/mpeg");
    expect(media.bytes).toEqual(new Uint8Array([9, 9]));
  });
});

describe("fetchMedia — settling the type", () => {
  it("falls back to the address when the server declares octet-stream", async () => {
    httpRequestMock
      .mockResolvedValueOnce(head({ "content-type": "application/octet-stream" }))
      .mockResolvedValueOnce(body(new Uint8Array([1])));

    const media = await fetchMedia({ ...base, url: "https://cdn.example.com/a/b/clip.mp4" });

    expect(media.kind).toBe("video");
    expect(media.mediaType).toBe("video/mp4");
  });

  it("falls back to the address when the HEAD brings nothing back", async () => {
    httpRequestMock
      .mockRejectedValueOnce(new Error("HEAD not allowed"))
      .mockResolvedValueOnce(body(new Uint8Array([1])));

    const media = await fetchMedia({ ...base, url: "https://example.com/talk.mp3" });

    expect(media.kind).toBe("audio");
    expect(media.mediaType).toBe("audio/mpeg");
  });

  it("ignores parameters on the declared type", async () => {
    httpRequestMock.mockResolvedValueOnce(head({ "content-type": "image/png; charset=binary" }));

    const media = await fetchMedia({ ...base, url: "https://example.com/a.png" });

    expect(media.kind).toBe("image");
    expect(media.mediaType).toBe("image/png");
  });

  it("refuses a type that is none of the three, naming what it saw", async () => {
    httpRequestMock.mockResolvedValueOnce(head({ "content-type": "application/pdf" }));

    const call = fetchMedia({ ...base, url: "https://example.com/report.pdf" });

    await expect(call).rejects.toBeInstanceOf(MediaUnavailable);
    await expect(call).rejects.toMatchObject({
      kind: "unsupported-type",
      declaredType: "application/pdf",
    });
  });

  it("refuses when neither the server nor the address settles a type", async () => {
    httpRequestMock.mockResolvedValueOnce(head({}));

    await expect(
      fetchMedia({ ...base, url: "https://example.com/download" }),
    ).rejects.toMatchObject({ kind: "unsupported-type" });
  });
});

describe("fetchMedia — the size limit", () => {
  it("refuses on the stated length without asking for the bytes", async () => {
    httpRequestMock.mockResolvedValueOnce(
      head({ "content-type": "video/mp4", "content-length": "26000000" }),
    );

    const call = fetchMedia({ ...base, url: "https://example.com/big.mp4" });

    await expect(call).rejects.toBeInstanceOf(MediaUnavailable);
    await expect(call).rejects.toMatchObject({
      kind: "too-large",
      bytes: 26_000_000,
      limit: 20_000_000,
    });
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
  });

  it("refuses while reading when no length was stated", async () => {
    httpRequestMock
      .mockResolvedValueOnce(head({ "content-type": "video/mp4" }))
      .mockResolvedValueOnce(body(new Uint8Array(200)));

    const call = fetchMedia({ ...base, maxBytes: 100, url: "https://example.com/big.mp4" });

    await expect(call).rejects.toMatchObject({ kind: "too-large", limit: 100 });
  });

  it("takes a file exactly on the limit", async () => {
    httpRequestMock
      .mockResolvedValueOnce(head({ "content-type": "video/mp4", "content-length": "100" }))
      .mockResolvedValueOnce(body(new Uint8Array(100)));

    const media = await fetchMedia({ ...base, maxBytes: 100, url: "https://example.com/edge.mp4" });

    expect(media.bytes).toHaveLength(100);
  });

  it("checks an image's stated length too, before handing the url over", async () => {
    httpRequestMock.mockResolvedValueOnce(
      head({ "content-type": "image/png", "content-length": "26000000" }),
    );

    await expect(
      fetchMedia({ ...base, url: "https://example.com/huge.png" }),
    ).rejects.toMatchObject({ kind: "too-large" });
  });
});

describe("fetchMedia — when it cannot be had", () => {
  it("reports a refusal from the far side with its status", async () => {
    httpRequestMock
      .mockResolvedValueOnce(head({ "content-type": "video/mp4" }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    const call = fetchMedia({ ...base, url: "https://example.com/gone.mp4" });

    await expect(call).rejects.toBeInstanceOf(MediaUnavailable);
    await expect(call).rejects.toMatchObject({ kind: "unreachable", status: 404 });
  });

  it("reports a transport failure with what the layer underneath said", async () => {
    httpRequestMock
      .mockResolvedValueOnce(head({ "content-type": "video/mp4" }))
      .mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND example.invalid"));

    const call = fetchMedia({ ...base, url: "https://example.invalid/clip.mp4" });

    await expect(call).rejects.toMatchObject({
      kind: "unreachable",
      detail: expect.stringContaining("ENOTFOUND"),
    });
  });

  it("gives up on a body that arrives slower than the budget allows", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        // and never another byte, and never a close
      },
    });
    httpRequestMock
      .mockResolvedValueOnce(head({ "content-type": "video/mp4" }))
      .mockResolvedValueOnce(new Response(stalled, { status: 200 }));

    const call = fetchMedia({
      ...base,
      // 1 byte per second against a body that stops after one byte: the read
      // budget is the smallest this states, and it runs out.
      minBytesPerSec: 1,
      readFloorMs: 10,
      url: "https://example.com/slow.mp4",
    });

    await expect(call).rejects.toMatchObject({ kind: "slow" });
  });
});

describe("fetchMedia — stopping", () => {
  it("passes the caller's signal to every delivery", async () => {
    const controller = new AbortController();
    httpRequestMock
      .mockResolvedValueOnce(head({ "content-type": "video/mp4" }))
      .mockResolvedValueOnce(body(new Uint8Array([1])));

    await fetchMedia({ ...base, signal: controller.signal, url: "https://example.com/c.mp4" });

    for (const call of httpRequestMock.mock.calls) {
      expect((call[2] as Record<string, unknown>).signal).toBe(controller.signal);
    }
  });

  it("declares both deliveries safe to replay", async () => {
    httpRequestMock
      .mockResolvedValueOnce(head({ "content-type": "video/mp4" }))
      .mockResolvedValueOnce(body(new Uint8Array([1])));

    await fetchMedia({ ...base, url: "https://example.com/c.mp4" });

    for (const call of httpRequestMock.mock.calls) {
      expect((call[2] as Record<string, unknown>).replaySafe).toBe(true);
    }
  });
});
