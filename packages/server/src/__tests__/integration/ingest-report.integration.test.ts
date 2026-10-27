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

// The server opens every upload at the ingest Worker itself before it
// answers a ticket (inner#1595); that one call is answered by a double.
vi.mock("@breatic/shared", async (importOriginal) =>
  (await import("../helpers/ingest-open-double.js")).sharedWithOpenDouble(importOriginal),
);

import crypto from "node:crypto";
import postgres from "postgres";
import fc from "fast-check";
import {
  initCore,
  getRedis,
  getStreamRedis,
  setSession,
  sessionCookieName,
  loadLocales,
  taskEventsStreamKey,
  getStorageConfig,
  createQueue,
  createPgClient,
} from "@breatic/core";
import {
  backendUploadService,
  ingestReportService,
  uploadGrantService,
  uploadStatusService,
  UPLOAD_FINISH_QUEUE,
  AUDIO_PEAKS_QUEUE,
  type UploadFinishResult,
} from "@breatic/domain";
import { Queue } from "bullmq";
import { closeFinishQueue, runQueuedFinish } from "@server/__tests__/helpers/queued-finish.js";
import {
  canvasSpaceDocName,
  INGEST_FAILURE_HEADER,
  signSessionToken,
  uprightKeyFor,
  UPLOAD_STATUS_MAX_KEYS,
} from "@breatic/shared";
import type { Hono } from "hono";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";

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
  await closeFinishQueue();
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


/** What the last finish request asked the Worker for. */
let lastFinishBody: Record<string, unknown> = {};
const ONE_PART = [{ partNumber: 1, etag: "etag-1" }];

/**
 * Drive one upload's finish, with the Worker answering what `body` describes.
 *
 * The browser hands back what it holds and this server does the rest, so a
 * report is no longer something that arrives — it is what the Worker answers a
 * call with. A body describing an abort stands for a Worker that could not
 * turn the parts into an object; one carrying `refusal` stands for a Worker
 * that could, looked at the bytes, and named what it would not keep.
 * @param body - What the Worker's answer amounts to.
 * @returns How the queued finish ended.
 * @throws {Error} When the route did not queue a finish, or the finish threw.
 */
