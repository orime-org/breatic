// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Finishing an upload (#173, design §4.4).
 *
 * The browser asking and the alarm going off do the same thing: count the
 * parts. All of them means the file is whole — complete it, hash what is
 * stored, report it. Fewer means it never finished, and R2 is told to drop
 * what was written.
 *
 * The report is the only thing that ends this. Until the server answers 2xx
 * the alarm stays set, because the node the upload belongs to sits in handling
 * until something tells it otherwise, and nothing else will.
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
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { signUploadTicket, type UploadTicketPayload } from "@breatic/shared";
import worker from "@ingest/index.js";

const PART_SIZE = 5 * 1024 * 1024;
const REPORT_ORIGIN = "http://localhost:3000";
const REPORT_PATH = "/api/v1/assets/ingest-report";

let seq = 0;

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

beforeEach(() => {
  reports.length = 0;
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

/** Every report body the Worker sent, in order. */
const reports: Record<string, unknown>[] = [];

/**
 * Expect one report and answer it with `status`.
 * @param status - What our server answers.
 */
function expectReport(status = 200): void {
  fetchMock
    .get(REPORT_ORIGIN)
    .intercept({ path: REPORT_PATH, method: "POST" })
    .reply(status, (opts: { body?: string }) => {
      reports.push(JSON.parse(opts.body ?? "{}") as Record<string, unknown>);
      return "";
    });
}

/** Open an upload and send `partCount` of its parts. */
async function uploadedThrough(
  partCount: number,
  over: Partial<UploadTicketPayload> = {},
): Promise<{ storageKey: string; uploadId: string; token: string }> {
  const storageKey = `video/2026-08-30/${seq++}_done.mp4`;
  const ticket = await signUploadTicket(
    {
      storageKey,
      studioId: "studio-1",
      userId: "user-1",
      totalParts: 2,
      partSize: PART_SIZE,
      maxBytes: 2 * 1024 * 1024 * 1024,
      contentType: "video/mp4",
      expiresAt: Date.now() + 300_000,
      leaseGen: 7,
      alarmIdleSeconds: 300,
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
          body: new Uint8Array(isFinal ? 1024 : PART_SIZE),
        },
      ),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    token = (await response.json<{ token: string }>()).token;
  }
  return { storageKey, uploadId: session.uploadId, token };
}

/** Ask the Worker to finish an upload. */
async function complete(uploadId: string, token: string): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://ingest.example.com/uploads/${uploadId}/complete`, {
      method: "POST",
      headers: { "x-upload-token": token },
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("an upload whose parts all arrived", () => {
  it("makes the object readable at the key the ticket named", async () => {
    expectReport();
    const { storageKey, uploadId, token } = await uploadedThrough(2);

    expect((await complete(uploadId, token)).status).toBe(200);

    const stored = await env.BUCKET.get(storageKey);
    expect(stored).not.toBeNull();
    expect(stored?.size).toBe(PART_SIZE + 1024);
  });

  it("keeps the content type the ticket signed", async () => {
    expectReport();
    const { storageKey, uploadId, token } = await uploadedThrough(2);

    await complete(uploadId, token);

    const stored = await env.BUCKET.get(storageKey);
    expect(stored?.httpMetadata?.contentType).toBe("video/mp4");
  });

  // The browser's claim opened the upload; this is what the ledger keys on,
  // and it can only come from the bytes that actually landed.
  it("reports a hash of the stored bytes, not of what was claimed", async () => {
    expectReport();
    const { storageKey, uploadId, token } = await uploadedThrough(2);

    await complete(uploadId, token);

    const stored = await env.BUCKET.get(storageKey);
    const expected = await crypto.subtle.digest(
      "SHA-256",
      await stored!.arrayBuffer(),
    );
    const hex = [...new Uint8Array(expected)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(reports[0]).toMatchObject({
      storage_key: storageKey,
      outcome: "completed",
      sha256: hex,
      size_bytes: PART_SIZE + 1024,
      content_type: "video/mp4",
      lease_gen: 7,
    });
  });
});

describe("an upload missing parts", () => {
  it("leaves no object behind and reports that it never finished", async () => {
    expectReport();
    const { storageKey, uploadId, token } = await uploadedThrough(1);

    expect((await complete(uploadId, token)).status).toBe(200);

    expect(await env.BUCKET.get(storageKey)).toBeNull();
    expect(reports[0]).toMatchObject({
      storage_key: storageKey,
      outcome: "aborted",
      lease_gen: 7,
    });
  });
});

describe("a server that does not accept the report", () => {
  // The node stays in handling until this report lands, so a failure here has
  // to keep the retry alive rather than let the Worker call it done.
  it("answers with a failure of its own", async () => {
    expectReport(503);
    const { uploadId, token } = await uploadedThrough(2);

    expect((await complete(uploadId, token)).status).toBe(502);
  });

  // The object is complete either way; what has not happened is the telling.
  it("finishes on the retry without redoing the work", async () => {
    expectReport(503);
    const { storageKey, uploadId, token } = await uploadedThrough(2);
    await complete(uploadId, token);

    expectReport(200);
    expect((await complete(uploadId, token)).status).toBe(200);

    expect(reports).toHaveLength(2);
    expect(reports[1]).toMatchObject({ storage_key: storageKey, outcome: "completed" });
  });
});

describe("an upload already reported", () => {
  it("says so again without touching R2 or the server", async () => {
    expectReport();
    const { uploadId, token } = await uploadedThrough(2);
    await complete(uploadId, token);

    expect((await complete(uploadId, token)).status).toBe(200);
    expect(reports).toHaveLength(1);
  });
});
