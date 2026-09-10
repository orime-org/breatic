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
import { fetchMedia } from "@domain/understand/fetch-media.js";
import { MediaUnavailable } from "@domain/understand/types.js";
import type { Media } from "@domain/understand/types.js";

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

/**
 * A response whose bytes arrive over time, so a budget can run out.
 * @param bytes - What arrives, in two halves.
 * @param gapMs - How long before each half.
 * @param headers - What the response states about itself.
 * @returns The response.
 */
function slowBody(bytes: Uint8Array, gapMs: number, headers: Record<string, string> = {}): Response {
  const halves = [bytes.slice(0, bytes.length / 2), bytes.slice(bytes.length / 2)];
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = halves.shift();
      if (next === undefined) {
        controller.close();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, gapMs));
      controller.enqueue(next);
    },
  });
  return new Response(stream, { status: 200, headers });
}

/**
 * A response whose body stops part way, the way a dropped connection does.
 * @param bytes - What arrives before the break.
 * @returns The response.
 */
function cutOff(bytes: Uint8Array): Response {
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.error(new TypeError("terminated"));
        return;
      }
      sent = true;
      controller.enqueue(bytes);
    },
  });
  return new Response(stream, { status: 200, headers: { "content-length": "999999" } });
}

/** The inputs every test varies from. */
const base = {
  maxBytes: 20_000_000,
  fetchTimeoutMs: 30_000,
  minBytesPerSec: 65_536,
};

/**
 * The bytes of a media that travelled inline.
 * @param media - What fetchMedia answered with.
 * @returns Its bytes.
 * @throws {Error} when it was the kind that stays an address.
 */
function bytesOf(media: Media): Uint8Array {
  if (media.kind === "image") throw new Error("an image carries no bytes");
  return media.bytes;
}

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
    expect([...bytesOf(media)]).toEqual([1, 2, 3, 4]);
    expect(methodOf(1)).toBe("GET");
  });

  it("downloads audio and reports its type", async () => {
    httpRequestMock
      .mockResolvedValueOnce(head({ "content-type": "audio/mpeg" }))
      .mockResolvedValueOnce(body(new Uint8Array([9, 9])));

    const media = await fetchMedia({ ...base, url: "https://example.com/talk.mp3" });

    expect(media.kind).toBe("audio");
    expect(media.mediaType).toBe("audio/mpeg");
    expect([...bytesOf(media)]).toEqual([9, 9]);
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

  it("refuses when neither the server nor the GET settles a type", async () => {
    // The peek settles nothing and the name settles nothing, so the GET is
    // asked — and it says nothing either.
    httpRequestMock
      .mockResolvedValueOnce(head({}))
      .mockResolvedValueOnce(body(new Uint8Array([1])));

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

    expect(bytesOf(media)).toHaveLength(100);
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

    expect(bytesOf(media)).toHaveLength(100);
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

describe("fetchMedia — following a redirect", () => {
  // A redirect is not an edge case on this path: a CDN-backed image address
  // answers 302 to both HEAD and GET (measured against the one the smoke test
  // uses). So the target has to be reached, and the gate that judged the first
  // address has to judge this one too — it is a second address, chosen by
  // whoever controls the first host.
  it("judges the address a redirect names before going there", async () => {
    httpRequestMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/x.mp4" } }),
    );

    const call = fetchMedia({ ...base, url: "https://example.com/clip.mp4" });

    await expect(call).rejects.toMatchObject({ kind: "unreachable" });
    // The refused hop was never sent: one call went out, and it was the first.
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
  });

  it("follows one that names a public address", async () => {
    httpRequestMock
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://cdn.example.com/x.mp4" } }),
      )
      .mockResolvedValueOnce(head({ "content-type": "video/mp4", "content-length": "9" }))
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: "https://cdn.example.com/x.mp4" } }),
      )
      .mockResolvedValueOnce(body(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])));

    const media = await fetchMedia({ ...base, url: "https://example.com/clip.mp4" });

    expect(media.kind).toBe("video");
    expect(bytesOf(media)).toHaveLength(9);
  });

  it("gives up rather than go round a loop", async () => {
    httpRequestMock.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "https://example.com/again.mp4" } }),
    );

    const call = fetchMedia({ ...base, url: "https://example.com/clip.mp4" });

    await expect(call).rejects.toMatchObject({ kind: "unreachable" });
    // The count is the assertion: "it stops eventually" holds for any ceiling,
    // so what is pinned here is how far a host can walk this server — the
    // first address plus ten hops.
    expect(httpRequestMock).toHaveBeenCalledTimes(11);
  });

  it("treats a redirect with nowhere to go as an answer, not a hop", async () => {
    httpRequestMock.mockResolvedValueOnce(new Response(null, { status: 302 }));

    const call = fetchMedia({ ...base, url: "https://example.com/clip.mp4" });

    await expect(call).rejects.toMatchObject({ kind: "unreachable" });
  });
});