async function report(
  body: Record<string, unknown>,
  cookie?: string,
): Promise<UploadFinishResult> {
  const storageKey = body.storage_key as string;
  const contentType = (body.content_type as string) ?? "image/png";
  const token = await signSessionToken(
    {
      storageKey,
      uploadId: FINISH_UPLOAD_ID,
      contentType,
      expiresAt: Date.now() + 900_000,
      partSize: 8 * 1024 * 1024,
      totalParts: ONE_PART.length,
    },
    INGEST_SECRET,
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      lastFinishBody = JSON.parse(String(init.body ?? "{}")) as Record<
        string,
        unknown
      >;
      if (body.unreachable === true) throw new TypeError("fetch failed");
      if (typeof body.refusal === "string") {
        return new Response("Refused", {
          status: 415,
          headers: { [INGEST_FAILURE_HEADER]: body.refusal },
        });
      }
      return body.outcome === "completed"
        ? new Response(
            JSON.stringify({
              sha256: body.sha256,
              sizeBytes: body.size_bytes,
              contentType,
              // Absent unless a case says otherwise: the container answering
              // nothing is what a timeout looks like from here, and it is the
              // ordinary shape for anything the probe found no numbers on.
              ...(body.width !== undefined && { width: body.width }),
              ...(body.height !== undefined && { height: body.height }),
              ...(body.duration_seconds !== undefined && {
                durationSeconds: body.duration_seconds,
              }),
              // The cover the container cut, already written to the key this
              // server minted and hashed at the edge.
              ...(body.cover !== undefined && { cover: body.cover }),
              // The upright copy of a picture with an EXIF orientation.
              ...(body.upright !== undefined && { upright: body.upright }),
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        : new Response("Could not assemble the object", { status: 502 });
    }),
  );
  try {
    const res = await app.request(
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
    if (res.status !== 202) throw new Error(`the finish route answered ${res.status}`);
    return await runQueuedFinish(storageKey);
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

    expect(res.refused).toBeDefined();
    const rows = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM studio_assets WHERE studio_id = ${seed.studioId}
    `;
    expect(rows[0]!.n).toBe("0");
  });

  it("points the consumed grant at the ledger row it registered", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed);

    await report(completed(key));

    const rows = await sql<{ asset_id: string | null; id: string; failure_reason: string | null }[]>`
      SELECT g.asset_id, a.id, g.failure_reason
      FROM upload_grants g JOIN studio_assets a ON a.storage_key = g.storage_key
      WHERE g.storage_key = ${key}
    `;
    expect(rows[0]!.asset_id).toBe(rows[0]!.id);
    expect(rows[0]!.failure_reason).toBeNull();
  });

  it("points a grant whose bytes deduped at the row that already stood", async () => {
    const seed = await seedEditor();
    const first = await mintTicket(seed);
    const second = await mintTicket(seed);
    const sha256 = crypto.randomBytes(32).toString("hex");

    await report(completed(first, { sha256 }));
    await report(completed(second, { sha256 }));

    const rows = await sql<{ storage_key: string; asset_id: string | null }[]>`
      SELECT storage_key, asset_id FROM upload_grants
      WHERE storage_key IN (${first}, ${second})
    `;
    const ids = new Set(rows.map((r) => r.asset_id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).not.toBeNull();
  });

  it("registers the asset under the grant's studio and consumes the grant", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });
    const sha = crypto.randomBytes(32).toString("hex");

    const res = await report(completed(key, { sha256: sha }));

    expect(res.refused).toBeUndefined();
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

  it("writes the dimensions the container read off an image", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed);
    const sha = crypto.randomBytes(32).toString("hex");

    await report(completed(key, { sha256: sha, width: 800, height: 600 }));

    const rows = await sql<
      { width: number | null; height: number | null; duration_seconds: string | null }[]
    >`
      SELECT width, height, duration_seconds FROM studio_assets
      WHERE content_hash = ${sha}
    `;
    expect(rows[0]).toEqual({ width: 800, height: 600, duration_seconds: null });
  });

  it("writes an audio duration to the millisecond, with no dimensions", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed, { content_type: "audio/mpeg" });
    const sha = crypto.randomBytes(32).toString("hex");

    await report(
      completed(key, {
        sha256: sha,
        content_type: "audio/mpeg",
        duration_seconds: 5.043,
      }),
    );

    const rows = await sql<
      { width: number | null; height: number | null; duration_seconds: string | null }[]
    >`
      SELECT width, height, duration_seconds FROM studio_assets
      WHERE content_hash = ${sha}
    `;
    expect(rows[0]!.width).toBeNull();
    expect(rows[0]!.height).toBeNull();
    expect(Number(rows[0]!.duration_seconds)).toBe(5.043);
  });

  // inner#1305 §4.4: the peaks of an audio row are read after it registers,
  // on their own queue, keyed by the row.
  describe("the peaks read of an audio upload", () => {
    /**
     * The peaks jobs queued for one row.
     * @param assetId - The row.
     * @returns The jobs waiting for it.
     */
    async function peaksJobsFor(assetId: string): Promise<{ data: unknown }[]> {
      const queue = createQueue(AUDIO_PEAKS_QUEUE);
      return (await queue.getJobs(["waiting", "delayed", "active"])).filter(
        (job) => job.id === `audio-peaks-${assetId}`,
      );
    }

    /**
     * Upload these audio bytes and register them.
     * @param seed - Whose upload.
     * @param sha - The bytes' hash.
     * @returns How the finish ended.
     */
    async function uploadSong(seed: Awaited<ReturnType<typeof seedEditor>>, sha: string): Promise<UploadFinishResult> {
      const key = await mintTicket(seed, { content_type: "audio/mpeg", filename: "take.mp3" });
      return report(completed(key, { sha256: sha, content_type: "audio/mpeg", duration_seconds: 61 }));
    }

    it("queues one for the upload's own row, however often it is reported", async () => {
      const seed = await seedEditor();
      const sha = crypto.randomBytes(32).toString("hex");
      const key = await mintTicket(seed, { content_type: "audio/mpeg", filename: "take.mp3" });
      const body = completed(key, { sha256: sha, content_type: "audio/mpeg", duration_seconds: 61 });

      const first = await report(body);
      await report(body);

      if (first.outcome.status !== "registered") throw new Error(`registered as ${first.outcome.status}`);
      const jobs = await peaksJobsFor(first.outcome.assetId);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.data).toEqual({ assetId: first.outcome.assetId });
      expect(first.outcome.peaksQueueFailed).toBeUndefined();
    });

    it("queues none for a picture", async () => {
      const seed = await seedEditor();
      const key = await mintTicket(seed);

      const done = await report(completed(key));

      if (done.outcome.status !== "registered") throw new Error(`registered as ${done.outcome.status}`);
      expect(await peaksJobsFor(done.outcome.assetId)).toHaveLength(0);
    });

    it("queues nothing more when the bytes land on a row the studio already held", async () => {
      const seed = await seedEditor();
      const sha = crypto.randomBytes(32).toString("hex");
      const first = await uploadSong(seed, sha);
      if (first.outcome.status !== "registered") throw new Error(`registered as ${first.outcome.status}`);
      const queuedTo: string[] = [];
      const original = Queue.prototype.add;
      const add = vi.spyOn(Queue.prototype, "add").mockImplementation(function (
        this: Queue,
        ...args: Parameters<Queue["add"]>
      ) {
        queuedTo.push(this.name);
        return original.apply(this, args);
      });

      try {
        const second = await uploadSong(seed, sha);

        expect(second.outcome).toMatchObject({ assetId: first.outcome.assetId, ownRow: false });
        expect(queuedTo).not.toContain(AUDIO_PEAKS_QUEUE);
      } finally {
        add.mockRestore();
      }
    });

    it("registers the audio anyway and flags it when its read could not be queued", async () => {
      const seed = await seedEditor();
      const original = Queue.prototype.add;
      const add = vi.spyOn(Queue.prototype, "add").mockImplementation(function (
        this: Queue,
        ...args: Parameters<Queue["add"]>
      ) {
        if (this.name === AUDIO_PEAKS_QUEUE) return Promise.reject(new Error("the queue's Redis is unreachable"));
        return original.apply(this, args);
      });

      try {
        const done = await uploadSong(seed, crypto.randomBytes(32).toString("hex"));

        expect(done.outcome).toMatchObject({ status: "registered", peaksQueueFailed: true });
      } finally {
        add.mockRestore();
      }
    });
  });

  it("registers the asset anyway when the container answered no numbers", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed);
    const sha = crypto.randomBytes(32).toString("hex");

    // What a container timeout looks like from here. The upload succeeded —
    // the bytes are in R2 and hashed — and reading the media is best-effort,
    // so nothing about this may turn a finished upload into a failed one.
    const res = await report(completed(key, { sha256: sha }));

    expect(res.refused).toBeUndefined();
    const rows = await sql<
      { width: number | null; height: number | null; duration_seconds: string | null }[]
    >`
      SELECT width, height, duration_seconds FROM studio_assets
      WHERE content_hash = ${sha}
    `;
    expect(rows[0]).toEqual({ width: null, height: null, duration_seconds: null });
  });

  it("registers the asset anyway when the container answered nonsense numbers", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed);
    const sha = crypto.randomBytes(32).toString("hex");

    // The three measurements above decide whether an upload succeeded; these
    // decide whether a node shows a resolution. A container answering -5 must
    // cost the node its angle marker, never the stored object.
    const res = await report(
      completed(key, {
        sha256: sha,
        width: -5,
        height: "not a number",
        duration_seconds: Number.POSITIVE_INFINITY,
      }),
    );

    expect(res.refused).toBeUndefined();
    const rows = await sql<
      { width: number | null; height: number | null; duration_seconds: string | null }[]
    >`
      SELECT width, height, duration_seconds FROM studio_assets
      WHERE content_hash = ${sha}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ width: null, height: null, duration_seconds: null });
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

  it("hands the node the numbers along with the URL", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });
    const docName = `project-${seed.projectId}/canvas-${seed.spaceId}`;

    await report(completed(key, { width: 1280, height: 720 }));

    const events = (await eventsFor(docName)).filter((e) => e.nodeId === nodeId);
    const done = events.find((e) => e.result !== undefined);
    // The node draws its resolution marker off this, so a null here is a node
    // that has to load and measure the media before it can show anything.
    expect(done?.result).toMatchObject({ width: 1280, height: 720, duration: null });
  });

  it("hands a repeat report the numbers off the row that already stands", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });
    const docName = `project-${seed.projectId}/canvas-${seed.spaceId}`;
    const sha = crypto.randomBytes(32).toString("hex");

    await report(completed(key, { sha256: sha, width: 1280, height: 720 }));
    // The browser did not hear the first answer and sent the same finish
    // again. What it is told the second time has to describe the same row.
    await report(completed(key, { sha256: sha, width: 1280, height: 720 }));

    const results = (await eventsFor(docName))
      .filter((e) => e.nodeId === nodeId)
      .map((e) => e.result)
      .filter((r): r is Record<string, unknown> => r !== undefined);
    expect(results.length).toBeGreaterThan(1);
    expect(results.at(-1)).toMatchObject({ width: 1280, height: 720 });
  });

  it("keeps on the history row the numbers the node was handed (#2184)", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });
    const docName = `project-${seed.projectId}/canvas-${seed.spaceId}`;

    await report(completed(key, { width: 1280, height: 720 }));

    const handed = (await eventsFor(docName))
      .filter((e) => e.nodeId === nodeId)
      .map((e) => e.result)
      .filter((r): r is Record<string, unknown> => r !== undefined)
      .at(-1);
    const rows = await sql<
      { media_width: number | null; media_height: number | null; duration_seconds: string | null; mime_type: string | null; size_bytes: string | null }[]
    >`
      SELECT media_width, media_height, duration_seconds, mime_type, size_bytes FROM node_history
      WHERE node_id = ${nodeId} AND deleted_at IS NULL
    `;
    expect(rows).toHaveLength(1);
    expect({
      width: rows[0]!.media_width,
      height: rows[0]!.media_height,
      duration: rows[0]!.duration_seconds === null ? null : Number(rows[0]!.duration_seconds),
      mimeType: rows[0]!.mime_type,
      size: rows[0]!.size_bytes === null ? null : Number(rows[0]!.size_bytes),
    }).toEqual({
      width: handed?.width,
      height: handed?.height,
      duration: handed?.duration,
      mimeType: handed?.mimeType,
      size: handed?.size,
    });
    expect(rows[0]!.media_width).toBe(1280);
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

  // A20: a browser mini-tool's export lands as an upload, and its history row
  // names the tool so the panel can say what made it.
  it("names the mini-tool on the history row of an export it made", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId, source: "mini_tool", tool_name: "image.crop" });

    await report(completed(key));

    const history = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM node_history
      WHERE node_id = ${nodeId} AND deleted_at IS NULL
    `;
    expect(history[0]!.metadata.toolId).toBe("image.crop");
  });

  // A picture with an EXIF orientation is filed as its upright copy; the hash
  // stays the received bytes' (inner#1367 §4.5).
  it("files a picture turned upright as its upright copy, under the received hash", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed, { content_type: "image/jpeg" });
    const sha = crypto.randomBytes(32).toString("hex");

    const finished = await report(
      completed(key, {
        sha256: sha,
        content_type: "image/jpeg",
        width: 3000,
        height: 4000,
        upright: { storageKey: uprightKeyFor(key), sizeBytes: 3900, width: 3000, height: 4000 },
      }),
    );

    expect(finished.refused).toBeUndefined();
    const rows = await sql<
      { storage_key: string; file_url: string; size_bytes: string; width: number; height: number }[]
    >`
      SELECT storage_key, file_url, size_bytes, width, height FROM studio_assets
      WHERE content_hash = ${sha}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      storage_key: uprightKeyFor(key),
      size_bytes: "3900",
      width: 3000,
      height: 4000,
    });
    expect(rows[0]!.file_url.endsWith(uprightKeyFor(key))).toBe(true);
    expect(finished.outcome).toMatchObject({ status: "registered", ownRow: true });
  });

  it("files the upright copy under the key it is derived from the ticket's, whatever the answer named", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed, { content_type: "image/jpeg" });
    const sha = crypto.randomBytes(32).toString("hex");

    await report(
      completed(key, {
        sha256: sha,
        content_type: "image/jpeg",
        upright: { storageKey: "image/2026-10-10/someone_else.jpg", sizeBytes: 10, width: 1, height: 1 },
      }),
    );

    const rows = await sql<{ storage_key: string }[]>`
      SELECT storage_key FROM studio_assets WHERE content_hash = ${sha}
    `;
    expect(rows[0]!.storage_key).toBe(uprightKeyFor(key));
  });

  it("keeps the ticket's key on the node history row of a picture turned upright", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { content_type: "image/jpeg", node_id: nodeId });

    await report(
      completed(key, {
        content_type: "image/jpeg",
        upright: { storageKey: uprightKeyFor(key), sizeBytes: 3900, width: 3000, height: 4000 },
      }),
    );

    // The ticket's key is what makes a repeated report find this row again.
    const history = await sql<{ upload_storage_key: string }[]>`
      SELECT upload_storage_key FROM node_history WHERE node_id = ${nodeId}
    `;
    expect(history[0]!.upload_storage_key).toBe(key);
  });

  it("queues the losing upright copy for reclaim when its received bytes dedup", async () => {
    const seed = await seedEditor();
    const sha = crypto.randomBytes(32).toString("hex");
    const upright = (k: string) => ({ storageKey: uprightKeyFor(k), sizeBytes: 3900, width: 3000, height: 4000 });
    const firstKey = await mintTicket(seed, { content_type: "image/jpeg" });
    await report(completed(firstKey, { sha256: sha, content_type: "image/jpeg", upright: upright(firstKey) }));
    const secondKey = await mintTicket(seed, { content_type: "image/jpeg" });

    const second = await report(
      completed(secondKey, { sha256: sha, content_type: "image/jpeg", upright: upright(secondKey) }),
    );

    expect(second.outcome).toMatchObject({ status: "registered", ownRow: false });
    const queued = await sql<{ kept_storage_key: string }[]>`
      SELECT kept_storage_key FROM storage_reclaim_queue WHERE storage_key = ${uprightKeyFor(secondKey)}
    `;
    expect(queued[0]!.kept_storage_key).toBe(uprightKeyFor(firstKey));
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

    expect(res.refused).toBeUndefined();
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

  // A node's history holds each content once (#2186), and the feed follows
  // the history: bytes that resolve onto content this node already holds are
  // not a second upload to announce.
  it("adds no history or feed row when the same bytes land on the same node again", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const sha = crypto.randomBytes(32).toString("hex");

    const firstKey = await mintTicket(seed, { node_id: nodeId });
    expect((await report(completed(firstKey, { sha256: sha }))).refused).toBeUndefined();
    const secondKey = await mintTicket(seed, { node_id: nodeId });
    expect((await report(completed(secondKey, { sha256: sha }))).refused).toBeUndefined();

    const history = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM node_history
      WHERE node_id = ${nodeId} AND status = 'success' AND deleted_at IS NULL
    `;
    expect(history[0]!.n).toBe("1");
    const feed = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM project_activities
      WHERE project_id = ${seed.projectId} AND type = 'asset:uploaded'
    `;
    expect(feed[0]!.n).toBe("1");
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

    expect(res.outcome).toMatchObject({ status: "rejected", reason: "over_cap" });
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

    expect(res.refused).toBeUndefined();
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
    expect(res.outcome).toMatchObject({ assetId: rows[0]!.id });

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

    expect(res.outcome).toMatchObject({ status: "rejected", reason: "empty" });
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

    expect(res.outcome).toMatchObject({ status: "rejected", reason: "empty" });
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
    // The job throws, so the queue delivers it again.
    await expect(report(completed(key))).rejects.toThrow();
    xadd.mockRestore();
  });

  // Nothing here can be logged where it happens — a library holds no logger —
  // so the only way an operator hears about it is the flag riding out on the
  // answer. Every terminal path has to carry it, and a path that quietly drops
  // it looks exactly like a path where nothing went wrong.
  //
  // This one is the repeat whose row went terminal some other way: the budget
  // ran out and a harvest moved it to `expired`, so the settle finds nothing
  // of its own to move, takes the branch that reports a publish failure rather
  // than throwing it, and hands the flag back.
  it("hands back the publish failure on a repeat whose row settled some other way", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });
    const body = completed(key);
    await report(body);

    await sql`
      UPDATE node_tasks SET status = 'expired' WHERE storage_key = ${key}
    `;

    const xadd = vi
      .spyOn(getStreamRedis(), "xadd")
      .mockRejectedValueOnce(new Error("the stream's Redis is unreachable"));
    const outcome = await ingestReportService.applyIngestReport({
      storageKey: key,
      outcome: "completed",
      sha256: body.sha256 as string,
      sizeBytes: body.size_bytes as number,
      contentType: body.content_type as string,
    });
    xadd.mockRestore();

    expect(outcome.status).toBe("already_registered");
    expect(outcome.countsPublishFailed).toBe(true);
  });

  // SQL registration, history, activity, and the grant terminal precede the
  // content publication. A lost publication is recovered from that terminal.
  it("keeps the committed grant, history, and feed when content publication fails", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });
    const body = completed(key);

    const xadd = vi
      .spyOn(getStreamRedis(), "xadd")
      .mockRejectedValueOnce(new Error("the stream's Redis is unreachable"));
    // The job throws, and the queue delivers it again.
    try {
      await expect(report(body)).rejects.toThrow("unreachable");
    } finally {
      xadd.mockRestore();
    }

    const feed = (await sql`
      SELECT type FROM project_activities WHERE project_id = ${seed.projectId}
    `) as unknown as { type: string }[];
    expect(feed.map((row) => row.type)).toContain("asset:uploaded");
    const grants = (await sql`
      SELECT consumed_at FROM upload_grants WHERE storage_key = ${key}
    `) as unknown as { consumed_at: Date | null }[];
    expect(grants[0]!.consumed_at).toBeInstanceOf(Date);
    const history = await sql<{ id: string }[]>`
      SELECT id FROM node_history WHERE node_id = ${nodeId} AND deleted_at IS NULL
    `;
    expect(history).toHaveLength(1);
    expect((await report(body)).outcome.status).toBe("already_registered");
    const tasks = await sql<{ node_history_id: string | null }[]>`
      SELECT node_history_id FROM node_tasks WHERE storage_key = ${key}
    `;
    expect(tasks).toEqual([{ node_history_id: history[0]!.id }]);
    expect(await sql<{ id: string }[]>`
      SELECT id FROM node_history WHERE node_id = ${nodeId} AND deleted_at IS NULL
    `).toEqual(history);
    const feedAfterRetry = await sql<{ type: string }[]>`
      SELECT type FROM project_activities
      WHERE project_id = ${seed.projectId} AND type = 'asset:uploaded'
    `;
    expect(feedAfterRetry).toEqual([{ type: "asset:uploaded" }]);
  });

  it("finishes on the report that follows", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });
    const xadd = vi
      .spyOn(getStreamRedis(), "xadd")
      .mockRejectedValueOnce(new Error("the stream's Redis is unreachable"));
    // The job throws, and the queue delivers it again.
    await expect(report(completed(key))).rejects.toThrow("unreachable");
    xadd.mockRestore();

    expect((await report(completed(key))).refused).toBeUndefined();

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
    });

    expect(res.refused).toBeDefined();
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

    expect((await report(completed(key))).refused).toBeUndefined();

    // The browser did not hear that answer and asked the Worker to finish
    // again. That delivery holds the same upload id, so it is granted the key,
    // but this time it could not read the object back — so it reports
    // aborted. What the earlier delivery registered stands.
    const res = await report({
      storage_key: key,
      outcome: "aborted",
    });

    expect(res.refused).toBeUndefined();
    expect(res.outcome.status).toBe("already_registered");
    const tasks = await sql<{ status: string }[]>`
      SELECT status FROM node_tasks WHERE node_id = ${nodeId}
    `;
    expect(tasks[0]!.status).toBe("done");

    // Replaying an abort uses the asset identity already fixed on the grant.
    // It republishes the canonical success without a new Worker hash.
    const docName = `project-${seed.projectId}/canvas-${seed.spaceId}`;
    const events = (await eventsFor(docName)).filter((e) => e.nodeId === nodeId);
    expect(events).toHaveLength(3);
    expect(events[2]!.result).toEqual(events[1]!.result);
  });

  // A grant with no node has no task row to say why it failed, so the grant
  // itself carries the reason the status query answers with (inner#1367).
  it("writes down on the grant why it was voided", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed);

    await ingestReportService.applyIngestReport({
      storageKey: key,
      outcome: "aborted",
      reason: "store_failed",
    });

    const grants = await sql<{ failure_reason: string | null; asset_id: string | null }[]>`
      SELECT failure_reason, asset_id FROM upload_grants WHERE storage_key = ${key}
    `;
    expect(grants[0]).toEqual({ failure_reason: "store_failed", asset_id: null });
  });

  it("writes expired on a grant with no node whose abort arrives past its two hours", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed);
    await sql`
      UPDATE upload_grants
      SET created_at = now() - interval '2 hours' - interval '1 second'
      WHERE storage_key = ${key}
    `;

    await report({ storage_key: key, outcome: "aborted" });

    const grants = await sql<{ failure_reason: string | null }[]>`
      SELECT failure_reason FROM upload_grants WHERE storage_key = ${key}
    `;
    expect(grants[0]!.failure_reason).toBe("expired");
  });

  it("writes over_cap on a grant whose bytes came back too large", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed);

    await report(completed(key, { size_bytes: Number.MAX_SAFE_INTEGER }));

    const grants = await sql<{ failure_reason: string | null }[]>`
      SELECT failure_reason FROM upload_grants WHERE storage_key = ${key}
    `;
    expect(grants[0]!.failure_reason).toBe("over_cap");
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
    });
    xadd.mockRestore();

    // The answer says the upload failed, which it did. What matters here is
    // that the writing before the event still stands: the grant is voided and
    // the row is failed before the event is tried, and the event carries four
    // numbers and no content. Opening the node's task list republishes them
    // (design §4.6.4), so a stream that was unreachable costs nothing else.
    expect(res.refused).toBeDefined();
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

    expect(first.outcome.status).toBe("registered");
    expect(second.outcome.status).toBe("already_registered");
    const a = first.outcome as { fileUrl: string };
    const b = second.outcome as { fileUrl: string };
    expect(b.fileUrl).toBe(a.fileUrl);

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
    // And one feed row: the replay writes no history row, so it announces
    // nothing either (#2186 A5).
    const feed = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM project_activities
      WHERE project_id = ${seed.projectId} AND type = 'asset:uploaded'
    `;
    expect(feed[0]!.n).toBe("1");

    // The event goes out again on purpose. A repeated report means the browser
    // did not hear us the first time, and the likeliest reason is that the
    // event never reached the node. Collab applies it last-write-wins.
    const docName = `project-${seed.projectId}/canvas-${seed.spaceId}`;
    const events = (await eventsFor(docName)).filter((e) => e.nodeId === nodeId);
    // The ticket's own event, then one settlement per report.
    expect(events).toHaveLength(3);
    expect(events[2]!.result?.content).toBe(a.fileUrl);
  });

  // History and activity precede the grant terminal. Their failed SQL work
  // leaves the grant pending, so the retry completes those original rows
  // before committing the terminal and publishing the canonical result.
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
    const first = await report(body).catch((err: unknown) => err);
    await sql.unsafe(
      `ALTER TABLE node_history DROP CONSTRAINT node_history_report_retry_probe`,
    );

    expect(first).toBeInstanceOf(Error);
    expect((await report(body)).refused).toBeUndefined();

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

describe("a video, whose cover comes back with the rest of the answer", () => {
  /** A cover the container cut and the Worker stored, as the answer carries it. */
  function coverAnswer(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      storageKey: `video/2026-09-10/${crypto.randomUUID()}_cover.png`,
      sha256: crypto.randomBytes(32).toString("hex"),
      sizeBytes: 8192,
      contentType: "image/png",
      ...over,
    };
  }

  /** Mint a ticket for a video and report it complete, cover and all. */
  async function uploadVideo(
    seed: Awaited<ReturnType<typeof seedEditor>>,
    over: Record<string, unknown> = {},
  ): Promise<{ key: string; nodeId: string; cover: Record<string, unknown> }> {
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, {
      filename: "clip.mp4",
      content_type: "video/mp4",
      node_id: nodeId,
      ...over,
    });
    const cover = coverAnswer();
    await report(
      completed(key, {
        content_type: "video/mp4",
        size_bytes: 200_000,
        width: 1920,
        height: 1080,
        duration_seconds: 12.5,
        cover,
        ...over,
      }),
    );
    return { key, nodeId, cover };
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

  // The cover arrives with the answer, so there is nothing left to wait for:
  // a video writes its history row, its feed row and its event in the same
  // pass an image does.
  it("writes the history row, the feed row and the event in this same pass", async () => {
    const seed = await seedEditor();
    const { key, nodeId } = await uploadVideo(seed);

    const history = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM node_history WHERE upload_storage_key = ${key}
    `;
    expect(history[0]!.n).toBe("1");
    const feed = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM project_activities
      WHERE project_id = ${seed.projectId} AND node_id = ${nodeId}
    `;
    expect(feed[0]!.n).toBe("1");
    const events = (await eventsFor(
      canvasSpaceDocName(seed.projectId, seed.spaceId),
    )).filter((e) => e.nodeId === nodeId);
    expect(events).toHaveLength(2);
    expect(events[1]!.counts).toMatchObject({ running: 0, done: 1 });
  });

  it("registers the cover as its own asset and points the video at it", async () => {
    const seed = await seedEditor();
    const { key, cover } = await uploadVideo(seed);

    const rows = await sql<{ id: string; kind: string; source: string }[]>`
      SELECT id, kind, source FROM studio_assets
      WHERE storage_key = ${cover.storageKey as string}
    `;
    expect(rows).toHaveLength(1);
    // The cover is a normal row that counts toward storage, its kind judged
    // from the cover itself.
    expect(rows[0]!.kind).toBe("image");
    expect(rows[0]!.source).toBe("cover");

    const video = await sql<{ cover_asset_id: string | null }[]>`
      SELECT cover_asset_id FROM studio_assets WHERE storage_key = ${key}
    `;
    expect(video[0]!.cover_asset_id).toBe(rows[0]!.id);
  });

  // The frame is capped on the way out of ffmpeg, so a 4K video's cover is
  // narrower than the video. The row states what its own bytes are, which the
  // container reads off the PNG it cut.
  it("states the cut frame's own size on the cover row", async () => {
    const seed = await seedEditor();
    const cover = coverAnswer({ width: 1920, height: 1080 });
    const key = await mintTicket(seed, {
      filename: "clip.mp4",
      content_type: "video/mp4",
      node_id: crypto.randomUUID(),
    });
    await report(
      completed(key, {
        content_type: "video/mp4",
        size_bytes: 200_000,
        width: 3840,
        height: 2160,
        duration_seconds: 6,
        cover,
      }),
    );

    const rows = await sql<{ width: number | null; height: number | null }[]>`
      SELECT width, height FROM studio_assets
      WHERE storage_key = ${cover.storageKey as string}
    `;
    expect(rows[0]).toMatchObject({ width: 1920, height: 1080 });

    const video = await sql<{ width: number | null; height: number | null }[]>`
      SELECT width, height FROM studio_assets WHERE storage_key = ${key}
    `;
    expect(video[0]).toMatchObject({ width: 3840, height: 2160 });
  });

  it("hands the node the cover URL along with the video", async () => {
    const seed = await seedEditor();
    const { nodeId, cover } = await uploadVideo(seed);

    const events = (await eventsFor(
      canvasSpaceDocName(seed.projectId, seed.spaceId),
    )).filter((e) => e.nodeId === nodeId);
    const settled = events[1]!.result;
    expect(settled?.coverUrl).toContain(cover.storageKey as string);
    expect(settled).toMatchObject({ width: 1920, height: 1080, duration: 12.5 });
  });

  // Cutting a frame is best-effort: a video holding no decodable frame, and a
  // container that timed out, both reach here the same way. Neither may cost
  // the user the upload.
  it("settles the video without a cover when the answer carried none", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, {
      filename: "clip.mp4",
      content_type: "video/mp4",
      node_id: nodeId,
    });

    const res = await report(
      completed(key, { content_type: "video/mp4", size_bytes: 200_000 }),
    );

    expect(res.refused).toBeUndefined();
    const video = await sql<{ cover_asset_id: string | null }[]>`
      SELECT cover_asset_id FROM studio_assets WHERE storage_key = ${key}
    `;
    expect(video[0]!.cover_asset_id).toBeNull();
    const events = (await eventsFor(
      canvasSpaceDocName(seed.projectId, seed.spaceId),
    )).filter((e) => e.nodeId === nodeId);
    expect(events[1]!.counts).toMatchObject({ running: 0, done: 1 });
    expect(events[1]!.result?.coverUrl).toBeNull();
  });

  // The history row is where the panel reads a video's preview from, and
  // restoring an entry writes what it holds back onto the node — so an entry
  // with no thumbnail takes the node's cover away when it is restored.
  it("gives the video's history row the cover as its thumbnail", async () => {
    const seed = await seedEditor();
    const { key, cover } = await uploadVideo(seed);

    await report(
      completed(key, {
        content_type: "video/mp4",
        size_bytes: 200_000,
        cover,
      }),
    );

    const rows = await sql<{ thumbnail_url: string | null }[]>`
      SELECT thumbnail_url FROM node_history WHERE upload_storage_key = ${key}
    `;
    expect(rows[0]?.thumbnail_url).toMatch(/_cover\.png$/);
  });

  // The video row carries its cover from the insert, so nothing can read the
  // row in a state where it has none — the window a dedup hit fell into
  // (#187). The cover being the older of the two rows is what shows it was
  // filed first.
  it("files the cover before the video that points at it", async () => {
    const seed = await seedEditor();
    const { key, cover } = await uploadVideo(seed);

    await report(
      completed(key, {
        content_type: "video/mp4",
        size_bytes: 200_000,
        cover,
      }),
    );

    const rows = await sql<{ storage_key: string }[]>`
      SELECT storage_key FROM studio_assets
      WHERE storage_key IN (${key}, ${cover.storageKey as string})
      ORDER BY created_at ASC, storage_key ASC
    `;
    expect(rows.map((r) => r.storage_key)).toEqual([cover.storageKey, key]);
  });

  // A repeat report means the browser did not hear the first answer. The
  // cover it carries is the same one, and registering it twice would leave a
  // second object nobody points at.
  it("registers one cover however many times the report arrives", async () => {
    const seed = await seedEditor();
    const { key, cover } = await uploadVideo(seed);

    await report(
      completed(key, {
        content_type: "video/mp4",
        size_bytes: 200_000,
        cover,
      }),
    );

    const rows = await sql<{ n: string }[]>`
      SELECT count(*) AS n FROM studio_assets
      WHERE storage_key = ${cover.storageKey as string}
    `;
    expect(rows[0]!.n).toBe("1");
  });

  // Within a studio the same bytes are one row. The second upload's node has
  // to come back showing the cover the first one already has — the window
  // where it could not was #187.
  it("shows the cover the surviving row already carries", async () => {
    const seed = await seedEditor();
    const sharedHash = crypto.randomBytes(32).toString("hex");
    const firstCover = coverAnswer();

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
        cover: firstCover,
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
        cover: coverAnswer(),
      }),
    );

    const events = (await eventsFor(
      canvasSpaceDocName(seed.projectId, seed.spaceId),
    )).filter((e) => e.nodeId === secondNodeId);
    const settled = events.at(-1)!.result;
    // The URL names the object the surviving row points at, never the one this
    // upload just wrote — that one is what the reclaim job removes.
    expect(settled?.coverUrl).toContain(firstCover.storageKey as string);
  });

  // The same window, reached the other way: this upload's own container run
  // cut nothing — it timed out, or there was no deadline to run under — while
  // the row it deduped onto has a cover sitting on it. Reading that row is what
  // the node needs, and it does not depend on this run having succeeded.
  it("shows the surviving row's cover even when this run cut none", async () => {
    const seed = await seedEditor();
    const sharedHash = crypto.randomBytes(32).toString("hex");
    const firstCover = coverAnswer();

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
        cover: firstCover,
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

    const events = (await eventsFor(
      canvasSpaceDocName(seed.projectId, seed.spaceId),
    )).filter((e) => e.nodeId === secondNodeId);
    const settled = events.at(-1)!.result;
    expect(settled?.coverUrl).toContain(firstCover.storageKey as string);
  });

  // The container writes the frame to a key rather than minting one, so the
  // key has to travel with the request that asks for it. Minting it here keeps
  // every key in the ledger coming from the one place that mints keys.
  it("asks the Worker for a cover, naming the key to write it to", async () => {
    const seed = await seedEditor();
    await uploadVideo(seed);

    expect(lastFinishBody.coverKey).toMatch(/^video\/\d{4}-\d{2}-\d{2}\/.+_cover\.png$/);
  });

  // Named on every upload, including the ones this side believes have no frame
  // to cut: nothing here has seen a byte, and what an upload was announced as
  // says nothing about what is in it. The edge narrows, off the type it reads
  // from the stored object (#240).
  it("names a key on an image too, leaving the edge to judge", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed, { node_id: crypto.randomUUID() });

    await report(completed(key));

    expect(lastFinishBody.coverKey).toBe(`${key.replace(/\.[^./]+$/, "")}_cover.png`);
  });

  it("registers no cover for an image, which the answer carries none for", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed, { node_id: crypto.randomUUID() });

    await report(completed(key));

    const rows = await sql<{ cover_asset_id: string | null }[]>`
      SELECT cover_asset_id FROM studio_assets WHERE storage_key = ${key}
    `;
    expect(rows[0]!.cover_asset_id).toBeNull();
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

    expect((await report(completed(key))).refused).toBeUndefined();

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

  // Every call on the upload's chain is cut at the task's deadline, so an
  // abort that arrives past it is the deadline's doing whatever it names.
  it("settles the row as expired when the abort arrives past the task's deadline", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });
    await sql`
      UPDATE node_tasks SET started_at = now() - (budget_ms + 1000) * interval '1 millisecond'
      WHERE node_id = ${nodeId}
    `;

    await report({ storage_key: key, outcome: "aborted" });

    const rows = await tasksOn(nodeId);
    expect(rows[0]!.status).toBe("expired");
    expect(rows[0]!.error_message).toBe("expired");
  });

  // Four failures answer the same status at the edge, and one more never
  // reaches it at all. What the list shows has to say which of them happened,
  // or every one of them reads to the user as the source being at fault.
  it("writes down the reason the caller named for the abort", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });

    await ingestReportService.applyIngestReport({
      storageKey: key,
      outcome: "aborted",
      reason: "ingest_no_answer",
    });

    const rows = await tasksOn(nodeId);
    expect(rows[0]!.error_message).toBe("ingest_no_answer");
  });

  // The edge is the one place that ever sees these bytes, so "we do not take
  // this format" can only be said there. Left unnamed it arrives as a bare
  // abort, and the list tells the user their transfer was interrupted — a
  // thing to try again, when trying again refuses identically every time.
  it("writes down the format refusal the edge named, not a bare abort", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });

    const res = await report({
      storage_key: key,
      refusal: "unsupported_type",
    });

    expect(res.refused?.reason).toBe("unsupported_type");
    const rows = await tasksOn(nodeId);
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.error_message).toBe("unsupported_type");
  });

  // The no-answer arm. A file picked off a disk has no address, so the token
  // the URL lane settles on there would describe something that does not exist
  // on this one — what did happen is that the transfer did not finish.
  it("says the transfer stopped when the finish call answered nothing", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });

    const res = await report({ storage_key: key, unreachable: true });

    expect(res.refused).toBeDefined();
    const rows = await tasksOn(nodeId);
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.error_message).toBe("aborted");
  });

  // A source that answers 200 with no body produces a completed report of
  // zero bytes. The grant is voided either way; what was missing is the node
  // being told, which left the row running until a harvest called it expired.
  it("settles the row as failed when nothing arrived", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });

    await ingestReportService.applyIngestReport({
      storageKey: key,
      outcome: "completed",
      sha256: crypto.randomBytes(32).toString("hex"),
      sizeBytes: 0,
      contentType: "image/png",
    });

    const rows = await tasksOn(nodeId);
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.error_message).toBe("empty");
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

    expect((await report(body)).refused).toBeUndefined();
    const second = await tasksOn(nodeId);

    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      status: "done",
      node_history_id: first[0]!.node_history_id,
    });
  });

  it("answers a repeat whose ledger row is gone without minting a url", async () => {
    // A replay resolves the stable asset id on the grant. A deleted asset
    // cannot be replaced by another row sharing the Worker's reported hash.
    const seed = await seedEditor();
    const key = await mintTicket(seed, { node_id: crypto.randomUUID() });
    const sha = crypto.randomBytes(32).toString("hex");
    const body = completed(key, { sha256: sha });

    await report(body);
    // Gone the way a ledger row goes: soft-deleted, never removed.
    await sql`UPDATE studio_assets SET deleted_at = now() WHERE content_hash = ${sha}`;

    const res = await report(body);

    expect(res.outcome.status).toBe("stale");
    expect(res.outcome).not.toHaveProperty("fileUrl");
  });

  // A queued finish that ran again after the first one registered, and failed
  // this time: what the first one wrote stands (inner#1367 §4.2a).
  it("restores a consumed upload success when a later report carries an abort", async () => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });
    await report(completed(key));
    const before = await tasksOn(nodeId);

    const res = await report({ storage_key: key, outcome: "aborted" });

    expect(res.outcome.status).toBe("already_registered");
    expect(res.refused).toBeUndefined();
    const rows = await tasksOn(nodeId);
    expect(rows[0]!.status).toBe("done");
    expect(rows[0]!.node_history_id).toBe(before[0]!.node_history_id);
    const grants = await sql<{ voided_at: Date | null }[]>`
      SELECT voided_at FROM upload_grants WHERE storage_key = ${key}
    `;
    expect(grants[0]!.voided_at).toBeNull();
  });

  it("settles nothing for an upload with no node behind it", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed, { node_id: undefined, space_id: undefined });

    expect((await report(completed(key))).refused).toBeUndefined();

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

    expect(res.status).toBe(202);
    const result = await runQueuedFinish(key);
    expect(result.outcome).toMatchObject({ status: "registered", fileUrl: expect.any(String) });
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
    expect(res.status).toBe(202);
    await runQueuedFinish(myKey);
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

  // A browser that did not hear 202 sends the finish again; the key is the
  // job id, so the job already queued is the only one (inner#1367 §4.2a).
  it("queues one finish however many times the browser asks", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed);
    workerAnswers({
      sha256: crypto.randomBytes(32).toString("hex"),
      sizeBytes: 4096,
      contentType: "image/png",
    });
    const token = await tokenFor(key);

    expect((await finish(token, { parts: PARTS }, seed.cookie)).status).toBe(202);
    expect((await finish(token, { parts: PARTS }, seed.cookie)).status).toBe(202);

    const queue = createQueue(UPLOAD_FINISH_QUEUE);
    const queued = (await queue.getJobs(["waiting", "delayed", "active"])).filter(
      (job) => job.id === key,
    );
    expect(queued).toHaveLength(1);
    await runQueuedFinish(key);
  });

  it("voids the grant and answers 502 when the finish could not be queued", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed);
    const add = vi
      .spyOn(Queue.prototype, "add")
      .mockRejectedValueOnce(new Error("the queue's Redis is unreachable"));

    const res = await finish(await tokenFor(key), { parts: PARTS }, seed.cookie);
    add.mockRestore();

    expect(res.status).toBe(502);
    const grants = await sql<{ voided_at: Date | null; failure_reason: string | null }[]>`
      SELECT voided_at, failure_reason FROM upload_grants WHERE storage_key = ${key}
    `;
    expect(grants[0]!.voided_at).not.toBeNull();
    expect(grants[0]!.failure_reason).toBe("not_started");
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
      expect(first.status).toBe(202);
      await runQueuedFinish(key);

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
        deadlineAt: Date.now() + 3_600_000,
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
        deadlineAt: Date.now() + 3_600_000,
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
        deadlineAt: Date.now() + 3_600_000,
      },
    );

    const feed = (await sql`
      SELECT id FROM project_activities WHERE project_id = ${seed.projectId}
    `) as unknown as { id: string }[];
    expect(feed).toHaveLength(0);
  });
});

describe("the upload status query (inner#1367)", () => {
  /** Ask how these uploads ended, as `cookie`'s user. */
  async function statusOf(
    cookie: string,
    keys: string[],
  ): Promise<{ res: Response; items: Record<string, unknown>[] }> {
    const query = keys.map((k) => `key=${encodeURIComponent(k)}`).join("&");
    const res = await app.request(`/api/v1/assets/upload-status?${query}`, {
      headers: { cookie },
    });
    const items =
      res.status === 200
        ? ((await res.json()) as { data: { items: Record<string, unknown>[] } }).data.items
        : [];
    return { res, items };
  }

  it("answers an upload still being finished as finishing", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed);

    const { items } = await statusOf(seed.cookie, [key]);

    expect(items).toEqual([{ key, state: "finishing" }]);
  });

  it("answers a registered upload with what it registered as", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed);
    await report(completed(key, { width: 800, height: 600 }));

    const { items } = await statusOf(seed.cookie, [key]);

    const asset = await sql<{ id: string; file_url: string }[]>`
      SELECT id, file_url FROM studio_assets WHERE storage_key = ${key}
    `;
    expect(items).toEqual([
      {
        key,
        state: "completed",
        result: {
          assetId: asset[0]!.id,
          fileUrl: asset[0]!.file_url,
          kind: "image",
          width: 800,
          height: 600,
        },
      },
    ]);
  });

  it("answers a voided upload with the reason written on its grant", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed);
    await ingestReportService.applyIngestReport({
      storageKey: key,
      outcome: "aborted",
      reason: "unsupported_type",
    });

    const { items } = await statusOf(seed.cookie, [key]);

    expect(items).toEqual([{ key, state: "failed", reason: "unsupported_type" }]);
  });

  it("answers expired for one still finishing past its two hours, and writes nothing", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed);
    await sql`
      UPDATE upload_grants
      SET created_at = now() - interval '2 hours' - interval '1 second'
      WHERE storage_key = ${key}
    `;

    const { items } = await statusOf(seed.cookie, [key]);

    expect(items).toEqual([{ key, state: "failed", reason: "expired" }]);
    const grants = await sql<{ voided_at: Date | null }[]>`
      SELECT voided_at FROM upload_grants WHERE storage_key = ${key}
    `;
    expect(grants[0]!.voided_at).toBeNull();
  });

  it("answers unknown for someone else's upload and for a key never issued", async () => {
    const owner = await seedEditor();
    const other = await seedEditor();
    const key = await mintTicket(owner);
    const mine = await mintTicket(other);

    const { items } = await statusOf(other.cookie, [key, "image/never/issued.png", mine]);

    expect(items).toEqual([
      { key, state: "unknown" },
      { key: "image/never/issued.png", state: "unknown" },
      { key: mine, state: "finishing" },
    ]);
  });

  it("tells the caller how long to wait before asking again", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed);

    const { res } = await statusOf(seed.cookie, [key]);

    expect(res.headers.get("retry-after")).toBe(
      String(getStorageConfig().upload.upload_status_poll_seconds),
    );
  });

  it("refuses a request naming no upload, or more than one request may carry", async () => {
    const seed = await seedEditor();

    // 422 is what every route's request validation answers.
    expect((await statusOf(seed.cookie, [])).res.status).toBe(422);
    const many = Array.from({ length: UPLOAD_STATUS_MAX_KEYS + 1 }, (_, i) => `k/${i}`);
    expect((await statusOf(seed.cookie, many)).res.status).toBe(422);
  });

  it("requires a signed-in caller", async () => {
    const res = await app.request("/api/v1/assets/upload-status?key=a");
    expect(res.status).toBe(401);
  });
});

describe("Project association and upload terminal arbitration", () => {
  type CompletedIntent = Extract<Parameters<typeof ingestReportService.applyIngestReport>[0], { outcome: "completed" }>;
  type TerminalIntent = "completed" | "aborted" | "over_cap" | "empty";

  /**
   * Build an internal report for a ticket already issued through the real API.
   * @returns The measured completion input without another Worker request.
   * @throws {Error} When the runtime cannot obtain the fixture's random hash.
   */
  function measuredCompletion(key: string, sha = crypto.randomBytes(32).toString("hex")): CompletedIntent {
    return { storageKey: key, outcome: "completed", sha256: sha, sizeBytes: 4096, contentType: "image/png" };
  }

  /**
   * Select one of the four real terminal report paths.
   * @returns The report passed to the registration service.
   */
  function terminalReport(base: CompletedIntent, intent: TerminalIntent): Parameters<typeof ingestReportService.applyIngestReport>[0] {
    if (intent === "aborted") return { storageKey: base.storageKey, outcome: "aborted", reason: "store_failed" };
    if (intent === "empty") return { ...base, sizeBytes: 0 };
    if (intent === "over_cap") return { ...base, sizeBytes: getStorageConfig().upload.max_upload_bytes + 1 };
    return base;
  }

  /**
   * Read the grant's durable terminal without reducing it to one status field.
   * @returns The grant's canonical identity and mutually exclusive terminals.
   * @throws {Error} When the database cannot return the issued grant.
   */
  async function terminalOn(key: string): Promise<{ consumed: boolean; voided: boolean; asset_id: string | null }> {
    const rows = await sql<{ consumed: boolean; voided: boolean; asset_id: string | null }[]>`
      SELECT consumed_at IS NOT NULL AS consumed, voided_at IS NOT NULL AS voided, asset_id
      FROM upload_grants WHERE storage_key = ${key}
    `;
    if (rows.length !== 1) throw new Error("issued upload grant missing");
    return rows[0]!;
  }

  /**
   * Read live Project associations for one upload's Project.
   * @returns The actual canonical asset identities in the Project directory.
   * @throws {Error} When the association query fails.
   */
  async function associatedAssets(projectId: string): Promise<string[]> {
    const rows = await sql<{ asset_id: string }[]>`
      SELECT asset_id FROM project_asset_refs
      WHERE project_id = ${projectId} AND deleted_at IS NULL ORDER BY asset_id
    `;
    return rows.map((row) => row.asset_id);
  }

  /**
   * Refuse association writes in PostgreSQL for only the current Project.
   * @returns Once the supplied operation and trigger cleanup finish.
   * @throws {Error} When setup, the operation, or database cleanup fails.
   */
  async function withAssociationFailure(projectId: string, run: () => Promise<void>): Promise<void> {
    const suffix = crypto.randomBytes(8).toString("hex");
    const name = `timeline_ingest_ref_fault_${suffix}`;
    await sql.unsafe(`CREATE FUNCTION ${name}() RETURNS trigger AS $$
      BEGIN
        IF NEW.project_id = '${projectId}'::uuid THEN
          RAISE EXCEPTION 'injected Project association failure';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    try {
      await sql.unsafe(`CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON project_asset_refs
        FOR EACH ROW EXECUTE FUNCTION ${name}()`);
      try {
        await run();
      } finally {
        await sql.unsafe(`DROP TRIGGER IF EXISTS ${name} ON project_asset_refs`);
      }
    } finally {
      await sql.unsafe(`DROP FUNCTION IF EXISTS ${name}()`);
    }
  }

  it("returns a nodeless registration only after its canonical Project association exists", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed, { node_id: undefined, space_id: undefined });
    const result = await ingestReportService.applyIngestReport(measuredCompletion(key));
    expect(result.status).toBe("registered");
    const terminal = await terminalOn(key);
    expect(terminal).toEqual({ consumed: true, voided: false, asset_id: expect.any(String) });
    expect(await associatedAssets(seed.projectId)).toEqual([terminal.asset_id]);
    expect(await sql`SELECT id FROM node_tasks WHERE storage_key = ${key}`).toEqual([]);
  });

  it("associates a backend dedup hit with the surviving asset in both Projects", async () => {
    const seed = await seedEditor();
    const firstKey = await mintTicket(seed, { node_id: undefined, space_id: undefined });
    const firstInput = measuredCompletion(firstKey);
    const first = await ingestReportService.applyIngestReport(firstInput);
    expect(first.status).toBe("registered");
    const canonical = (await terminalOn(firstKey)).asset_id;
    const projectId = crypto.randomUUID();
    await sql`INSERT INTO projects (id, studio_id, created_by_user_id, name, slug)
      VALUES (${projectId}, ${seed.studioId}, ${seed.userId}, 'Dedup target', ${projectId})`;
    await sql`INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${projectId}, ${seed.userId}, 'owner', null)`;
    const target = { ...seed, projectId, spaceId: crypto.randomUUID() };
    const secondKey = await mintTicket(target, { node_id: undefined, space_id: undefined });
    const second = await ingestReportService.applyIngestReport(measuredCompletion(secondKey, firstInput.sha256));
    expect(second).toMatchObject({ status: "registered", assetId: canonical, ownRow: false });
    expect(await associatedAssets(seed.projectId)).toEqual([canonical]);
    expect(await associatedAssets(projectId)).toEqual([canonical]);
    expect(await terminalOn(secondKey)).toEqual({ consumed: true, voided: false, asset_id: canonical });
  });

  it("requires the Project association before the browser hash-dedup endpoint returns alreadyExists", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed, { node_id: undefined, space_id: undefined });
    const input = measuredCompletion(key);
    await ingestReportService.applyIngestReport(input);
    const canonical = (await terminalOn(key)).asset_id;
    await sql`UPDATE project_asset_refs SET deleted_at = now() WHERE project_id = ${seed.projectId}`;
    const request = {
      method: "POST",
      headers: { "content-type": "application/json", cookie: seed.cookie },
      body: JSON.stringify({
        filename: "dedup.png", content_type: "image/png", size: 4096,
        client_hash: input.sha256, project_id: seed.projectId,
      }),
    };
    await withAssociationFailure(seed.projectId, async () => {
      const refused = await app.request("/api/v1/assets/upload-ticket", request);
      expect(refused.status).toBe(500);
    });
    expect(await associatedAssets(seed.projectId)).toEqual([]);
    const accepted = await app.request("/api/v1/assets/upload-ticket", request);
    expect(accepted.status).toBe(200);
    const payload = await accepted.json() as { data: Record<string, unknown> };
    expect(payload.data).toMatchObject({ alreadyExists: true, assetId: canonical });
    expect(await associatedAssets(seed.projectId)).toEqual([canonical]);
  });

  it.each(["registered", "already_registered", "completed"] as const)(
    "cannot return %s while the actual association write fails",
    async (successShape) => {
      const seed = await seedEditor();
      const nodeId = crypto.randomUUID();
      const key = await mintTicket(seed, { node_id: nodeId });
      const input = measuredCompletion(key);
      if (successShape !== "registered") {
        await ingestReportService.applyIngestReport(input);
        await sql`UPDATE project_asset_refs SET deleted_at = now() WHERE project_id = ${seed.projectId}`;
      }
      const eventsBefore = await eventsFor(canvasSpaceDocName(seed.projectId, seed.spaceId));
      await withAssociationFailure(seed.projectId, async () => {
        const operation = successShape === "completed"
          ? uploadStatusService.statusOf(seed.userId, [key])
          : ingestReportService.applyIngestReport(input);
        await expect(operation).rejects.toBeInstanceOf(Error);
      });
      expect(await associatedAssets(seed.projectId)).toEqual([]);
      expect(await eventsFor(canvasSpaceDocName(seed.projectId, seed.spaceId))).toEqual(eventsBefore);
      if (successShape === "registered") {
        expect(await terminalOn(key)).toEqual({ consumed: false, voided: false, asset_id: null });
        expect(await sql`SELECT id FROM node_history WHERE node_id = ${nodeId}`).toEqual([]);
      }
    },
  );

  it.each(["report", "status"] as const)("repairs a legacy consumed grant through %s before answering success", async (path) => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });
    const input = measuredCompletion(key);
    await ingestReportService.applyIngestReport(input);
    const canonical = (await terminalOn(key)).asset_id;
    await sql`UPDATE project_asset_refs SET deleted_at = now() WHERE project_id = ${seed.projectId}`;
    expect(await associatedAssets(seed.projectId)).toEqual([]);
    const before = await eventsFor(canvasSpaceDocName(seed.projectId, seed.spaceId));
    if (path === "report") {
      expect(await ingestReportService.applyIngestReport(input)).toMatchObject({ status: "already_registered", assetId: canonical });
    } else {
      expect(await uploadStatusService.statusOf(seed.userId, [key])).toEqual([{
        key, state: "completed", result: {
          assetId: canonical, fileUrl: expect.any(String), kind: "image", width: null, height: null,
        },
      }]);
      expect(await eventsFor(canvasSpaceDocName(seed.projectId, seed.spaceId))).toEqual(before);
    }
    expect(await associatedAssets(seed.projectId)).toEqual([canonical]);
    expect(await terminalOn(key)).toEqual({ consumed: true, voided: false, asset_id: canonical });
  });

  it("keeps the consumed asset identity when the same hash is registered again after deletion", async () => {
    const seed = await seedEditor();
    const key = await mintTicket(seed, { node_id: crypto.randomUUID() });
    const input = measuredCompletion(key);
    await ingestReportService.applyIngestReport(input);
    const original = (await terminalOn(key)).asset_id;
    await sql`UPDATE studio_assets SET deleted_at = now() WHERE id = ${original}`;
    const replacementKey = await mintTicket(seed, { node_id: undefined, space_id: undefined });
    await ingestReportService.applyIngestReport(measuredCompletion(replacementKey, input.sha256));
    const replacement = (await terminalOn(replacementKey)).asset_id;
    expect(replacement).not.toBe(original);
    const before = await eventsFor(canvasSpaceDocName(seed.projectId, seed.spaceId));
    const replay = await ingestReportService.applyIngestReport(input);
    expect(replay.status).toBe("stale");
    expect(replay).not.toHaveProperty("fileUrl");
    expect((await terminalOn(key)).asset_id).toBe(original);
    expect(await uploadStatusService.statusOf(seed.userId, [key])).toEqual([{ key, state: "unknown" }]);
    expect(await eventsFor(canvasSpaceDocName(seed.projectId, seed.spaceId))).toEqual(before);
  });

  it.each([
    ["aborted", "completed"], ["aborted", "void"],
    ["over_cap", "completed"], ["over_cap", "void"],
    ["empty", "completed"], ["empty", "void"],
  ] as const)("arbitrates completed against %s when %s reaches the grant lock first", async (otherIntent, firstIntent) => {
    const seed = await seedEditor();
    const nodeId = crypto.randomUUID();
    const key = await mintTicket(seed, { node_id: nodeId });
    const input = measuredCompletion(key);
    const reports = firstIntent === "completed"
      ? [input, terminalReport(input, otherIntent)]
      : [terminalReport(input, otherIntent), input];
    const gate = createPgClient(inject("DATABASE_URL"), {
      name: "upload-terminal-arbitration-gate", max: 1, prepare: false,
    });
    try {
      await gate`BEGIN`;
      await gate`SELECT id FROM upload_grants WHERE storage_key = ${key} FOR UPDATE`;
      let interleavingError: unknown;
      const first = ingestReportService.applyIngestReport(reports[0]!);
      const observedFirst = Promise.allSettled([first]);
      let observedSecond: ReturnType<typeof Promise.allSettled> | undefined;
      try {
        await waitUntilBlockedOn(sql, ["upload_grants", "for update"], 1);
        const second = ingestReportService.applyIngestReport(reports[1]!);
        observedSecond = Promise.allSettled([second]);
        await waitUntilBlockedOn(sql, ["upload_grants", "for update"], 2);
        const before = (await eventsFor(canvasSpaceDocName(seed.projectId, seed.spaceId))).filter((event) => event.nodeId === nodeId);
        expect(before).toHaveLength(1);
        expect(before[0]!.counts).toMatchObject({ running: 1, failed: 0 });
        expect(before[0]!.result).toBeUndefined();
      } catch (error) {
        interleavingError = error;
      } finally {
        await gate`ROLLBACK`;
      }
      const settled = [...await observedFirst, ...await (observedSecond ?? Promise.resolve([]))];
      if (interleavingError !== undefined) throw interleavingError;
      expect(settled.map((entry) => entry.status)).toEqual(["fulfilled", "fulfilled"]);
      const terminal = await terminalOn(key);
      expect([terminal.consumed, terminal.voided]).toEqual(firstIntent === "completed" ? [true, false] : [false, true]);
      const tasks = await sql<{ status: string }[]>`SELECT status FROM node_tasks WHERE storage_key = ${key}`;
      expect(tasks).toEqual([{ status: terminal.consumed ? "done" : "failed" }]);
      const ended = (await eventsFor(canvasSpaceDocName(seed.projectId, seed.spaceId))).filter((event) => event.nodeId === nodeId).slice(1);
      expect(ended.some((event) => event.counts.running === 0)).toBe(true);
      expect(ended.every((event) => terminal.consumed
        ? typeof event.result?.content === "string" && event.counts.failed === 0
        : event.result === undefined && event.counts.failed === 1)).toBe(true);
    } finally {
      await gate.end({ timeout: 1 });
    }
  });

  it("preserves the first committed terminal over generated report and replay sequences", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.constantFrom(...(["completed", "aborted", "over_cap", "empty"] as const)), { minLength: 1, maxLength: 5 }),
      async (intents) => {
        const seed = await seedEditor();
        const nodeId = crypto.randomUUID();
        const key = await mintTicket(seed, { node_id: nodeId });
        const input = measuredCompletion(key);
        const consumed = intents[0] === "completed";
        let originalAssetId: string | null = null;
        for (const intent of intents) {
          const outcome = await ingestReportService.applyIngestReport(terminalReport(input, intent));
          const terminal = await terminalOn(key);
          expect([terminal.consumed, terminal.voided]).toEqual([consumed, !consumed]);
          if (consumed) {
            expect(["registered", "already_registered"]).toContain(outcome.status);
            originalAssetId ??= terminal.asset_id;
            expect(terminal.asset_id).toBe(originalAssetId);
            expect(await associatedAssets(seed.projectId)).toEqual([originalAssetId]);
          } else {
            expect(outcome).not.toHaveProperty("fileUrl");
          }
        }
        const tasks = await sql<{ status: string }[]>`SELECT status FROM node_tasks WHERE storage_key = ${key}`;
        expect(tasks).toEqual([{ status: consumed ? "done" : "failed" }]);
      },
    ), { numRuns: 12 });
  });
});
