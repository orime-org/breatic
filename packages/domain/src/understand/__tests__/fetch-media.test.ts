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

// Resolution is stubbed so these cases neither reach the network nor depend on
// what a name happens to point at today. `localhost` is the one name whose
// answer is the subject of a case below; everything else is public.
vi.mock("node:dns/promises", () => ({
  lookup: (host: string) =>
    host === "localhost"
      ? Promise.resolve([{ address: "127.0.0.1", family: 4 }])
      : Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
}));

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
  const init = httpRequestMock.mock.calls[index]?.[1] as RequestInit | undefined;
  return (init?.method ?? "GET").toUpperCase();
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

  it("lets a large image through, because its bytes never enter our request", async () => {
    // The limit describes the request body we send, and an image travels as an
    // address the backend fetches for itself. Measured: a 25 MB photo is
    // nothing this side has to carry.
    httpRequestMock.mockResolvedValueOnce(
      head({ "content-type": "image/png", "content-length": "26000000" }),
    );

    const media = await fetchMedia({ ...base, url: "https://example.com/huge.png" });

    expect(media.kind).toBe("image");
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
  });

  it("takes the length off the GET when the HEAD did not state one", async () => {
    // A server that refuses HEAD still states the length on the GET, and that
    // is the figure the read budget has to come from: without it a 15 MB clip
    // gets the floor and is called slow.
    httpRequestMock
      .mockRejectedValueOnce(new Error("HEAD not allowed"))
      .mockResolvedValueOnce(
        new Response(new Uint8Array(200), {
          status: 200,
          headers: { "content-type": "video/mp4", "content-length": "26000000" },
        }),
      );

    const call = fetchMedia({ ...base, url: "https://example.com/big.mp4" });

    await expect(call).rejects.toMatchObject({
      kind: "too-large",
      bytes: 26_000_000,
      limit: 20_000_000,
    });
  });

  it("says a file is over the limit without inventing a size it does not know", async () => {
    // The stream path only knows "more than the limit arrived". Reporting the
    // cut-off point as the file size is a number the reader can act on and it
    // would be wrong.
    httpRequestMock
      .mockResolvedValueOnce(head({ "content-type": "video/mp4" }))
      .mockResolvedValueOnce(body(new Uint8Array(200)));

    const call = fetchMedia({ ...base, maxBytes: 100, url: "https://example.com/big.mp4" });

    await expect(call).rejects.toMatchObject({ kind: "too-large", limit: 100 });
    await expect(call).rejects.toMatchObject({ bytes: undefined });
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

  it("refuses an image whose address never answered, without handing it over", async () => {
    // The image path makes no second request, so a HEAD that never answered is
    // the only thing this side will ever know about the address. Passing it to
    // the model anyway asks the model to look at something we know is not there.
    httpRequestMock.mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND"));

    const call = fetchMedia({ ...base, url: "https://example.invalid/dog.jpg" });

    await expect(call).rejects.toBeInstanceOf(MediaUnavailable);
    await expect(call).rejects.toMatchObject({ kind: "unreachable" });
  });

  it("keeps going when the HEAD was answered with a refusal, and reads nothing off it", async () => {
    // 405 is a live host declining one method, which is a different fact from
    // no answer at all: the GET goes ahead. What a refusal says about the
    // content is nothing at all — the type on an error page describes the
    // error page — so the type comes off the address instead.
    httpRequestMock
      .mockResolvedValueOnce(head({ "content-type": "application/pdf" }, 405))
      .mockResolvedValueOnce(body(new Uint8Array([1])));

    const media = await fetchMedia({ ...base, url: "https://example.com/clip.mp4" });

    expect(media.kind).toBe("video");
    expect(media.mediaType).toBe("video/mp4");
  });

  it("cancels a body it is not going to read", async () => {
    // The transport measured connection reuse collapsing when refusals are
    // discarded unread past undici's buffering threshold.
    const cancel = vi.fn().mockResolvedValue(undefined);
    const refusal = new Response("not found, here is a long error page", { status: 404 });
    Object.defineProperty(refusal, "body", {
      value: { cancel },
      configurable: true,
    });
    httpRequestMock
      .mockResolvedValueOnce(head({ "content-type": "video/mp4" }))
      .mockResolvedValueOnce(refusal);

    await expect(
      fetchMedia({ ...base, url: "https://example.com/gone.mp4" }),
    ).rejects.toMatchObject({ kind: "unreachable", status: 404 });
    expect(cancel).toHaveBeenCalled();
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

  it("gives an unknown-length body the budget the limit implies", async () => {
    // Nothing stated a length, so the size is unknown and its upper bound is
    // the limit. Handing such a body the floor instead is what turned every
    // download over a few seconds into "it took too long".
    const slowly = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new Uint8Array(50));
        await new Promise((resolve) => setTimeout(resolve, 60));
        controller.enqueue(new Uint8Array(50));
        controller.close();
      },
    });
    httpRequestMock
      .mockResolvedValueOnce(head({ "content-type": "video/mp4" }))
      .mockResolvedValueOnce(new Response(slowly, { status: 200 }));

    // 1000 bytes at 100 bytes/sec is a 10s budget; the floor is 10ms, so a
    // budget taken from the floor would give up on the pause above.
    const media = await fetchMedia({
      ...base,
      maxBytes: 1000,
      minBytesPerSec: 100,
      readFloorMs: 10,
      url: "https://example.com/unknown.mp4",
    });

    expect(media.bytes).toHaveLength(100);
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

describe("fetchMedia — where it will not go", () => {
  // The address comes from whoever is typing in the chat box, by way of the
  // model. Without this the server's own network position is on offer: a
  // status code tells whether a host and port are there, and any response that
  // passes for media is downloaded and read out by the model.
  it.each([
    ["loopback", "http://127.0.0.1:5432/x.mp4"],
    ["loopback by name", "http://localhost:8080/x.mp4"],
    ["link-local, which is where cloud metadata lives", "http://169.254.169.254/latest/meta-data/"],
    ["private class A", "http://10.0.0.5/x.mp4"],
    ["private class B", "http://172.16.3.4/x.mp4"],
    ["private class C", "http://192.168.1.1/x.mp4"],
    ["IPv6 loopback", "http://[::1]/x.mp4"],
    ["IPv6 unique local", "http://[fd00::1]/x.mp4"],
  ])("refuses %s", async (_name, url) => {
    const call = fetchMedia({ ...base, url });

    await expect(call).rejects.toBeInstanceOf(MediaUnavailable);
    await expect(call).rejects.toMatchObject({ kind: "unreachable" });
    expect(httpRequestMock).not.toHaveBeenCalled();
  });

  it("says nothing about what it found there", async () => {
    // A status code is the answer to "is something listening on this port".
    const failure = await fetchMedia({ ...base, url: "http://169.254.169.254/x.mp4" }).catch(
      (err: MediaUnavailable) => err,
    );

    expect((failure as MediaUnavailable).status).toBeUndefined();
  });
});
