// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Pulling a provider's URL straight into R2 (#181, lane ③).
 *
 * An AIGC provider answers with a link that expires. Downloading it to our
 * servers and uploading it again would move every byte twice for nothing, so
 * the Worker fetches it where R2 already is, and hashes what landed the same
 * way it hashes bytes a browser sent.
 *
 * The source declares no length we can rely on, which is why the bytes go in
 * as multipart rather than a single put: workerd refuses a stream whose length
 * it does not know, and whether a response declares one is the source's choice.
 *
 * The endpoint takes the shared secret as well as a ticket. Every browser
 * holds a ticket, and this is the one endpoint that makes the Worker fetch an
 * address the caller names.
 */

import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  fetchMock,
} from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import {
  signUploadTicket,
  INGEST_FAILURE_HEADER,
  type MediaLimits,
  type UploadTicketPayload,
} from "@breatic/shared";
import worker, { type Env } from "@ingest/index.js";
import type { ProbeReport } from "@ingest/media-metadata.js";
import { head, type Sample } from "./helpers/encoder-heads.js";
import { containerAnswering } from "./helpers/stand-in-container.js";

const PART_SIZE = 5 * 1024 * 1024;
const SOURCE_ORIGIN = "https://provider.test.example";
const SOURCE_PATH = "/results/out.png";

let seq = 0;

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

/**
 * Bytes no two positions of which are alike, opening as a real file.
 *
 * The parts are cut on fixed boundaries out of reads that arrive in whatever
 * size they arrive in, so the object is assembled from slices this Worker
 * chose. A uniform fill would land byte-for-byte correct however those slices
 * were mixed up; a walking pattern does not.
 *
 * The head is what a reader names the stored object by, and every finish now
 * answers with that name — so bytes that are nothing are refused, whatever the
 * source declared. Which file it opens as is the case's to choose.
 * @param length - How many bytes.
 * @param opens - Which file the first bytes come from.
 * @returns The pattern.
 */
function pattern(length: number, opens: Sample = "png"): Uint8Array {
  const bytes = Uint8Array.from({ length }, (_, i) => (i * 31 + 7) & 0xff);
  bytes.set(head(opens).subarray(0, length), 0);
  return bytes;
}

/**
 * Expect one fetch of the source and answer it with these bytes.
 * @param status - What the provider answers.
 * @param bytes - What it serves.
 */
function expectSource(
  status = 200,
  bytes = pattern(1024),
  headers: Record<string, string> = {},
): void {
  fetchMock
    .get(SOURCE_ORIGIN)
    .intercept({ path: SOURCE_PATH, method: "GET" })
    .reply(status, bytes, { headers });
}

/**
 * Ask the Worker to pull a URL into the key a ticket names.
 * @param over - Ticket fields to override.
 * @param headers - Request headers to override.
 * @param url - The source to name in the body.
 * @param callBudgetMs - How long the whole call may take, when the case cares.
 * @returns The Worker's answer and the key it was written to.
 */
async function pull(
  over: Partial<UploadTicketPayload> = {},
  headers: Record<string, string> = {},
  url = `${SOURCE_ORIGIN}${SOURCE_PATH}`,
  callBudgetMs?: number,
  run?: { coverKey: string; limits: MediaLimits; media: Env["MEDIA"] },
): Promise<{ response: Response; storageKey: string }> {
  const storageKey = `image/2026-09-07/${seq++}_pulled.png`;
  const ticket = await signUploadTicket(
    {
      storageKey,
      studioId: "studio-1",
      userId: "user-1",
      totalParts: 4,
      partSize: PART_SIZE,
      contentType: "image/png",
      expiresAt: Date.now() + 300_000,
      sessionTokenTtlSeconds: 900,
      ...over,
    },
    env.INGEST_SHARED_SECRET,
  );
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request("https://ingest.example.com/fetch", {
      method: "POST",
      headers: {
        "x-ingest-secret": env.INGEST_SHARED_SECRET,
        "x-upload-ticket": ticket,
        ...headers,
      },
      body: JSON.stringify({
        url,
        ...(callBudgetMs !== undefined && { callBudgetMs }),
        ...(run !== undefined && { coverKey: run.coverKey, limits: run.limits }),
      }),
    }),
    run === undefined ? env : { ...env, MEDIA: run.media },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return { response, storageKey };
}

