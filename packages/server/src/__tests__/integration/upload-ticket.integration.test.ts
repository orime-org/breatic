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

import crypto from "node:crypto";
import postgres from "postgres";
import {
  createQueue,
  initCore,
  getRedis,
  getStreamRedis,
  setSession,
  sessionCookieName,
  loadLocales,
  taskEventsStreamKey,
} from "@breatic/core";
import { verifyUploadTicket, canvasSpaceDocName } from "@breatic/shared";
import { VIDEO_COVER_QUEUE, videoCoverJobId } from "@breatic/domain";
import type { Hono } from "hono";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

/**
 * The same secret `integration-setup.ts` hands the server. Read from the
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

afterAll(async () => {
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
    INSERT INTO projects (studio_id, created_by_user_id, name, slug, visibility)
    VALUES (${studioId}, ${userId}, ${`P ${slug}`}, ${slug}, 'private')
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
  kind: "video" | "image" = "video",
): Promise<void> {
  const isVideo = kind === "video";
  const ext = isVideo ? "mp4" : "png";
  await sql`
    INSERT INTO studio_assets
      (studio_id, content_hash, storage_key, file_url, size_bytes,
       mime_type, kind, source, produced_by_user_id)
    VALUES
      (${studioId}, ${contentHash}, ${`${kind}/${contentHash}.${ext}`},
       ${`https://cdn.test.invalid/${contentHash}.${ext}`}, ${sizeBytes},
       ${isVideo ? "video/mp4" : "image/png"}, ${kind}, 'upload',
       ${producedByUserId})
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
    lease_gen: 6,
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

/** Every node-state event on the stream for `docName`, oldest first. */
async function eventsFor(docName: string): Promise<
  { nodeId: string; gen: number; update: Record<string, unknown> }[]
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
        e !== null && e.type === "node-state-update" && e.docName === docName,
    )
    .map((e) => ({
      nodeId: e.nodeId as string,
      gen: e.gen as number,
      update: e.update as Record<string, unknown>,
    }));
}

