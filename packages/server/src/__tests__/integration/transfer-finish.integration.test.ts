// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Finishing a transfer upload, its status, and every cell of the grant
 * transition table that is not a reference read (inner#1006 design §4.3,
 * §4.4, §7.4; test spec §3.2 T25, T30–T33, T35, T37 and §6.1 S04, S05, S07,
 * S08, S09, S12, S13, S15, S16, S17, S19, S26, S28, S30, S31, S32).
 *
 * A transfer finish asks the Worker for no media read, checks the stored type
 * is our transfer type and the size is no more than declared, and marks the
 * grant complete without writing an asset row. Real ledger, real queue, the
 * Worker stood in by a stubbed `fetch`.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, inject, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: async () => ({ text: "", steps: [], usage: { totalTokens: 0 } }),
  streamText: () => ({
    fullStream: (async function* () {})(),
    text: Promise.resolve(""),
    usage: Promise.resolve({ totalTokens: 0 }),
  }),
  stepCountIs: (_n: number) => () => false,
  tool: (config: Record<string, unknown>) => config,
}));

// The server opens every upload at the ingest Worker itself before it
// answers a ticket (inner#1595); that one call is answered by a double.
vi.mock("@breatic/shared", async (importOriginal) =>
  (await import("../helpers/ingest-open-double.js")).sharedWithOpenDouble(importOriginal),
);

/**
 * What the app logs, at each level. Core's logger answers through a proxy
 * that a spy cannot see into, so the app is handed this one instead.
 */
const logged = vi.hoisted(() => {
  const record = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() };
  return { ...record, child: () => record };
});
vi.mock("@breatic/core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logger: logged,
}));

import crypto from "node:crypto";
import postgres from "postgres";
import type { Hono } from "hono";
import {
  createQueue,
  env,
  getRedis,
  getStorageAdapter,
  getStorageConfig,
  initCore,
  loadLocales,
} from "@breatic/core";
import {
  MEDIA_READ_QUEUE,
  UPLOAD_FINISH_QUEUE,
  uploadFinishService,
  uploadGrantRepo,
  uploadStatusService,
} from "@breatic/domain";
import { DeadlinePassed, encodeTransferBody, signSessionToken, t } from "@breatic/shared";
import { accountStorageUsage } from "@server/modules/asset/assetUsage.service.js";
import { closeFinishQueue, runQueuedFinish } from "@server/__tests__/helpers/queued-finish.js";
import {
  grantRow,
  openTransferGrant,
  seedOwner,
  TRANSFER_TYPE,
  transferJob,
  workerAnswers,
  workerRefuses,
  workerThrows,
  type SeededOwner,
  type Sql,
} from "@server/__tests__/integration/transfer-grant-fixtures.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

const INGEST_SECRET = process.env.INGEST_SHARED_SECRET ?? "";
const DECLARED = 1500019;