describe("POST /fetch — who may ask for it", () => {
  it("refuses a caller with no shared secret", async () => {
    const { response } = await pull({}, { "x-ingest-secret": "" });
    expect(response.status).toBe(401);
  });

  it("refuses a caller holding only a ticket", async () => {
    // A browser has one of these for every upload it starts. Letting a ticket
    // alone through would make this Worker fetch any address a page names.
    const { response } = await pull({}, { "x-ingest-secret": "not-the-secret" });
    expect(response.status).toBe(401);
  });

  it("refuses a ticket that does not verify", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://ingest.example.com/fetch", {
        method: "POST",
        headers: {
          "x-ingest-secret": env.INGEST_SHARED_SECRET,
          "x-upload-ticket": "not.a.ticket",
        },
        body: JSON.stringify({ url: `${SOURCE_ORIGIN}${SOURCE_PATH}` }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(401);
  });

  it("refuses a body that names no https url", async () => {
    const { response } = await pull({}, {}, "http://provider.test.example/x");
    expect(response.status).toBe(400);
  });
});

describe("POST /fetch — the transfer", () => {
  it("stores what the source served and measures the object it wrote", async () => {
    const served = pattern(1024);
    expectSource(200, served);

    const { response, storageKey } = await pull();

    expect(response.status).toBe(200);
    // What the ledger keys on is computed over the object in R2, not over what
    // anyone said about it — the same rule as an upload the browser sent.
    const measured = await response.json<{
      sha256: string;
      sizeBytes: number;
      contentType: string;
    }>();
    expect(measured.sizeBytes).toBe(1024);
    expect(measured.contentType).toBe("image/png");
    expect(measured.sha256).toMatch(/^[0-9a-f]{64}$/);

    const stored = await env.BUCKET.get(storageKey);
    expect(stored).not.toBeNull();
    expect(stored!.size).toBe(1024);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(served);
    // Set when the upload is opened, so a public read answers with the type
    // the ticket signed rather than application/octet-stream.
    expect(stored!.httpMetadata?.contentType).toBe("image/png");
  });

  // A source that answered 200 and served nothing. Zero bytes are no format at
  // all, and saying so would tell a person their file is a kind we do not take
  // when what happened is that nothing came back — which the ledger already has
  // a settlement for, reached only if this answers.
  it("stores an empty source rather than calling it a format we refuse", async () => {
    expectSource(200, new Uint8Array(0));

    const { response } = await pull();

    expect(response.status).toBe(200);
    // The type as well as the size. No bytes read as no format, and answering
    // `application/octet-stream` hands the caller something no lane stores —
    // which it turns into a failure of its own, in place of the settlement the
    // ledger writes for nothing arriving.
    expect(await response.json()).toMatchObject({
      sizeBytes: 0,
      contentType: "image/png",
    });
  });

  it("answers with nothing beyond what it measured", async () => {
    expectSource();

    const { response } = await pull();

    // Flat, the way the other endpoints answer, and holding only what this
    // Worker could see. The caller registers the transfer itself.
    expect(
      Object.keys(await response.json<Record<string, unknown>>()).sort(),
    ).toEqual([
      "contentType",
      "cover",
      "durationSeconds",
      "height",
      "sha256",
      "sizeBytes",
      "width",
    ]);
  });

  it("writes a source larger than one part as several", async () => {
    // A read hands back whatever arrived, so the part boundary falls inside a
    // chunk. R2 refuses any part but the last under its 5 MiB floor, which is
    // what a boundary handled wrongly would produce.
    const served = pattern(PART_SIZE + 4096);
    expectSource(200, served);

    const { response, storageKey } = await pull();

    expect(response.status).toBe(200);
    const stored = await env.BUCKET.get(storageKey);
    expect(stored!.size).toBe(PART_SIZE + 4096);
    // Every byte, in order: the boundary falls inside one of the reads, and
    // what the second part starts with is the remainder of that read.
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(served);
  });

  it("refuses a source past what the ticket allows", async () => {
    // A URL announces nothing about its size, so this ceiling is all that
    // stands between a source that never ends and a full bucket.
    expectSource(200, pattern(PART_SIZE * 2 + 16));

    const { response, storageKey } = await pull({ totalParts: 2 });

    expect(response.status).toBe(413);
    // Nothing was assembled, so nothing stands at the key. What the caller
    // does about the grant and the task row is the caller's, on this answer.
    expect(await env.BUCKET.head(storageKey)).toBeNull();
  });

  it("refuses one that fills the last allowed part exactly", async () => {
    // A source whose length is a whole number of parts leaves nothing over at
    // the end, so the ceiling has to hold while the parts are being written
    // rather than only once the stream runs out.
    expectSource(200, pattern(PART_SIZE * 3));

    const { response, storageKey } = await pull({ totalParts: 2 });

    expect(response.status).toBe(413);
    expect(await env.BUCKET.head(storageKey)).toBeNull();
  });

  it("hands back an object it stored even when the call's window is spent", async () => {
    // The object is written and hashed before the container is asked for a
    // resolution and a poster. A window with nothing left in it costs the
    // upload those two, and a run started anyway would end with the caller's
    // own timer firing on a transfer that succeeded.
    const served = pattern(1024);
    expectSource(200, served, { "content-type": "video/mp4" });
    const run = containerAnswering(PULLED_FILM, null);

    const { response, storageKey } = await pull(
      { contentType: "application/octet-stream", typeFromSource: true },
      {},
      undefined,
      1,
      {
        coverKey: `video/2026-09-14/${seq}_spent_cover.png`,
        limits: RUN_LIMITS,
        media: run.media,
      },
    );

    expect(response.status).toBe(200);
    const measured = await response.json<{ sizeBytes: number }>();
    expect(measured.sizeBytes).toBe(1024);
    expect((await env.BUCKET.head(storageKey))!.size).toBe(1024);
    // The one assertion that holds the window to the call: the deadlines
    // arrived, and the run was still not started.
    expect(run.asked).toBeNull();
  });

  it("answers a source it could not read, storing nothing", async () => {
    expectSource(404, new Uint8Array(0));

    const { response, storageKey } = await pull();

    expect(response.status).toBe(502);
    expect(await env.BUCKET.head(storageKey)).toBeNull();
  });
});

