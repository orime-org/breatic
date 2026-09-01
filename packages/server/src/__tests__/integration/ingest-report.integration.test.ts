// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `POST /assets/ingest-report` — what the ingest Worker tells us, and what we
 * do about it (task #173, design §4.6 and §5).
 *
 * This endpoint has no user session behind it. The caller is the Worker, and
 * everything it knows came from a ticket we signed, so the only thing it can
 * prove is that it holds the shared secret. Every fact that decides where the
 * bytes are charged and which node they land on is read off the grant row we
 * wrote when the ticket was minted.
 *
 * The node is the part a user sees. Whatever this endpoint decides, it ends
 * with an event carrying the grant's `lease_gen`: success clears the node's
 * handling state and gives it the URL, failure clears it and leaves an error.
 * Without that event the node sits spinning until collab's hour-long sweeper
 * reclaims it.
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
import { Queue } from "bullmq";
import {
  initCore,
  getRedis,
  getStreamRedis,
  setSession,
  sessionCookieName,
  loadLocales,
  taskEventsStreamKey,
  createQueue,
} from "@breatic/core";
import {
  VIDEO_COVER_QUEUE,
  videoCoverJobId,
  type VideoCoverJobData,
} from "@breatic/domain";
import { canvasSpaceDocName } from "@breatic/shared";
import type { Hono } from "hono";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

const INGEST_SECRET = process.env.INGEST_SHARED_SECRET ?? "";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "ingest-report-test-driver" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/** A user, their personal studio, a project, a space id, and a session. */
async function seedEditor(): Promise<{
  userId: string;
  studioId: string;
  projectId: string;
  spaceId: string;
  cookie: string;
}> {
  const users = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`ir-${seq++}@example.com`}, true) RETURNING id
  `;
  const userId = users[0]!.id;
  const studios = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`ir-s-${seq++}`}, 'personal', 'Personal') RETURNING id
  `;
  const studioId = studios[0]!.id;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${userId}, 'admin')
  `;
  const slug = `ir-proj-${seq++}`;
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
    spaceId: crypto.randomUUID(),
    cookie: `${sessionCookieName()}=${token}`,
  };
}

/**
 * Walk the whole flow the browser would: ask for a ticket, and hand back the
 * key the Worker will report on. Going through the real endpoint is the point
 * — a grant hand-written here could carry a shape the ticket endpoint never
 * produces, and this suite would then be testing a row nothing writes.
 */
async function mintTicket(
  seed: Awaited<ReturnType<typeof seedEditor>>,
  over: Record<string, unknown> = {},
): Promise<string> {
  const res = await app.request("/api/v1/assets/upload-ticket", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: seed.cookie },
    body: JSON.stringify({
      filename: "shot.png",
      content_type: "image/png",
      project_id: seed.projectId,
      space_id: seed.spaceId,
      size: 4096,
      client_hash: crypto.randomBytes(32).toString("hex"),
      lease_gen: 7,
      ...over,
    }),
  });
  const payload = (await res.json()) as { data: { storageKey: string } };
  return payload.data.storageKey;
}

/** POST a report the way the ingest Worker would. */
async function report(
  body: Record<string, unknown>,
  secret: string = INGEST_SECRET,
): Promise<Response> {
  return app.request("/api/v1/assets/ingest-report", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ingest-secret": secret },
    body: JSON.stringify(body),
  });
}

/** A completed report for `storageKey`, with the parts a caller varies. */
function completed(
  storageKey: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    storage_key: storageKey,
    outcome: "completed",
    lease_gen: 7,
    sha256: crypto.randomBytes(32).toString("hex"),
    size_bytes: 4096,
    content_type: "image/png",
    ...over,
  };
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

describe("POST /assets/ingest-report — who may call it", () => {
  it("refuses a report with no shared secret", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed);

    const res = await app.request("/api/v1/assets/ingest-report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(completed(key)),
    });

    expect(res.status).toBe(401);
  });

  it("refuses a report whose secret does not match, registering nothing", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed);

    const res = await report(completed(key), `${INGEST_SECRET}-wrong`);

    expect(res.status).toBe(401);
    const rows = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM studio_assets WHERE studio_id = ${seed.studioId}
    `;
    expect(rows[0]!.n).toBe("0");
  });

  it("refuses a key that was never issued", async () => {
    const res = await report(completed("image/2026-08-30/never-issued.png"));

    expect(res.status).toBe(404);
  });
});