describe("fetchMedia — an image whose address is dead", () => {
  // The image path makes no second request, so the HEAD is the only chance
  // this side has to learn the address is gone. A 404 handed on reaches the
  // model as a url it cannot fetch, and the reason it reports is its own
  // complaint rather than the status we already had.
  it("refuses a 404 and says so", async () => {
    httpRequestMock.mockResolvedValueOnce(head({}, 404));

    const call = fetchMedia({ ...base, url: "https://example.com/dog.jpg" });

    await expect(call).rejects.toMatchObject({ kind: "unreachable", status: 404 });
  });

  it("goes ahead when the host merely declines the method", async () => {
    // A presigned url is signed per method: 403 or 405 to HEAD says nothing
    // about whether the backend can GET it.
    httpRequestMock.mockResolvedValueOnce(head({}, 405));

    const media = await fetchMedia({ ...base, url: "https://example.com/dog.jpg" });

    expect(media).toEqual({ kind: "image", url: "https://example.com/dog.jpg", mediaType: "image/jpeg" });
  });
});

describe("fetchMedia — audio this model cannot be sent", () => {
  // Which audio can travel is one fact, and the whole file used to be
  // downloaded before it was consulted: an iPhone voice memo (.m4a) went up to
  // 20 MB across the wire and was then refused, with a sentence blaming the
  // model for a refusal that happened on this side.
  it.each([
    ["an m4a", "https://example.com/memo.m4a", "audio/mp4"],
    ["an ogg", "https://example.com/talk.ogg", "audio/ogg"],
    ["a flac", "https://example.com/song.flac", "audio/flac"],
  ])("refuses %s before fetching it", async (_name, url, type) => {
    httpRequestMock.mockResolvedValueOnce(head({ "content-type": type, "content-length": "9" }));

    const call = fetchMedia({ ...base, url });

    await expect(call).rejects.toMatchObject({ kind: "unsupported-type", declaredType: type });
    // The peek, and nothing after it.
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
  });

  // Every entry, because each one is a different server's way of announcing
  // the same file and the endpoint takes neither spelling as it stands. An
  // entry with no case can be deleted with the suite still green, and the
  // files it covers then fall into the refusal above.
  it.each([
    ["audio/mpeg", "mp3"],
    ["audio/mp3", "mp3"],
    ["audio/wav", "wav"],
    ["audio/x-wav", "wav"],
    ["audio/wave", "wav"],
    ["audio/vnd.wave", "wav"],
  ])("carries the format %s travels as", async (type, format) => {
    httpRequestMock
      .mockResolvedValueOnce(head({ "content-type": type, "content-length": "3" }))
      .mockResolvedValueOnce(body(new Uint8Array([1, 2, 3])));

    const media = await fetchMedia({ ...base, url: "https://example.com/a.bin" });

    expect(media).toMatchObject({ kind: "audio", format });
  });
});

