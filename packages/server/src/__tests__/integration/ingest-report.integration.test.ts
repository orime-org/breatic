// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * `POST /assets/uploads/{uploadId}/complete` — this server finishing an upload
 * at the Worker, and what it does with what came back (task #173 design §4.6
 * and §5, #206 design §3).
 *
 * The Worker calls nobody. The browser sends back the upload id, the token its
 * last part answered with, and R2's receipt for each part; this server takes
 * the exclusive permission, asks the Worker to assemble, and registers what it
 * measured. Nothing the caller says decides anything: the key comes out of the
 * signature the Worker verified on every part, and every fact about where the
 * bytes are charged and which node they land on is read off the grant row
 * written when the ticket was minted.
 *
 * The node is the part a user sees. However this ends, it settles the task row
 * the ticket opened and publishes the node's four counts: success carries the
 * content along, failure carries nothing and leaves the row failed. Without
 * that event the node keeps counting an upload that has already ended.
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
  backendUploadService,
  uploadGrantService,
  type VideoCoverJobData,
} from "@breatic/domain";
import { canvasSpaceDocName, signSessionToken } from "@breatic/shared";
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
const mintedBy = new Map<string, string>();

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
      ...over,
    }),
  });
  const payload = (await res.json()) as { data: { storageKey: string } };
  mintedBy.set(payload.data.storageKey, seed.cookie);
  return payload.data.storageKey;
}

const FINISH_UPLOAD_ID = "r2-upload-id";
const ONE_PART = [{ partNumber: 1, etag: "etag-1" }];

/**
 * Drive one upload's finish, with the Worker answering what `body` describes.
 *
 * The browser hands back what it holds and this server does the rest, so a
 * report is no longer something that arrives — it is what the Worker answers a
 * call with. A body describing an abort stands for a Worker that could not
 * turn the parts into an object.
 * @param body - What the Worker's answer amounts to.
 * @returns This server's answer to the browser.
 */
async function report(
  body: Record<string, unknown>,
  cookie?: string,
): Promise<Response> {
  const storageKey = body.storage_key as string;
  const contentType = (body.content_type as string) ?? "image/png";
  const token = await signSessionToken(
    {
      storageKey,
      uploadId: FINISH_UPLOAD_ID,
      contentType,
      sessionTokenTtlSeconds: 900,
      expiresAt: Date.now() + 900_000,
      partSize: 8 * 1024 * 1024,
      totalParts: ONE_PART.length,
    },
    INGEST_SECRET,
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      body.outcome === "completed"
        ? new Response(
            JSON.stringify({
              sha256: body.sha256,
              sizeBytes: body.size_bytes,
              contentType,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        : new Response("Could not assemble the object", { status: 502 }),
    ),
  );
  try {
    return await app.request(
      `/api/v1/assets/uploads/${FINISH_UPLOAD_ID}/complete`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-upload-token": token,
          ...((cookie ?? mintedBy.get(storageKey)) !== undefined && {
            cookie: (cookie ?? mintedBy.get(storageKey))!,
          }),
        },
        body: JSON.stringify({ parts: ONE_PART }),
      },
    );
  } finally {
    vi.unstubAllGlobals();
  }
}

/** A completed report for `storageKey`, with the parts a caller varies. */
function completed(
  storageKey: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    storage_key: storageKey,
    outcome: "completed",
    sha256: crypto.randomBytes(32).toString("hex"),
    size_bytes: 4096,
    content_type: "image/png",
    ...over,
  };
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

describe("a finish this server drove — a completed upload", () => {
  // The hash is what the ledger keys on, so a success that names none would
  // register a row under the empty string. The second such row anywhere in the
  // studio then collides on `(studio_id, content_hash)`, and every later upload
  // of unknown bytes dedups against whatever got there first.
  // The hash is what the ledger keys on, and it comes from the Worker rather
  // than from anyone asking. An answer without one is a Worker we cannot read,
  // so the upload fails rather than registering a row under the empty string.
  it("fails the upload when the Worker's answer names no hash", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed);
    const { sha256: _omitted, ...noHash } = completed(key);

    const res = await report(noHash);

    expect(res.status).toBe(502);
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

  it("gives the node its URL through the counts event that settles the task", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });

    await report(completed(key));

    const docName = `project-${seed.projectId}/canvas-${seed.spaceId}`;
    const events = (await eventsFor(docName)).filter((e) => e.nodeId === nodeId);
    // Two: the ticket opened the task, the report settled it.
    expect(events).toHaveLength(2);
    expect(events[0]!.counts).toEqual({
      running: 1,
      done: 0,
      failed: 0,
      expired: 0,
    });
    expect(events[1]!.counts).toEqual({
      running: 0,
      done: 1,
      failed: 0,
      expired: 0,
    });
    // The content rides on the transition that reached done, and on no other.
    expect(typeof events[1]!.result?.content).toBe("string");
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
    expect(events).toHaveLength(2);
    expect(events[1]!.counts).toMatchObject({ running: 0, failed: 1 });
    // A failure carries no content: the node keeps whatever it already had.
    expect(events[1]!.result).toBeUndefined();
  });
});

