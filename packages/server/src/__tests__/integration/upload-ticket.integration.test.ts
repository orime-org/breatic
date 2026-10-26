// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `POST /assets/upload-ticket` — the permission slip the browser carries to
 * the ingest Worker (task #173, design §4.1).
 *
 * It runs the gate the presign endpoint used to run: access to the project,
 * the upload cap, and "no hash, no upload". What is new is the row it leaves
 * behind. The grant is the only thing that survives until the Worker reports
 * back, so the context the browser declares here — which node, which project,
 * which space — is checked against this user's access before it lands, and
 * from then on it is ours rather than the client's.
 *
 * The signed ticket is read back through the same verifier the Worker runs,
 * so a ticket this endpoint mints and a ticket the Worker accepts cannot
 * drift apart without failing here.
 *
 * A dedup hit sends no bytes at all, and this endpoint is the whole of that
 * path now that the second round trip through `/uploaded` is gone. So it also
 * has to leave the record that round trip used to leave: the node's content
 * changed, and the node history is where that is kept.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, inject, vi } from "vitest";

/**
 * Mocked so this suite can drive both of its answers; whether the alarm was
 * really set is covered where that call is made.
 */
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

// The ingest Worker's `POST /uploads`, which the server now calls itself
// before it answers (inner#1595): counted and answered by a double, every
// other part of the flow real.
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
import {
  initCore,
  getRedis,
  getStreamRedis,
  getNodeTaskConfig,
  setSession,
  sessionCookieName,
  loadLocales,
  taskEventsStreamKey,
} from "@breatic/core";
import { uploadDeadlineByKey } from "@breatic/domain";
import {
  verifyUploadTicket,
  verifySessionToken,
  canvasSpaceDocName,
  UploadHttpError,
  INGEST_NO_ANSWER,
  INGEST_REFUSED_UNNAMED,
} from "@breatic/shared";
import {
  onlyOpenOf,
  openCalls,
  opensByKey,
  resetOpenDouble,
  setOpenMode,
} from "../helpers/ingest-open-double.js";
import { workerAnswers } from "@server/__tests__/integration/transfer-grant-fixtures.js";
import { closeFinishQueue, runQueuedFinish } from "@server/__tests__/helpers/queued-finish.js";
import type { Hono } from "hono";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

/**
 * The same secret `@breatic/integration-tests/env` hands the server. Read from the
 * environment rather than repeated as a literal: a ticket the endpoint signs
 * with one value and this file verifies with another would pass a test that
 * asserts nothing.
 */
const INGEST_SECRET = process.env.INGEST_SHARED_SECRET ?? "";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "upload-ticket-test-driver" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

beforeEach(() => {
  resetOpenDouble();
  vi.clearAllMocks();
});

