// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The worker half of an address someone handed us (task #207, design §7.6).
 *
 * The route opened a grant and a task row and stopped; everything that moves
 * bytes happens here, in a job. What this pins is the two ends of that job —
 * what it asks the ingest Worker for, and what the node is left showing.
 *
 * The failures are the larger half. Four of them answer the same status at the
 * edge and one never reaches it at all, so the row a person opens has to say
 * which of them happened rather than blaming the source for all five.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";

/** The canvas routes reach the agent stack on import; this keeps it inert. */
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
  initCore,
  getRedis,
  setSession,
  sessionCookieName,
  loadLocales,
} from "@breatic/core";
import {
  INGEST_FAILURE_HEADER,
  verifyUploadTicket,
  type UploadTicketPayload,
} from "@breatic/shared";
import type { Hono } from "hono";
import type { Job } from "bullmq";
import {
  runUrlIngest,
  type UrlIngestJobData,
} from "@breatic/worker/src/handlers/url-ingest.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

const SOURCE = "https://cdn.test.invalid/clip.mp4";
const INGEST_SECRET = process.env.INGEST_SHARED_SECRET ?? "test-secret";

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "url-ingest-worker-test-driver" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  vi.unstubAllGlobals();
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
    VALUES (${`uiw-${seq++}@example.com`}, true) RETURNING id
  `;
  const userId = users[0]!.id;
  const studios = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`uiw-s-${seq++}`}, 'personal', 'Personal') RETURNING id
  `;
  const studioId = studios[0]!.id;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${userId}, 'admin')
  `;
  const slug = `uiw-proj-${seq++}`;
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

/**
 * Submit an address through the route, so the rows this job runs against are
 * the ones production opens rather than ones a test invented.
 * @returns Everything the queued job carries.
 */
async function submitted(): Promise<UrlIngestJobData & { nodeId: string }> {
  const seed = await seedEditor();
  const nodeId = crypto.randomUUID();
  const spaceId = crypto.randomUUID();

  const res = await app.request("/api/v1/canvas/ingest-url", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: seed.cookie },
    body: JSON.stringify({
      url: SOURCE,
      project_id: seed.projectId,
      space_id: spaceId,
      node_id: nodeId,
    }),
  });
  expect(res.status).toBe(201);

  const grants = await sql<{ storage_key: string }[]>`
    SELECT storage_key FROM upload_grants WHERE project_id = ${seed.projectId}
  `;
  return {
    storageKey: grants[0]!.storage_key,
    studioId: seed.studioId,
    url: SOURCE,
    userId: seed.userId,
    projectId: seed.projectId,
    spaceId,
    nodeId,
  };
}

/** Drive the job the route queued. */
async function run(data: UrlIngestJobData): Promise<void> {
  await runUrlIngest({ data } as Job<UrlIngestJobData>);
}

/** What the Worker answered, and what it was asked. */
let asked: { url: string; ticket: string } = { url: "", ticket: "" };

/**
 * Answer the one call this job makes with what `answer` describes.
 * @param answer - The Worker's response, or a failure to reach it at all.
 */
function workerAnswers(answer: Response | Error): void {
  asked = { url: "", ticket: "" };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      asked = {
        url: String(url),
        ticket: headers["x-upload-ticket"] ?? "",
      };
      if (answer instanceof Error) throw answer;
      return answer.clone();
    }),
  );
}

/** A Worker answer for an object that landed. */
function landed(over: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      sha256: crypto.randomBytes(32).toString("hex"),
      sizeBytes: 2048,
      contentType: "video/mp4",
      cover: null,
      ...over,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** A Worker refusal naming `code`. */
function refusal(status: number, code: string): Response {
  return new Response("no", {
    status,
    headers: { [INGEST_FAILURE_HEADER]: code },
  });
}

/** The task row on this node. */
async function taskOn(
  nodeId: string,
): Promise<{ status: string; error_message: string | null }> {
  const rows = await sql<{ status: string; error_message: string | null }[]>`
    SELECT status, error_message FROM node_tasks WHERE node_id = ${nodeId}
  `;
  return rows[0]!;
}

/** The grant's two settlement columns. */
async function grantOn(
  storageKey: string,
): Promise<{ consumed_at: Date | null; voided_at: Date | null }> {
  const rows = await sql<{ consumed_at: Date | null; voided_at: Date | null }[]>`
    SELECT consumed_at, voided_at FROM upload_grants
    WHERE storage_key = ${storageKey}
  `;
  return rows[0]!;
}

describe("the url ingest job — what it asks the Worker for", () => {
  it("asks the one endpoint that fetches an address, with the job's own url", async () => {
    const job = await submitted();
    workerAnswers(landed());

    await run(job);

    expect(asked.url).toMatch(/\/fetch$/);
  });

  it("signs a ticket that tells the Worker to take the source's own type", async () => {
    // The type cannot be signed here: nobody has seen a byte of what is behind
    // that address. What the ticket carries is a placeholder, and the flag is
    // what stops it being written to R2 as the truth.
    const job = await submitted();
    workerAnswers(landed());

    await run(job);

    const read = await verifyUploadTicket(asked.ticket, INGEST_SECRET, Date.now());
    expect(read.ok).toBe(true);
    const payload = (read as { ok: true; payload: UploadTicketPayload }).payload;
    expect(payload.typeFromSource).toBe(true);
    expect(payload.storageKey).toBe(job.storageKey);
    expect(payload.studioId).toBe(job.studioId);
  });
});

describe("the url ingest job — when the transfer lands", () => {
  it("registers the asset under the type the source served", async () => {
    const job = await submitted();
    workerAnswers(landed({ contentType: "video/mp4", sizeBytes: 2048 }));

    await run(job);

    const rows = await sql<{ mime_type: string; kind: string; source: string }[]>`
      SELECT mime_type, kind, source FROM studio_assets
      WHERE storage_key = ${job.storageKey}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      mime_type: "video/mp4",
      kind: "video",
      source: "upload",
    });
  });

  it("settles the node's task as done and consumes the grant", async () => {
    const job = await submitted();
    workerAnswers(landed());

    await run(job);

    expect((await taskOn(job.nodeId)).status).toBe("done");
    const grant = await grantOn(job.storageKey);
    expect(grant.consumed_at).not.toBeNull();
    expect(grant.voided_at).toBeNull();
  });
});