// The event that settles a successful upload is the only way its content
// reaches the node. Answering 2xx while that event was lost would end the
// delivery with nothing left to carry the result, so the report is refused
// and the Worker's own retry is what tries again.
describe("a finish this server drove — an upload the backend opened", () => {
  // The worker uploads its own output through the same ingest Worker (#181),
  // so what an upload is can no longer be assumed from the fact that it came
  // through here. It travels on the grant, which is written where the upload
  // was opened and is the only thing that outlives it -- the ingest Worker
  // knows nothing but the key it was told to write to.
  it("files the asset under what the grant says it is, and links its task", async () => {
    const seed = await seedEditor();
    const tasks = await sql<{ id: string }[]>`
      INSERT INTO tasks (user_id, project_id, space_id, task_type, mode, status)
      VALUES (${seed.userId}, ${seed.projectId}, ${seed.spaceId}, 'image', 'append', 'processing')
      RETURNING id
    `;
    const taskId = tasks[0]!.id;

    const { key } = await uploadGrantService.issueUploadGrant({
      projectId: seed.projectId,
      actingUserId: seed.userId,
      declaredSize: 4096,
      taskType: "image",
      ext: ".png",
      expiresAt: new Date(Date.now() + 60_000),
      context: { assetSource: "ai", generationTaskId: taskId, derived: true },
    });
    const sha = crypto.randomBytes(32).toString("hex");

    const res = await report(completed(key, { sha256: sha }), seed.cookie);

    expect(res.status).toBe(200);
    const rows = await sql<
      { source: string; generation_task_id: string | null; id: string }[]
    >`
      SELECT id, source, generation_task_id FROM studio_assets
      WHERE content_hash = ${sha}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("ai");
    // Without this an asset cannot be traced back to what it cost.
    expect(rows[0]!.generation_task_id).toBe(taskId);

    // The row it landed on, which is what a caller hanging a cover off this
    // asset has to be told -- it never sees the ledger itself.
    const answer = (await res.json()) as { data: { assetId: string } };
    expect(answer.data.assetId).toBe(rows[0]!.id);

    // The feed announces what a person did in the project. A generation's
    // output reaches it through the worker, which writes its own row; one
    // written here would be the second one for the same act.
    const feed = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM project_activities
      WHERE project_id = ${seed.projectId}
    `;
    expect(feed[0]!.n).toBe("0");
  });

  it("still files a browser upload as an upload", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed);
    const sha = crypto.randomBytes(32).toString("hex");

    await report(completed(key, { sha256: sha }));

    const rows = await sql<{ source: string; generation_task_id: string | null }[]>`
      SELECT source, generation_task_id FROM studio_assets
      WHERE content_hash = ${sha}
    `;
    expect(rows[0]!.source).toBe("upload");
    expect(rows[0]!.generation_task_id).toBeNull();
  });
});