describe("POST /assets/upload-ticket", () => {
  it("mints a ticket the ingest Worker's own verifier accepts", async () => {
    const { projectId, cookie } = await seedEditor();

    const res = await requestTicket(cookie, body({ project_id: projectId }));

    expect(res.status).toBe(201);
    const payload = (await res.json()) as {
      data: { ticket: string; storageKey: string; uploadUrl: string };
    };
    expect(payload.data.storageKey).toMatch(/\.mp4$/);
    expect(payload.data.uploadUrl.startsWith("https://ingest.test.invalid")).toBe(
      true,
    );

    const verified = await verifyUploadTicket(
      payload.data.ticket,
      INGEST_SECRET,
      Date.now(),
    );
    expect(verified.ok).toBe(true);
  });

  // What the Worker acts on, and nothing more. The fencing generation is not
  // among it: the Worker never reads one, and every consequence of this upload
  // takes it off the grant row instead.
  it("signs the storage key, the content type and the expiry into the ticket", async () => {
    const { projectId, cookie } = await seedEditor();

    const res = await requestTicket(
      cookie,
      body({ project_id: projectId, lease_gen: 42 }),
    );
    const payload = (await res.json()) as {
      data: { ticket: string; storageKey: string };
    };
    const verified = await verifyUploadTicket(
      payload.data.ticket,
      INGEST_SECRET,
      Date.now(),
    );

    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.payload.storageKey).toBe(payload.data.storageKey);
    expect(verified.payload.contentType).toBe("video/mp4");
    expect(verified.payload).not.toHaveProperty("leaseGen");
    // The expiry is what the Worker checks when the browser asks to start, so
    // a ticket has to arrive with room left on it.
    expect(verified.payload.expiresAt).toBeGreaterThan(Date.now());
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
        lease_gen: number;
        consumed_at: Date | null;
        voided_at: Date | null;
      }[]
    >`
      SELECT user_id, project_id, node_id, lease_gen, consumed_at, voided_at
      FROM upload_grants WHERE storage_key = ${payload.data.storageKey}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id).toBe(userId);
    expect(rows[0]!.project_id).toBe(projectId);
    expect(rows[0]!.node_id).toBe(nodeId);
    expect(rows[0]!.lease_gen).toBe(6);
    expect(rows[0]!.consumed_at).toBeNull();
    expect(rows[0]!.voided_at).toBeNull();
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

    const grants = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM upload_grants WHERE studio_id = ${studioId}
    `;
    expect(grants[0]!.n).toBe("0");
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

  it("distrusts a hash whose declared size disagrees with the stored row", async () => {
    const { projectId, cookie, studioId, userId } = await seedEditor();
    const hash = crypto.randomBytes(32).toString("hex");
    await registerAsset(studioId, userId, hash, 40 * 1024 * 1024);

    // The hash is the client's claim about content it has not sent. Matching
    // it against a row of a different length would hand back somebody else's
    // file, so the mismatch falls through to a real upload.
    const res = await requestTicket(
      cookie,
      body({ project_id: projectId, client_hash: hash, size: 40 * 1024 * 1024 + 1 }),
    );

    expect(res.status).toBe(201);
    const payload = (await res.json()) as {
      data: { ticket?: string; alreadyExists?: boolean };
    };
    expect(payload.data.alreadyExists).toBeUndefined();
    expect(typeof payload.data.ticket).toBe("string");
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
    // An image: nothing about it is extracted afterwards, so the hit is the
    // whole of what this node will be told.
    await registerAsset(studioId, userId, hash, size, "image");
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
        lease_gen: 9,
      }),
    );

    const docName = canvasSpaceDocName(projectId, spaceId);
    const events = (await eventsFor(docName)).filter((e) => e.nodeId === nodeId);
    expect(events).toHaveLength(1);
    expect(events[0]!.gen).toBe(9);
    expect(events[0]!.update).toMatchObject({
      content: `https://cdn.test.invalid/${hash}.png`,
    });
  });

  // Nothing uploads on a hit, so no cover job runs and this event is the only
  // one this node will get. A video node reads `coverUrl` for its poster, so
  // an event carrying the video alone leaves the second node showing a
  // modality icon where the first shows a frame — from the same file.
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
        lease_gen: 9,
      }),
    );

    const docName = canvasSpaceDocName(projectId, spaceId);
    const events = (await eventsFor(docName)).filter((e) => e.nodeId === nodeId);
    expect(events[0]!.update).toMatchObject({
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

  // The event is the only thing that brings this node out of handling, so a
  // failure to publish fails the request — and the browser's own retry sends
  // the same request again. A history row written before that failure records
  // an attempt that did not happen, and the retry writes a second one; a hit
  // has no grant, so there is no key these rows could dedup on.
  it("leaves no history row behind when the event cannot be published", async () => {
    const { projectId, cookie, studioId, userId } = await seedEditor();
    const hash = crypto.randomBytes(32).toString("hex");
    const size = 40 * 1024 * 1024;
    await registerAsset(studioId, userId, hash, size, "image");
    const nodeId = crypto.randomUUID();

    // The same lazy singleton the service publishes through.
    const xadd = vi
      .spyOn(getStreamRedis(), "xadd")
      .mockRejectedValueOnce(new Error("the stream's Redis is unreachable"));
    const refused = await requestTicket(
      cookie,
      body({
        project_id: projectId,
        client_hash: hash,
        size,
        node_id: nodeId,
        space_id: crypto.randomUUID(),
      }),
    );
    xadd.mockRestore();

    expect(refused.status).toBe(500);
    const rows = await sql`SELECT id FROM node_history WHERE node_id = ${nodeId}`;
    expect(rows).toHaveLength(0);
  });

  // A video's cover is extracted after its row lands, so a hit that arrives in
  // that window finds a video with no cover yet. Announcing then would put a
  // cover-less video on this node for good: the extraction running for the
  // first upload announces to its own node and no other, and a hit sends no
  // second event. The node joins that wait instead.
  it("waits for the cover when the deduped video has not got one yet", async () => {
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
        lease_gen: 9,
      }),
    );

    const events = (await eventsFor(canvasSpaceDocName(projectId, spaceId)))
      .filter((e) => e.nodeId === nodeId);
    expect(events).toHaveLength(0);
    const assets = await sql<{ id: string }[]>`
      SELECT id FROM studio_assets WHERE content_hash = ${hash} AND kind = 'video'
    `;
    const queue = createQueue(VIDEO_COVER_QUEUE);
    const job = await queue.getJob(videoCoverJobId(assets[0]!.id, nodeId));
    expect(job).not.toBeNull();
    expect(job?.data).toMatchObject({ nodeId, videoAssetId: assets[0]!.id });
  });

  // A focus crop asks with no node. There is nothing to announce to, and the
  // answer to this request is how that path hears its result.
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