describe("the url ingest job — when it does not", () => {
  /** Every refusal the Worker names, and what the node is left showing. */
  const NAMED: [number, string][] = [
    [502, "source_unreachable"],
    [415, "unsupported_type"],
    [413, "over_cap"],
    [502, "store_failed"],
    [502, "assemble_failed"],
  ];

  it.each(NAMED)(
    "shows %i as the reason the Worker named: %s",
    async (status, code) => {
      const job = await submitted();
      workerAnswers(refusal(status, code));

      await run(job);

      expect(await taskOn(job.nodeId)).toMatchObject({
        status: "failed",
        error_message: code,
      });
      expect((await grantOn(job.storageKey)).voided_at).not.toBeNull();
    },
  );

  it("says the source was too slow when nothing answered at all", async () => {
    // Our own deadline fires before the platform's, so this is what a transfer
    // that outran its window looks like from here — the one failure that
    // brings back no answer to read a name off.
    const job = await submitted();
    workerAnswers(new Error("http request to https://ingest.example timed out"));

    await run(job);

    expect(await taskOn(job.nodeId)).toMatchObject({
      status: "failed",
      error_message: "source_too_slow",
    });
  });

  it("refuses a Worker that answered with the placeholder it was handed", async () => {
    // The ticket asked for the source's type. An answer carrying the
    // placeholder back means that Worker never read one, and registering it
    // would put a type on the node that nothing ever measured.
    const job = await submitted();
    workerAnswers(landed({ contentType: "application/octet-stream" }));

    await run(job);

    expect(await taskOn(job.nodeId)).toMatchObject({
      status: "failed",
      error_message: "type_not_reported",
    });
    const rows = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM studio_assets
      WHERE storage_key = ${job.storageKey}
    `;
    expect(rows[0]!.n).toBe("0");
  });

  it("refuses a type outside the three kinds a node can hold", async () => {
    const job = await submitted();
    workerAnswers(landed({ contentType: "text/html" }));

    await run(job);

    expect(await taskOn(job.nodeId)).toMatchObject({
      status: "failed",
      error_message: "type_not_reported",
    });
  });
});
