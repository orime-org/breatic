// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `POST /uploads` — opening one upload (#173, design §4.2).
 *
 * The Worker knows nothing about who is asking beyond what our server signed.
 * A ticket carries the key, the part layout and the size ceiling under one
 * HMAC, so the checks here are against values the browser cannot alter, and a
 * ticket that does not verify is refused without any lookup at all.
 *
 * Opening twice with the same ticket has to give back the same upload. The
 * browser retries — its own transport layer does, on 5xx and on a dropped
 * connection — and a second `createMultipartUpload` would strand the first,
 * leaving parts written into an upload nobody ever completes.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { signUploadTicket, type UploadTicketPayload } from "@breatic/shared";
import worker from "@ingest/index.js";

let seq = 0;

/** A ticket the way our server mints one, over a key nothing else uses. */
async function mintTicket(
  over: Partial<UploadTicketPayload> = {},
): Promise<{ ticket: string; storageKey: string }> {
  const storageKey = `video/2026-08-30/${seq++}_clip.mp4`;
  const ticket = await signUploadTicket(
    {
      storageKey,
      studioId: "studio-1",
      userId: "user-1",
      totalParts: 2,
      partSize: 5 * 1024 * 1024,
      maxBytes: 2 * 1024 * 1024 * 1024,
      contentType: "video/mp4",
      expiresAt: Date.now() + 300_000,
      leaseGen: 7,
      alarmIdleSeconds: 300,
      ...over,
    },
    env.INGEST_SHARED_SECRET,
  );
  return { ticket, storageKey };
}

/** Ask the Worker to open an upload. */
async function open(ticket: string | null): Promise<Response> {
  const headers = new Headers();
  if (ticket !== null) headers.set("x-upload-ticket", ticket);
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request("https://ingest.example.com/uploads", { method: "POST", headers }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe("a ticket the Worker will not take", () => {
  it("refuses a request carrying none", async () => {
    expect((await open(null)).status).toBe(401);
  });

  it("refuses one whose signature does not match", async () => {
    const { ticket } = await mintTicket();
    const [body] = ticket.split(".");

    expect((await open(`${body}.dGFtcGVyZWQ=`)).status).toBe(401);
  });

  it("refuses one that is not even shaped like a ticket", async () => {
    expect((await open("not-a-ticket")).status).toBe(401);
  });

  it("refuses one whose window has closed", async () => {
    const { ticket } = await mintTicket({ expiresAt: Date.now() - 1 });

    expect((await open(ticket)).status).toBe(401);
  });
});

describe("a ticket the Worker takes", () => {
  it("opens the upload and hands back a token for the parts", async () => {
    const { ticket } = await mintTicket();

    const response = await open(ticket);

    expect(response.status).toBe(200);
    const body = await response.json<{ uploadId: string; token: string }>();
    expect(body.uploadId).toBeTruthy();
    expect(body.token).toBeTruthy();
  });

  // The browser's own retry sends this again on a 5xx or a dropped connection.
  // A second createMultipartUpload would strand the first: parts already
  // written would belong to an upload that never completes, and the object
  // they were meant for would never appear.
  it("gives the same upload back when the same ticket opens it again", async () => {
    const { ticket } = await mintTicket();

    const first = await (await open(ticket)).json<{ uploadId: string }>();
    const second = await (await open(ticket)).json<{ uploadId: string }>();

    expect(second.uploadId).toBe(first.uploadId);
  });

  // The key's extension comes from the picked file's name, and our server
  // deliberately admits Unicode there — a file called 截图 has no dot to split
  // on, so the whole name becomes the extension. Everything this Worker signs
  // into a session token therefore has to survive being encoded.
  it("opens an upload whose key carries characters outside latin1", async () => {
    const { ticket } = await mintTicket({
      storageKey: `image/2026-08-31/${seq++}_shot.截图`,
    });

    const response = await open(ticket);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      token: expect.any(String),
    });
  });

  it("keeps two different uploads apart", async () => {
    const a = await mintTicket();
    const b = await mintTicket();

    const first = await (await open(a.ticket)).json<{ uploadId: string }>();
    const second = await (await open(b.ticket)).json<{ uploadId: string }>();

    expect(second.uploadId).not.toBe(first.uploadId);
  });
});
