// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Finishing an upload (#186, design §6.2 / §6.4).
 *
 * The Worker keeps nothing between requests, so the list of parts comes back
 * from whoever is uploading. It judges that list against the layout its own
 * token signed, asks our server for the exclusive permission to finish this
 * key, and only then has R2 assemble the object.
 *
 * The permission is what stops a replayed ticket: opening a second multipart
 * upload on a key already in the ledger and completing it overwrites the
 * object, and the studio's dedup points other members at that same key.
 *
 * The hash is computed over the stored object rather than over what the
 * browser said. The ledger keys on it, and only bytes that actually landed
 * name what is actually there.
 */

import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  fetchMock,
} from "cloudflare:test";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { signUploadTicket, type UploadTicketPayload } from "@breatic/shared";
import worker from "@ingest/index.js";

const PART_SIZE = 5 * 1024 * 1024;
const FINAL_PART_SIZE = 1024;
/** The two halves of each server URL as vitest.config.ts binds them. */
const SERVER_ORIGIN = "https://api.test.example";
const REPORT_PATH = "/api/v1/assets/ingest-report";
const CLAIM_PATH = "/api/v1/assets/upload-grant/claim";

let seq = 0;

/** Every report body the Worker sent, in order. */
const reports: Record<string, unknown>[] = [];
/** Every claim body the Worker sent, in order. */
const claims: Record<string, unknown>[] = [];

/** What our server answers a completed report with. */
const REGISTERED = {
  data: { ok: true, fileUrl: "https://cdn.test.example/stored.mp4", kind: "video" },
};

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

