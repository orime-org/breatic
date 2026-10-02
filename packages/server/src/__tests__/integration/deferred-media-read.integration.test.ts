// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * A project cover or a studio avatar, read after its upload returns (#299).
 *
 * The finish asks the ingest Worker for no media read; a job on the
 * `media-read` queue reads the stored object afterwards and fills the row.
 * Every other upload still reads at finish. What this pins, against the real
 * ledger and the real queue, with only the Worker stood in:
 *   - which finishes ask for no read, decided off the grant (A1, A4, A5)
 *   - which rows get a job: this upload's own new row with no numbers, and
 *     never a row it deduped onto (A3, A7)
 *   - a purpose admits pictures only, at the ticket and again at the finish
 *     (A5)
 *   - the write-back fills a row with no numbers and leaves a measured one
 *     alone
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  inject,
  vi,
} from "vitest";

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

// The real scheduling, unless a case asks for it to fail: A6 is about what the
// finish answers when the queue cannot take the job.
const scheduling = vi.hoisted(() => ({ fails: false }));
vi.mock("@breatic/domain", async (importOriginal) => {
  const actual = await importOriginal<typeof domainModule>();
  return {
    ...actual,
    mediaReadService: {
      ...actual.mediaReadService,
      scheduleMediaRead: (
        ...args: Parameters<typeof actual.mediaReadService.scheduleMediaRead>
      ) =>
        scheduling.fails
          ? Promise.reject(new Error("queue unreachable"))
          : actual.mediaReadService.scheduleMediaRead(...args),
    },
  };
});

import crypto from "node:crypto";
import postgres from "postgres";
import type * as domainModule from "@breatic/domain";
import {
  createQueue,
  initCore,
  getRedis,
  setSession,
  sessionCookieName,
  loadLocales,
} from "@breatic/core";
import { assetRepo, MEDIA_READ_QUEUE } from "@breatic/domain";
import { signSessionToken } from "@breatic/shared";
import type { Hono } from "hono";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

const INGEST_SECRET = process.env.INGEST_SHARED_SECRET ?? "";
const UPLOAD_ID = "r2-upload-id-deferred";
const PARTS = [{ partNumber: 1, etag: "etag-1" }];

let sql: ReturnType<typeof postgres>;
let app: Hono;
const queue = createQueue(MEDIA_READ_QUEUE);

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "deferred-media-read-test" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

let seq = 0;

