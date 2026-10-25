// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `POST /assets/transfer-ticket` — the ticket a browser asks for before it
 * moves a request body too large for the API through storage (inner#1006
 * design §4.2, test spec §3.1: T18, T19, T21–T27, S01).
 *
 * The ticket signs our own transfer type, opens a grant marked
 * `asset_source = 'transfer'` with no node and no space, and skips both the
 * dedup pass and the storage allowance: a transfer never becomes an asset and
 * never counts toward storage.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

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

// The storage-full path sends mail; that leg is not this file's subject.
vi.mock("@server/utils/send-best-effort-mail.js", () => ({
  sendBestEffortMail: async () => {},
}));

/**
 * What the route logs, at each level. Core's logger answers through a proxy
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
import { initCore, loadLocales, getStorageConfig, getMembershipLimits } from "@breatic/core";
import { assetRepo } from "@breatic/domain";
import { t, verifyUploadTicket, TRANSFER_MEDIA_TYPE } from "@breatic/shared";
import {
  seedMember,
  seedOwner,
  seedUser,
  TRANSFER_TYPE,
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
const KEY_SHAPE = /^transfer\/\d{4}-\d{2}-\d{2}\/\d+_[0-9a-f-]{36}\.transfer$/;

let sql: Sql;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "transfer-ticket-test" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/**
 * The largest transfer file any route accepts, signature included (TMAX).
 * Read lazily: the `transfer` section does not exist before the design lands.
 * @returns The ticket's size ceiling.
 */
function tmax(): number {
  return Math.max(...Object.values(getStorageConfig().transfer.route_max_bytes));
}

/**
 * Ask for a transfer ticket.
 * @param cookie - The caller's session cookie, or undefined for none.
 * @param payload - The JSON body.
 * @returns The raw response.
 */
async function transferTicket(cookie: string | undefined, payload: unknown): Promise<Response> {
  return app.request("/api/v1/assets/transfer-ticket", {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie !== undefined && { cookie }) },
    body: JSON.stringify(payload),
  });
}

/**
 * Ask for a media upload ticket.
 * @param cookie - The caller's session cookie.
 * @param payload - The JSON body.
 * @returns The raw response.
 */
async function uploadTicket(cookie: string, payload: Record<string, unknown>): Promise<Response> {
  return app.request("/api/v1/assets/upload-ticket", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      filename: "photo.png",
      content_type: "image/png",
      size: 4096,
      client_hash: crypto.randomBytes(32).toString("hex"),
      ...payload,
    }),
  });
}

/**
 * How many grants a user holds.
 * @param userId - Whose grants.
 * @returns The count.
 */
async function grantCount(userId: string): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM upload_grants WHERE user_id = ${userId}
  `;
  return rows[0]!.n;
}

/**
 * The validation answer every route gives an unsatisfiable body.
 * @param res - The response.
 */
async function expectValidationAnswer(res: Response): Promise<void> {
  expect(res.status).toBe(422);
  const body = (await res.json()) as { error: { message: string } };
  expect(body.error.message).toBe(t("server.error.validation"));
}

describe("the shared transfer type", () => {
  it("is the vendor type the design names", () => {
    expect(TRANSFER_MEDIA_TYPE).toBe(TRANSFER_TYPE);
  });
});

describe("T18 / S01: a transfer ticket and the grant it opens", () => {
  it("answers 201 with a ticket for a transfer file and records an open transfer grant", async () => {
    const a: SeededOwner = await seedOwner(sql);
    logged.info.mockClear();

    const res = await transferTicket(a.cookie, { project_id: a.projectId, size: 1500019 });

    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(Object.keys(data).sort()).toEqual(
      ["kind", "partSize", "storageKey", "ticket", "totalParts", "uploadUrl"],
    );
    expect(data.kind).toBe("file");
    expect(data.partSize).toBe(getStorageConfig().ingest.part_size_bytes);
    expect(data.totalParts).toBe(1);
    expect(data.uploadUrl).toBe(process.env.INGEST_BASE_URL);
    const key = data.storageKey as string;
    expect(key).toMatch(KEY_SHAPE);

    const rows = await sql<
      {
        storage_key: string;
        asset_source: string | null;
        derived: boolean | null;
        node_id: string | null;
        space_id: string | null;
        project_id: string | null;
        studio_id: string;
        filename: string | null;
        declared_size: string;
        user_id: string;
        consumed_at: Date | null;
        voided_at: Date | null;
        finalizing_upload_id: string | null;
      }[]
    >`
      SELECT storage_key, asset_source, derived, node_id, space_id, project_id, studio_id,
             filename, declared_size::text AS declared_size, user_id, consumed_at, voided_at,
             finalizing_upload_id
      FROM upload_grants WHERE storage_key = ${key}
    `;
    expect(rows).toEqual([
      {
        storage_key: key,
        asset_source: "transfer",
        derived: true,
        node_id: null,
        space_id: null,
        project_id: a.projectId,
        studio_id: a.studioId,
        filename: "body.transfer",
        declared_size: "1500019",
        user_id: a.userId,
        consumed_at: null,
        voided_at: null,
        finalizing_upload_id: null,
      },
    ]);

    const tasks = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM node_tasks WHERE storage_key = ${key}
    `;
    expect(tasks[0]!.n).toBe(0);

    const verified = await verifyUploadTicket(data.ticket as string, INGEST_SECRET, Date.now());
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.payload.contentType).toBe(TRANSFER_TYPE);
    expect(verified.payload.storageKey).toBe(key);
    expect(verified.payload.userId).toBe(a.userId);

    const messages = logged.info.mock.calls.map((call) => call[1] as string);
    expect(messages).not.toContain("upload_ticket_issued");
    const issued = logged.info.mock.calls.filter((call) => call[1] === "transfer_ticket_issued");
    expect(issued).toHaveLength(1);
    expect(issued[0]![0]).toMatchObject({ key, userId: a.userId, size: 1500019 });
  });
});