describe("a finish this server drove — a backend upload that landed empty", () => {
  /**
   * Open a grant the way the worker does, for bytes it produced itself.
   * @param seed - The signed-in editor and their project.
   * @param assetSource - What the resulting asset would be.
   * @returns The minted storage key.
   */
  async function mintBackendGrant(
    seed: Awaited<ReturnType<typeof seedEditor>>,
    assetSource: "ai" | "cover",
  ): Promise<string> {
    const { key } = await uploadGrantService.issueUploadGrant({
      projectId: seed.projectId,
      actingUserId: seed.userId,
      declaredSize: 4096,
      taskType: "image",
      ext: ".png",
      expiresAt: new Date(Date.now() + 60_000),
      context: { assetSource, derived: true },
    });
    return key;
  }

  it("refuses it, so the generation fails instead of being billed for nothing", async () => {
    // A provider that answers 200 with no body produces a completed report of
    // zero bytes. Registering it hands the node an empty object and lets the
    // run reach markCompletedAndBill, so the studio pays for a generation that
    // produced nothing.
    const seed = await seedEditor();
    const key = await mintBackendGrant(seed, "ai");
    const sha = crypto.randomBytes(32).toString("hex");

    const res = await report(
      completed(key, { size_bytes: 0, sha256: sha }),
      seed.cookie,
    );

    expect(res.status).toBe(422);
    const rows = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM studio_assets WHERE content_hash = ${sha}
    `;
    expect(rows[0]!.n).toBe("0");
  });

  it("refuses an empty cover the same way", async () => {
    const seed = await seedEditor();
    const key = await mintBackendGrant(seed, "cover");
    const sha = crypto.randomBytes(32).toString("hex");

    const res = await report(
      completed(key, { size_bytes: 0, sha256: sha }),
      seed.cookie,
    );

    expect(res.status).toBe(422);
  });

  it("needs no lane of its own, because the browser cannot open an empty one", async () => {
    // This is why the refusal above is unconditional rather than asked about
    // the grant: the ticket endpoint declares `size` positive, so a browser
    // upload of an empty file never gets a key to report against. Every
    // zero-byte report there can be comes from a backend lane.
    const seed = await seedEditor();

    const res = await app.request("/api/v1/assets/upload-ticket", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: seed.cookie },
      body: JSON.stringify({
        filename: "nothing.png",
        content_type: "image/png",
        project_id: seed.projectId,
        space_id: seed.spaceId,
        size: 0,
        client_hash: crypto.randomBytes(32).toString("hex"),
      }),
    });

    expect(res.status).toBe(422);
  });
});

describe("a finish this server drove — an event that could not be published", () => {
  it("refuses a success whose content event was lost", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed, { node_id: crypto.randomUUID() });

    const xadd = vi
      .spyOn(getStreamRedis(), "xadd")
      .mockRejectedValueOnce(new Error("the stream's Redis is unreachable"));
    const res = await report(completed(key));
    xadd.mockRestore();

    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  // The feed row is written before the grant is consumed, and the grant is
  // what tells a repeat finish from a first one. Were the order the other way
  // round, an interruption landing between them would leave a consumed grant:
  // the retry takes the early exit and that feed row is gone for good. Broken
  // here at the step that sits between the two, which is the only interruption
  // this suite can place there.
  it("has already written the feed row when a later step fails, and holds the grant", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed, { node_id: crypto.randomUUID() });

    const xadd = vi
      .spyOn(getStreamRedis(), "xadd")
      .mockRejectedValueOnce(new Error("the stream's Redis is unreachable"));
    await report(completed(key));
    xadd.mockRestore();

    const feed = (await sql`
      SELECT type FROM project_activities WHERE project_id = ${seed.projectId}
    `) as unknown as { type: string }[];
    expect(feed.map((row) => row.type)).toContain("asset:uploaded");
    const grants = (await sql`
      SELECT consumed_at FROM upload_grants WHERE storage_key = ${key}
    `) as unknown as { consumed_at: Date | null }[];
    expect(grants[0]!.consumed_at).toBeNull();
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
    // The ticket's own event went out before the publisher was broken, so the
    // one that got through afterwards is the settlement.
    expect(events.filter((e) => e.nodeId === nodeId)).toHaveLength(2);
  });
});

describe("a finish the Worker could not complete", () => {
  it("voids the grant and tells the node, without registering anything", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });

    const res = await report({
      storage_key: key,
      outcome: "aborted",
      reason: "parts_missing",
    });

    expect(res.status).toBe(502);
    const assets = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM studio_assets WHERE storage_key = ${key}
    `;
    expect(assets[0]!.n).toBe("0");

    const grants = await sql<{ voided_at: Date | null }[]>`
      SELECT voided_at FROM upload_grants WHERE storage_key = ${key}
    `;
    expect(grants[0]!.voided_at).not.toBeNull();

    // The node has been counting this upload since before the first byte
    // moved. This event is the only thing that stops it.
    const docName = `project-${seed.projectId}/canvas-${seed.spaceId}`;
    const events = (await eventsFor(docName)).filter((e) => e.nodeId === nodeId);
    expect(events).toHaveLength(2);
    expect(events[1]!.counts).toMatchObject({ running: 0, failed: 1 });
    expect(events[1]!.result).toBeUndefined();
  });

  it("leaves a registered upload alone when a later delivery reports it aborted", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });

    expect((await report(completed(key))).status).toBe(200);

    // The browser did not hear that answer and asked the Worker to finish
    // again. That delivery holds the same upload id, so it is granted the key,
    // but this time it could not read the object back — so it reports
    // aborted. What the earlier delivery registered stands.
    const res = await report({
      storage_key: key,
      outcome: "aborted",
      reason: "hashing failed",
    });

    expect(res.status).toBe(502);
    const tasks = await sql<{ status: string }[]>`
      SELECT status FROM node_tasks WHERE node_id = ${nodeId}
    `;
    expect(tasks[0]!.status).toBe("done");

    // Two events: the one the ticket sent, and the one that settled the task.
    // A third would mean this report announced something — and it has no hash
    // to look the registered asset up by, so anything it announced would name
    // a URL built from the key rather than the one in the ledger.
    const docName = `project-${seed.projectId}/canvas-${seed.spaceId}`;
    const events = (await eventsFor(docName)).filter((e) => e.nodeId === nodeId);
    expect(events).toHaveLength(2);
  });

  it("voids the grant even when the node's counts could not be published", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });

    const xadd = vi
      .spyOn(getStreamRedis(), "xadd")
      .mockRejectedValueOnce(new Error("the stream's Redis is unreachable"));
    const res = await report({
      storage_key: key,
      outcome: "aborted",
      reason: "parts_missing",
    });
    xadd.mockRestore();

    // The answer says the upload failed, which it did. What matters here is
    // that the writing before the event still stands: the grant is voided and
    // the row is failed before the event is tried, and the event carries four
    // numbers and no content. Opening the node's task list republishes them
    // (design §4.6.4), so a stream that was unreachable costs nothing else.
    expect(res.status).toBe(502);
    const grants = await sql<{ voided_at: Date | null }[]>`
      SELECT voided_at FROM upload_grants WHERE storage_key = ${key}
    `;
    expect(grants[0]!.voided_at).not.toBeNull();
  });
});

