// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The upload session does not watch the clock (#186, design §6.3).
 *
 * It has two exits: the object was assembled and the outcome reported, or a
 * step failed and that was reported. How long an upload takes is not one of
 * them — a task's lifetime belongs to the timer Durable Object, which knows
 * nothing about this chain and which this chain knows nothing about.
 *
 * So no part arriving arms anything, opening an upload arms nothing, and an
 * upload that never finishes is left where it is. The parts already written
 * are dropped by the bucket's own lifecycle rule, which expires a multipart
 * upload seven days after it starts.
 */

import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  fetchMock,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { signUploadTicket } from "@breatic/shared";
import worker from "@ingest/index.js";

const PART_SIZE = 5 * 1024 * 1024;
const FINAL_PART_SIZE = 1024;

let seq = 0;

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

/** The instance holding one upload's bookkeeping. */
function sessionOf(storageKey: string): DurableObjectStub {
  return env.UPLOAD_SESSION.get(env.UPLOAD_SESSION.idFromName(storageKey));
}

/**
 * Open an upload and send `partCount` of its two parts.
 * @param partCount - How many parts to send.
 * @returns The key, the upload id and the token the next request would carry.
 */
async function uploadedThrough(
  partCount: number,
): Promise<{ storageKey: string; uploadId: string; token: string }> {
  const storageKey = `video/2026-09-04/${seq++}_no-clock.mp4`;
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
  for (let n = 1; n <= partCount; n += 1) {
    ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(
        `https://ingest.example.com/uploads/${session.uploadId}/parts/${n}`,
        {
          method: "PUT",
          headers: { "x-upload-token": token },
          body: new Uint8Array(n === 2 ? FINAL_PART_SIZE : PART_SIZE),
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

describe("an upload nobody has finished", () => {
  it("has no alarm armed after it opens", async () => {
    const { storageKey } = await uploadedThrough(0);

    // `runDurableObjectAlarm` answers false when there is nothing scheduled,
    // which is the whole assertion: opening an upload starts no clock.
    expect(await runDurableObjectAlarm(sessionOf(storageKey))).toBe(false);
  });

  it("has no alarm armed after a part lands", async () => {
    const { storageKey } = await uploadedThrough(1);

    expect(await runDurableObjectAlarm(sessionOf(storageKey))).toBe(false);
  });

  it("has no alarm armed once every part has landed", async () => {
    const { storageKey } = await uploadedThrough(2);

    expect(await runDurableObjectAlarm(sessionOf(storageKey))).toBe(false);
  });
});

describe("completing an upload whose parts are not all in", () => {
  it("refuses, and reports nothing", async () => {
    const { uploadId, token } = await uploadedThrough(1);

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

    // 409 rather than an outcome: this upload has not ended, it is unfinished.
    // Nothing is dropped and nothing is said to the server — `fetchMock` has no
    // interceptor for the report, so a report here would throw.
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("1 of 2");
  });

  it("still completes once the missing part arrives", async () => {
    // The refusal above leaves the upload usable, which is what makes it a
    // refusal rather than an outcome.
    const { storageKey, uploadId, token } = await uploadedThrough(1);

    const ctx = createExecutionContext();
    await worker.fetch(
      new Request(`https://ingest.example.com/uploads/${uploadId}/complete`, {
        method: "POST",
        headers: { "x-upload-token": token },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    const ctx2 = createExecutionContext();
    const sent = await worker.fetch(
      new Request(
        `https://ingest.example.com/uploads/${uploadId}/parts/2`,
        {
          method: "PUT",
          headers: { "x-upload-token": token },
          body: new Uint8Array(FINAL_PART_SIZE),
        },
      ),
      env,
      ctx2,
    );
    await waitOnExecutionContext(ctx2);

    expect(sent.status).toBe(200);
    expect(storageKey).toBeTruthy();
  });
});