describe("POST /assets/ingest-report — a completed upload", () => {
  // The hash is what the ledger keys on, so a success that names none would
  // register a row under the empty string. The second such row anywhere in the
  // studio then collides on `(studio_id, content_hash)`, and every later upload
  // of unknown bytes dedups against whatever got there first.
  it("refuses a success that names no hash, registering nothing", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed);
    const { sha256: _omitted, ...noHash } = completed(key);

    const res = await report(noHash);

    expect(res.status).toBe(422);
    const rows = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM studio_assets WHERE studio_id = ${seed.studioId}
    `;
    expect(rows[0]!.n).toBe("0");
  });

  it("registers the asset under the grant's studio and consumes the grant", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });
    const sha = crypto.randomBytes(32).toString("hex");

    const res = await report(completed(key, { sha256: sha }));

    expect(res.status).toBe(200);
    const assets = await sql<
      { studio_id: string; content_hash: string; storage_key: string; kind: string }[]
    >`
      SELECT studio_id, content_hash, storage_key, kind FROM studio_assets
      WHERE content_hash = ${sha}
    `;
    expect(assets).toHaveLength(1);
    // The studio comes off the grant, never off anything the Worker said.
    expect(assets[0]!.studio_id).toBe(seed.studioId);
    expect(assets[0]!.storage_key).toBe(key);
    expect(assets[0]!.kind).toBe("image");

    const grants = await sql<{ consumed_at: Date | null }[]>`
      SELECT consumed_at FROM upload_grants WHERE storage_key = ${key}
    `;
    expect(grants[0]!.consumed_at).not.toBeNull();
  });

  it("keys the ledger on the hash the Worker computed, not the one the browser claimed", async () => {
    const seed = await seedEditor();
    const claimed = crypto.randomBytes(32).toString("hex");
    const key = await mintTicket(seed, { client_hash: claimed });
    const actual = crypto.randomBytes(32).toString("hex");

    await report(completed(key, { sha256: actual }));

    // Only the Worker has seen the bytes. The browser's claim was good enough
    // to answer "have we got this already?" before the upload; it is not good
    // enough to name what actually landed.
    const rows = await sql<{ content_hash: string }[]>`
      SELECT content_hash FROM studio_assets WHERE storage_key = ${key}
    `;
    expect(rows[0]!.content_hash).toBe(actual);
  });

  it("gives the node its URL through an event carrying the grant's lease gen", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId, lease_gen: 42 });

    await report(completed(key, { lease_gen: 42 }));

    const docName = `project-${seed.projectId}/canvas-${seed.spaceId}`;
    const events = (await eventsFor(docName)).filter((e) => e.nodeId === nodeId);
    expect(events).toHaveLength(1);
    expect(events[0]!.gen).toBe(42);
    expect(events[0]!.update.state).toBe("idle");
    // Collab deletes the key on null, which is what takes the node out of
    // handling; a stale error has to go with it.
    expect(events[0]!.update.handlingBy).toBeNull();
    expect(events[0]!.update.errorMessage).toBeNull();
    expect(typeof events[0]!.update.content).toBe("string");
  });

  it("records the upload in the node's history and in the project's feed", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });

    await report(completed(key));

    const history = await sql<{ entry_type: string; status: string }[]>`
      SELECT entry_type, status FROM node_history
      WHERE node_id = ${nodeId} AND deleted_at IS NULL
    `;
    expect(history).toHaveLength(1);
    expect(history[0]!.entry_type).toBe("upload");
    expect(history[0]!.status).toBe("success");

    const feed = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM project_activities
      WHERE project_id = ${seed.projectId} AND type = 'asset:uploaded'
    `;
    expect(feed[0]!.n).toBe("1");
  });

  it("reuses the existing row when the bytes turn out to be a duplicate", async () => {
    const seed = await seedEditor();
    const sha = crypto.randomBytes(32).toString("hex");

    const firstKey = await mintTicket(seed);
    await report(completed(firstKey, { sha256: sha }));

    // A second upload of the same content, started before the first finished:
    // the pass at ticket time could not have seen it yet.
    const secondKey = await mintTicket(seed);
    const res = await report(completed(secondKey, { sha256: sha }));

    expect(res.status).toBe(200);
    // One row per (studio, content), so the second upload resolves onto the
    // first one's row rather than adding another.
    const assets = await sql<{ storage_key: string }[]>`
      SELECT storage_key FROM studio_assets WHERE content_hash = ${sha}
    `;
    expect(assets).toHaveLength(1);
    expect(assets[0]!.storage_key).toBe(firstKey);

    // The copy nobody needs is registered for offline reclaim rather than
    // deleted here — runtime never destroys a stored object.
    const queued = await sql<{ kept_storage_key: string }[]>`
      SELECT kept_storage_key FROM storage_reclaim_queue
      WHERE storage_key = ${secondKey}
    `;
    expect(queued).toHaveLength(1);
    expect(queued[0]!.kept_storage_key).toBe(firstKey);
  });

  it("refuses bytes over the upload cap, and tells the node it failed", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });

    // The size the browser declared passed the cap; what actually arrived did
    // not. Only this side of the upload knows the real number.
    const res = await report(
      completed(key, { size_bytes: 3 * 1024 * 1024 * 1024 }),
    );

    expect(res.status).toBe(413);
    const assets = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM studio_assets WHERE storage_key = ${key}
    `;
    expect(assets[0]!.n).toBe("0");

    const grants = await sql<{ voided_at: Date | null; consumed_at: Date | null }[]>`
      SELECT voided_at, consumed_at FROM upload_grants WHERE storage_key = ${key}
    `;
    expect(grants[0]!.voided_at).not.toBeNull();
    expect(grants[0]!.consumed_at).toBeNull();

    // Not the reclaim queue. What that table lists is a known DUPLICATE, and
    // its safety comes from the surviving row it names: the offline job checks
    // the winner still exists before deleting the loser. This object has no
    // winner — it is an orphan, and the voided grant is what records it for
    // the operations-side cleanup (#176).
    const queued = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM storage_reclaim_queue WHERE storage_key = ${key}
    `;
    expect(queued[0]!.n).toBe("0");

    const docName = `project-${seed.projectId}/canvas-${seed.spaceId}`;
    const events = (await eventsFor(docName)).filter((e) => e.nodeId === nodeId);
    expect(events).toHaveLength(1);
    expect(events[0]!.update.handlingBy).toBeNull();
    expect(typeof events[0]!.update.errorMessage).toBe("string");
  });
});