// Four of these answer 502, so a caller reading the status alone would have
// to report every one of them as the source being unreachable — a false
// statement about a third party when our own storage was what broke.
describe("POST /fetch — naming which failure this was", () => {
  /** What the Worker named its refusal, on this answer. */
  function named(response: Response): string | null {
    return response.headers.get(INGEST_FAILURE_HEADER);
  }

  it("names a source it could not read", async () => {
    expectSource(404, new Uint8Array(0));

    const { response } = await pull();

    expect(named(response)).toBe("source_unreachable");
  });

  it("names a type it will not store", async () => {
    expectSource(200, pattern(1024), { "content-type": "text/html" });

    const { response } = await pull({
      contentType: "application/octet-stream",
      typeFromSource: true,
    });

    expect(named(response)).toBe("unsupported_type");
  });

  it("names a source past what the ticket allows", async () => {
    expectSource(200, pattern(PART_SIZE * 2 + 16));

    const { response } = await pull({ totalParts: 2 });

    expect(named(response)).toBe("over_cap");
  });

  it("names R2 turning the upload down, which is ours rather than the source's", async () => {
    // The one R2 call on this path with no guard of its own answered for the
    // whole endpoint as a bare 500, and a caller reading no name reports the
    // source. Storage refusing to open an upload is store_failed like its
    // sibling that writes the parts.
    expectSource();
    const open = env.BUCKET.createMultipartUpload;
    (env.BUCKET as { createMultipartUpload: unknown }).createMultipartUpload =
      (): Promise<never> => Promise.reject(new Error("r2 is unavailable"));

    try {
      const { response } = await pull();
      expect(response.status).toBe(502);
      expect(named(response)).toBe("store_failed");
    } finally {
      (env.BUCKET as { createMultipartUpload: unknown }).createMultipartUpload =
        open;
    }
  });

  it("leaves an answer that succeeded unnamed", async () => {
    expectSource();

    const { response } = await pull();

    expect(named(response)).toBeNull();
  });
});