describe("T19: the media ticket never signs the transfer type", () => {
  it("refuses content_type application/vnd.breatic.transfer with the validation answer and opens no grant", async () => {
    const a = await seedOwner(sql);

    const res = await uploadTicket(a.cookie, {
      project_id: a.projectId,
      content_type: TRANSFER_TYPE,
      filename: "body.transfer",
    });

    await expectValidationAnswer(res);
    expect(await grantCount(a.userId)).toBe(0);
  });
});

describe("T21: the size is the whole transfer file, an integer from 1 to TMAX", () => {
  it("accepts 1 and TMAX", async () => {
    const a = await seedOwner(sql);
    expect(tmax()).toBe(25165824);

    for (const size of [1, tmax()]) {
      const res = await transferTicket(a.cookie, { project_id: a.projectId, size });
      expect(res.status).toBe(201);
    }
    expect(await grantCount(a.userId)).toBe(2);
  });

  it.each([
    ["0", 0],
    ["TMAX + 1", 25165825],
    ["1.5", 1.5],
    ['the string "1000"', "1000"],
  ])("refuses %s with the validation answer and opens no grant", async (_label, size) => {
    const a = await seedOwner(sql);

    const res = await transferTicket(a.cookie, { project_id: a.projectId, size });

    await expectValidationAnswer(res);
    expect(await grantCount(a.userId)).toBe(0);
  });
});

