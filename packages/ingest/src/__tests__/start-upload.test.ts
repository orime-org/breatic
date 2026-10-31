// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `POST /uploads` — opening one upload (#173, design §4.2; inner#1595).
 *
 * Only our own services open an upload: the request carries the shared secret
 * next to the ticket, and the browser is handed the upload id and the first
 * token. A request without the right secret is refused before R2 is touched,
 * whatever ticket it carries. With the secret, the ticket still has to verify:
 * it carries the key, the part layout and the size ceiling under one HMAC, so
 * the checks are against values nobody downstream can alter.
 *
 * How many uploads one ticket opens is decided by our server, which opens each
 * exactly once; the Worker does not remember tickets and opens a fresh upload
 * every time it is asked.
 */

import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { verifySessionToken } from "@breatic/shared";
import { ask, counted, mint, openForTest } from "./helpers/open-upload.js";

const SECRET_W = env.INGEST_SHARED_SECRET;

/** The secret with its last character changed: same length, wrong value. */
const SAME_LENGTH_WRONG = `${SECRET_W.slice(0, -1)}${SECRET_W.endsWith("x") ? "y" : "x"}`;

/**
 * Ask the Worker to open an upload as our server does.
 * @param ticket - The ticket, or null to send none.
 * @param e - The bindings the Worker runs with.
 * @returns What it answered.
 */
async function open(ticket: string | null, e = env): ReturnType<typeof ask> {
  const headers: Record<string, string> = { "x-ingest-secret": SECRET_W };
  if (ticket !== null) headers["x-upload-ticket"] = ticket;
  return ask(headers, e);
}

describe("the counting bucket", () => {
  it("T00: counts the real call and forwards it to the real bucket", async () => {
    const bucket = counted();
    const { ticket, storageKey } = await mint();

    const answer = await ask({ "x-ingest-secret": SECRET_W, "x-upload-ticket": ticket }, bucket.env);

    expect(answer.status).toBe(200);
    expect(bucket.opens[storageKey]).toBe(1);
    const upload = env.BUCKET.resumeMultipartUpload(storageKey, answer.uploadId ?? "");
    await expect(upload.uploadPart(1, new Uint8Array(1024))).resolves.toMatchObject({
      partNumber: 1,
      etag: expect.any(String),
    });
  });
});

describe("a request without our secret", () => {
  it("T01: is refused and opens nothing, even with a valid ticket", async () => {
    const bucket = counted();
    const { ticket } = await mint();

    const answer = await ask({ "x-upload-ticket": ticket }, bucket.env);

    expect(answer.status).toBe(401);
    expect(bucket.opens).toEqual({});
  });

  it.each([
    ["(a) same length, last character different", SAME_LENGTH_WRONG],
    ["(b) one character longer", `${SECRET_W}x`],
    ["(c) present but empty", ""],
  ])("T02: is refused with a wrong secret %s", async (_name, secret) => {
    const bucket = counted();
    const { ticket } = await mint();

    const answer = await ask({ "x-ingest-secret": secret, "x-upload-ticket": ticket }, bucket.env);

    expect(answer.status).toBe(401);
    expect(bucket.opens).toEqual({});
  });

  it.each([
    ["no secret", {}],
    ["a wrong secret", { "x-ingest-secret": SAME_LENGTH_WRONG }],
    ["an empty secret", { "x-ingest-secret": "" }],
  ])("T07: with %s never reaches the bucket at all", async (_name, secretHeader) => {
    const bucket = counted();
    const { ticket } = await mint();

    const answer = await ask({ ...secretHeader, "x-upload-ticket": ticket }, bucket.env);

    expect(answer.status).toBe(401);
    expect(bucket.calls).toEqual([]);
  });
});

// With the right secret, so a 401 here is the ticket check and not the secret
// check.
describe("a ticket the Worker will not take", () => {
  it("T03: refuses our secret carrying no ticket", async () => {
    const bucket = counted();

    expect((await open(null, bucket.env)).status).toBe(401);
    expect(bucket.opens).toEqual({});
  });

  it("T04(a): refuses one whose signature does not match", async () => {
    const bucket = counted();
    const { ticket } = await mint();
    const [body] = ticket.split(".");

    expect((await open(`${body}.dGFtcGVyZWQ=`, bucket.env)).status).toBe(401);
    expect(bucket.opens).toEqual({});
  });

  it("T04(b): refuses one that is not even shaped like a ticket", async () => {
    const bucket = counted();

    expect((await open("not-a-ticket", bucket.env)).status).toBe(401);
    expect(bucket.opens).toEqual({});
  });

  it("T04(c): refuses one whose window has closed", async () => {
    const bucket = counted();
    const { ticket } = await mint({ expiresAt: Date.now() - 1 });

    expect((await open(ticket, bucket.env)).status).toBe(401);
    expect(bucket.opens).toEqual({});
  });
});

