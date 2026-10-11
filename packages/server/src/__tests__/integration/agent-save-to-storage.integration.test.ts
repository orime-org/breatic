// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The agent's save against the real gates and ledger (inner#1315).
 *
 * `saveToStorageFor` runs the gates a link pasted on the canvas runs -- rate,
 * access, storage -- and then has the ingest Worker pull the link within the
 * turn's request. This suite drives it with the database, Redis and the report
 * path as they are; the one thing stood in for is the ingest Worker's answer,
 * which is the only call that leaves this process.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, inject, vi } from "vitest";
import crypto from "node:crypto";
import postgres from "postgres";
import { initCore, getRedis, setSession, sessionCookieName, loadLocales } from "@breatic/core";
import { INGEST_FAILURE_HEADER } from "@breatic/shared";
import { backendUploadService, SaveRefused } from "@breatic/domain";
import type { createApp } from "@server/app.js";
import { getRateLimit } from "@server/config/rate-limits.js";
import { saveToStorageFor } from "@server/agent/save-to-storage.js";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

const SOURCE = "https://images.test.invalid/found/cat.jpg";

let sql: ReturnType<typeof postgres>;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "agent-save-test-driver" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/** A fresh user, their personal studio, a project in it they own, and a session. */
async function seedEditor(): Promise<{ userId: string; studioId: string; projectId: string; cookie: string }> {
  const users = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`ags-${seq++}@example.com`}, true) RETURNING id
  `;
  const userId = users[0]!.id;
  const studios = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`ags-s-${seq++}`}, 'personal', 'Personal') RETURNING id
  `;
  const studioId = studios[0]!.id;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${userId}, 'admin')
  `;
  const slug = `ags-proj-${seq++}`;
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
  return { userId, studioId, projectId, cookie: `${sessionCookieName()}=${token}` };
}

/** The addresses this process asked for, in order. */
let reached: string[] = [];

/**
 * Answer every outbound call with `answer`, as the ingest Worker would.
 * @param answer - The Worker's response.
 */
function workerAnswers(answer: () => Response): void {
  reached = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      reached.push(String(url));
      return answer();
    }),
  );
}

/**
 * A Worker answer for a picture that landed. Its type differs from what the
 * link's `.jpg` suggests, so a registration that read the link would show.
 */
function landedPicture(): Response {
  return new Response(
    JSON.stringify({
      sha256: crypto.randomBytes(32).toString("hex"),
      sizeBytes: 4096,
      contentType: "image/png",
      cover: null,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** The grants this project has, with their settlement columns. */
async function grantsOf(projectId: string): Promise<{ consumed_at: Date | null; voided_at: Date | null }[]> {
  return sql<{ consumed_at: Date | null; voided_at: Date | null }[]>`
    SELECT consumed_at, voided_at FROM upload_grants WHERE project_id = ${projectId}
  `;
}

/**
 * What a save threw.
 * @param save - The save to run.
 * @returns The refusal it threw.
 */
async function refusalOf(save: Promise<unknown>): Promise<SaveRefused> {
  const err = await save.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SaveRefused);
  return err as SaveRefused;
}

describe("the agent's save — when the link lands", () => {
  it("registers the picture in the project's studio as the agent's, under the type the Worker judged", async () => {
    // The saver is an editor in someone else's project, so the project's
    // studio, the saver and the project's creator are three different answers.
    const owner = await seedEditor();
    const editor = await seedEditor();
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${owner.projectId}, ${editor.userId}, 'editor', ${owner.userId})
    `;
    workerAnswers(landedPicture);

    const saved = await saveToStorageFor({ projectId: owner.projectId, userId: editor.userId })(SOURCE);

    const rows = await sql<{ studio_id: string; file_url: string; mime_type: string; kind: string; source: string; produced_by_user_id: string }[]>`
      SELECT studio_id, file_url, mime_type, kind, source, produced_by_user_id
      FROM studio_assets WHERE file_url = ${saved.url}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      studio_id: owner.studioId,
      mime_type: "image/png",
      kind: "image",
      source: "agent",
      produced_by_user_id: editor.userId,
    });
    expect(saved.mimeType).toBe("image/png");
  });

  it("consumes the grant it opened", async () => {
    const { userId, projectId } = await seedEditor();
    workerAnswers(landedPicture);

    await saveToStorageFor({ projectId, userId })(SOURCE);

    const grants = await grantsOf(projectId);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.consumed_at).not.toBeNull();
  });

  it("asks only the Worker's fetch endpoint", async () => {
    const { userId, projectId } = await seedEditor();
    workerAnswers(landedPicture);

    await saveToStorageFor({ projectId, userId })(SOURCE);

    expect(reached).toHaveLength(1);
    expect(reached[0]).toMatch(/\/fetch$/);
  });
});

describe("the agent's save — the gates", () => {
  it("counts against the same throttle as a link pasted on the canvas", async () => {
    const { userId, projectId, cookie } = await seedEditor();
    const { max } = getRateLimit("ingest-url");
    for (let n = 0; n < max; n += 1) {
      const res = await app.request("/api/v1/canvas/ingest-url", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          url: SOURCE,
          project_id: projectId,
          space_id: crypto.randomUUID(),
          node_id: crypto.randomUUID(),
        }),
      });
      expect(res.status).toBe(201);
    }
    workerAnswers(landedPicture);

    const refused = await refusalOf(saveToStorageFor({ projectId, userId })(SOURCE));

    expect(refused.kind).toBe("rate_limited");
    expect(reached).toEqual([]);
  });

  it("refuses a viewer, who may read the project but not add to it", async () => {
    const owner = await seedEditor();
    const viewer = await seedEditor();
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${owner.projectId}, ${viewer.userId}, 'viewer', ${owner.userId})
    `;
    workerAnswers(landedPicture);

    const refused = await refusalOf(saveToStorageFor({ projectId: owner.projectId, userId: viewer.userId })(SOURCE));

    expect(refused.kind).toBe("no_access");
    expect(await grantsOf(owner.projectId)).toEqual([]);
    expect(reached).toEqual([]);
  });

  it("refuses someone with no role in the project", async () => {
    const owner = await seedEditor();
    const stranger = await seedEditor();
    workerAnswers(landedPicture);

    const refused = await refusalOf(saveToStorageFor({ projectId: owner.projectId, userId: stranger.userId })(SOURCE));

    expect(refused.kind).toBe("no_access");
    expect(await grantsOf(owner.projectId)).toEqual([]);
  });

  it("refuses when the studio has no storage left", async () => {
    const { studioId, userId, projectId } = await seedEditor();
    await sql`
      INSERT INTO studio_assets
        (studio_id, content_hash, storage_key, file_url, size_bytes,
         mime_type, kind, source, produced_by_user_id)
      VALUES
        (${studioId}, ${crypto.randomBytes(32).toString("hex")},
         ${`video/ags-${seq++}.mp4`}, 'https://cdn.test.invalid/x.mp4',
         ${"1000000000000000"}, 'video/mp4', 'video', 'upload', ${userId})
    `;
    workerAnswers(landedPicture);

    const refused = await refusalOf(saveToStorageFor({ projectId, userId })(SOURCE));

    expect(refused.kind).toBe("storage_full");
    expect(await grantsOf(projectId)).toEqual([]);
    expect(reached).toEqual([]);
  });
});

describe("the agent's save — when the link does not land", () => {
  it("tells a link the source would not serve as the link's, and voids the grant", async () => {
    const { userId, projectId } = await seedEditor();
    workerAnswers(() => new Response("no", { status: 502, headers: { [INGEST_FAILURE_HEADER]: "source_unreachable" } }));

    const refused = await refusalOf(saveToStorageFor({ projectId, userId })(SOURCE));

    expect(refused).toMatchObject({ kind: "link", detail: "source_unreachable" });
    const grants = await grantsOf(projectId);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.voided_at).not.toBeNull();
  });

  it("throws a failure on our side as it is, not as the link's", async () => {
    const { userId, projectId } = await seedEditor();
    workerAnswers(() => new Response("no", { status: 502, headers: { [INGEST_FAILURE_HEADER]: "store_failed" } }));

    const err = await saveToStorageFor({ projectId, userId })(SOURCE).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(backendUploadService.ReaderUrlTransferError);
    expect(err).toMatchObject({ reason: "store_failed" });
    expect((await grantsOf(projectId))[0]!.voided_at).not.toBeNull();
  });
});
