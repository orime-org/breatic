// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `PUT /uploads/{uploadId}/parts/{n}` — one part's bytes (#173, design §4.2).
 *
 * The layout is decided before a byte moves: the ticket said how many parts
 * there would be and how long each is, and both travelled under the HMAC. So
 * the Worker can judge a part on its own, without asking anything, and refuse
 * one that does not fit the layout the server signed.
 *
 * Only the last part may be short. Every earlier one must be exactly
 * `partSize`, because that is what makes "have all the parts arrived?" a
 * question about counting rather than about summing lengths — and R2 rejects a
 * non-final part under 5 MiB anyway.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { signUploadTicket, type UploadTicketPayload } from "@breatic/shared";
import worker from "@ingest/index.js";
import { signSessionToken } from "@ingest/session-token.js";

const PART_SIZE = 5 * 1024 * 1024;

let seq = 0;

/** Open an upload the way the browser does, and keep what it needs next. */
async function openUpload(
  over: Partial<UploadTicketPayload> = {},
): Promise<{ storageKey: string; uploadId: string; token: string }> {
  const storageKey = `video/2026-08-30/${seq++}_part.mp4`;
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
      sessionTokenTtlSeconds: 900,
      ...over,
    },
    env.INGEST_SHARED_SECRET,
  );
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request("https://ingest.example.com/uploads", {
      method: "POST",
      headers: { "x-upload-ticket": ticket },
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  const body = await response.json<{ uploadId: string; token: string }>();
  return { storageKey, uploadId: body.uploadId, token: body.token };
}

/** Send one part. */
async function sendPart(
  uploadId: string,
  partNumber: number,
  bytes: Uint8Array,
  token: string | null,
): Promise<Response> {
  const headers = new Headers();
  if (token !== null) headers.set("x-upload-token", token);
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(
      `https://ingest.example.com/uploads/${uploadId}/parts/${partNumber}`,
      { method: "PUT", headers, body: bytes },
    ),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

/** `length` bytes of nothing in particular. */
function bytes(length: number): Uint8Array {
  return new Uint8Array(length);
}

describe("a part the Worker will not take", () => {
  it("refuses one with no token", async () => {
    const { uploadId } = await openUpload();

    expect((await sendPart(uploadId, 1, bytes(PART_SIZE), null)).status).toBe(401);
  });

  it("refuses one whose token does not verify", async () => {
    const { uploadId } = await openUpload();

    expect(
      (await sendPart(uploadId, 1, bytes(PART_SIZE), "forged.token")).status,
    ).toBe(401);
  });

  it("refuses one whose token has expired", async () => {
    const { storageKey, uploadId } = await openUpload();
    const stale = await signSessionToken(
      { storageKey, uploadId, expiresAt: Date.now() - 1 },
      env.INGEST_SHARED_SECRET,
    );

    expect((await sendPart(uploadId, 1, bytes(PART_SIZE), stale)).status).toBe(401);
  });

  // A token names the upload it may write into. Without this check it would
  // name nothing in particular, and one upload's token would write into
  // another's — which is the whole reason the upload id is inside the
  // signature rather than only in the path.
  it("refuses a token issued for a different upload", async () => {
    const a = await openUpload();
    const b = await openUpload();

    expect((await sendPart(b.uploadId, 1, bytes(PART_SIZE), a.token)).status).toBe(
      401,
    );
  });

  it("refuses a part number past the layout the ticket signed", async () => {
    const { uploadId, token } = await openUpload();

    expect((await sendPart(uploadId, 3, bytes(PART_SIZE), token)).status).toBe(400);
  });

  it("refuses a part number below one", async () => {
    const { uploadId, token } = await openUpload();

    expect((await sendPart(uploadId, 0, bytes(PART_SIZE), token)).status).toBe(400);
  });

  it("refuses a non-final part that is not exactly one part long", async () => {
    const { uploadId, token } = await openUpload();

    expect((await sendPart(uploadId, 1, bytes(PART_SIZE - 1), token)).status).toBe(
      400,
    );
  });

  it("refuses any part longer than one part", async () => {
    const { uploadId, token } = await openUpload();

    expect((await sendPart(uploadId, 2, bytes(PART_SIZE + 1), token)).status).toBe(
      400,
    );
  });
});

describe("a part the Worker takes", () => {
  it("accepts a full-length non-final part", async () => {
    const { uploadId, token } = await openUpload();

    expect((await sendPart(uploadId, 1, bytes(PART_SIZE), token)).status).toBe(200);
  });

  // Only the last part may be short — the file rarely divides evenly.
  it("accepts a short final part", async () => {
    const { uploadId, token } = await openUpload();

    expect((await sendPart(uploadId, 2, bytes(1024), token)).status).toBe(200);
  });

  // Re-issued with every part so its lifetime need only cover the gap between
  // two parts. The one just used stays valid until it expires; nothing here
  // revokes it, and the narrow scope is what makes that acceptable.
  it("hands back a fresh token for the next part", async () => {
    const { uploadId, token } = await openUpload();

    const response = await sendPart(uploadId, 1, bytes(PART_SIZE), token);
    const next = await response.json<{ token: string }>();

    expect(next.token).toBeTruthy();
    expect((await sendPart(uploadId, 2, bytes(1024), next.token)).status).toBe(200);
  });
});
