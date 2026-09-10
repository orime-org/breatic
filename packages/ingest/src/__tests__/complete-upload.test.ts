// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Finishing an upload (#186, design §6.2; #206, design §3).
 *
 * The Worker keeps nothing between requests, so the list of parts comes back
 * from whoever is uploading. It judges that list against the layout its own
 * token signed, has R2 assemble the object, and answers with three
 * measurements over what landed: the hash the ledger keys on, the size it
 * charges for, and the type a reader will be served.
 *
 * It reaches nothing to do that. The permission to finish this key is taken by
 * the caller before it asks, and the caller is what records the outcome — so
 * every refusal here is one the Worker can decide on its own, out of the
 * signature it verified and the bytes it can see.
 *
 * The hash is computed over the stored object rather than over what the
 * browser said. The ledger keys on it, and only bytes that actually landed
 * name what is actually there.
 */

import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { signUploadTicket, type UploadTicketPayload } from "@breatic/shared";
import worker from "@ingest/index.js";

const PART_SIZE = 5 * 1024 * 1024;
const FINAL_PART_SIZE = 1024;

let seq = 0;

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
 * @param secret - The shared secret, or null to send none.
 * @returns The Worker's answer.
 */
async function complete(
  uploadId: string,
  token: string,
  parts: HeldPart[],
  secret: string | null = env.INGEST_SHARED_SECRET,
): Promise<Response> {
  const headers = new Headers({
    "x-upload-token": token,
    "content-type": "application/json",
  });
  if (secret !== null) headers.set("x-ingest-secret", secret);
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://ingest.example.com/uploads/${uploadId}/complete`, {
      method: "POST",
      headers,
      body: JSON.stringify({ parts }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

/** SHA-256 of what is stored at `storageKey`, as lowercase hex. */
async function storedHash(storageKey: string): Promise<string> {
  const stored = await env.BUCKET.get(storageKey);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await stored!.arrayBuffer(),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// The permission that stops a replayed ticket used to be taken here, inside
// the Worker, before R2 was touched. It now belongs to whoever drives the
// finish, and a session token is something the browser holds — every part's
// answer hands it one. So the only thing separating "our server is finishing
// this" from "a page is finishing this behind our back" is a secret the
// browser never sees.
//
// What the browser could otherwise do is measured and written down in
// upload-grant.repo.ts: opening a second upload on a key already registered
// and completing it overwrites the object, while the ledger row still names
// the hash of the bytes that were there before.
describe("who may finish an upload", () => {
  it("refuses a caller who holds a valid token but no shared secret", async () => {
    const held = await uploadedThrough(2);

    const response = await complete(held.uploadId, held.token, held.parts, null);

    expect(response.status).toBe(401);
  });

  it("refuses a caller whose secret does not match", async () => {
    const held = await uploadedThrough(2);

    const response = await complete(
      held.uploadId,
      held.token,
      held.parts,
      "not-the-secret",
    );

    expect(response.status).toBe(401);
  });
});

describe("an upload whose parts all arrived", () => {
  it("makes the object readable at the key the ticket named", async () => {
    const { storageKey, uploadId, token, parts } = await uploadedThrough(2);

    const response = await complete(uploadId, token, parts);

    expect(response.status).toBe(200);
    const stored = await env.BUCKET.get(storageKey);
    expect(stored?.size).toBe(PART_SIZE + FINAL_PART_SIZE);
  });

  it("keeps the content type the ticket signed", async () => {
    const { storageKey, uploadId, token, parts } = await uploadedThrough(2);

    await complete(uploadId, token, parts);

    const stored = await env.BUCKET.head(storageKey);
    expect(stored?.httpMetadata?.contentType).toBe("video/mp4");
  });

  it("answers with a hash of the stored bytes, not of what was claimed", async () => {
    const { storageKey, uploadId, token, parts } = await uploadedThrough(2);

    const response = await complete(uploadId, token, parts);

    expect(await response.json()).toEqual({
      sha256: await storedHash(storageKey),
      sizeBytes: PART_SIZE + FINAL_PART_SIZE,
      contentType: "video/mp4",
    });
  });

  // Flat, like the other two endpoints, and holding only what this Worker
  // measured. Anything about the ledger row belongs to the caller that writes
  // it, and the Worker has no way to know it.
  it("answers with nothing beyond the three measurements", async () => {
    const { uploadId, token, parts } = await uploadedThrough(2);

    const response = await complete(uploadId, token, parts);

    expect(Object.keys(await response.json<Record<string, unknown>>()).sort()).toEqual([
      "contentType",
      "sha256",
      "sizeBytes",
    ]);
  });
});

describe("an upload missing parts", () => {
  it("refuses and says what is owed, writing nothing", async () => {
    const { storageKey, uploadId, token, parts } = await uploadedThrough(1);

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

    const response = await complete(uploadId, token, duplicated);

    expect(response.status).toBe(400);
    expect(await env.BUCKET.head(storageKey)).toBeNull();
  });
});