afterAll(async () => {
  await closeFinishQueue();
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/** A fresh user, their personal studio, a project in it, and a session. */
async function seedEditor(): Promise<{
  userId: string;
  studioId: string;
  projectId: string;
  cookie: string;
}> {
  const users = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`ut-${seq++}@example.com`}, true) RETURNING id
  `;
  const userId = users[0]!.id;
  const studios = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`ut-s-${seq++}`}, 'personal', 'Personal') RETURNING id
  `;
  const studioId = studios[0]!.id;
  // Every studio has exactly one admin in production, personal ones included;
  // the storage-ceiling lookup resolves a studio through its current admin and
  // treats a studio without one as corrupt.
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${userId}, 'admin')
  `;
  const slug = `ut-proj-${seq++}`;
  const projects = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studioId}, ${userId}, ${`P ${slug}`}, ${slug})
    RETURNING id
  `;
  const projectId = projects[0]!.id;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${projectId}, ${userId}, 'owner', null)
  `;

  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return {
    userId,
    studioId,
    projectId,
    cookie: `${sessionCookieName()}=${token}`,
  };
}

/** Put one asset in the studio's ledger so the dedup pass can find it. */
async function registerAsset(
  studioId: string,
  producedByUserId: string,
  contentHash: string,
  sizeBytes: number,
  media: { width: number; height: number; durationSeconds: number } | null = null,
): Promise<void> {
  await sql`
    INSERT INTO studio_assets
      (studio_id, content_hash, storage_key, file_url, size_bytes,
       mime_type, kind, source, produced_by_user_id,
       width, height, duration_seconds)
    VALUES
      (${studioId}, ${contentHash}, ${`video/${contentHash}.mp4`},
       ${`https://cdn.test.invalid/${contentHash}.mp4`}, ${sizeBytes},
       'video/mp4', 'video', 'upload', ${producedByUserId},
       ${media?.width ?? null}, ${media?.height ?? null},
       ${media?.durationSeconds ?? null})
  `;
}

/**
 * Register a video that already carries its extracted cover, the way the first
 * upload of that file leaves it.
 * @param studioId - Studio the rows belong to.
 * @param producedByUserId - Who uploaded it.
 * @param contentHash - The video's hash, which dedup matches on.
 * @param sizeBytes - The video's size, which dedup also matches on.
 * @returns The cover's public URL.
 */
async function registerVideoWithCover(
  studioId: string,
  producedByUserId: string,
  contentHash: string,
  sizeBytes: number,
): Promise<string> {
  await registerAsset(studioId, producedByUserId, contentHash, sizeBytes);
  const coverHash = crypto.randomBytes(32).toString("hex");
  const coverUrl = `https://cdn.test.invalid/${coverHash}_cover.png`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studio_assets
      (studio_id, content_hash, storage_key, file_url, size_bytes,
       mime_type, kind, source, produced_by_user_id)
    VALUES
      (${studioId}, ${coverHash}, ${`image/${coverHash}_cover.png`},
       ${coverUrl}, 4096, 'image/png', 'image', 'cover', ${producedByUserId})
    RETURNING id
  `;
  await sql`
    UPDATE studio_assets SET cover_asset_id = ${rows[0]!.id}
    WHERE studio_id = ${studioId} AND content_hash = ${contentHash}
  `;
  return coverUrl;
}

/** A request body the endpoint should accept, with the pieces a caller varies. */
function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    filename: "clip.mp4",
    content_type: "video/mp4",
    size: 40 * 1024 * 1024,
    client_hash: crypto.randomBytes(32).toString("hex"),
    ...overrides,
  };
}

/** POST the ticket endpoint with `cookie` and the given body. */
async function requestTicket(
  cookie: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  return app.request("/api/v1/assets/upload-ticket", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(payload),
  });
}

/** Every task-counts event on the stream for `docName`, oldest first. */
async function eventsFor(docName: string): Promise<
  {
    nodeId: string;
    counts: Record<string, number>;
    result: Record<string, unknown> | undefined;
  }[]
> {
  const raw = (await getStreamRedis().xrange(
    taskEventsStreamKey(),
    "-",
    "+",
  )) as [string, string[]][];
  return raw
    .map(([, fields]) => {
      const idx = fields.indexOf("payload");
      return idx === -1 ? null : (JSON.parse(fields[idx + 1]!) as Record<string, unknown>);
    })
    .filter(
      (e): e is Record<string, unknown> =>
        e !== null && e.type === "node-task-counts" && e.docName === docName,
    )
    .map((e) => ({
      nodeId: e.nodeId as string,
      counts: e.counts as Record<string, number>,
      result: e.result as Record<string, unknown> | undefined,
    }));
}

describe("POST /assets/upload-ticket", () => {
  // The ticket no longer reaches the browser (inner#1595): what is verified
  // is the one the server handed the Worker's open, as the double received it.
  it("mints a ticket the ingest Worker's own verifier accepts", async () => {
    const { projectId, cookie } = await seedEditor();

    const res = await requestTicket(cookie, body({ project_id: projectId }));

    expect(res.status).toBe(201);
    const payload = (await res.json()) as {
      data: { storageKey: string; uploadUrl: string };
    };
    expect(payload.data.storageKey).toMatch(/\.mp4$/);
    expect(payload.data.uploadUrl.startsWith("https://ingest.test.invalid")).toBe(
      true,
    );

    const verified = await verifyUploadTicket(
      onlyOpenOf(payload.data.storageKey).ticket,
      INGEST_SECRET,
      Date.now(),
    );
    expect(verified.ok).toBe(true);
  });

  // What the Worker acts on, and nothing more. The fencing generation is not
  // among it: the Worker never reads one, and every consequence of this upload
  // takes it off the grant row instead.
  it("T62: signs the storage key, the content type, the expiry and the task's deadline into the ticket", async () => {
    const { projectId, cookie } = await seedEditor();

    const res = await requestTicket(
      cookie,
      body({ project_id: projectId }),
    );
    const payload = (await res.json()) as {
      data: { storageKey: string };
    };
    const verified = await verifyUploadTicket(
      onlyOpenOf(payload.data.storageKey).ticket,
      INGEST_SECRET,
      Date.now(),
    );

    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.payload.storageKey).toBe(payload.data.storageKey);
    expect(verified.payload.contentType).toBe("video/mp4");
    expect(verified.payload).not.toHaveProperty("leaseGen");
    // The expiry is what the Worker checks when the server asks to start, so
    // a ticket has to arrive with room left on it.
    expect(verified.payload.expiresAt).toBeGreaterThan(Date.now());
    expect(verified.payload.deadlineAt).toBe(await uploadDeadlineByKey(payload.data.storageKey));
  });

  it("leaves a grant carrying the context the report will need", async () => {
    const { projectId, cookie, userId } = await seedEditor();
    const nodeId = crypto.randomUUID();

    const res = await requestTicket(
      cookie,
      body({ project_id: projectId, node_id: nodeId }),
    );
    const payload = (await res.json()) as { data: { storageKey: string } };

    const rows = await sql<
      {
        user_id: string;
        project_id: string;
        node_id: string | null;
        consumed_at: Date | null;
        voided_at: Date | null;
      }[]
    >`
      SELECT user_id, project_id, node_id, consumed_at, voided_at
      FROM upload_grants WHERE storage_key = ${payload.data.storageKey}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(userId);
    expect(rows[0]!.project_id).toBe(projectId);
    expect(rows[0]!.node_id).toBe(nodeId);
    expect(rows[0]!.consumed_at).toBeNull();
    expect(rows[0]!.voided_at).toBeNull();
  });

  it("names the task row it opened, so a failure can be retried by task", async () => {
    // The browser holds a failed upload's File for a retry, and the stash is
    // keyed by task (#186 §3.7.2) — two uploads onto one node each keep their
    // own. It can only do that if it is told which task this upload is.
    const { projectId, cookie } = await seedEditor();
    const nodeId = crypto.randomUUID();

    const res = await requestTicket(
      cookie,
      body({
        project_id: projectId,
        node_id: nodeId,
        space_id: crypto.randomUUID(),
      }),
    );
    const payload = (await res.json()) as { data: { taskId: string } };

    const rows = await sql<{ id: string }[]>`
      SELECT id FROM node_tasks WHERE node_id = ${nodeId}
    `;
    expect(rows).toHaveLength(1);
    expect(payload.data.taskId).toBe(rows[0]!.id);
  });

  it("refuses a project this user is not in, and leaves no grant", async () => {
    const mine = await seedEditor();
    const theirs = await seedEditor();

    const res = await requestTicket(
      mine.cookie,
      body({ project_id: theirs.projectId }),
    );

    // 404, not 403: `assertAccess` answers a non-member with NotFound so the
    // reply does not disclose whether that project exists. 403 is reserved for
    // a member whose role is below editor.
    expect(res.status).toBe(404);
    const rows = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM upload_grants WHERE user_id = ${mine.userId}
    `;
    expect(rows[0]!.n).toBe("0");
  });

  it("refuses a file over the upload cap with 413, minting nothing", async () => {
    const { projectId, cookie, userId } = await seedEditor();

    const res = await requestTicket(
      cookie,
      body({ project_id: projectId, size: 3 * 1024 * 1024 * 1024 }),
    );

    expect(res.status).toBe(413);
    const rows = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM upload_grants WHERE user_id = ${userId}
    `;
    expect(rows[0]!.n).toBe("0");
  });

  it("refuses a request with no client hash — no hash, no upload", async () => {
    const { projectId, cookie } = await seedEditor();
    const withoutHash = body({ project_id: projectId });
    delete withoutHash.client_hash;

    const res = await requestTicket(cookie, withoutHash);

    // 422: the body parsed as JSON and every field was read, so the request is
    // well-formed and merely unsatisfiable — which is what `validate` answers.
    expect(res.status).toBe(422);
  });

  it("answers content the studio already holds without minting anything", async () => {
    const { projectId, cookie, studioId, userId } = await seedEditor();
    const hash = crypto.randomBytes(32).toString("hex");
    const size = 40 * 1024 * 1024;
    await registerAsset(studioId, userId, hash, size);

    const res = await requestTicket(
      cookie,
      body({ project_id: projectId, client_hash: hash, size }),
    );

    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      data: { alreadyExists?: boolean; fileUrl?: string; ticket?: string };
    };
    expect(payload.data.alreadyExists).toBe(true);
    expect(payload.data.fileUrl).toBe(`https://cdn.test.invalid/${hash}.mp4`);
    expect(payload.data.ticket).toBeUndefined();
    expect(openCalls()).toEqual([]);

    const grants = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM upload_grants WHERE studio_id = ${studioId}
    `;
    expect(grants[0]!.n).toBe("0");
  });

  // An upload with no node reads the picture's size off this answer, the way
  // it reads it off a finished upload (inner#1367 §4.8a).
  it("answers content the studio already holds with the size stored on its row", async () => {
    const { projectId, cookie, studioId, userId } = await seedEditor();
    const hash = crypto.randomBytes(32).toString("hex");
    await registerAsset(studioId, userId, hash, 4096, { width: 3000, height: 4000, durationSeconds: 0 });

    const res = await requestTicket(cookie, body({ project_id: projectId, client_hash: hash, size: 4096 }));

    const payload = (await res.json()) as { data: { width?: number; height?: number } };
    expect(payload.data).toMatchObject({ width: 3000, height: 4000 });
  });

  it("records the node's new content in its history on a dedup hit", async () => {
    const { projectId, cookie, studioId, userId } = await seedEditor();
    const hash = crypto.randomBytes(32).toString("hex");
    const size = 40 * 1024 * 1024;
    const nodeId = crypto.randomUUID();
    await registerAsset(studioId, userId, hash, size);

    await requestTicket(
      cookie,
      body({ project_id: projectId, client_hash: hash, size, node_id: nodeId }),
    );

    // No bytes moved, but the node now shows something it did not show before,
    // and that is what the history is for.
    const rows = await sql<
      { entry_type: string; status: string; content: string }[]
    >`
      SELECT entry_type, status, content FROM node_history
      WHERE node_id = ${nodeId} AND deleted_at IS NULL
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entry_type).toBe("upload");
    expect(rows[0]!.status).toBe("success");
    expect(rows[0]!.content).toBe(`https://cdn.test.invalid/${hash}.mp4`);
  });

  it("keeps the registered row's numbers on the dedup hit's history row (#2184)", async () => {
    const { projectId, cookie, studioId, userId } = await seedEditor();
    const hash = crypto.randomBytes(32).toString("hex");
    const size = 40 * 1024 * 1024;
    const nodeId = crypto.randomUUID();
    await registerAsset(studioId, userId, hash, size);

    await requestTicket(
      cookie,
      body({ project_id: projectId, client_hash: hash, size, node_id: nodeId }),
    );

    const [asset] = await sql<
      { width: number | null; height: number | null; duration_seconds: string | null; mime_type: string; size_bytes: string }[]
    >`
      SELECT width, height, duration_seconds, mime_type, size_bytes FROM studio_assets
      WHERE studio_id = ${studioId} AND content_hash = ${hash}
    `;
    const [row] = await sql<
      { media_width: number | null; media_height: number | null; duration_seconds: string | null; mime_type: string | null; size_bytes: string | null }[]
    >`
      SELECT media_width, media_height, duration_seconds, mime_type, size_bytes FROM node_history
      WHERE node_id = ${nodeId} AND deleted_at IS NULL
    `;
    expect(row).toEqual({
      media_width: asset!.width,
      media_height: asset!.height,
      duration_seconds: asset!.duration_seconds,
      mime_type: asset!.mime_type,
      size_bytes: asset!.size_bytes,
    });
    expect(Number(row!.size_bytes)).toBe(size);
  });

  it("points the dedup hit's task row at the history row it landed", async () => {
    // Design §4.3: a hit is a task that finished before it started, and the
    // user "可以点替换、点完成，跟别的完成态一样". Replace renders only for a
    // row the list can read a result off, and the list reads it across
    // `node_history_id` — so a row without that pointer is a finished task
    // whose result the user cannot put back.
    const { projectId, cookie, studioId, userId } = await seedEditor();
    const hash = crypto.randomBytes(32).toString("hex");
    const size = 40 * 1024 * 1024;
    const nodeId = crypto.randomUUID();
    await registerAsset(studioId, userId, hash, size);

    await requestTicket(
      cookie,
      body({
        project_id: projectId,
        space_id: crypto.randomUUID(),
        client_hash: hash,
        size,
        node_id: nodeId,
      }),
    );

    const { nodeTaskService } = await import("@breatic/domain");
    const live = await nodeTaskService.listLive({ projectId, nodeId });

    expect(live).toHaveLength(1);
    expect(live[0]!.status).toBe("done");
    expect(live[0]!.content).toBe(`https://cdn.test.invalid/${hash}.mp4`);
  });

  // A picture turned upright is filed with its upright copy's size and the
  // received bytes' hash, so the size a browser declares for the same file
  // never matches the row (inner#1367 §4.6). The hash alone decides.
  it("reuses the row a hash names though its declared size differs from the stored one", async () => {
    const { projectId, cookie, studioId, userId } = await seedEditor();
    const hash = crypto.randomBytes(32).toString("hex");
    await registerAsset(studioId, userId, hash, 40 * 1024 * 1024);

    const res = await requestTicket(
      cookie,
      body({ project_id: projectId, client_hash: hash, size: 40 * 1024 * 1024 + 1 }),
    );

    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      data: { ticket?: string; alreadyExists?: boolean };
    };
    expect(payload.data.alreadyExists).toBe(true);
    expect(payload.data.ticket).toBeUndefined();
    expect(openCalls()).toEqual([]);
  });

  it("dedups against the PROJECT's studio, not the uploader's own", async () => {
    const owner = await seedEditor();
    const collaborator = await seedEditor();
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${owner.projectId}, ${collaborator.userId}, 'editor', null)
    `;
    const hash = crypto.randomBytes(32).toString("hex");
    const size = 40 * 1024 * 1024;
    // The content sits in the PROJECT owner's studio. The collaborator has
    // never stored it anywhere of their own.
    await registerAsset(owner.studioId, owner.userId, hash, size);

    const res = await requestTicket(
      collaborator.cookie,
      body({ project_id: owner.projectId, client_hash: hash, size }),
    );

    // One project is one dedup domain no matter who uploads into it: the
    // storage is charged to the project's studio, so that is where a duplicate
    // has to be looked for.
    const payload = (await res.json()) as { data: { alreadyExists?: boolean } };
    expect(payload.data.alreadyExists).toBe(true);
  });

  it("leaves the activity feed alone on a dedup hit — nothing was uploaded", async () => {
    const { projectId, cookie, studioId, userId } = await seedEditor();
    const hash = crypto.randomBytes(32).toString("hex");
    const size = 40 * 1024 * 1024;
    await registerAsset(studioId, userId, hash, size);

    await requestTicket(
      cookie,
      body({ project_id: projectId, client_hash: hash, size }),
    );

    // `asset:uploaded` is the only shape the feed has for this, and it would be
    // recording something that did not happen. The feed carries no event for
    // "a node's content changed" — that is what node_history is.
    const rows = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM project_activities
      WHERE project_id = ${projectId} AND type = 'asset:uploaded'
    `;
    expect(rows[0]!.n).toBe("0");
  });

  // Nothing was uploaded, so nothing reports back — and the node opened
  // handling before asking. Without an event here it would sit in handling
  // forever, which is the one thing the upload path promises cannot happen
  // (design §6.6).
  it("tells the node what it now holds on a dedup hit", async () => {
    const { projectId, cookie, studioId, userId } = await seedEditor();
    const hash = crypto.randomBytes(32).toString("hex");
    const size = 40 * 1024 * 1024;
    await registerAsset(studioId, userId, hash, size);
    const nodeId = crypto.randomUUID();
    const spaceId = crypto.randomUUID();

    await requestTicket(
      cookie,
      body({
        project_id: projectId,
        client_hash: hash,
        size,
        node_id: nodeId,
        space_id: spaceId,
      }),
    );

    const docName = canvasSpaceDocName(projectId, spaceId);
    const events = (await eventsFor(docName)).filter((e) => e.nodeId === nodeId);
    expect(events).toHaveLength(1);
    expect(events[0]!.counts).toEqual({
      running: 0,
      done: 1,
      failed: 0,
      expired: 0,
    });
    expect(events[0]!.result).toMatchObject({
      content: `https://cdn.test.invalid/${hash}.mp4`,
    });
  });

  // Nothing uploads on a hit, so the container is never asked and this event
  // is the only one this node will get. A video node reads `coverUrl` for its poster, so
  // an event carrying the video alone leaves the second node showing a
  // modality icon where the first shows a frame — from the same file. The
  // ledger row's own link is where it comes from (design §7).
  it("hands over the cover as well when the deduped video already has one", async () => {
    const { projectId, cookie, studioId, userId } = await seedEditor();
    const hash = crypto.randomBytes(32).toString("hex");
    const size = 40 * 1024 * 1024;
    const coverUrl = await registerVideoWithCover(studioId, userId, hash, size);
    const nodeId = crypto.randomUUID();
    const spaceId = crypto.randomUUID();

    await requestTicket(
      cookie,
      body({
        project_id: projectId,
        client_hash: hash,
        size,
        node_id: nodeId,
        space_id: spaceId,
      }),
    );

    const docName = canvasSpaceDocName(projectId, spaceId);
    const events = (await eventsFor(docName)).filter((e) => e.nodeId === nodeId);
    expect(events[0]!.result).toMatchObject({
      content: `https://cdn.test.invalid/${hash}.mp4`,
      coverUrl,
    });
  });

  it("puts that cover on the history row too", async () => {
    const { projectId, cookie, studioId, userId } = await seedEditor();
    const hash = crypto.randomBytes(32).toString("hex");
    const size = 40 * 1024 * 1024;
    const coverUrl = await registerVideoWithCover(studioId, userId, hash, size);
    const nodeId = crypto.randomUUID();

    await requestTicket(
      cookie,
      body({
        project_id: projectId,
        client_hash: hash,
        size,
        node_id: nodeId,
        space_id: crypto.randomUUID(),
      }),
    );

    const rows = await sql<{ thumbnail_url: string | null }[]>`
      SELECT thumbnail_url FROM node_history WHERE node_id = ${nodeId}
    `;
    expect(rows[0]!.thumbnail_url).toBe(coverUrl);
  });

  // The window between registering a video and linking its cover is short, and
  // a hit that lands inside it reads no cover. That node shows a modality icon
  // — the same degradation an extraction that produced nothing leaves behind,
  // and no wrong data (design §5.3).
  it("hands over the video alone when its cover is not linked yet", async () => {
    const { projectId, cookie, studioId, userId } = await seedEditor();
    const hash = crypto.randomBytes(32).toString("hex");
    const size = 40 * 1024 * 1024;
    await registerAsset(studioId, userId, hash, size);
    const nodeId = crypto.randomUUID();
    const spaceId = crypto.randomUUID();

    await requestTicket(
      cookie,
      body({
        project_id: projectId,
        client_hash: hash,
        size,
        node_id: nodeId,
        space_id: spaceId,
      }),
    );

    const docName = canvasSpaceDocName(projectId, spaceId);
    const events = (await eventsFor(docName)).filter((e) => e.nodeId === nodeId);
    expect(events).toHaveLength(1);
    // The five content fields travel together, so a video with no cover says
    // so rather than leaving the field out: collab writes all five.
    expect(events[0]!.result?.coverUrl).toBeNull();
  });

  // A focus crop asks with no node. There is nothing to announce to, and the
  // answer to this request is how that path hears its result.
  // A hit uploads nothing, so no container runs and nothing here can measure
  // the media. The row that won dedup was measured when it was first stored,
  // and this is the only place a hit's node can read it from.
  it("hands over the dimensions and duration the winning row carries", async () => {
    const { projectId, cookie, studioId, userId } = await seedEditor();
    const hash = crypto.randomBytes(32).toString("hex");
    const size = 40 * 1024 * 1024;
    await registerAsset(studioId, userId, hash, size, {
      width: 1920,
      height: 1080,
      durationSeconds: 12.5,
    });
    const nodeId = crypto.randomUUID();
    const spaceId = crypto.randomUUID();

    await requestTicket(
      cookie,
      body({
        project_id: projectId,
        client_hash: hash,
        size,
        node_id: nodeId,
        space_id: spaceId,
      }),
    );

    const events = (await eventsFor(canvasSpaceDocName(projectId, spaceId)))
      .filter((e) => e.nodeId === nodeId);
    expect(events[0]!.result).toMatchObject({
      width: 1920,
      height: 1080,
      duration: 12.5,
    });
  });

  it("announces nothing when the dedup hit has no node behind it", async () => {
    const { projectId, cookie, studioId, userId } = await seedEditor();
    const hash = crypto.randomBytes(32).toString("hex");
    const size = 40 * 1024 * 1024;
    await registerAsset(studioId, userId, hash, size);
    const spaceId = crypto.randomUUID();

    await requestTicket(
      cookie,
      body({
        project_id: projectId,
        client_hash: hash,
        size,
        space_id: spaceId,
      }),
    );

    expect(await eventsFor(canvasSpaceDocName(projectId, spaceId))).toEqual([]);
  });

  // `source` decides how the ledger files what is stored, and the only value
  // any of our code sends is the mini-tool one. Left open, an editor could
  // hand-write a request that files their own upload as a video's cover — a
  // column the offline reclaim job reads to tell the two apart.
  it("refuses a source no caller of ours sends", async () => {
    const { projectId, cookie } = await seedEditor();

    const res = await requestTicket(
      cookie,
      body({ project_id: projectId, source: "cover" }),
    );

    // 422, the same answer every other unsatisfiable field gets: the body
    // parsed and was read, and one value is not one this endpoint accepts.
    expect(res.status).toBe(422);
  });

  // Whatever is declared here becomes the stored object's Content-Type, which
  // a public read hands straight to whoever opens the URL. The canvas only
  // ever uploads these three kinds — anything else is a hand-written request
  // asking us to serve something of its choosing off our own domain.
  it("refuses a content type the canvas never uploads", async () => {
    const { projectId, cookie } = await seedEditor();

    const res = await requestTicket(
      cookie,
      body({ project_id: projectId, content_type: "text/html" }),
    );

    expect(res.status).toBe(422);
  });

  // A browser honours the LAST parsable value when a Content-Type carries
  // commas — measured in Chromium: "video/mp4,text/html" renders as HTML and
  // runs the scripts in it. So what the gate reads has to be what R2 stores,
  // which is why only the first essence survives the ticket.
  it("carries only the first type when the declaration names several", async () => {
    const { projectId, cookie } = await seedEditor();

    const res = await requestTicket(
      cookie,
      body({
        project_id: projectId,
        client_hash: crypto.randomBytes(32).toString("hex"),
        content_type: "video/mp4,text/html",
      }),
    );

    expect(res.status).toBe(201);
    const answer = (await res.json()) as { data: { storageKey: string } };
    const verified = await verifyUploadTicket(
      onlyOpenOf(answer.data.storageKey).ticket,
      INGEST_SECRET,
      Date.now(),
    );

    expect(verified.ok && verified.payload.contentType).toBe("video/mp4");
  });

  // Being an image is not the question. The list names formats one by one
  // because a family holds things no model can be given and things a browser
  // executes — an SVG is an image by family and a script by content, and a GIF
  // is an image nothing downstream reads (#240).
  it.each(["image/svg+xml", "image/gif", "video/ogg", "audio/aiff"])(
    "refuses %s, which is the right family and the wrong format",
    async (contentType) => {
      const { projectId, cookie } = await seedEditor();

      const res = await requestTicket(
        cookie,
        body({
          project_id: projectId,
          content_type: contentType,
          client_hash: crypto.randomBytes(32).toString("hex"),
        }),
      );

      expect(res.status).toBe(422);
    },
  );

  // One format goes by more than one name: `.m4a` is `audio/mp4` in the
  // registry and `audio/x-m4a` to a browser and an operating system alike.
  // Which name the caller holds says nothing about the file.
  it("takes every format on the list, under any name it goes by", async () => {
    const { projectId, cookie } = await seedEditor();

    for (const contentType of [
      "image/png",
      "image/jpeg",
      "image/webp",
      "video/mp4",
      "video/webm",
      "video/quicktime",
      "audio/mpeg",
      "audio/wav",
      "audio/mp4",
      "audio/webm",
      "audio/x-m4a",
    ]) {
      const res = await requestTicket(
        cookie,
        body({
          project_id: projectId,
          content_type: contentType,
          client_hash: crypto.randomBytes(32).toString("hex"),
        }),
      );

      expect(res.status).toBe(201);
    }
  });

  it("refuses an anonymous caller", async () => {
    const { projectId } = await seedEditor();

    const res = await app.request("/api/v1/assets/upload-ticket", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body({ project_id: projectId })),
    });

    expect(res.status).toBe(401);
  });
});