// Two questions, and only one of them is answered before the bytes move. What
// a source declares decides whether the transfer happens at all and what R2
// freezes on the object; what the ledger records is read off the bytes once
// they are down (#240).
describe("POST /fetch — where the stored type comes from", () => {
  it("answers with what the bytes are, not with what anyone declared", async () => {
    expectSource(200, pattern(1024, "mp4"), {
      "content-type": "image/png",
    });

    const { response, storageKey } = await pull({ typeFromSource: true });

    expect(response.status).toBe(200);
    const measured = await response.json<{ contentType: string }>();
    expect(measured.contentType).toBe("video/mp4");
    // R2 takes an object's metadata from the upload it was created under, and
    // the upload was opened before a byte had been seen. That copy is #241's.
    const stored = await env.BUCKET.head(storageKey);
    expect(stored!.httpMetadata?.contentType).toBe("image/png");
  });

  it("opens the upload under the ticket's type when it asks for no other", async () => {
    // Lane ③ signs a type before a byte moves, from the task type, and the
    // key's extension is decided from the same place. A provider answering
    // with something else does not get to change what the object is served as.
    expectSource(200, pattern(1024), { "content-type": "application/json" });

    const { response, storageKey } = await pull();

    expect(response.status).toBe(200);
    const stored = await env.BUCKET.head(storageKey);
    expect(stored!.httpMetadata?.contentType).toBe("image/png");
  });

  it("opens it under the source's type when the ticket asks for it", async () => {
    expectSource(200, pattern(1024, "mp4"), {
      "content-type": "video/mp4",
    });

    const { response, storageKey } = await pull({
      contentType: "application/octet-stream",
      typeFromSource: true,
    });

    expect(response.status).toBe(200);
    const stored = await env.BUCKET.head(storageKey);
    expect(stored!.httpMetadata?.contentType).toBe("video/mp4");
  });

  it("reduces the source's type the same way the ticket endpoint does", async () => {
    // A browser honours the LAST parsable value when a header carries commas,
    // so what reaches R2 has to be the first one.
    expectSource(200, pattern(1024, "mp4"), {
      "content-type": "VIDEO/MP4 , text/html",
    });

    const { response, storageKey } = await pull({
      contentType: "application/octet-stream",
      typeFromSource: true,
    });

    expect(response.status).toBe(200);
    const stored = await env.BUCKET.head(storageKey);
    expect(stored!.httpMetadata?.contentType).toBe("video/mp4");
  });

  it("refuses a source that is not an uploadable kind, storing nothing", async () => {
    expectSource(200, pattern(1024), { "content-type": "text/html" });

    const { response, storageKey } = await pull({
      contentType: "application/octet-stream",
      typeFromSource: true,
    });

    expect(response.status).toBe(415);
    expect(await env.BUCKET.head(storageKey)).toBeNull();
  });

  it("refuses a source whose first value is not an uploadable kind", async () => {
    expectSource(200, pattern(1024), {
      "content-type": "text/html,image/png",
    });

    const { response, storageKey } = await pull({
      contentType: "application/octet-stream",
      typeFromSource: true,
    });

    expect(response.status).toBe(415);
    expect(await env.BUCKET.head(storageKey)).toBeNull();
  });

  it("refuses a source that declares no type at all", async () => {
    expectSource(200, pattern(1024), {});

    const { response, storageKey } = await pull({
      contentType: "application/octet-stream",
      typeFromSource: true,
    });

    expect(response.status).toBe(415);
    expect(await env.BUCKET.head(storageKey)).toBeNull();
  });
});

const RUN_LIMITS: MediaLimits = { runDeadlineMs: 150_000, toolTimeoutMs: 60_000 };

/** A 640x360 film, the shape ffprobe answers with. */
const PULLED_FILM: ProbeReport = {
  durationSeconds: 4,
  streams: [
    {
      index: 0,
      codecType: "video",
      codecName: "h264",
      width: 640,
      height: 360,
      attachedPic: false,
    },
  ],
};

// The caller names a cover key on every call, because it learns the type only
// once the transfer has happened. What it gets for a video has to reach the
// container, and what it gets for anything else has to not.
describe("POST /fetch — the cover the caller named", () => {
  it("is asked of the container when the source served a video", async () => {
    expectSource(200, pattern(1024, "mp4"), {
      "content-type": "video/mp4",
    });
    const run = containerAnswering(PULLED_FILM, new Uint8Array([0x89, 0x50, 1, 2]));
    const coverKey = `video/2026-09-14/${seq}_pulled_cover.png`;

    const { response, storageKey } = await pull(
      { contentType: "application/octet-stream", typeFromSource: true },
      {},
      undefined,
      undefined,
      { coverKey, limits: RUN_LIMITS, media: run.media },
    );

    expect(response.status).toBe(200);
    expect(run.asked).toMatchObject({
      wantCover: true,
      toolTimeoutMs: RUN_LIMITS.toolTimeoutMs,
    });
    expect(run.asked?.objectUrl).toContain(storageKey);
    expect(await response.json<{ cover: unknown }>()).toMatchObject({
      cover: { storageKey: coverKey },
    });
  });

  it("is not asked of it for a source with no frame to lift", async () => {
    expectSource(200, pattern(1024), { "content-type": "image/png" });
    const run = containerAnswering(PULLED_FILM, new Uint8Array([0x89, 0x50, 3, 4]));

    const { response } = await pull(
      { contentType: "application/octet-stream", typeFromSource: true },
      {},
      undefined,
      undefined,
      {
        coverKey: `image/2026-09-14/${seq}_pulled_cover.png`,
        limits: RUN_LIMITS,
        media: run.media,
      },
    );

    expect(response.status).toBe(200);
    expect(run.asked).toMatchObject({ wantCover: false });
    expect(await response.json<{ cover: unknown }>()).toMatchObject({
      cover: null,
    });
  });
});