describe("a finish this server drove — the same report twice", () => {
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

    // The event goes out again on purpose. A repeated report means the browser
    // did not hear us the first time, and the likeliest reason is that the
    // event never reached the node. Collab applies it last-write-wins.
    const docName = `project-${seed.projectId}/canvas-${seed.spaceId}`;
    const events = (await eventsFor(docName)).filter((e) => e.nodeId === nodeId);
    // The ticket's own event, then one settlement per report.
    expect(events).toHaveLength(3);
    expect(events[2]!.result?.content).toBe(a.data.fileUrl);
  });

  // The grant is what tells a repeat report apart from a first one, so it is
  // consumed only once everything a first one owes has been written. Consuming
  // it earlier would make the retry take a half-finished upload for a finished
  // one, and the rows the first attempt never got to write would have nobody
  // left to write them.
  it("writes the history and feed rows the interrupted attempt never got to", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });
    const body = completed(key);

    // The history write fails for this one node and nothing else. A constraint
    // rather than a stubbed module: the two writes at stake are the ones the
    // retry has to reach, and only a failure the database itself raises puts
    // the report on the path a real interruption takes.
    await sql.unsafe(
      `ALTER TABLE node_history ADD CONSTRAINT node_history_report_retry_probe
       CHECK (node_id <> '${nodeId}')`,
    );
    const first = await report(body);
    await sql.unsafe(
      `ALTER TABLE node_history DROP CONSTRAINT node_history_report_retry_probe`,
    );

    expect(first.status).toBeGreaterThanOrEqual(500);
    expect((await report(body)).status).toBe(200);

    const history = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM node_history
      WHERE node_id = ${nodeId} AND deleted_at IS NULL
    `;
    expect(history[0]!.n).toBe("1");
    const feed = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM project_activities
      WHERE project_id = ${seed.projectId} AND type = 'asset:uploaded'
    `;
    expect(feed[0]!.n).toBe("1");
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
  it("writes no history row, no feed row and settles nothing yet", async () => {
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
    // Only the event the ticket published when it opened the task. The row is
    // still running: the cover job is what settles it.
    const events = (await eventsFor(
      canvasSpaceDocName(seed.projectId, seed.spaceId),
    )).filter((e) => e.nodeId === nodeId);
    expect(events).toHaveLength(1);
    expect(events[0]!.counts).toMatchObject({ running: 1, done: 0 });
  });

  it("hands the worker the registered video and the node waiting on it", async () => {
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
      // No owner studio travels on the job. The cover is uploaded the way
      // every asset is, and that path resolves the owner from the project —
      // a second copy on the payload would be a second answer to the same
      // question, free to disagree with the first.
      userId: seed.userId,
      projectId: seed.projectId,
      spaceId: seed.spaceId,
      nodeId,
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

  // The job id is the storage key, so a repeated report cannot start a second
  // extraction of the same upload.
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

    const events = (await eventsFor(
      canvasSpaceDocName(seed.projectId, seed.spaceId),
    )).filter((e) => e.nodeId === nodeId);
    // Still only the ticket's own event: this report settled nothing.
    expect(events).toHaveLength(1);
    expect(events[0]!.counts).toMatchObject({ running: 1, done: 0 });
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

/**
 * What the report does to the task the ticket opened (#186, design §3.6).
 *
 * The ticket left a running row on the node. This is where it stops running:
 * a registered upload settles it as done and points it at the history row
 * holding the result, an abort or a refusal settles it as failed. Either way
 * the node's four counts are recomputed and published, because those numbers
 * are the whole of what the canvas document knows about tasks.
 */
describe("a finish this server drove — the task it settles", () => {
  /** Every task row on one node, newest first. */
  async function tasksOn(nodeId: string): Promise<
    { id: string; status: string; node_history_id: string | null; error_message: string | null }[]
  > {
    return sql`
      SELECT id, status, node_history_id, error_message
      FROM node_tasks WHERE node_id = ${nodeId}
      ORDER BY started_at DESC
    ` as never;
  }

  /** Every task-counts event for `docName`, oldest first. */
  async function countEvents(
    docName: string,
  ): Promise<{ nodeId: string; counts: Record<string, number> }[]> {
    const raw = (await getStreamRedis().xrange(
      taskEventsStreamKey(),
      "-",
      "+",
    )) as [string, string[]][];
    return raw
      .map(([, fields]) => {
        const idx = fields.indexOf("payload");
        return idx === -1
          ? null
          : (JSON.parse(fields[idx + 1]!) as Record<string, unknown>);
      })
      .filter(
        (e): e is Record<string, unknown> =>
          e !== null && e.type === "node-task-counts" && e.docName === docName,
      )
      .map((e) => ({
        nodeId: e.nodeId as string,
        counts: e.counts as Record<string, number>,
      }));
  }

  it("settles the row as done once the upload is registered", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });

    expect((await report(completed(key))).status).toBe(200);

    const rows = await tasksOn(nodeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("done");
  });

  it("points the settled row at the history row holding the result", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });

    await report(completed(key));

    const rows = await tasksOn(nodeId);
    const history = (await sql`
      SELECT id FROM node_history WHERE node_id = ${nodeId}
    `) as unknown as { id: string }[];
    expect(history).toHaveLength(1);
    expect(rows[0]!.node_history_id).toBe(history[0]!.id);
  });

  it("publishes the node's counts with one done and nothing running", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });

    await report(completed(key));

    const events = await countEvents(
      canvasSpaceDocName(seed.projectId, seed.spaceId),
    );
    expect(events.at(-1)).toMatchObject({
      nodeId,
      counts: { running: 0, done: 1, failed: 0, expired: 0 },
    });
  });

  it("settles the row as failed when the Worker reports an abort", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });

    await report({ storage_key: key, outcome: "aborted" });

    const rows = await tasksOn(nodeId);
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.error_message).not.toBeNull();
  });

  it("publishes the counts on that failure too", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });

    await report({ storage_key: key, outcome: "aborted" });

    const events = await countEvents(
      canvasSpaceDocName(seed.projectId, seed.spaceId),
    );
    expect(events.at(-1)).toMatchObject({
      nodeId,
      counts: { running: 0, done: 0, failed: 1, expired: 0 },
    });
  });

  it("settles the row as failed when what landed is over the cap", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });

    const { getStorageConfig } = await import("@breatic/core");
    const over = getStorageConfig().upload.max_upload_bytes + 1;
    await report(completed(key, { size_bytes: over }));

    const rows = await tasksOn(nodeId);
    expect(rows[0]!.status).toBe("failed");
  });

  it("leaves a settled row alone when the same report arrives again", async () => {
    // The grant is what tells a repeat from a first report, and the task row
    // has its own state machine: a second `done` is a fact that already
    // happened, so it changes nothing and throws nothing.
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });
    const body = completed(key);

    await report(body);
    const first = await tasksOn(nodeId);

    expect((await report(body)).status).toBe(200);
    const second = await tasksOn(nodeId);

    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      status: "done",
      node_history_id: first[0]!.node_history_id,
    });
  });

  it("answers a repeat whose ledger row is gone without minting a url", async () => {
    // The grant says this key registered, so a repeat looks the row up by the
    // hash the Worker sent. A studio that no longer holds a row for that
    // content has no canonical url to answer with, and the key on the grant is
    // not one: within a studio the same content dedups to a single row, so
    // that key may be the loser the reclaim job is about to remove.
    const seed = await seedEditor();
    const key = await mintTicket(seed, { node_id: crypto.randomUUID() });
    const sha = crypto.randomBytes(32).toString("hex");
    const body = completed(key, { sha256: sha });

    await report(body);
    await sql`DELETE FROM studio_assets WHERE content_hash = ${sha}`;

    const res = await report(body);

    expect(res.status).toBe(200);
    const answer = (await res.json()) as { data: Record<string, unknown> };
    expect(answer.data).not.toHaveProperty("fileUrl");
  });

  it("settles nothing for an upload with no node behind it", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed, { node_id: undefined, space_id: undefined });

    expect((await report(completed(key))).status).toBe(200);

    const rows = (await sql`
      SELECT id FROM node_tasks WHERE storage_key = ${key}
    `) as unknown as { id: string }[];
    expect(rows).toHaveLength(0);
  });
});