describe("a ticket the Worker takes", () => {
  it("T05: opens the upload and hands back a token for exactly that upload", async () => {
    const bucket = counted();
    const deadlineAt = Date.now() + 7_200_000;
    const { ticket, storageKey } = await mint({
      totalParts: 7,
      partSize: 6 * 1024 * 1024,
      deadlineAt,
    });

    const answer = await open(ticket, bucket.env);

    expect(answer.status).toBe(200);
    expect(answer.uploadId).toBeTruthy();
    expect(answer.token).toBeTruthy();
    const payload = await verifySessionToken(answer.token ?? "", SECRET_W, Date.now());
    expect(payload?.storageKey).toBe(storageKey);
    expect(payload?.uploadId).toBe(answer.uploadId);
    expect(payload?.expiresAt).toBe(deadlineAt);
    expect(payload?.totalParts).toBe(7);
    expect(payload?.partSize).toBe(6 * 1024 * 1024);
    expect(bucket.opens[storageKey]).toBe(1);
  });

  // Nothing on this side remembers an upload, so a ticket presented twice
  // opens twice. Our server presents each ticket once (inner#1595); this pins
  // that the Worker itself does not deduplicate, so that guarantee lives on
  // the server and is tested there.
  it("T06: opens a fresh upload each time the same ticket is presented", async () => {
    const bucket = counted();
    const { ticket, storageKey } = await mint();

    const first = await open(ticket, bucket.env);
    const second = await open(ticket, bucket.env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.uploadId).not.toBe(first.uploadId);
    expect(bucket.opens[storageKey]).toBe(2);
  });

  // The key's extension comes from the picked file's name, and our server
  // deliberately admits Unicode there — a file called 截图 has no dot to split
  // on, so the whole name becomes the extension. Everything this Worker signs
  // into a session token therefore has to survive being encoded.
  it("T05: opens an upload whose key carries characters outside latin1", async () => {
    const { ticket } = await mint({
      storageKey: `image/2026-08-31/${crypto.randomUUID()}_shot.截图`,
    });

    const answer = await open(ticket);

    expect(answer.status).toBe(200);
    expect(answer.token).toEqual(expect.any(String));
  });

  // The token lives as long as the upload's task does (inner#1367): the
  // instant comes off the ticket, so the one place it is decided is the task
  // our server opened the ticket for.
  it("ends the session token at the deadline the ticket signed", async () => {
    const deadlineAt = Date.now() + 7_200_000;
    const { ticket } = await mint({ deadlineAt });

    const { token } = await open(ticket);

    const payload = await verifySessionToken(token ?? "", SECRET_W, Date.now());
    expect(payload?.expiresAt).toBe(deadlineAt);
  });

  // The layout bounds what this upload may put into R2, and only the Worker
  // is in front of the bytes. Signed in so the Worker can hold that bound
  // without asking anything, and without anyone downstream able to widen it.
  it("carries the layout the ticket signed", async () => {
    const { ticket } = await mint({
      totalParts: 7,
      partSize: 6 * 1024 * 1024,
    });

    const { token } = await open(ticket);

    const payload = await verifySessionToken(token ?? "", SECRET_W, Date.now());
    expect(payload?.totalParts).toBe(7);
    expect(payload?.partSize).toBe(6 * 1024 * 1024);
  });

  it("keeps two different uploads apart", async () => {
    const a = await mint();
    const b = await mint();

    const first = await open(a.ticket);
    const second = await open(b.ticket);

    expect(second.uploadId).not.toBe(first.uploadId);
  });
});

describe("the shared test helper that opens an upload", () => {
  it("T15: opens a real upload with our secret", async () => {
    const bucket = counted();
    const { ticket, storageKey } = await mint();

    const { uploadId, token } = await openForTest(ticket, bucket.env);

    expect(uploadId).toBeTruthy();
    expect(token).toBeTruthy();
    const payload = await verifySessionToken(token, SECRET_W, Date.now());
    expect(payload?.uploadId).toBe(uploadId);
    expect(bucket.opens[storageKey]).toBe(1);
  });
});