beforeEach(() => {
  reports.length = 0;
  claims.length = 0;
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

/**
 * Expect one claim and answer it.
 * @param answer - The verdict our server gives.
 * @param times - How many askings to answer.
 */
function expectClaim(
  answer: unknown = { data: { granted: true } },
  times = 1,
): void {
  fetchMock
    .get(SERVER_ORIGIN)
    .intercept({ path: CLAIM_PATH, method: "POST" })
    .reply(200, (opts: { body?: string }) => {
      claims.push(JSON.parse(opts.body ?? "{}") as Record<string, unknown>);
      return answer;
    })
    .times(times);
}

/**
 * Expect one report and answer it with `status`.
 * @param status - What our server answers.
 * @param body - The answer's body.
 */
function expectReport(status = 200, body: unknown = REGISTERED): void {
  fetchMock
    .get(SERVER_ORIGIN)
    .intercept({ path: REPORT_PATH, method: "POST" })
    .reply(status, (opts: { body?: string }) => {
      reports.push(JSON.parse(opts.body ?? "{}") as Record<string, unknown>);
      return body;
    });
}

/** One part as the browser hands it back. */
interface HeldPart {
  partNumber: number;
  etag: string;
}

/**
 * Open an upload and send `partCount` of its parts.
 *
 * What comes back is everything the browser would be holding: the upload id,
 * the token for the next request, and the part list it has to send back to
 * finish. Nothing on the Worker's side remembers any of it.
 * @param partCount - How many parts to send.
 * @param over - Ticket fields to override.
 * @returns What the browser holds after those parts.
 */
async function uploadedThrough(
  partCount: number,
  over: Partial<UploadTicketPayload> = {},
): Promise<{
  storageKey: string;
  uploadId: string;
  token: string;
  parts: HeldPart[];
}> {
  const storageKey = `video/2026-09-05/${seq++}_done.mp4`;
  const ticket = await signUploadTicket(
    {
      storageKey,
      studioId: "studio-1",
      userId: "user-1",
      totalParts: 2,
      partSize: PART_SIZE,
      contentType: "video/mp4",
      expiresAt: Date.now() + 300_000,
      sessionTokenTtlSeconds: 900,
      ...over,
    },
    env.INGEST_SHARED_SECRET,
  );
  let ctx = createExecutionContext();
  const opened = await worker.fetch(
    new Request("https://ingest.example.com/uploads", {
      method: "POST",
      headers: { "x-upload-ticket": ticket },
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const session = await opened.json<{ uploadId: string; token: string }>();

  let token = session.token;
  const parts: HeldPart[] = [];
  const totalParts = over.totalParts ?? 2;
  for (let n = 1; n <= partCount; n += 1) {
    const isFinal = n === totalParts;
    ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(
        `https://ingest.example.com/uploads/${session.uploadId}/parts/${n}`,
        {
          method: "PUT",
          headers: { "x-upload-token": token },
          body: new Uint8Array(isFinal ? FINAL_PART_SIZE : PART_SIZE),
        },
      ),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const landed = await response.json<{
      token: string;
      partNumber: number;
      etag: string;
    }>();
    token = landed.token;
    parts.push({ partNumber: landed.partNumber, etag: landed.etag });
  }
  return { storageKey, uploadId: session.uploadId, token, parts };
}

/**
 * Ask the Worker to finish an upload, handing back the parts.
 * @param uploadId - The multipart upload.
 * @param token - The session token.
 * @param parts - The list the browser holds.
 * @returns The Worker's answer.
 */
async function complete(
  uploadId: string,
  token: string,
  parts: HeldPart[],
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://ingest.example.com/uploads/${uploadId}/complete`, {
      method: "POST",
      headers: { "x-upload-token": token, "content-type": "application/json" },
      body: JSON.stringify({ parts }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("an upload whose parts all arrived", () => {
  it("makes the object readable at the key the ticket named", async () => {
    const { storageKey, uploadId, token, parts } = await uploadedThrough(2);
    expectClaim();
    expectReport();

    const response = await complete(uploadId, token, parts);

    expect(response.status).toBe(200);
    const stored = await env.BUCKET.get(storageKey);
    expect(stored?.size).toBe(PART_SIZE + FINAL_PART_SIZE);
  });

  it("keeps the content type the ticket signed", async () => {
    const { storageKey, uploadId, token, parts } = await uploadedThrough(2);
    expectClaim();
    expectReport();

    await complete(uploadId, token, parts);

    const stored = await env.BUCKET.head(storageKey);
    expect(stored?.httpMetadata?.contentType).toBe("video/mp4");
  });

  it("reports a hash of the stored bytes, not of what was claimed", async () => {
    const { storageKey, uploadId, token, parts } = await uploadedThrough(2);
    expectClaim();
    expectReport();

    await complete(uploadId, token, parts);

    const stored = await env.BUCKET.get(storageKey);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      await stored!.arrayBuffer(),
    );
    const hex = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(reports[0]).toMatchObject({
      storage_key: storageKey,
      outcome: "completed",
      sha256: hex,
      size_bytes: PART_SIZE + FINAL_PART_SIZE,
    });
  });

  it("carries the URL the server registered back to the browser", async () => {
    const { uploadId, token, parts } = await uploadedThrough(2);
    expectClaim();
    expectReport();

    const response = await complete(uploadId, token, parts);

    // Flat, like the other two endpoints: the browser reads `fileUrl` off
    // the answer itself rather than off an envelope inside it.
    expect(await response.json()).toMatchObject({
      fileUrl: "https://cdn.test.example/stored.mp4",
    });
  });
});

describe("the exclusive permission to finish", () => {
  it("asks for it before R2 is told to assemble anything", async () => {
    const { storageKey, uploadId, token, parts } = await uploadedThrough(2);
    expectClaim({ data: { granted: false, reason: "in_flight" } });

    const response = await complete(uploadId, token, parts);

    expect(claims[0]).toEqual({
      storage_key: storageKey,
      upload_id: uploadId,
    });
    // Refused, so the object was never assembled: the key holds nothing.
    expect(await env.BUCKET.head(storageKey)).toBeNull();
    expect(response.status).toBe(409);
  });

  it("refuses when another upload already registered this key", async () => {
    const { storageKey, uploadId, token, parts } = await uploadedThrough(2);
    expectClaim({ data: { granted: false, reason: "already_registered" } });

    const response = await complete(uploadId, token, parts);

    // Only a replay gets this answer: it had to open its own multipart
    // upload, and completing that one would write over the object the ledger
    // describes. This upload's own retry is granted instead, and finishes
    // through the report our server answers out of the ledger.
    expect(await env.BUCKET.head(storageKey)).toBeNull();
    expect(response.status).toBe(409);
  });

  it("finishes again on the same upload id, writing nothing new", async () => {
    const { storageKey, uploadId, token, parts } = await uploadedThrough(2);
    expectClaim(undefined, 2);
    expectReport();
    expectReport();

    const first = await complete(uploadId, token, parts);
    const stored = await env.BUCKET.head(storageKey);

    // The browser did not hear that answer, so it asks again with the upload
    // id it still holds. R2 refuses a second complete on that id, and
    // `assembleObject` reads the size off the object already standing there —
    // so this delivery finishes without writing a byte, and our server
    // answers the repeated report out of the ledger.
    const second = await complete(uploadId, token, parts);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await env.BUCKET.head(storageKey))?.uploaded).toEqual(
      stored?.uploaded,
    );
    expect(reports).toHaveLength(2);
    expect(reports[1]).toMatchObject({
      storage_key: storageKey,
      outcome: "completed",
      size_bytes: PART_SIZE + FINAL_PART_SIZE,
    });
  });

  it("refuses when there is no grant for this key", async () => {
    const { uploadId, token, parts } = await uploadedThrough(2);
    expectClaim({ data: { granted: false, reason: "no_grant" } });

    expect((await complete(uploadId, token, parts)).status).toBe(403);
  });
});

describe("an upload missing parts", () => {
  it("refuses before it asks for anything, and says what is owed", async () => {
    const { storageKey, uploadId, token, parts } = await uploadedThrough(1);

    // No interceptors are set: reaching either server URL would throw, which
    // is the assertion that a short list costs nothing.
    const response = await complete(uploadId, token, parts);

    expect(response.status).toBe(409);
    expect(await response.text()).toContain("1 of 2");
    expect(await env.BUCKET.head(storageKey)).toBeNull();
  });

  it("still finishes once the missing part is sent", async () => {
    // The refusal leaves the upload usable, which is what makes it a refusal
    // rather than an outcome.
    const { storageKey, uploadId, token, parts } = await uploadedThrough(2);
    await complete(uploadId, token, parts.slice(0, 1));

    expectClaim();
    expectReport();
    const response = await complete(uploadId, token, parts);

    expect(response.status).toBe(200);
    expect((await env.BUCKET.head(storageKey))?.size).toBe(
      PART_SIZE + FINAL_PART_SIZE,
    );
  });

  it("refuses a part the layout never signed", async () => {
    const { uploadId, token, parts } = await uploadedThrough(2);
    const forged = [...parts, { partNumber: 3, etag: "made-up" }];

    const response = await complete(uploadId, token, forged);

    expect(response.status).toBe(400);
  });

  it("refuses a list that names one part twice", async () => {
    const { storageKey, uploadId, token, parts } = await uploadedThrough(2);
    // Two entries, two parts expected — so counting alone says this list is
    // complete while part 2 was never sent at all.
    const duplicated = [parts[0]!, parts[0]!];

    // No interceptors: reaching either server URL would throw, which is the
    // assertion that this is refused before anything is asked or written.
    const response = await complete(uploadId, token, duplicated);

    expect(response.status).toBe(400);
    expect(await env.BUCKET.head(storageKey)).toBeNull();
  });
});

describe("a server that does not accept the report", () => {
  it("answers with a failure of its own", async () => {
    const { uploadId, token, parts } = await uploadedThrough(2);
    expectClaim();
    expectReport(503, "");

    const response = await complete(uploadId, token, parts);

    // The bytes are in R2 but nothing describes them, so this delivery did not
    // finish. Retrying is the browser's to do (design §6.6).
    expect(response.status).toBe(502);
  });
});

describe("what an operator has to go on when a step fails", () => {
  // Every one of these turns an exception or a refusal into an answer for the
  // browser, which is what the person uploading needs. The reason it happened
  // exists only inside this Worker, so if it is not written here nobody can
  // tell a wrong URL from a refused claim from R2 turning the assembly down.
  it("writes down a report the server would not take", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { uploadId, token, parts } = await uploadedThrough(2);
    expectClaim();
    expectReport(503, "");

    await complete(uploadId, token, parts);

    expect(logged).toHaveBeenCalledWith(
      "ingest_report_refused",
      expect.objectContaining({ status: 503 }),
    );
    logged.mockRestore();
  });

  it("writes down a claim the server would not answer", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { uploadId, token, parts } = await uploadedThrough(2);
    fetchMock
      .get(SERVER_ORIGIN)
      .intercept({ path: CLAIM_PATH, method: "POST" })
      .reply(500, "");

    await complete(uploadId, token, parts);

    expect(logged).toHaveBeenCalledWith(
      "ingest_claim_refused",
      expect.objectContaining({ status: 500 }),
    );
    logged.mockRestore();
  });
});

describe("what an operator has to go on when a step throws", () => {
  it("writes down a claim it could not send at all", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { uploadId, token, parts } = await uploadedThrough(2);
    // No interceptor for the claim, so the fetch itself throws under
    // `disableNetConnect` — the same shape a wrong SERVER_CLAIM_URL has.

    const response = await complete(uploadId, token, parts);

    expect(response.status).toBe(502);
    expect(logged).toHaveBeenCalledWith(
      "ingest_claim_unreachable",
      expect.objectContaining({ storageKey: expect.any(String), err: expect.any(String) }),
    );
    logged.mockRestore();
  });
});