/**
 * The report that arrives after the deadline already passed (#186, §4.5).
 *
 * The timer judged this task dead, the user may have started another one, and
 * then the bytes turn up after all. The result becomes reachable from the task
 * list, and the node's content is left where it is: choosing between the two
 * for the user is not ours to do.
 */
describe("a finish this server drove — a report that lost its race", () => {
  it("attaches the result without putting it back on the node", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });

    // The deadline passes first.
    await sql`
      UPDATE node_tasks SET status = 'expired' WHERE storage_key = ${key}
    `;
    const before = await getStreamRedis().xlen(taskEventsStreamKey());

    await report(completed(key));

    const raw = (await getStreamRedis().xrange(
      taskEventsStreamKey(),
      "-",
      "+",
    )) as [string, string[]][];
    const counts = raw
      .slice(before)
      .map(([, fields]) => {
        const idx = fields.indexOf("payload");
        return idx === -1
          ? null
          : (JSON.parse(fields[idx + 1]!) as Record<string, unknown>);
      })
      .filter(
        (e): e is Record<string, unknown> =>
          e !== null && e.type === "node-task-counts",
      );

    expect(counts).toHaveLength(1);
    expect(counts[0]!.result).toBeUndefined();
  });

  it("leaves the row expired and fills in where its result went", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });
    await sql`
      UPDATE node_tasks SET status = 'expired' WHERE storage_key = ${key}
    `;

    await report(completed(key));

    const rows = (await sql`
      SELECT status, node_history_id FROM node_tasks WHERE storage_key = ${key}
    `) as unknown as { status: string; node_history_id: string | null }[];
    expect(rows[0]!.status).toBe("expired");
    expect(rows[0]!.node_history_id).not.toBeNull();
  });
});

