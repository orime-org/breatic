// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The upload session does not judge an upload by how long it takes
 * (#186, design §6.3).
 *
 * It has two exits: the object was assembled and the outcome reported, or a
 * step failed and that was reported. How long the upload took is not one of
 * them — a task's lifetime belongs to the timer Durable Object, which knows
 * nothing about this chain and which this chain knows nothing about. So no
 * part is refused for arriving late and no upload is failed for being slow.
 *
 * The one thing time decides is when this instance stops holding what it
 * knows. An upload nobody finishes never reaches the step that would let the
 * instance go, and a Durable Object's storage is billed until something
 * deletes it, so opening one sets the horizon its ticket signed — twice the
 * task budget, by which point the task it belongs to has long been judged
 * dead and nothing about this upload can matter any more.
 */

import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  fetchMock,
  runInDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { signUploadTicket } from "@breatic/shared";
import worker from "@ingest/index.js";

const PART_SIZE = 5 * 1024 * 1024;
const FINAL_PART_SIZE = 1024;
/** What these tickets sign: twice the two-hour task budget, in seconds. */
const BOOKKEEPING_TTL = 4 * 60 * 60;
/** The two halves of `SERVER_REPORT_URL` as vitest.config.ts binds it. */
const REPORT_ORIGIN = "https://api.test.example";
const REPORT_PATH = "/api/v1/assets/ingest-report";

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
 * Move one upload's horizon into the past.
 *
 * The horizon is hours away, and what these cases are about is the rule the
 * handler applies when it arrives — not the wait. Writing the moment rather
 * than waiting for it keeps that rule the only thing under test.
 * @param storageKey - The upload to age.
 */
async function passHorizon(storageKey: string): Promise<void> {
  await runInDurableObject(sessionOf(storageKey), (_i, state) =>
    state.storage.put("deleteAfter", Date.now() - 1),
  );
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
      bookkeepingTtlSeconds: BOOKKEEPING_TTL,
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
  it("sets the horizon the ticket signed when it opens", async () => {
    const before = Date.now();
    const { storageKey } = await uploadedThrough(0);

    const armed = await runInDurableObject(sessionOf(storageKey), (_i, state) =>
      state.storage.getAlarm(),
    );
    expect(armed).toBeGreaterThanOrEqual(before + BOOKKEEPING_TTL * 1000);
    expect(armed).toBeLessThanOrEqual(
      before + BOOKKEEPING_TTL * 1000 + 5_000,
    );
  });

  it("leaves it where it is as parts land", async () => {
    const opened = await uploadedThrough(0);
    const atOpen = await runInDurableObject(sessionOf(opened.storageKey), (_i, s) =>
      s.storage.getAlarm(),
    );

    const filled = await uploadedThrough(2);
    const atFull = await runInDurableObject(sessionOf(filled.storageKey), (_i, s) =>
      s.storage.getAlarm(),
    );

    // Both were set once, when their upload opened. A part landing judges
    // nothing about how long this is taking, so it moves nothing.
    expect(atFull).toBeGreaterThanOrEqual(atOpen ?? 0);
    expect(atFull).toBeLessThanOrEqual((atOpen ?? 0) + 5_000);
  });

  it("drops what it knew once the horizon arrives", async () => {
    const { storageKey, uploadId, token } = await uploadedThrough(1);
    await passHorizon(storageKey);

    expect(await runDurableObjectAlarm(sessionOf(storageKey))).toBe(true);

    const left = await runInDurableObject(sessionOf(storageKey), (_i, state) =>
      state.storage.list(),
    );
    expect(left.size).toBe(0);

    // Nothing is left to write into, and the caller is told so rather than
    // reading whatever R2 throws at a part with no upload behind it.
    const ctx = createExecutionContext();
    const late = await worker.fetch(
      new Request(
        `https://ingest.example.com/uploads/${uploadId}/parts/2`,
        {
          method: "PUT",
          headers: { "x-upload-token": token },
          body: new Uint8Array(FINAL_PART_SIZE),
        },
      ),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(late.status).toBe(410);
  });

  // The retry rhythm is this instance's own: it re-arms every thirty seconds
  // and that survives the handler failing, so nothing stops it on its own.
  // The horizon is what stops it, and it stops it whatever state the upload
  // is in — an outcome nobody would take is not a reason to keep asking for
  // ever, and the object it left in R2 is collected offline (#176).
  it("stops asking at the horizon even with an outcome nobody took", async () => {
    const { storageKey, uploadId, token } = await uploadedThrough(2);
    fetchMock
      .get(REPORT_ORIGIN)
      .intercept({ path: REPORT_PATH, method: "POST" })
      .reply(503, "")
      .persist();

    const ctx = createExecutionContext();
    const refused = await worker.fetch(
      new Request(`https://ingest.example.com/uploads/${uploadId}/complete`, {
        method: "POST",
        headers: { "x-upload-token": token },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(refused.status).toBe(502);

    await passHorizon(storageKey);
    await runDurableObjectAlarm(sessionOf(storageKey));

    const left = await runInDurableObject(sessionOf(storageKey), (_i, state) =>
      state.storage.list(),
    );
    expect(left.size).toBe(0);
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