describe("T22: who may ask", () => {
  it("answers 401 without a session and opens no grant", async () => {
    const a = await seedOwner(sql);

    const res = await transferTicket(undefined, { project_id: a.projectId, size: 1500019 });

    expect(res.status).toBe(401);
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM upload_grants WHERE project_id = ${a.projectId}
    `;
    expect(rows[0]!.n).toBe(0);
  });

  it.each(["viewer", "non-member"] as const)(
    "answers a %s exactly as the paste route's editor check does, opening no grant",
    async (who) => {
      const a = await seedOwner(sql);
      const caller =
        who === "viewer" ? await seedMember(sql, a.projectId, "viewer") : await seedUser(sql);

      const paste = await app.request("/api/v1/canvas/paste", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: caller.cookie },
        body: JSON.stringify({ project_id: a.projectId, urls: [], pairs: [], history: [] }),
      });
      const res = await transferTicket(caller.cookie, { project_id: a.projectId, size: 1500019 });

      expect(res.status).toBe(paste.status);
      expect(await res.text()).toBe(await paste.text());
      expect(await grantCount(caller.userId)).toBe(0);
    },
  );

  it("answers a project_id that is not a uuid with the validation answer", async () => {
    const a = await seedOwner(sql);

    const res = await transferTicket(a.cookie, { project_id: "not-a-uuid", size: 1500019 });

    await expectValidationAnswer(res);
    expect(await grantCount(a.userId)).toBe(0);
  });
});

describe("T23: no dedup pass and no storage allowance", () => {
  it("issues a ticket when the studio's storage is full", async () => {
    const a = await seedOwner(sql);
    await assetRepo.registerWithDedup({
      studioId: a.studioId,
      producedByUserId: a.userId,
      contentHash: crypto.randomBytes(32).toString("hex"),
      storageKey: `image/2026-10-24/${crypto.randomUUID()}.png`,
      fileUrl: `https://cdn/${crypto.randomUUID()}.png`,
      sizeBytes: getMembershipLimits("base").storage_bytes,
      mimeType: "image/png",
      kind: "image",
      source: "upload",
    });
    // The media ticket is refused on this account, which is what makes the
    // transfer ticket's 201 below mean the allowance was not asked.
    const media = await uploadTicket(a.cookie, { project_id: a.projectId });
    expect(media.status).toBe(507);

    const res = await transferTicket(a.cookie, { project_id: a.projectId, size: 1500019 });

    expect(res.status).toBe(201);
  });

  it("issues a fresh ticket even when a client_hash names content the studio holds", async () => {
    const a = await seedOwner(sql);
    const hash = crypto.randomBytes(32).toString("hex");
    await assetRepo.registerWithDedup({
      studioId: a.studioId,
      producedByUserId: a.userId,
      contentHash: hash,
      storageKey: `image/2026-10-24/${crypto.randomUUID()}.png`,
      fileUrl: `https://cdn/${crypto.randomUUID()}.png`,
      sizeBytes: 1500019,
      mimeType: "image/png",
      kind: "image",
      source: "upload",
    });

    const res = await transferTicket(a.cookie, {
      project_id: a.projectId,
      size: 1500019,
      client_hash: hash,
    });

    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data.alreadyExists).toBeUndefined();
    expect(data.storageKey as string).toMatch(KEY_SHAPE);
  });
});

describe("T24: the server fixes the type and the file name", () => {
  it("ignores a content_type and a filename the body carries", async () => {
    const a = await seedOwner(sql);

    const res = await transferTicket(a.cookie, {
      project_id: a.projectId,
      size: 1500019,
      content_type: "image/png",
      filename: "x.png",
    });

    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { ticket: string; storageKey: string } };
    expect(data.storageKey).toMatch(/\.transfer$/);
    const verified = await verifyUploadTicket(data.ticket, INGEST_SECRET, Date.now());
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.payload.contentType).toBe(TRANSFER_TYPE);
    const rows = await sql<{ filename: string | null }[]>`
      SELECT filename FROM upload_grants WHERE storage_key = ${data.storageKey}
    `;
    expect(rows).toEqual([{ filename: "body.transfer" }]);
  });
});

describe("T26: its own rate limit", () => {
  it("answers the eleventh ticket in a minute with 429 and leaves the media ticket's budget alone", async () => {
    const a = await seedOwner(sql);

    const statuses: number[] = [];
    let last: Response | undefined;
    for (let i = 0; i < 11; i++) {
      last = await transferTicket(a.cookie, { project_id: a.projectId, size: 1500019 });
      statuses.push(last.status);
    }

    expect(statuses).toEqual([201, 201, 201, 201, 201, 201, 201, 201, 201, 201, 429]);
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await last!.json()).toEqual({ error: { code: 429, message: t("server.error.rate_limited") } });

    const media = await uploadTicket(a.cookie, { project_id: a.projectId });
    expect(media.status).toBe(201);
  });

  it("still issues a transfer ticket once the media ticket's budget is spent", async () => {
    // A user who has never asked for a transfer ticket is in a fresh window
    // of both buckets, which is what the case asks for.
    const a = await seedOwner(sql);
    for (let i = 0; i < 30; i++) {
      const media = await uploadTicket(a.cookie, { project_id: a.projectId });
      expect(media.status).toBe(201);
    }
    expect((await uploadTicket(a.cookie, { project_id: a.projectId })).status).toBe(429);

    const res = await transferTicket(a.cookie, { project_id: a.projectId, size: 1500019 });

    expect(res.status).toBe(201);
  });
});

describe("T27: the limiter runs before validation", () => {
  it("counts refused bodies, so the eleventh size-0 request is 429", async () => {
    const a = await seedOwner(sql);

    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await transferTicket(a.cookie, { project_id: a.projectId, size: 0 });
      statuses.push(res.status);
    }

    expect(statuses).toEqual([422, 422, 422, 422, 422, 422, 422, 422, 422, 422, 429]);
  });
});