/** A team studio administered by a user with a session, and one project they own. */
async function seedAdmin(): Promise<{
  userId: string;
  cookie: string;
  studioId: string;
  projectId: string;
}> {
  const users = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`dmr-${seq++}-${crypto.randomUUID()}@example.com`}, true) RETURNING id
  `;
  const userId = users[0]!.id;
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  const studios = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`dmr-s-${seq++}-${crypto.randomBytes(3).toString("hex")}`}, 'team', 'Team')
    RETURNING id
  `;
  const studioId = studios[0]!.id;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${userId}, 'admin')
  `;
  const projects = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studioId}, ${userId}, 'P', ${`dmr-p-${seq++}`}) RETURNING id
  `;
  const projectId = projects[0]!.id;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${projectId}, ${userId}, 'owner', null)
  `;
  return { userId, cookie: `${sessionCookieName()}=${token}`, studioId, projectId };
}

/** Ask for a ticket as the holder of `cookie`. */
async function ticket(
  cookie: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request("/api/v1/assets/upload-ticket", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      filename: "cover.jpg",
      content_type: "image/jpeg",
      size: 4096,
      client_hash: crypto.randomBytes(32).toString("hex"),
      ...body,
    }),
  });
}

/** A ticket's storage key; fails the case when the ticket was refused. */
async function keyFor(cookie: string, body: Record<string, unknown>): Promise<string> {
  const res = await ticket(cookie, body);
  expect(res.status).toBe(201);
  const { data } = (await res.json()) as { data: { storageKey: string } };
  return data.storageKey;
}

/**
 * Finish the upload on `storageKey`, the Worker answering `answer`.
 * @returns This server's answer, and the body it sent the Worker.
 */
async function finish(
  cookie: string,
  storageKey: string,
  answer: Record<string, unknown>,
): Promise<{ res: Response; sent: Record<string, unknown> }> {
  let sent: Record<string, unknown> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify(answer), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  const token = await signSessionToken(
    {
      storageKey,
      uploadId: UPLOAD_ID,
      contentType: "image/jpeg",
      sessionTokenTtlSeconds: 900,
      expiresAt: Date.now() + 900_000,
      partSize: 5 * 1024 * 1024,
      totalParts: 1,
    },
    INGEST_SECRET,
  );
  const res = await app.request(`/api/v1/assets/uploads/${UPLOAD_ID}/complete`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-upload-token": token,
      cookie,
    },
    body: JSON.stringify({ parts: PARTS }),
  });
  return { res, sent };
}

/** A picture the Worker measured nothing on. */
function picture(sha256 = crypto.randomBytes(32).toString("hex")): Record<string, unknown> {
  return { sha256, sizeBytes: 4096, contentType: "image/jpeg" };
}

/** The row an asset id names. */
async function rowOf(assetId: string): Promise<{
  width: number | null;
  height: number | null;
  storage_key: string;
}> {
  const rows = await sql<{ width: number | null; height: number | null; storage_key: string }[]>`
    SELECT width, height, storage_key FROM studio_assets WHERE id = ${assetId}
  `;
  return rows[0]!;
}

describe("which finishes ask the Worker for no media read", () => {
  it("a project cover asks for none, and still sends its deadlines", async () => {
    const admin = await seedAdmin();
    const key = await keyFor(admin.cookie, {
      project_id: admin.projectId,
      purpose: "project_cover",
    });

    const { res, sent } = await finish(admin.cookie, key, picture());

    expect(res.status).toBe(200);
    expect(sent.deferMediaRead).toBe(true);
    expect(sent.limits).toBeDefined();
  });

  it("a studio avatar asks for none", async () => {
    const admin = await seedAdmin();
    const key = await keyFor(admin.cookie, {
      studio_id: admin.studioId,
      purpose: "studio_avatar",
    });

    const { sent } = await finish(admin.cookie, key, picture());

    expect(sent.deferMediaRead).toBe(true);
  });

  // A4: every other upload still reads while it is being finished.
  it("a canvas upload reads at finish, as before", async () => {
    const admin = await seedAdmin();
    const key = await keyFor(admin.cookie, {
      project_id: admin.projectId,
      node_id: crypto.randomUUID(),
      space_id: crypto.randomUUID(),
    });

    const { sent } = await finish(admin.cookie, key, picture());

    expect(sent.deferMediaRead).toBeUndefined();
  });
});

describe("which finished uploads get a read job", () => {
  it("queues one for a cover's own new row, which has no numbers yet", async () => {
    const admin = await seedAdmin();
    const key = await keyFor(admin.cookie, {
      project_id: admin.projectId,
      purpose: "project_cover",
    });

    const { res } = await finish(admin.cookie, key, picture());
    const { data } = (await res.json()) as { data: { assetId: string } };

    expect((await rowOf(data.assetId)).width).toBeNull();
    const job = await queue.getJob(`media-read-${data.assetId}`);
    expect(job?.data).toEqual({ assetId: data.assetId });
  });

  // A7: the studio already held these bytes as a canvas upload whose read
  // timed out. The cover lands on that row, and that row stays as it is.
  it("queues none when the cover landed on a row it did not write", async () => {
    const admin = await seedAdmin();
    const sha256 = crypto.randomBytes(32).toString("hex");
    const canvasKey = await keyFor(admin.cookie, {
      project_id: admin.projectId,
      node_id: crypto.randomUUID(),
      space_id: crypto.randomUUID(),
    });
    const first = await finish(admin.cookie, canvasKey, picture(sha256));
    const { data: canvasRow } = (await first.res.json()) as { data: { assetId: string } };
    const coverKey = await keyFor(admin.cookie, {
      project_id: admin.projectId,
      purpose: "project_cover",
    });

    const { res } = await finish(admin.cookie, coverKey, picture(sha256));
    const { data } = (await res.json()) as { data: { assetId: string } };

    expect(data.assetId).toBe(canvasRow.assetId);
    expect(await queue.getJob(`media-read-${canvasRow.assetId}`)).toBeUndefined();
  });

  it("queues none for a canvas upload", async () => {
    const admin = await seedAdmin();
    const key = await keyFor(admin.cookie, {
      project_id: admin.projectId,
      node_id: crypto.randomUUID(),
      space_id: crypto.randomUUID(),
    });

    const { res } = await finish(admin.cookie, key, picture());
    const { data } = (await res.json()) as { data: { assetId: string } };

    expect(await queue.getJob(`media-read-${data.assetId}`)).toBeUndefined();
  });
});

// A6: the row stands either way. A read that could not be queued leaves it
// without numbers, which is how a read that failed leaves it too.
it("answers the finish even when the read could not be queued", async () => {
  const admin = await seedAdmin();
  const key = await keyFor(admin.cookie, {
    project_id: admin.projectId,
    purpose: "project_cover",
  });
  scheduling.fails = true;
  try {
    const { res } = await finish(admin.cookie, key, picture());

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { assetId: string } };
    expect((await rowOf(data.assetId)).width).toBeNull();
  } finally {
    scheduling.fails = false;
  }
});

describe("a purpose admits pictures only", () => {
  it.each([
    ["a cover ticket for a video", { purpose: "project_cover", content_type: "video/mp4", filename: "c.mp4" }],
    ["a cover ticket with a node", { purpose: "project_cover", node_id: crypto.randomUUID() }],
    ["a cover ticket with a space", { purpose: "project_cover", space_id: crypto.randomUUID() }],
  ])("refuses %s", async (_case, body) => {
    const admin = await seedAdmin();

    const res = await ticket(admin.cookie, { project_id: admin.projectId, ...body });

    expect(res.status).toBe(422);
  });

  it("refuses an avatar ticket for audio", async () => {
    const admin = await seedAdmin();

    const res = await ticket(admin.cookie, {
      studio_id: admin.studioId,
      purpose: "studio_avatar",
      content_type: "audio/mpeg",
      filename: "a.mp3",
    });

    expect(res.status).toBe(422);
  });

  // The ticket names a picture; the bytes that landed are a film. Nothing is
  // registered, and the refusal is the one a format we do not take gets.
  it("refuses at finish when the stored bytes are not a picture", async () => {
    const admin = await seedAdmin();
    const key = await keyFor(admin.cookie, {
      project_id: admin.projectId,
      purpose: "project_cover",
    });

    const { res } = await finish(admin.cookie, key, {
      ...picture(),
      contentType: "video/mp4",
    });

    expect(res.status).toBe(415);
    const rows = await sql`SELECT id FROM studio_assets WHERE storage_key = ${key}`;
    expect(rows).toHaveLength(0);
    const grants = await sql<{ voided_at: Date | null }[]>`
      SELECT voided_at FROM upload_grants WHERE storage_key = ${key}
    `;
    expect(grants[0]!.voided_at).not.toBeNull();
  });
});

describe("writing the numbers back", () => {
  it("fills a row that has none, and leaves a measured row alone", async () => {
    const admin = await seedAdmin();
    const key = await keyFor(admin.cookie, {
      project_id: admin.projectId,
      purpose: "project_cover",
    });
    const { res } = await finish(admin.cookie, key, picture());
    const { data } = (await res.json()) as { data: { assetId: string } };

    const first = await assetRepo.fillMediaNumbers(data.assetId, {
      width: 800,
      height: 450,
      durationSeconds: null,
    });
    const second = await assetRepo.fillMediaNumbers(data.assetId, {
      width: 1,
      height: 1,
      durationSeconds: null,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await rowOf(data.assetId)).toMatchObject({ width: 800, height: 450 });
  });
});