/**
 * `POST /assets/uploads/{uploadId}/complete` — the browser handing back what
 * it holds, and our server driving the finish.
 *
 * The Worker no longer calls us. The browser sends the upload id, the last
 * token every part's answer handed it, and the receipts R2 gave for each part;
 * this server takes the exclusive permission, asks the Worker to assemble, and
 * registers what came back.
 *
 * The key is never in the body. Everything after this point is indexed by it,
 * and a caller who could name one would be naming somebody else's grant — the
 * ledger decides consequences off the grant row, not off who is asking. So it
 * comes out of the signature the Worker verified on every part.
 */
describe("POST /assets/uploads/:uploadId/complete", () => {
  const UPLOAD_ID = "r2-upload-id-1";
  const PARTS = [{ partNumber: 1, etag: "etag-1" }];

  /** A token for `storageKey`, signed the way the Worker signs one. */
  async function tokenFor(
    storageKey: string,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    return signSessionToken(
      {
        storageKey,
        uploadId: UPLOAD_ID,
        contentType: "image/png",
        sessionTokenTtlSeconds: 900,
        expiresAt: Date.now() + 900_000,
        partSize: 5 * 1024 * 1024,
        totalParts: 1,
        ...over,
      },
      INGEST_SECRET,
    );
  }

  /** Answer the one call this server makes to the Worker. */
  function workerAnswers(body: Record<string, unknown>): ReturnType<typeof vi.fn> {
    const stub = vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", stub);
    return stub;
  }

  /** Drive the finish under `uploadId`, the way the browser does. */
  async function finishAs(
    uploadId: string,
    token: string,
    body: Record<string, unknown> = { parts: PARTS },
    cookie?: string,
  ): Promise<Response> {
    return app.request(`/api/v1/assets/uploads/${uploadId}/complete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-upload-token": token,
        ...(cookie !== undefined && { cookie }),
      },
      body: JSON.stringify(body),
    });
  }

  /** Drive the finish the way the browser does. */
  async function finish(
    token: string,
    body: Record<string, unknown> = { parts: PARTS },
    cookie?: string,
  ): Promise<Response> {
    return finishAs(UPLOAD_ID, token, body, cookie);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers the asset and answers with the row", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed);
    workerAnswers({
      sha256: crypto.randomBytes(32).toString("hex"),
      sizeBytes: 4096,
      contentType: "image/png",
    });

    const res = await finish(await tokenFor(key), { parts: PARTS }, seed.cookie);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { fileUrl: string } };
    expect(body.data.fileUrl).toBeTruthy();
    const rows = (await sql`
      SELECT consumed_at FROM upload_grants WHERE storage_key = ${key}
    `) as unknown as { consumed_at: Date | null }[];
    expect(rows[0]!.consumed_at).not.toBeNull();
  });

  // The body names the upload, never the key. A caller who could name a key
  // would reach a grant row that decides the studio charged and the node
  // written, and none of that is checked against who is asking.
  it("ignores a storage key the body tries to name", async () => {
    const mine = await seedEditor();
    const theirs = await seedEditor();
    const myKey = await mintTicket(mine);
    const theirKey = await mintTicket(theirs);
    workerAnswers({
      sha256: crypto.randomBytes(32).toString("hex"),
      sizeBytes: 4096,
      contentType: "image/png",
    });

    const res = await finish(
      await tokenFor(myKey),
      { parts: PARTS, storage_key: theirKey },
      mine.cookie,
    );

    // Asserted first: without it this passes on any answer at all, including
    // a route that does not exist, and then it says nothing about which key
    // was used.
    expect(res.status).toBe(200);
    const rows = (await sql`
      SELECT storage_key, consumed_at FROM upload_grants
      WHERE storage_key IN (${myKey}, ${theirKey})
    `) as unknown as { storage_key: string; consumed_at: Date | null }[];
    const consumed = rows.filter((r) => r.consumed_at !== null);
    expect(consumed.map((r) => r.storage_key)).toEqual([myKey]);
  });

  it("refuses a token that does not verify", async () => {
    const seed = await seedEditor();
    await mintTicket(seed);

    const res = await finish("forged.token", { parts: PARTS }, seed.cookie);

    expect(res.status).toBe(401);
  });

  it("refuses a token signed for another upload", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed);

    const res = await finish(
      await tokenFor(key, { uploadId: "some-other-upload" }),
      { parts: PARTS },
      seed.cookie,
    );

    expect(res.status).toBe(401);
  });

  it("refuses a caller with no session", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed);

    const res = await finish(await tokenFor(key));

    expect(res.status).toBe(401);
  });

  /**
   * The exclusive permission to finish, which used to be an endpoint of its own
   * the Worker called (#186 §6.4).
   *
   * What it stops is a write. A ticket still inside its window can open a
   * second upload over a key the ledger already describes, and completing that
   * one silently overwrites the object dedup points other members of the studio
   * at. So the permission is taken before the Worker is asked to assemble
   * anything — a refusal that arrived after would be too late to stop it.
   */
  describe("the claim that runs before the Worker is asked", () => {
    const OTHER_UPLOAD_ID = "r2-upload-id-2";

    it("refuses a key this ledger never issued, and asks the Worker nothing", async () => {
      const seed = await seedEditor();
      const stub = workerAnswers({ sha256: "x".repeat(64), sizeBytes: 1, contentType: "image/png" });

      const res = await finish(
        await tokenFor("image/2026-09-08/never-minted.png"),
        { parts: PARTS },
        seed.cookie,
      );

      expect(res.status).toBe(404);
      expect(stub).not.toHaveBeenCalled();
    });

    it("refuses a second upload over a key already registered, and asks the Worker nothing", async () => {
      const seed = await seedEditor();
      const key = await mintTicket(seed);
      workerAnswers({
        sha256: crypto.randomBytes(32).toString("hex"),
        sizeBytes: 4096,
        contentType: "image/png",
      });
      const first = await finish(await tokenFor(key), { parts: PARTS }, seed.cookie);
      expect(first.status).toBe(200);

      const stub = workerAnswers({
        sha256: crypto.randomBytes(32).toString("hex"),
        sizeBytes: 4096,
        contentType: "image/png",
      });
      const res = await finishAs(
        OTHER_UPLOAD_ID,
        await tokenFor(key, { uploadId: OTHER_UPLOAD_ID }),
        { parts: PARTS },
        seed.cookie,
      );

      expect(res.status).toBe(409);
      expect(stub).not.toHaveBeenCalled();
    });

    // The state a first caller leaves behind between taking the permission and
    // the Worker answering it, which is exactly the window a replay aims at.
    it("refuses while another upload is finishing this key, and asks the Worker nothing", async () => {
      const seed = await seedEditor();
      const key = await mintTicket(seed);
      await sql`
        UPDATE upload_grants SET finalizing_upload_id = ${UPLOAD_ID}
        WHERE storage_key = ${key}
      `;
      const stub = workerAnswers({
        sha256: crypto.randomBytes(32).toString("hex"),
        sizeBytes: 4096,
        contentType: "image/png",
      });

      const res = await finishAs(
        OTHER_UPLOAD_ID,
        await tokenFor(key, { uploadId: OTHER_UPLOAD_ID }),
        { parts: PARTS },
        seed.cookie,
      );

      expect(res.status).toBe(409);
      expect(stub).not.toHaveBeenCalled();
    });
  });
});

/**
 * A backend lane reaching the ledger (#181 lane ②, #206 design §6).
 *
 * The browser's lane registers through an endpoint, so the cases above drive
 * it over HTTP. A backend lane has no endpoint: our worker calls the domain
 * service directly, in its own process. Everything below the ingest client is
 * the same code either way, and the point here is that it really is — that a
 * generation's own output lands in `studio_assets` under the hash the Worker
 * measured, against the studio the grant names.
 *
 * Only the network is stood in for. The grant, the ticket, the signature the
 * Worker verifies, the registration and the ledger are all the real ones.
 */
describe("an upload our own worker drove", () => {
  const MEASURED_SIZE = 4096;

  /** Answer the three calls a backend lane makes to the Worker. */
  function workerAnswersEveryStep(sha256: string): ReturnType<typeof vi.fn> {
    const stub = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/uploads")) {
        return new Response(
          JSON.stringify({ uploadId: "worker-upload-1", token: "token-0" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/parts/")) {
        return new Response(
          JSON.stringify({ token: "token-1", partNumber: 1, etag: "etag-1" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          sha256,
          sizeBytes: MEASURED_SIZE,
          contentType: "image/png",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", stub);
    return stub;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("files what a generation produced against the grant's studio", async () => {
    const seed = await seedEditor();
    const sha256 = crypto.randomBytes(32).toString("hex");
    workerAnswersEveryStep(sha256);

    const stored = await backendUploadService.uploadBytesToStorage(
      new Blob([new Uint8Array(MEASURED_SIZE)]),
      {
        projectId: seed.projectId,
        actingUserId: seed.userId,
        assetSource: "ai",
        taskType: "image",
        ext: ".png",
        contentType: "image/png",
      },
    );

    expect(stored.fileUrl).toBeTruthy();
    const rows = (await sql`
      SELECT studio_id, content_hash, size_bytes FROM studio_assets
      WHERE content_hash = ${sha256}
    `) as unknown as {
      studio_id: string;
      content_hash: string;
      size_bytes: string | number;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.studio_id).toBe(seed.studioId);
    expect(Number(rows[0]!.size_bytes)).toBe(MEASURED_SIZE);
  });

  it("consumes the grant it opened, so a replay finds nothing to do", async () => {
    const seed = await seedEditor();
    const sha256 = crypto.randomBytes(32).toString("hex");
    workerAnswersEveryStep(sha256);

    await backendUploadService.uploadBytesToStorage(
      new Blob([new Uint8Array(MEASURED_SIZE)]),
      {
        projectId: seed.projectId,
        actingUserId: seed.userId,
        assetSource: "ai",
        taskType: "image",
        ext: ".png",
        contentType: "image/png",
      },
    );

    const grants = (await sql`
      SELECT g.consumed_at FROM upload_grants g
      JOIN studio_assets a ON a.storage_key = g.storage_key
      WHERE a.content_hash = ${sha256}
    `) as unknown as { consumed_at: Date | null }[];
    expect(grants).toHaveLength(1);
    expect(grants[0]!.consumed_at).not.toBeNull();
  });

  // The worker announces a generation itself, so the grant it opens is marked
  // derived and registration writes no feed row — a second one would report
  // one act twice.
  it("writes no project feed row, because the worker announces its own work", async () => {
    const seed = await seedEditor();
    workerAnswersEveryStep(crypto.randomBytes(32).toString("hex"));

    await backendUploadService.uploadBytesToStorage(
      new Blob([new Uint8Array(MEASURED_SIZE)]),
      {
        projectId: seed.projectId,
        actingUserId: seed.userId,
        assetSource: "ai",
        taskType: "image",
        ext: ".png",
        contentType: "image/png",
      },
    );

    const feed = (await sql`
      SELECT id FROM project_activities WHERE project_id = ${seed.projectId}
    `) as unknown as { id: string }[];
    expect(feed).toHaveLength(0);
  });
});