let sql: Sql;
let app: Hono;
const finishQueue = createQueue(UPLOAD_FINISH_QUEUE);
const mediaReadQueue = createQueue(MEDIA_READ_QUEUE);

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "transfer-finish-test" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await closeFinishQueue();
  await finishQueue.close();
  await mediaReadQueue.close();
  await sql?.end({ timeout: 1 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * A transfer grant in `finishing`: opened, then claimed by `uploadId`.
 * @param owner - Whose upload.
 * @param uploadId - The multipart upload that claims it.
 * @returns The storage key.
 */
async function finishingGrant(owner: SeededOwner, uploadId = "transfer-upload-1"): Promise<string> {
  const key = await openTransferGrant(owner, DECLARED);
  const claim = await uploadGrantRepo.claimFinalize({ storageKey: key, uploadId });
  expect(claim.granted).toBe(true);
  return key;
}

/**
 * A completed transfer grant, made the way the spec's fixture says: issue,
 * claim, then `completeTransferGrant`.
 * @param owner - Whose upload.
 * @param uploadId - The multipart upload that claimed it.
 * @returns The storage key.
 */
async function completedGrant(owner: SeededOwner, uploadId = "transfer-upload-1"): Promise<string> {
  const key = await finishingGrant(owner, uploadId);
  expect(await uploadGrantRepo.completeTransferGrant(key)).toBe(true);
  return key;
}

/**
 * Push a grant's two-hour deadline into the past by backdating when it opened.
 * @param key - The grant's storage key.
 */
async function pastDeadline(key: string): Promise<void> {
  await sql`UPDATE upload_grants SET created_at = now() - interval '3 hours' WHERE storage_key = ${key}`;
}

/**
 * The status the route answers for one of `cookie`'s keys.
 * @param cookie - The caller's session cookie.
 * @param key - The key asked about.
 * @returns The one status item.
 */
async function statusVia(cookie: string, key: string): Promise<unknown> {
  const res = await app.request(`/api/v1/assets/upload-status?key=${encodeURIComponent(key)}`, {
    headers: { cookie },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { items: unknown[] } };
  expect(body.data.items).toHaveLength(1);
  return body.data.items[0];
}

/**
 * Ask the complete route to finish `uploadId` on `key`.
 * @param cookie - The caller's session cookie.
 * @param key - The key the token is signed for.
 * @param uploadId - The multipart upload id.
 * @param expiresAt - When the token stops being accepted, in epoch ms.
 * @returns The raw response.
 */
async function completeVia(
  cookie: string,
  key: string,
  uploadId: string,
  expiresAt = Date.now() + 900_000,
): Promise<Response> {
  const token = await signSessionToken(
    { storageKey: key, uploadId, contentType: TRANSFER_TYPE, expiresAt, partSize: 8388608, totalParts: 1 },
    INGEST_SECRET,
  );
  return app.request(`/api/v1/assets/uploads/${uploadId}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-upload-token": token, cookie },
    body: JSON.stringify({ parts: [{ partNumber: 1, etag: "etag-1" }] }),
  });
}

/**
 * How many studio_assets rows carry `key`.
 * @param key - The storage key.
 * @returns The count.
 */
async function assetRowsFor(key: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM studio_assets WHERE storage_key = ${key}`;
  return rows[0]!.n;
}

/**
 * The one-time reference marker's Redis key (spec §0.4 `REF(K)`).
 * @param key - The transfer file's storage key.
 * @returns The Redis key.
 */
function refKey(key: string): string {
  return `${env.REDIS_KEY_PREFIX}:server:transfer-ref:${key}`;
}

describe("T30 / S10: a successful transfer finish", () => {
  it("completes the grant with no asset row, no media read, deferMediaRead true and status transferred", async () => {
    const a = await seedOwner(sql);
    const key = await finishingGrant(a);
    const calls = workerAnswers({ contentType: TRANSFER_TYPE, sizeBytes: DECLARED });
    const mediaJobsBefore = await mediaReadQueue.getJobCountByTypes("waiting", "delayed", "active", "prioritized");

    const result = await uploadFinishService.finishUpload(transferJob(key));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${process.env.INGEST_BASE_URL}/uploads/transfer-upload-1/complete`);
    expect(calls[0]!.body.deferMediaRead).toBe(true);
    expect(result.outcome.status).toBe("transferred");
    const row = await grantRow(sql, key);
    expect(row!.consumed_at).not.toBeNull();
    expect(row!.asset_id).toBeNull();
    expect(row!.voided_at).toBeNull();
    expect(await assetRowsFor(key)).toBe(0);
    expect(await mediaReadQueue.getJobCountByTypes("waiting", "delayed", "active", "prioritized")).toBe(
      mediaJobsBefore,
    );
    expect(await uploadStatusService.statusOf(a.userId, [key])).toEqual([{ key, state: "transferred" }]);
  });
});

describe("T31: the stored size against the declared one", () => {
  it.each([
    [DECLARED - 1, "completes"],
    [DECLARED, "completes"],
  ])("a stored size of %i %s", async (sizeBytes) => {
    const a = await seedOwner(sql);
    const key = await finishingGrant(a);
    workerAnswers({ contentType: TRANSFER_TYPE, sizeBytes });

    const result = await uploadFinishService.finishUpload(transferJob(key));

    expect(result.outcome.status).toBe("transferred");
    const row = await grantRow(sql, key);
    expect(row!.consumed_at).not.toBeNull();
    expect(row!.voided_at).toBeNull();
    expect(row!.asset_id).toBeNull();
  });

  it("a stored size one byte over the declared size voids the grant as too_large (S11)", async () => {
    const a = await seedOwner(sql);
    const key = await finishingGrant(a);
    workerAnswers({ contentType: TRANSFER_TYPE, sizeBytes: DECLARED + 1 });

    await uploadFinishService.finishUpload(transferJob(key));

    const row = await grantRow(sql, key);
    expect(row!.voided_at).not.toBeNull();
    expect(row!.failure_reason).toBe("too_large");
    expect(row!.consumed_at).toBeNull();
    expect(await uploadStatusService.statusOf(a.userId, [key])).toEqual([
      { key, state: "failed", reason: "too_large" },
    ]);
  });
});

describe("T32 / S11: the Worker answers 200 with a type that is not ours", () => {
  it("voids the grant as unsupported_type and writes no asset row", async () => {
    const a = await seedOwner(sql);
    const key = await finishingGrant(a);
    workerAnswers({ contentType: "text/plain", sizeBytes: DECLARED });

    await uploadFinishService.finishUpload(transferJob(key));

    const row = await grantRow(sql, key);
    expect(row!.voided_at).not.toBeNull();
    expect(row!.failure_reason).toBe("unsupported_type");
    expect(row!.consumed_at).toBeNull();
    expect(row!.asset_id).toBeNull();
    expect(await assetRowsFor(key)).toBe(0);
    expect(await uploadStatusService.statusOf(a.userId, [key])).toEqual([
      { key, state: "failed", reason: "unsupported_type" },
    ]);
  });
});

describe("T33 / S11: the Worker refuses the stored bytes", () => {
  it("voids the grant with the Worker's failure code", async () => {
    const a = await seedOwner(sql);
    const key = await finishingGrant(a);
    workerRefuses(415, "unsupported_type");

    const result = await uploadFinishService.finishUpload(transferJob(key));

    expect(result.refused?.reason).toBe("unsupported_type");
    const row = await grantRow(sql, key);
    expect(row!.voided_at).not.toBeNull();
    expect(row!.failure_reason).toBe("unsupported_type");
    expect(row!.consumed_at).toBeNull();
    expect(row!.asset_id).toBeNull();
  });
});

describe("T35 / S12 / S18: running the finish again is a no-op", () => {
  it("leaves consumed_at at its first value to the microsecond", async () => {
    const a = await seedOwner(sql);
    const key = await finishingGrant(a);
    workerAnswers({ contentType: TRANSFER_TYPE, sizeBytes: DECLARED });
    const first = await uploadFinishService.finishUpload(transferJob(key));
    expect(first.outcome.status).toBe("transferred");
    const t1 = (await grantRow(sql, key))!.consumed_at;
    expect(t1).not.toBeNull();

    // (a) the same job again
    const again = await uploadFinishService.finishUpload(transferJob(key));
    expect(again.outcome.status).toBe("transferred");
    // (b) the completion itself, twice more
    expect(await uploadGrantRepo.completeTransferGrant(key)).toBe(true);
    expect(await uploadGrantRepo.completeTransferGrant(key)).toBe(true);

    const row = await grantRow(sql, key);
    expect(row!.consumed_at).toBe(t1);
    expect(row!.voided_at).toBeNull();
    expect(row!.asset_id).toBeNull();
  });
});

describe("T25: a transfer leaves no activity, no asset and no storage usage", () => {
  it("writes nothing to project_activities or studio_assets and leaves usage unchanged", async () => {
    const a = await seedOwner(sql);
    const activitiesBefore = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM project_activities WHERE project_id = ${a.projectId}
    `;
    const usageBefore = await accountStorageUsage(a.userId);

    const ticket = await app.request("/api/v1/assets/transfer-ticket", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: a.cookie },
      body: JSON.stringify({ project_id: a.projectId, size: DECLARED }),
    });
    expect(ticket.status).toBe(201);
    const { data } = (await ticket.json()) as { data: { storageKey: string } };
    const claim = await uploadGrantRepo.claimFinalize({ storageKey: data.storageKey, uploadId: "transfer-upload-1" });
    expect(claim).toEqual({ granted: true, assetSource: "transfer" });
    workerAnswers({ contentType: TRANSFER_TYPE, sizeBytes: DECLARED });
    const result = await uploadFinishService.finishUpload(transferJob(data.storageKey));
    expect(result.outcome.status).toBe("transferred");

    const activitiesAfter = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM project_activities WHERE project_id = ${a.projectId}
    `;
    expect(activitiesAfter[0]!.n).toBe(activitiesBefore[0]!.n);
    const assets = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM studio_assets WHERE studio_id = ${a.studioId}
    `;
    expect(assets[0]!.n).toBe(0);
    expect(await accountStorageUsage(a.userId)).toBe(usageBefore);
  });
});

describe("T37: where a transfer grant stands, as the status route answers", () => {
  it("answers finishing, finishing, transferred, failed and expired by state, and leaves other grants as they were", async () => {
    const a = await seedOwner(sql);
    const b = await seedOwner(sql);

    const open = await openTransferGrant(a, DECLARED);
    const finishing = await finishingGrant(a);
    const completed = await completedGrant(a);
    const voided = await finishingGrant(a);
    await uploadGrantRepo.voidGrant(voided, "unsupported_type");
    const expired = await openTransferGrant(a, DECLARED);
    await pastDeadline(expired);
    const theirs = await openTransferGrant(b, DECLARED);

    // An ordinary upload, registered as an asset.
    const ordinary = `image/2026-10-24/${Date.now()}_${crypto.randomUUID()}.png`;
    await uploadGrantRepo.issueGrant({
      userId: a.userId,
      studioId: a.studioId,
      storageKey: ordinary,
      declaredSize: 4096,
      expiresAt: new Date(Date.now() + 300_000),
      context: { projectId: a.projectId },
    });
    const assetRows = await sql<{ id: string }[]>`
      INSERT INTO studio_assets
        (studio_id, content_hash, storage_key, file_url, size_bytes, mime_type, kind, source,
         produced_by_user_id, width, height)
      VALUES
        (${a.studioId}, ${crypto.randomBytes(32).toString("hex")}, ${ordinary},
         ${"https://cdn.test.invalid/ordinary.png"}, 4096, 'image/png', 'image', 'upload', ${a.userId}, 640, 480)
      RETURNING id
    `;
    expect(
      await uploadGrantRepo.consumeGrant({ storageKey: ordinary, userId: a.userId, assetId: assetRows[0]!.id }),
    ).toBe(true);

    expect(await statusVia(a.cookie, open)).toEqual({ key: open, state: "finishing" });
    expect(await statusVia(a.cookie, finishing)).toEqual({ key: finishing, state: "finishing" });
    expect(await statusVia(a.cookie, completed)).toEqual({ key: completed, state: "transferred" });
    expect(await statusVia(a.cookie, voided)).toEqual({ key: voided, state: "failed", reason: "unsupported_type" });
    expect(await statusVia(a.cookie, expired)).toEqual({ key: expired, state: "failed", reason: "expired" });
    expect(await statusVia(a.cookie, ordinary)).toEqual({
      key: ordinary,
      state: "completed",
      result: {
        assetId: assetRows[0]!.id,
        fileUrl: "https://cdn.test.invalid/ordinary.png",
        kind: "image",
        width: 640,
        height: 480,
      },
    });
    expect(await statusVia(a.cookie, theirs)).toEqual({ key: theirs, state: "unknown" });
  });
});

describe("§6.1 grant transitions outside the reference read", () => {
  it("S04: open × complete answers 202, claims the grant and queues one finish keyed by the storage key", async () => {
    const a = await seedOwner(sql);
    const key = await openTransferGrant(a, DECLARED);

    const res = await completeVia(a.cookie, key, "upload-s04");

    expect(res.status).toBe(202);
    expect((await grantRow(sql, key))!.finalizing_upload_id).toBe("upload-s04");
    const job = await finishQueue.getJob(key);
    expect(job?.id).toBe(key);
    expect(job?.data).toMatchObject({ storageKey: key, uploadId: "upload-s04", assetSource: "transfer" });
    await job?.remove();
  });

  it("S05: open × deadline passed answers failed/expired without writing, and an expired token is 401", async () => {
    const a = await seedOwner(sql);
    const key = await openTransferGrant(a, DECLARED);
    await pastDeadline(key);

    expect(await statusVia(a.cookie, key)).toEqual({ key, state: "failed", reason: "expired" });
    expect((await grantRow(sql, key))!.voided_at).toBeNull();

    const res = await completeVia(a.cookie, key, "upload-s05", Date.now() - 1000);
    expect(res.status).toBe(401);
    expect((await grantRow(sql, key))!.finalizing_upload_id).toBeNull();
  });

  it("S07 (server half): a browser that leaves mid-upload leaves the grant open", async () => {
    const a = await seedOwner(sql);
    const key = await openTransferGrant(a, DECLARED);

    expect(await grantRow(sql, key)).toEqual({
      consumed_at: null,
      voided_at: null,
      asset_id: null,
      failure_reason: null,
      finalizing_upload_id: null,
      asset_source: "transfer",
    });
    expect(await statusVia(a.cookie, key)).toEqual({ key, state: "finishing" });
    expect(await finishQueue.getJob(key)).toBeUndefined();
  });

  it("S08: finishing × complete with the same upload id answers 202 and keeps one job", async () => {
    const a = await seedOwner(sql);
    const key = await openTransferGrant(a, DECLARED);
    expect((await completeVia(a.cookie, key, "upload-s08")).status).toBe(202);

    const res = await completeVia(a.cookie, key, "upload-s08");

    expect(res.status).toBe(202);
    const waiting = (await finishQueue.getJobs(["waiting", "delayed", "prioritized"])).filter((j) => j.id === key);
    expect(waiting).toHaveLength(1);
    await finishQueue.getJob(key).then((job) => job?.remove());
  });

  it("S09: finishing × complete with another upload id answers 409 in_flight and leaves the row", async () => {
    const a = await seedOwner(sql);
    const key = await finishingGrant(a, "upload-s09-first");
    const before = await grantRow(sql, key);
    logged.info.mockClear();

    const res = await completeVia(a.cookie, key, "upload-s09-second");

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { message: t("server.error.conflict") } });
    expect(logged.info).toHaveBeenCalledWith({ key, reason: "in_flight" }, "upload_finalize_refused");
    expect(await grantRow(sql, key)).toEqual(before);
  });

  it("S13: finishing × deadline passed answers expired while finishing, then voids as expired when the Worker call is cut", async () => {
    const a = await seedOwner(sql);
    const key = await finishingGrant(a);
    await pastDeadline(key);

    // (a) the status query reads expired and writes nothing
    expect(await statusVia(a.cookie, key)).toEqual({ key, state: "failed", reason: "expired" });
    const row = await grantRow(sql, key);
    expect(row!.voided_at).toBeNull();
    expect(row!.consumed_at).toBeNull();

    // (b) the finish's Worker call is cut at the deadline
    workerThrows(new DeadlinePassed());
    await uploadFinishService.finishUpload(transferJob(key));
    const after = await grantRow(sql, key);
    expect(after!.voided_at).not.toBeNull();
    expect(after!.failure_reason).toBe("expired");
    expect(after!.consumed_at).toBeNull();
  });

  it("S15 (server half): the finish still completes after the browser leaves, and nothing is referenced", async () => {
    const a = await seedOwner(sql);
    const key = await finishingGrant(a);
    workerAnswers({ contentType: TRANSFER_TYPE, sizeBytes: DECLARED });

    const result = await uploadFinishService.finishUpload(transferJob(key));

    expect(result.outcome.status).toBe("transferred");
    const row = await grantRow(sql, key);
    expect(row!.consumed_at).not.toBeNull();
    expect(row!.asset_id).toBeNull();
    expect(await getRedis().exists(refKey(key))).toBe(0);
  });

  it("S16: completed × the same upload id after the job was cleared re-queues, and the rerun leaves the row", async () => {
    const a = await seedOwner(sql);
    const key = await completedGrant(a, "upload-s16");
    const before = await grantRow(sql, key);
    expect(await finishQueue.getJob(key)).toBeUndefined();

    const res = await completeVia(a.cookie, key, "upload-s16");

    expect(res.status).toBe(202);
    expect((await finishQueue.getJob(key))?.data).toMatchObject({ storageKey: key, uploadId: "upload-s16" });
    workerAnswers({ contentType: TRANSFER_TYPE, sizeBytes: DECLARED });
    await runQueuedFinish(key);
    expect(await grantRow(sql, key)).toEqual(before);
  });

  it("S17: completed × another upload id answers 409 already_registered and leaves the row", async () => {
    const a = await seedOwner(sql);
    const key = await completedGrant(a, "upload-s17-first");
    const before = await grantRow(sql, key);
    logged.info.mockClear();

    const res = await completeVia(a.cookie, key, "upload-s17-second");

    expect(res.status).toBe(409);
    expect(logged.info).toHaveBeenCalledWith({ key, reason: "already_registered" }, "upload_finalize_refused");
    expect(await grantRow(sql, key)).toEqual(before);
  });

  it("S19: completed × deadline passed still reads transferred, and the reference still succeeds", async () => {
    const a = await seedOwner(sql);
    const key = await completedGrant(a);
    await pastDeadline(key);
    const before = await grantRow(sql, key);

    expect(await statusVia(a.cookie, key)).toEqual({ key, state: "transferred" });
    expect(await grantRow(sql, key)).toEqual(before);

    const nodeId = crypto.randomUUID();
    const snapshot = { project_id: a.projectId, node_id: nodeId, text: "after the deadline" };
    const adapter = await getStorageAdapter();
    vi.spyOn(adapter as unknown as { read: (k: string, m: number) => Promise<Uint8Array> }, "read").mockResolvedValue(
      encodeTransferBody(JSON.stringify(snapshot)),
    );
    const res = await app.request("/api/v1/canvas/node-history/snapshot", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: a.cookie },
      body: JSON.stringify({ transfer: key }),
    });
    expect(res.status).toBe(201);
    const rows = await sql<{ content: string }[]>`
      SELECT content FROM node_history WHERE node_id = ${nodeId}
    `;
    expect(rows).toEqual([{ content: "after the deadline" }]);
  });

  it("S26: voided × complete answers 404 not_found and leaves the row", async () => {
    const a = await seedOwner(sql);
    const key = await finishingGrant(a, "upload-s26");
    await uploadGrantRepo.voidGrant(key, "unsupported_type");
    const before = await grantRow(sql, key);

    const res = await completeVia(a.cookie, key, "upload-s26");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { message: t("server.error.not_found") } });
    expect(await grantRow(sql, key)).toEqual(before);
  });

  it("S27: voided × rerun leaves the row: completeTransferGrant and a later successful finish change nothing", async () => {
    const a = await seedOwner(sql);
    const key = await finishingGrant(a);
    await uploadGrantRepo.voidGrant(key, "unsupported_type");
    const before = await grantRow(sql, key);

    expect(await uploadGrantRepo.completeTransferGrant(key)).toBe(false);
    workerAnswers({ contentType: TRANSFER_TYPE, sizeBytes: DECLARED });
    const result = await uploadFinishService.finishUpload(transferJob(key));

    expect(result.outcome.status).not.toBe("transferred");
    expect(await grantRow(sql, key)).toEqual(before);
    expect((await grantRow(sql, key))!.consumed_at).toBeNull();
    expect(await uploadStatusService.statusOf(a.userId, [key])).toEqual([
      { key, state: "failed", reason: "unsupported_type" },
    ]);
  });

  it("S28 / S30: voided × deadline passed keeps its own reason, and the row stays as it was", async () => {
    const a = await seedOwner(sql);
    const key = await finishingGrant(a);
    await uploadGrantRepo.voidGrant(key, "unsupported_type");
    await pastDeadline(key);
    const before = await grantRow(sql, key);

    expect(await statusVia(a.cookie, key)).toEqual({ key, state: "failed", reason: "unsupported_type" });
    expect(await grantRow(sql, key)).toEqual(before);
  });

  it("S31: stale × complete behaves as completed: the same upload id re-queues, another is 409 already_registered", async () => {
    const a = await seedOwner(sql);
    const key = await completedGrant(a, "upload-s31");
    const ttl = getStorageConfig().transfer.reference_ttl_seconds;
    await sql`
      UPDATE upload_grants SET consumed_at = now() - make_interval(secs => ${ttl + 1})
      WHERE storage_key = ${key}
    `;
    const before = await grantRow(sql, key);

    const same = await completeVia(a.cookie, key, "upload-s31");
    expect(same.status).toBe(202);
    workerAnswers({ contentType: TRANSFER_TYPE, sizeBytes: DECLARED });
    await runQueuedFinish(key);
    expect(await grantRow(sql, key)).toEqual(before);

    logged.info.mockClear();
    const other = await completeVia(a.cookie, key, "upload-s31-other");
    expect(other.status).toBe(409);
    expect(logged.info).toHaveBeenCalledWith({ key, reason: "already_registered" }, "upload_finalize_refused");
    expect(await grantRow(sql, key)).toEqual(before);
  });

  it("S32: stale × a successful rerun does not refresh consumed_at", async () => {
    const a = await seedOwner(sql);
    const key = await completedGrant(a);
    const ttl = getStorageConfig().transfer.reference_ttl_seconds;
    await sql`
      UPDATE upload_grants SET consumed_at = now() - make_interval(secs => ${ttl + 1})
      WHERE storage_key = ${key}
    `;
    const before = await grantRow(sql, key);

    workerAnswers({ contentType: TRANSFER_TYPE, sizeBytes: DECLARED });
    await uploadFinishService.finishUpload(transferJob(key));

    expect(await grantRow(sql, key)).toEqual(before);
  });
});