describe("fetchMedia — telling the failures apart", () => {
  it("says the address could not be had when nothing answered and the name says nothing", async () => {
    // Both facts are missing at once: no answer, and no extension to fall back
    // on. The one worth reporting is that the host did not answer — an address
    // whose name carries no type is ordinary (object stores hand out hash keys).
    // Both requests: a host that is not there does not answer the GET either.
    httpRequestMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND nope.example"));

    const call = fetchMedia({ ...base, url: "https://nope.example/a/Ab3xQ" });

    await expect(call).rejects.toMatchObject({ kind: "unreachable" });
    await expect(call).rejects.toMatchObject({
      detail: expect.stringContaining("ENOTFOUND") as unknown as string,
    });
  });

  it("still falls back to the name when the host merely declines the method", async () => {
    httpRequestMock
      .mockResolvedValueOnce(head({}, 405))
      .mockResolvedValueOnce(body(new Uint8Array([1, 2])));

    const media = await fetchMedia({ ...base, url: "https://example.com/clip.mp4" });

    expect(media.kind).toBe("video");
  });

  it("says an empty file could not be had, rather than that it was slow", async () => {
    // Nothing arrived, and it arrived instantly. Reported as slow, the model
    // is told the download did not finish — which reads as "try again", and
    // this address answers the same way every time.
    httpRequestMock
      .mockResolvedValueOnce(head({ "content-type": "video/mp4" }))
      .mockResolvedValueOnce(body(new Uint8Array()));

    const call = fetchMedia({ ...base, url: "https://example.com/empty.mp4" });

    await expect(call).rejects.toMatchObject({ kind: "unreachable" });
  });

  it("says the same when the answer carried no body at all", async () => {
    httpRequestMock
      .mockResolvedValueOnce(head({ "content-type": "video/mp4" }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const call = fetchMedia({ ...base, url: "https://example.com/nobody.mp4" });

    await expect(call).rejects.toMatchObject({ kind: "unreachable" });
  });

  it("carries the underlying reason out of a transport that retried", async () => {
    // What the transport throws states only that it tried several times; which
    // failure it was sits in the cause, two links down. Flattened with
    // `String()`, "the host does not exist" and "the host refused" read alike.
    const wrapped = new Error("http request to https://x.example/a.mp4 failed after 3 attempts", {
      cause: new TypeError("fetch failed", {
        cause: new Error("getaddrinfo ENOTFOUND x.example"),
      }),
    });
    // Both requests: a host that is not there is not there for the GET either.
    httpRequestMock.mockRejectedValue(wrapped);

    const call = fetchMedia({ ...base, url: "https://x.example/a.mp4" });

    await expect(call).rejects.toMatchObject({
      detail: expect.stringContaining("ENOTFOUND") as unknown as string,
    });
  });
});

describe("fetchMedia — reading the length the body's own answer states", () => {
  it("prefers the GET's own length over the HEAD's", async () => {
    // The bytes being read are the GET's, so the header describing them is the
    // GET's. A HEAD that understates the length shrinks the read budget for a
    // body it is not describing: read at 1 byte per second, 300 bytes are worth
    // 300 seconds, while the HEAD's zero is worth the floor.
    httpRequestMock
      .mockResolvedValueOnce(head({ "content-type": "video/mp4", "content-length": "0" }))
      .mockResolvedValueOnce(
        slowBody(new Uint8Array(300), 40, { "content-type": "video/mp4", "content-length": "300" }),
      );

    const media = await fetchMedia({
      ...base,
      minBytesPerSec: 1,
      readFloorMs: 20,
      url: "https://example.com/clip.mp4",
    });

    expect(bytesOf(media)).toHaveLength(300);
  });

  it("falls back to the HEAD's length when the GET states none", async () => {
    httpRequestMock
      .mockResolvedValueOnce(head({ "content-type": "video/mp4", "content-length": "26000000" }))
      .mockResolvedValueOnce(body(new Uint8Array(4)));

    // Refused on the HEAD's statement, before the GET goes out at all.
    await expect(fetchMedia({ ...base, url: "https://example.com/big.mp4" })).rejects.toMatchObject(
      { kind: "too-large", bytes: 26_000_000 },
    );
  });
});

describe("fetchMedia — when the HEAD settles nothing", () => {
  // HEAD is optional and plenty of hosts decline it. Measured against
  // picsum.photos/400/300: HEAD answers 405, GET answers 200 image/jpeg, and
  // the path carries no extension to fall back on. Refusing there names the
  // wrong thing — the address was never asked the method it answers.
  it("asks with a GET when the method was declined and the name says nothing", async () => {
    httpRequestMock
      .mockResolvedValueOnce(head({}, 405))
      .mockResolvedValueOnce(head({ "content-type": "image/jpeg" }));

    const media = await fetchMedia({ ...base, url: "https://example.com/400/300" });

    expect(media).toEqual({
      kind: "image",
      url: "https://example.com/400/300",
      mediaType: "image/jpeg",
    });
    expect(methodOf(1)).toBe("GET");
  });

  it("reads the bytes when that GET turns out to be a video", async () => {
    httpRequestMock
      .mockResolvedValueOnce(head({}, 403))
      .mockResolvedValueOnce(body(new Uint8Array([1, 2, 3]), { "content-type": "video/mp4" }));

    const media = await fetchMedia({ ...base, url: "https://example.com/a/Ab3xQ" });

    expect(media.kind).toBe("video");
    expect(bytesOf(media)).toHaveLength(3);
  });

  it("says the address is gone when the HEAD answered 404, whatever its name", async () => {
    httpRequestMock.mockResolvedValueOnce(head({}, 404));

    const call = fetchMedia({ ...base, url: "https://cdn.example.com/o/Ab3xQ9" });

    await expect(call).rejects.toMatchObject({ kind: "unreachable", status: 404 });
    // 404 is the one status a GET cannot recover from, so no second request.
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
  });

  it("refuses when the GET settles no type either", async () => {
    httpRequestMock
      .mockResolvedValueOnce(head({}, 405))
      .mockResolvedValueOnce(body(new Uint8Array([1]), { "content-type": "application/pdf" }));

    await expect(
      fetchMedia({ ...base, url: "https://example.com/a/Ab3xQ" }),
    ).rejects.toMatchObject({ kind: "unsupported-type", declaredType: "application/pdf" });
  });
});

describe("fetchMedia — a download cut off part way", () => {
  it("says it was slow rather than that the address is gone", async () => {
    // Measured: Node's fetch throws `TypeError: terminated` when the peer
    // closes mid-body. Read as "nothing was there", the model is told the
    // address cannot be reached and stops — while a retry would likely finish.
    httpRequestMock
      .mockResolvedValueOnce(head({ "content-type": "video/mp4" }))
      .mockResolvedValueOnce(cutOff(new Uint8Array([1, 2, 3, 4])));

    const call = fetchMedia({ ...base, url: "https://example.com/clip.mp4" });

    await expect(call).rejects.toMatchObject({ kind: "slow" });
  });
});

describe("fetchMedia — the length a HEAD understated", () => {
  it("treats a zero from the HEAD as no statement when the GET makes none", async () => {
    // A HEAD claiming zero for a body it never described would otherwise put
    // the read on the floor budget, and a normal clip is called slow.
    httpRequestMock
      .mockResolvedValueOnce(head({ "content-type": "video/mp4", "content-length": "0" }))
      .mockResolvedValueOnce(slowBody(new Uint8Array(300), 40, { "content-type": "video/mp4" }));

    const media = await fetchMedia({
      ...base,
      maxBytes: 5_000,
      minBytesPerSec: 1,
      readFloorMs: 20,
      url: "https://example.com/clip.mp4",
    });

    expect(bytesOf(media)).toHaveLength(300);
  });
});