// The whole retry chain rests on this. A report answered 2xx tells the Durable
// Object it is done and its alarm is deleted, so an answer given while the
// node was never told leaves that node in handling with nothing left to reach
// it — the alarm that would have tried again is gone.
describe("POST /assets/ingest-report — an event that could not be published", () => {
  it("refuses the report so the Durable Object keeps its alarm", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed, { node_id: crypto.randomUUID() });

    const xadd = vi
      .spyOn(getStreamRedis(), "xadd")
      .mockRejectedValueOnce(new Error("the stream's Redis is unreachable"));
    const res = await report(completed(key));
    xadd.mockRestore();

    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it("finishes on the report that follows", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });
    const xadd = vi
      .spyOn(getStreamRedis(), "xadd")
      .mockRejectedValueOnce(new Error("the stream's Redis is unreachable"));
    await report(completed(key));
    xadd.mockRestore();

    expect((await report(completed(key))).status).toBe(200);

    const events = await eventsFor(
      canvasSpaceDocName(seed.projectId, seed.spaceId),
    );
    expect(events.filter((e) => e.nodeId === nodeId)).toHaveLength(1);
  });
});

describe("POST /assets/ingest-report — an aborted upload", () => {
  it("voids the grant and tells the node, without registering anything", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });

    const res = await report({
      storage_key: key,
      outcome: "aborted",
      lease_gen: 7,
      reason: "parts_missing",
    });

    expect(res.status).toBe(200);
    const assets = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM studio_assets WHERE storage_key = ${key}
    `;
    expect(assets[0]!.n).toBe("0");

    const grants = await sql<{ voided_at: Date | null }[]>`
      SELECT voided_at FROM upload_grants WHERE storage_key = ${key}
    `;
    expect(grants[0]!.voided_at).not.toBeNull();

    // The node has been sitting in handling since before the first byte moved.
    // This event is the only thing that takes it out.
    const docName = `project-${seed.projectId}/canvas-${seed.spaceId}`;
    const events = (await eventsFor(docName)).filter((e) => e.nodeId === nodeId);
    expect(events).toHaveLength(1);
    expect(events[0]!.gen).toBe(7);
    expect(events[0]!.update.handlingBy).toBeNull();
    expect(typeof events[0]!.update.errorMessage).toBe("string");
  });
});

describe("POST /assets/ingest-report — the same report twice", () => {
  it("answers the second one with the same URL and publishes the event again", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });
    const body = completed(key);

    const first = await report(body);
    const second = await report(body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = (await first.json()) as { data: { fileUrl: string } };
    const b = (await second.json()) as { data: { fileUrl: string } };
    expect(b.data.fileUrl).toBe(a.data.fileUrl);

    // One asset, one history row: the retry registers nothing new.
    const assets = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM studio_assets WHERE storage_key = ${key}
    `;
    expect(assets[0]!.n).toBe("1");
    const history = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM node_history
      WHERE node_id = ${nodeId} AND deleted_at IS NULL
    `;
    expect(history[0]!.n).toBe("1");

    // The event goes out again on purpose. A retry means the Durable Object
    // did not hear us the first time, and the likeliest reason is that the
    // event never reached the node. Collab applies it last-write-wins.
    const docName = `project-${seed.projectId}/canvas-${seed.spaceId}`;
    const events = (await eventsFor(docName)).filter((e) => e.nodeId === nodeId);
    expect(events).toHaveLength(2);
    expect(events[1]!.update.content).toBe(a.data.fileUrl);
  });
});

describe("a video, which needs a cover before the node hears anything", () => {
  /** The cover job queued for one upload's key, or null. */
  async function coverJobFor(storageKey: string): Promise<{
    data: VideoCoverJobData;
  } | null> {
    const queue = createQueue(VIDEO_COVER_QUEUE);
    const job = await queue.getJob(videoCoverJobId(storageKey));
    return job ? { data: job.data as VideoCoverJobData } : null;
  }

  /** Mint a ticket for a video and report it complete. */
  async function uploadVideo(
    seed: Awaited<ReturnType<typeof seedEditor>>,
    over: Record<string, unknown> = {},
  ): Promise<{ key: string; nodeId: string }> {
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, {
      filename: "clip.mp4",
      content_type: "video/mp4",
      node_id: nodeId,
      ...over,
    });
    await report(
      completed(key, { content_type: "video/mp4", size_bytes: 200_000 }),
    );
    return { key, nodeId };
  }

  it("registers the video and consumes the grant like any other upload", async () => {
    const seed = await seedEditor();
    const { key } = await uploadVideo(seed);

    const assets = await sql<{ kind: string }[]>`
      SELECT kind FROM studio_assets WHERE storage_key = ${key}
    `;
    expect(assets[0]!.kind).toBe("video");
    const grants = await sql<{ consumed_at: Date | null }[]>`
      SELECT consumed_at FROM upload_grants WHERE storage_key = ${key}
    `;
    expect(grants[0]!.consumed_at).not.toBeNull();
  });

  // Everything the node sees is written once, after the cover is settled. A
  // history row now would have no thumbnail and never gain one; an event now
  // would put a cover-less video on screen and replace it a moment later.
  it("writes no history row, no feed row and no event yet", async () => {
    const seed = await seedEditor();
    const { key, nodeId } = await uploadVideo(seed);

    const history = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM node_history WHERE upload_storage_key = ${key}
    `;
    expect(history[0]!.n).toBe("0");
    const feed = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM project_activities
      WHERE project_id = ${seed.projectId} AND node_id = ${nodeId}
    `;
    expect(feed[0]!.n).toBe("0");
    const events = await eventsFor(
      canvasSpaceDocName(seed.projectId, seed.spaceId),
    );
    expect(events.filter((e) => e.nodeId === nodeId)).toHaveLength(0);
  });

  it("hands the worker the registered video, its studio and the node's lease", async () => {
    const seed = await seedEditor();
    const { key, nodeId } = await uploadVideo(seed);

    const job = await coverJobFor(key);
    expect(job).not.toBeNull();
    const rows = await sql<{ id: string; file_url: string }[]>`
      SELECT id, file_url FROM studio_assets WHERE storage_key = ${key}
    `;
    expect(job!.data).toMatchObject({
      storageKey: key,
      videoAssetId: rows[0]!.id,
      videoUrl: rows[0]!.file_url,
      ownerStudioId: seed.studioId,
      userId: seed.userId,
      projectId: seed.projectId,
      spaceId: seed.spaceId,
      nodeId,
      leaseGen: 7,
      mimeType: "video/mp4",
      filename: "clip.mp4",
    });
  });

  // A video's whole outcome hangs on this job: it writes the history row, the
  // feed row and the one event the node gets. A grant marked consumed before
  // the job exists turns the next report into the already-registered answer,
  // and nothing is then left that could still queue it — the upload's bytes
  // are safe in R2 while its node spins until the sweeper reclaims it.
  it("leaves the grant unconsumed when the cover job cannot be queued", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed, {
      filename: "clip.mp4",
      content_type: "video/mp4",
      node_id: crypto.randomUUID(),
    });

    const add = vi
      .spyOn(Queue.prototype, "add")
      .mockRejectedValueOnce(new Error("the queue's Redis is unreachable"));
    const refused = await report(
      completed(key, { content_type: "video/mp4", size_bytes: 200_000 }),
    );
    add.mockRestore();

    expect(refused.status).toBe(500);
    const grants = await sql<{ consumed_at: Date | null }[]>`
      SELECT consumed_at FROM upload_grants WHERE storage_key = ${key}
    `;
    expect(grants[0]!.consumed_at).toBeNull();
  });

  it("queues the job and consumes the grant on the report that follows", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, {
      filename: "clip.mp4",
      content_type: "video/mp4",
      node_id: nodeId,
    });
    const add = vi
      .spyOn(Queue.prototype, "add")
      .mockRejectedValueOnce(new Error("the queue's Redis is unreachable"));
    await report(completed(key, { content_type: "video/mp4", size_bytes: 200_000 }));
    add.mockRestore();

    const second = await report(
      completed(key, { content_type: "video/mp4", size_bytes: 200_000 }),
    );

    expect(second.status).toBe(200);
    expect(await coverJobFor(key)).not.toBeNull();
    const grants = await sql<{ consumed_at: Date | null }[]>`
      SELECT consumed_at FROM upload_grants WHERE storage_key = ${key}
    `;
    expect(grants[0]!.consumed_at).not.toBeNull();
  });

  // The job id is the storage key, so the Durable Object retrying its report
  // cannot start a second extraction of the same upload.
  it("queues one job however many times the report arrives", async () => {
    const seed = await seedEditor();
    const { key } = await uploadVideo(seed);

    await report(
      completed(key, { content_type: "video/mp4", size_bytes: 200_000 }),
    );

    const queue = createQueue(VIDEO_COVER_QUEUE);
    const waiting = await queue.getJobs(["waiting", "delayed", "active"]);
    expect(waiting.filter((j) => j.data.storageKey === key)).toHaveLength(1);
  });

  // The cover job sends the one event this node gets. A video-only event here
  // would beat it to the node, or undo the cover it already showed.
  it("stays quiet when the report arrives again", async () => {
    const seed = await seedEditor();
    const { key, nodeId } = await uploadVideo(seed);

    await report(
      completed(key, { content_type: "video/mp4", size_bytes: 200_000 }),
    );

    const events = await eventsFor(
      canvasSpaceDocName(seed.projectId, seed.spaceId),
    );
    expect(events.filter((e) => e.nodeId === nodeId)).toHaveLength(0);
  });

  // Within a studio the same bytes are one row, so a second upload of the same
  // video resolves to the first one's object — and the key this upload just
  // wrote is what the reclaim job removes. Sending the worker that key would
  // have it extract from an object about to disappear and pin the node to it.
  it("hands over the surviving object's URL when the video already existed", async () => {
    const seed = await seedEditor();
    const sharedHash = crypto.randomBytes(32).toString("hex");

    const firstKey = await mintTicket(seed, {
      filename: "clip.mp4",
      content_type: "video/mp4",
      node_id: crypto.randomUUID(),
    });
    await report(
      completed(firstKey, {
        content_type: "video/mp4",
        size_bytes: 200_000,
        sha256: sharedHash,
      }),
    );

    const secondNodeId = crypto.randomUUID();
    const secondKey = await mintTicket(seed, {
      filename: "clip.mp4",
      content_type: "video/mp4",
      node_id: secondNodeId,
    });
    await report(
      completed(secondKey, {
        content_type: "video/mp4",
        size_bytes: 200_000,
        sha256: sharedHash,
      }),
    );

    const rows = await sql<{ id: string; file_url: string }[]>`
      SELECT id, file_url FROM studio_assets WHERE storage_key = ${firstKey}
    `;
    const job = await coverJobFor(secondKey);
    expect(job!.data.videoAssetId).toBe(rows[0]!.id);
    expect(job!.data.videoUrl).toBe(rows[0]!.file_url);
    expect(job!.data.videoUrl).not.toContain(secondKey);
  });

  it("queues nothing for an image, which needs no cover", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });
    await report(completed(key));

    expect(await coverJobFor(key)).toBeNull();
  });

  // Without a node there is nobody to show a cover to, and the payload has no
  // place to put the fields the worker writes its downstreams from.
  it("queues nothing for a video that no node is waiting on", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed, {
      filename: "clip.mp4",
      content_type: "video/mp4",
    });
    await report(
      completed(key, { content_type: "video/mp4", size_bytes: 200_000 }),
    );

    // No node id was declared, so nothing is waiting to be told.
    expect(await coverJobFor(key)).toBeNull();
  });
});
