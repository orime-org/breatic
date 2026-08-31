// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The alarm, which is what makes an upload's outcome guaranteed (#173, §4.4).
 *
 * A browser that stopped sending never asks the Worker to finish, so the alarm
 * is the only thing that notices. It is also the only retry this Worker has:
 * Cloudflare re-runs `alarm()` on failure and does nothing at all when it
 * returns, so an outcome the server refused has to leave the handler failing.
 *
 * The finishing sequence is re-entered by every one of those retries, which is
 * why each of its steps is remembered separately. Assembling the object and
 * hashing it are two facts, and a retry that lost only the second must not
 * redo the first.
 */

import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  fetchMock,
  runInDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { signUploadTicket } from "@breatic/shared";
import worker from "@ingest/index.js";

const PART_SIZE = 5 * 1024 * 1024;
const FINAL_PART_SIZE = 1024;
const REPORT_ORIGIN = "https://api.test.example";
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

/** What our server answers a report it accepted with. */
const REGISTERED: unknown = {
  data: { fileUrl: "https://cdn.test.example/stored.mp4", kind: "video" },
};

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
      return REGISTERED;
    });
}

/**
 * Open an upload and send `partCount` of its two parts.
 * @param partCount - How many parts to send.
 * @returns The key, upload id and the token the next request would carry.
 */
async function uploadedThrough(
  partCount: number,
): Promise<{ storageKey: string; uploadId: string; token: string }> {
  const storageKey = `video/2026-08-31/${seq++}_alarm.mp4`;
  const ticket = await signUploadTicket(
    {
      storageKey,
      studioId: "studio-1",
      userId: "user-1",
      totalParts: 2,
      partSize: PART_SIZE,
      contentType: "video/mp4",
      expiresAt: Date.now() + 300_000,
      alarmIdleSeconds: 300,
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
    const isFinal = n === 2;
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
    token = (await response.json<{ token: string }>()).token;
  }
  return { storageKey, uploadId: session.uploadId, token };
}

/**
 * Ask the Worker to finish an upload.
 * @param uploadId - The upload to finish.
 * @param token - The most recent session token.
 * @returns The Worker's answer.
 */
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

/**
 * The instance holding one upload's bookkeeping.
 * @param storageKey - The key the upload writes to.
 * @returns Its Durable Object stub.
 */
function sessionOf(storageKey: string): DurableObjectStub {
  return env.UPLOAD_SESSION.get(env.UPLOAD_SESSION.idFromName(storageKey));
}

describe("a browser that stops without asking to finish", () => {
  it("has its outcome reported by the alarm instead", async () => {
    expectReport();
    const { storageKey } = await uploadedThrough(2);

    expect(await runDurableObjectAlarm(sessionOf(storageKey))).toBe(true);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      storage_key: storageKey,
      outcome: "completed",
    });
  });

  it("has an incomplete upload dropped and reported as never finished", async () => {
    expectReport();
    const { storageKey } = await uploadedThrough(1);

    await runDurableObjectAlarm(sessionOf(storageKey));

    expect(await env.BUCKET.get(storageKey)).toBeNull();
    expect(reports[0]).toMatchObject({
      storage_key: storageKey,
      outcome: "aborted",
    });
  });
});

describe("a server that refuses the alarm's own report", () => {
  // Cloudflare retries `alarm()` only when it fails, and reschedules nothing
  // when it returns. An outcome the server has not taken therefore has to come
  // back out of the handler, or this upload is never spoken of again and the
  // node it belongs to spins until collab's sweeper reclaims it.
  it("fails the handler so the runtime retries it", async () => {
    expectReport(503);
    const { storageKey } = await uploadedThrough(2);

    await expect(runDurableObjectAlarm(sessionOf(storageKey))).rejects.toThrow();
  });

  it("reports again on the next attempt", async () => {
    expectReport(503);
    const { storageKey, uploadId, token } = await uploadedThrough(2);
    await runDurableObjectAlarm(sessionOf(storageKey)).catch(() => undefined);

    expectReport();
    expect((await complete(uploadId, token)).status).toBe(200);

    expect(reports).toHaveLength(2);
    expect(reports[1]).toMatchObject({ outcome: "completed" });
  });
});

describe("a retry that lost the hash but not the object", () => {
  // Reading a completed object back can fail on its own, and the attempt that
  // follows must not ask R2 to assemble an upload it has already assembled.
  // Assembling and hashing are remembered apart for that reason.
  it("hashes what is stored rather than reporting no hash at all", async () => {
    expectReport();
    const { storageKey, uploadId, token } = await uploadedThrough(2);
    await complete(uploadId, token);

    await runInDurableObject(sessionOf(storageKey), async (_instance, state) => {
      // What a failed read leaves behind: R2 has the object and its size is
      // known, nothing has been computed over it, nothing has been reported.
      await state.storage.put("finish", {
        settled: true,
        sizeBytes: PART_SIZE + FINAL_PART_SIZE,
        reported: false,
      });
    });

    expectReport();
    expect((await complete(uploadId, token)).status).toBe(200);

    const stored = await env.BUCKET.get(storageKey);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      await stored!.arrayBuffer(),
    );
    const hex = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    expect(reports[1]).toMatchObject({
      sha256: hex,
      size_bytes: PART_SIZE + FINAL_PART_SIZE,
    });
  });
});
