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
import { signUploadTicket, type UploadTicketPayload } from "@breatic/shared";
import worker from "@ingest/index.js";

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
 * Bytes no two positions of which are alike.
 *
 * The parts are cut on fixed boundaries out of reads that arrive in whatever
 * size they arrive in, so the object is assembled from slices this Worker
 * chose. A uniform fill would land byte-for-byte correct however those slices
 * were mixed up; a walking pattern does not.
 * @param length - How many bytes.
 * @returns The pattern.
 */
function pattern(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 31 + 7) & 0xff);
}

/**
 * Expect one fetch of the source and answer it with these bytes.
 * @param status - What the provider answers.
 * @param bytes - What it serves.
 */
function expectSource(status = 200, bytes = pattern(1024)): void {
  fetchMock
    .get(SOURCE_ORIGIN)
    .intercept({ path: SOURCE_PATH, method: "GET" })
    .reply(status, bytes);
}

/**
 * Ask the Worker to pull a URL into the key a ticket names.
 * @param over - Ticket fields to override.
 * @param headers - Request headers to override.
 * @param url - The source to name in the body.
 * @returns The Worker's answer and the key it was written to.
 */
async function pull(
  over: Partial<UploadTicketPayload> = {},
  headers: Record<string, string> = {},
  url = `${SOURCE_ORIGIN}${SOURCE_PATH}`,
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
      body: JSON.stringify({ url }),
    }),
    env,
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

  it("answers with nothing beyond the three measurements", async () => {
    expectSource();

    const { response } = await pull();

    // Flat, the way the other endpoints answer, and holding only what this
    // Worker could see. The caller registers the transfer itself.
    expect(
      Object.keys(await response.json<Record<string, unknown>>()).sort(),
    ).toEqual(["contentType", "sha256", "sizeBytes"]);
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

  it("answers a source it could not read, storing nothing", async () => {
    expectSource(404, new Uint8Array(0));

    const { response, storageKey } = await pull();

    expect(response.status).toBe(502);
    expect(await env.BUCKET.head(storageKey)).toBeNull();
  });
});