/**
 * The task this ticket opens (#186, design §4.2 E1 and §4.6.5).
 *
 * A ticket is the moment an upload becomes a thing that can fail, so it is
 * also the moment the node gets a row for it. What judges that row dead is a
 * read of the node's task list (design §4.6), so nothing else has to happen
 * here: the row carries its own budget and is measured against it whenever
 * somebody looks.
 */
describe("POST /assets/upload-ticket — the task it opens", () => {
  /** Every task row on one node, newest first. */
  async function tasksOn(nodeId: string): Promise<
    {
      id: string;
      status: string;
      kind: string;
      budget_ms: number;
      label: string;
      storage_key: string | null;
      started_by_user_id: string;
      space_id: string;
      project_id: string;
    }[]
  > {
    return sql`
      SELECT id, status, kind, budget_ms, label, storage_key,
             started_by_user_id, space_id, project_id
      FROM node_tasks WHERE node_id = ${nodeId}
      ORDER BY started_at DESC
    ` as never;
  }

  it("opens one running row carrying who, where and what", async () => {
    const { userId, projectId, cookie } = await seedEditor();
    const nodeId = crypto.randomUUID();
    const spaceId = crypto.randomUUID();

    const res = await requestTicket(
      cookie,
      body({ project_id: projectId, node_id: nodeId, space_id: spaceId }),
    );
    expect(res.status).toBe(201);

    const rows = await tasksOn(nodeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "running",
      kind: "upload",
      label: "clip.mp4",
      started_by_user_id: userId,
      space_id: spaceId,
      project_id: projectId,
    });
  });

  it("points the row at the grant the bytes will land under", async () => {
    const { projectId, cookie } = await seedEditor();
    const nodeId = crypto.randomUUID();

    const res = await requestTicket(
      cookie,
      body({
        project_id: projectId,
        node_id: nodeId,
        space_id: crypto.randomUUID(),
      }),
    );
    const payload = (await res.json()) as { data: { storageKey: string } };

    const rows = await tasksOn(nodeId);
    expect(rows[0]!.storage_key).toBe(payload.data.storageKey);
  });

  it("gives the row one budget, whatever the file size (#186 §4.6.2)", async () => {
    // The deadline is a flat ceiling, not an estimate of this transfer. What a
    // file will take depends on a link we cannot see, so a computed deadline is
    // a guess dressed as a measurement — and the number it produces is the sole
    // basis on which a live task is judged dead.
    const { projectId, cookie } = await seedEditor();
    const small = crypto.randomUUID();
    const large = crypto.randomUUID();

    for (const [nodeId, size] of [
      [small, 1024],
      [large, 2 * 1024 * 1024 * 1024],
    ] as const) {
      await requestTicket(
        cookie,
        body({
          project_id: projectId,
          node_id: nodeId,
          space_id: crypto.randomUUID(),
          size,
        }),
      );
    }

    const { getNodeTaskConfig } = await import("@breatic/core");
    const budget = getNodeTaskConfig().default_budget_ms;
    expect(budget).toBe(7_200_000);
    expect((await tasksOn(small))[0]!.budget_ms).toBe(budget);
    expect((await tasksOn(large))[0]!.budget_ms).toBe(budget);
  });

  it("publishes the node's counts so everyone sees one running", async () => {
    const { projectId, cookie } = await seedEditor();
    const nodeId = crypto.randomUUID();
    const spaceId = crypto.randomUUID();

    await requestTicket(
      cookie,
      body({ project_id: projectId, node_id: nodeId, space_id: spaceId }),
    );

    const counts = await eventsFor(canvasSpaceDocName(projectId, spaceId));
    expect(counts.at(-1)).toMatchObject({
      nodeId,
      counts: { running: 1, done: 0, failed: 0, expired: 0 },
    });
  });

  it("opens nothing for an upload with no node behind it", async () => {
    // A focus crop has no node, so there is no corner to count it in.
    const { projectId, cookie } = await seedEditor();
    const res = await requestTicket(cookie, body({ project_id: projectId }));

    expect(res.status).toBe(201);
    const opened = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM node_tasks WHERE project_id = ${projectId}
    `;
    expect(Number(opened[0]!.n)).toBe(0);
  });

  it("opens a row already finished when the studio already holds the file", async () => {
    // A dedup hit sends no bytes, so there is nothing to time — but the node
    // still gains the content, and the row is what the counts are computed
    // from. It opens and settles in the same request.
    const { studioId, userId, projectId, cookie } = await seedEditor();
    const hash = crypto.randomBytes(32).toString("hex");
    await registerAsset(studioId, userId, hash, 40 * 1024 * 1024);
    const nodeId = crypto.randomUUID();
    const res = await requestTicket(
      cookie,
      body({
        project_id: projectId,
        node_id: nodeId,
        space_id: crypto.randomUUID(),
        client_hash: hash,
      }),
    );

    expect(res.status).toBe(200);
    const rows = await tasksOn(nodeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("done");
  });
});

/**
 * The server opens the upload at the Worker itself (inner#1595 test spec §6,
 * T60–T70, T76, T77). The browser gets the upload id and the first session
 * token, never the ticket; an open that fails answers 200 `openFailed` with
 * the task id, the grant voided and the row failed, so the browser neither
 * asks again nor is left with a row that runs on.
 */
describe("POST /assets/upload-ticket — the server opens the upload (inner#1595)", () => {
  /** An ordinary picture onto one node of one Space. */
  function picture(projectId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
    return body({
      project_id: projectId,
      filename: "photo.png",
      content_type: "image/png",
      size: 4096,
      node_id: crypto.randomUUID(),
      space_id: crypto.randomUUID(),
      ...over,
    });
  }

  /** Every grant this user holds, oldest first. */
  async function grantsOf(userId: string): Promise<{ storage_key: string; voided_at: Date | null }[]> {
    return sql<{ storage_key: string; voided_at: Date | null }[]>`
      SELECT storage_key, voided_at FROM upload_grants WHERE user_id = ${userId} ORDER BY created_at
    `;
  }

  /** The task rows opened for one key. */
  async function rowsFor(storageKey: string): Promise<{ id: string; status: string; settled_at: Date | null }[]> {
    return sql<{ id: string; status: string; settled_at: Date | null }[]>`
      SELECT id, status, settled_at FROM node_tasks WHERE storage_key = ${storageKey}
    `;
  }

  /** Every `upload_open_failed` line logged since the last clear. */
  function openFailedLines(): Record<string, unknown>[] {
    return logged.error.mock.calls
      .filter((call) => call[1] === "upload_open_failed")
      .map((call) => call[0] as Record<string, unknown>);
  }

  it("T60: the double is the open the server calls — nothing reaches the network for it", async () => {
    const { projectId, cookie } = await seedEditor();
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        urls.push(String(url));
        return new Response("", { status: 500 });
      }),
    );
    try {
      const res = await requestTicket(cookie, picture(projectId));

      expect(res.status).toBe(201);
      const { data } = (await res.json()) as { data: { storageKey: string } };
      expect([...opensByKey()]).toEqual([[data.storageKey, 1]]);
      expect(urls.filter((url) => url.endsWith("/uploads"))).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("T61: answers the upload id and first token the Worker gave, and no ticket", async () => {
    const { projectId, cookie } = await seedEditor();

    const res = await requestTicket(cookie, picture(projectId));

    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(Object.keys(data).sort()).toEqual(
      ["kind", "partSize", "storageKey", "taskId", "token", "totalParts", "uploadId", "uploadUrl"],
    );
    const call = onlyOpenOf(data.storageKey as string);
    expect(data.uploadId).toBe(call.answer?.uploadId);
    expect(data.token).toBe(call.answer?.token);
    const session = await verifySessionToken(data.token as string, INGEST_SECRET, Date.now());
    expect(session?.uploadId).toBe(data.uploadId);
    expect(session?.storageKey).toBe(data.storageKey);
    expect((data.uploadUrl as string).startsWith(process.env.INGEST_BASE_URL ?? "https://ingest.test.invalid")).toBe(true);
  });

  it("T63: opens with the shared secret, bound by the task's deadline", async () => {
    const { projectId, cookie } = await seedEditor();
    // The bound is computed before the ticket is signed and the open recorded,
    // so the moment before the request is its upper limit.
    const before = Date.now();

    const res = await requestTicket(cookie, picture(projectId));
    const { data } = (await res.json()) as { data: { storageKey: string } };

    const call = onlyOpenOf(data.storageKey);
    expect(call.secret).toBe(INGEST_SECRET);
    expect(call.bound?.signal).toBeInstanceOf(AbortSignal);
    expect(call.bound?.signal?.aborted).toBe(false);
    const timeoutMs = call.bound?.timeoutMs ?? 0;
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThanOrEqual(call.payload.deadlineAt - before);
    expect(call.payload.deadlineAt - call.at).toBeLessThanOrEqual(getNodeTaskConfig().default_budget_ms);
  });

  it("T64: finishes the upload with nothing but the upload id and token it answered", async () => {
    const { projectId, cookie } = await seedEditor();
    const res = await requestTicket(cookie, picture(projectId));
    const { data } = (await res.json()) as { data: { storageKey: string; uploadId: string; token: string } };

    const complete = await app.request(`/api/v1/assets/uploads/${data.uploadId}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-upload-token": data.token },
      body: JSON.stringify({ parts: [{ partNumber: 1, etag: "e1" }] }),
    });
    expect(complete.status).toBe(202);

    workerAnswers({ contentType: "image/png", sizeBytes: 4096 });
    try {
      const finished = await runQueuedFinish(data.storageKey);
      expect(finished.outcome.status).toBe("registered");
    } finally {
      vi.unstubAllGlobals();
    }
    expect((await rowsFor(data.storageKey)).map((row) => row.status)).toEqual(["done"]);
    // Finishing opens nothing.
    expect(opensByKey().get(data.storageKey)).toBe(1);
  });

  it.each([
    ["T65: the Worker names its refusal", () => new UploadHttpError(502, "store_failed"), "store_failed"],
    ["T66: nothing answers", () => new TypeError("fetch failed"), INGEST_NO_ANSWER],
  ])("%s → 200 openFailed with the task id, grant voided, row failed, logged once", async (_label, failure, reason) => {
    const { userId, projectId, cookie } = await seedEditor();
    setOpenMode(() => failure());
    const request = picture(projectId);

    const res = await requestTicket(cookie, request);

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(Object.keys(data).sort()).toEqual(["openFailed", "taskId"]);
    expect(data.openFailed).toEqual({ reason });
    expect(Object.keys(data.openFailed as object)).toEqual(["reason"]);

    const grants = await grantsOf(userId);
    expect(grants).toHaveLength(1);
    const key = grants[0]!.storage_key;
    expect(grants[0]!.voided_at).not.toBeNull();
    const rows = await rowsFor(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed");
    expect(data.taskId).toBe(rows[0]!.id);

    const docName = canvasSpaceDocName(projectId, request.space_id as string);
    const events = (await eventsFor(docName)).filter((e) => e.nodeId === request.node_id);
    expect(events.some((e) => e.counts.failed === 1)).toBe(true);

    const lines = openFailedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ key, reason, userId, projectId });
    expect(lines[0]!.err).toBeDefined();
    expect(opensByKey().get(key)).toBe(1);
  });

  it.each([
    ["a project upload with no node", (seed: Awaited<ReturnType<typeof seedEditor>>) => body({
      project_id: seed.projectId, filename: "crop.png", content_type: "image/png", size: 4096,
    })],
    ["a studio's avatar", (seed: Awaited<ReturnType<typeof seedEditor>>) => body({
      studio_id: seed.studioId, purpose: "studio_avatar", filename: "me.png", content_type: "image/png", size: 4096,
    })],
  ])("T67: an open that fails for %s answers openFailed with no task id", async (_label, make) => {
    const seed = await seedEditor();
    setOpenMode(() => new UploadHttpError(500, null));

    const res = await requestTicket(seed.cookie, make(seed));

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toEqual({ openFailed: { reason: INGEST_REFUSED_UNNAMED } });
    expect(Object.keys(data)).toEqual(["openFailed"]);
    const grants = await grantsOf(seed.userId);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.voided_at).not.toBeNull();
    expect(await rowsFor(grants[0]!.storage_key)).toEqual([]);
  });

  it("T68: the browser's failure report after openFailed changes nothing and is logged as late", async () => {
    const { userId, projectId, cookie } = await seedEditor();
    setOpenMode(() => new UploadHttpError(502, "store_failed"));
    const request = picture(projectId);
    const res = await requestTicket(cookie, request);
    const { data } = (await res.json()) as { data: { taskId: string } };
    const key = (await grantsOf(userId))[0]!.storage_key;
    const [before] = await rowsFor(key);

    const report = await app.request(`/api/v1/canvas/node-tasks/${data.taskId}/failure`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ reason: "aborted" }),
    });

    expect(report.status).toBe(200);
    const after = await rowsFor(key);
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe("failed");
    expect(after[0]!.settled_at).toEqual(before!.settled_at);
    const late = logged.info.mock.calls.filter((call) => call[1] === "upload_transfer_failed_late");
    expect(late).toHaveLength(1);
    expect(late[0]![0]).toMatchObject({ taskId: data.taskId, applied: false });
    const onNode = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM node_tasks WHERE node_id = ${request.node_id as string}
    `;
    expect(onNode[0]!.n).toBe(1);
  });

  it("T69: a retry after a failed open is a new ticket under a new key", async () => {
    const { userId, projectId, cookie } = await seedEditor();
    setOpenMode(() => new UploadHttpError(502, "store_failed"));
    const request = picture(projectId);
    await requestTicket(cookie, request);
    const oldKey = (await grantsOf(userId))[0]!.storage_key;

    setOpenMode(() => "ok");
    const retry = await requestTicket(cookie, { ...request, client_hash: request.client_hash });

    expect(retry.status).toBe(201);
    const { data } = (await retry.json()) as { data: { storageKey: string } };
    expect(data.storageKey).not.toBe(oldKey);
    expect(opensByKey().get(data.storageKey)).toBe(1);
    expect(opensByKey().get(oldKey)).toBe(1);
    const grants = await grantsOf(userId);
    expect(grants.find((g) => g.storage_key === oldKey)!.voided_at).not.toBeNull();
    expect(grants.find((g) => g.storage_key === data.storageKey)!.voided_at).toBeNull();
    expect((await rowsFor(oldKey)).map((row) => row.status)).toEqual(["failed"]);
    expect((await rowsFor(data.storageKey)).map((row) => row.status)).toEqual(["running"]);
  });

  it("T70a: a dedup hit opens nothing", async () => {
    const { projectId, cookie, studioId, userId } = await seedEditor();
    const hash = crypto.randomBytes(32).toString("hex");
    await registerAsset(studioId, userId, hash, 4096);

    const res = await requestTicket(cookie, picture(projectId, { client_hash: hash }));

    expect(res.status).toBe(200);
    expect(openCalls()).toEqual([]);
  });

  it("T70b: a file over the cap opens nothing", async () => {
    const { projectId, cookie } = await seedEditor();

    const res = await requestTicket(cookie, picture(projectId, { size: 3 * 1024 * 1024 * 1024 }));

    expect(res.status).toBe(413);
    expect(openCalls()).toEqual([]);
  });

  it("T70c: a project the caller is not in opens nothing", async () => {
    const mine = await seedEditor();
    const theirs = await seedEditor();

    const res = await requestTicket(mine.cookie, picture(theirs.projectId));

    expect(res.status).toBe(404);
    expect(openCalls()).toEqual([]);
  });

  it("T76: five tickets asked at once each open their own upload once", async () => {
    const { projectId, cookie } = await seedEditor();

    const answers = await Promise.all(Array.from({ length: 5 }, () => requestTicket(cookie, picture(projectId))));

    expect(answers.map((res) => res.status)).toEqual([201, 201, 201, 201, 201]);
    const keys = await Promise.all(
      answers.map(async (res) => ((await res.json()) as { data: { storageKey: string } }).data.storageKey),
    );
    expect(new Set(keys).size).toBe(5);
    expect(keys.map((key) => opensByKey().get(key))).toEqual([1, 1, 1, 1, 1]);
  });

  it("T77: logs the upload id it answered with", async () => {
    const { projectId, cookie } = await seedEditor();

    const res = await requestTicket(cookie, picture(projectId));
    const { data } = (await res.json()) as { data: { uploadId: string } };

    const issued = logged.info.mock.calls.filter((call) => call[1] === "upload_ticket_issued");
    expect(issued).toHaveLength(1);
    expect(issued[0]![0]).toMatchObject({ uploadId: data.uploadId });
  });
});
