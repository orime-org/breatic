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
import { initCore, getAgentConfig, getRedis, getStorageAdapter, setSession, sessionCookieName, loadLocales } from "@breatic/core";
import { agentPictureKeyFor, INGEST_FAILURE_HEADER } from "@breatic/shared";
import { backendUploadService, SaveRefused } from "@breatic/domain";
import type { createApp } from "@server/app.js";
import { getRateLimit } from "@server/config/rate-limits.js";
import { saveToStorageFor } from "@server/agent/save-to-storage.js";
import { picturePreparerFor } from "@server/agent/prepare-pictures.js";

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
function workerAnswers(answer: () => Response, onRequest?: (url: string, body: unknown) => Response | undefined): void {
  reached = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      reached.push(String(url));
      const handled = onRequest?.(String(url), JSON.parse(String(init?.body ?? "null")) as unknown);
      return handled ?? answer();
    }),
  );
}

/**
 * A Worker answer for a picture that landed. Its type differs from what the
 * link's `.jpg` suggests, so a registration that read the link would show.
 */
function landedPicture(contentHash = crypto.randomBytes(32).toString("hex")): Response {
  return new Response(
    JSON.stringify({
      sha256: contentHash,
      sizeBytes: 4096,
      contentType: "image/png",
      cover: null,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/**
 * Answer source transfers and JPEG reads, recording only the latter's JSON.
 *
 * Database registration, deduplication, authorization and Redis gates remain
 * real. The headers carrying the ingest capability are never inspected.
 * @param contentHash - A fixed source hash for a deduplication case.
 * @returns The JSON bodies actually sent to the external media endpoint.
 * @throws {never} Never.
 */
function pictureWorker(contentHash?: string): unknown[] {
  const reads: unknown[] = [];
  workerAnswers(() => landedPicture(contentHash), (url, body) => {
    if (!url.endsWith("/media")) return undefined;
    reads.push(body);
    return new Response(JSON.stringify({
      width: 1024,
      height: 768,
      durationSeconds: null,
      agentPicture: { outcome: "generated", sizeBytes: 6123, mediaType: "image/jpeg" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return reads;
}

/**
 * Read the canonical registered source row, without consulting an opened grant.
 * @param studioId - The Studio whose live source is being checked.
 * @param fileUrl - The URL returned by real asset registration.
 * @returns The one matching canonical key.
 * @throws {Error} when registration did not leave exactly one live row.
 */
async function canonicalKey(studioId: string, fileUrl: string): Promise<string> {
  const assets = await sql<{ storage_key: string }[]>`
    SELECT storage_key FROM studio_assets
    WHERE studio_id = ${studioId} AND file_url = ${fileUrl} AND deleted_at IS NULL
  `;
  expect(assets).toHaveLength(1);
  return assets[0]!.storage_key;
}

/**
 * Spell the same stored address with a case-insensitive host and explicit port.
 * @param fileUrl - The URL returned by actual asset registration.
 * @returns An equivalent source URL with a view query and fragment.
 * @throws {TypeError} When registration returned an invalid URL.
 */
function equivalentLocalUrl(fileUrl: string): string {
  const parsed = new URL(fileUrl);
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return `${parsed.protocol}//${parsed.hostname.toUpperCase()}:${port}${parsed.pathname}?view=1#preview`;
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

describe("Agent pictures use the real Studio ledger and canonical registration", () => {
  it("prepares a registered local source using its canonical key and measured JPEG facts", async () => {
    const who = await seedEditor();
    pictureWorker();
    const saved = await saveToStorageFor(who)(SOURCE);
    const key = await canonicalKey(who.studioId, saved.url);
    const reads = pictureWorker();
    const source = { label: "Attachment 1", sourceUrl: saved.url };

    const prepared = await picturePreparerFor(who)([source]);

    const config = getAgentConfig();
    const spec = { version: 1 as const, longEdge: config.agent_picture_long_edge, quality: config.agent_picture_quality };
    const storage = await getStorageAdapter();
    expect(prepared).toEqual([{
      status: "ready", ...source,
      url: storage.publicUrl(agentPictureKeyFor(key, spec)),
      sizeBytes: 6123, mediaType: "image/jpeg",
    }]);
    expect(reads).toEqual([expect.objectContaining({ storageKey: key, contentType: "image/png", agentPicture: spec })]);
    expect(reached).toHaveLength(1);
    expect(reached[0]).toMatch(/\/media$/);
    expect(await grantsOf(who.projectId)).toHaveLength(1);
  });

  it("prepares an equivalent same-Studio URL using its existing canonical registration", async () => {
    const who = await seedEditor();
    pictureWorker();
    const saved = await saveToStorageFor(who)(SOURCE);
    const key = await canonicalKey(who.studioId, saved.url);
    const reads = pictureWorker();
    const source = { label: "Attachment 1", sourceUrl: equivalentLocalUrl(saved.url) };

    const prepared = await picturePreparerFor(who)([source]);

    const config = getAgentConfig();
    const spec = { version: 1 as const, longEdge: config.agent_picture_long_edge, quality: config.agent_picture_quality };
    const storage = await getStorageAdapter();
    expect(prepared).toEqual([{
      status: "ready", ...source,
      url: storage.publicUrl(agentPictureKeyFor(key, spec)),
      sizeBytes: 6123, mediaType: "image/jpeg",
    }]);
    expect(reads).toEqual([expect.objectContaining({ storageKey: key, agentPicture: spec })]);
    expect(reached.map((url) => new URL(url).pathname)).toEqual(["/media"]);
    expect(await grantsOf(who.projectId)).toHaveLength(1);
  });

  it("refuses another Studio's registered local source without reimport or JPEG IO", async () => {
    const owner = await seedEditor();
    const other = await seedEditor();
    pictureWorker();
    const saved = await saveToStorageFor(owner)(SOURCE);
    await canonicalKey(owner.studioId, saved.url);
    const reads = pictureWorker();
    const source = { label: "Attachment 1", sourceUrl: saved.url };

    const prepared = await picturePreparerFor(other)([source]);

    expect(prepared).toEqual([{
      status: "unavailable", ...source, reason: expect.stringMatching(/live asset.*Studio/),
    }]);
    expect(reads).toEqual([]);
    expect(reached).toEqual([]);
    expect(await grantsOf(other.projectId)).toEqual([]);
  });

  it("refuses an equivalent other-Studio URL before any grant or JPEG read", async () => {
    const owner = await seedEditor();
    const other = await seedEditor();
    pictureWorker();
    const saved = await saveToStorageFor(owner)(SOURCE);
    await canonicalKey(owner.studioId, saved.url);
    const reads = pictureWorker();
    const source = { label: "Attachment 1", sourceUrl: equivalentLocalUrl(saved.url) };

    const prepared = await picturePreparerFor(other)([source]);

    expect(prepared).toEqual([{
      status: "unavailable", ...source, reason: expect.stringMatching(/live asset.*Studio/),
    }]);
    expect(reads).toEqual([]);
    expect(reached).toEqual([]);
    expect(await grantsOf(other.projectId)).toEqual([]);
  });

  it("keeps invalid sources unavailable while preparing a registered picture in the same batch", async () => {
    const who = await seedEditor();
    pictureWorker();
    const saved = await saveToStorageFor(who)(SOURCE);
    const key = await canonicalKey(who.studioId, saved.url);
    const reads = pictureWorker();
    const sources = [
      { label: "Attachment 1", sourceUrl: "http://images.test.invalid/invalid.png" },
      { label: "Attachment 2", sourceUrl: "not a URL" },
      { label: "Attachment 3", sourceUrl: saved.url },
      { label: "Attachment 4", sourceUrl: `https://images.test.invalid/${"x".repeat(2049 - "https://images.test.invalid/".length)}` },
    ];

    const prepared = await picturePreparerFor(who)(sources);

    const config = getAgentConfig();
    const spec = { version: 1 as const, longEdge: config.agent_picture_long_edge, quality: config.agent_picture_quality };
    const storage = await getStorageAdapter();
    const unavailable = { status: "unavailable", reason: expect.stringMatching(/\S/) };
    expect(prepared).toEqual([
      { ...sources[0], ...unavailable },
      { ...sources[1], ...unavailable },
      { status: "ready", ...sources[2], url: storage.publicUrl(agentPictureKeyFor(key, spec)), sizeBytes: 6123, mediaType: "image/jpeg" },
      { ...sources[3], ...unavailable },
    ]);
    expect(reads).toEqual([expect.objectContaining({ storageKey: key, agentPicture: spec })]);
    expect(reached.map((url) => new URL(url).pathname)).toEqual(["/media"]);
    expect(await grantsOf(who.projectId)).toHaveLength(1);
  });

  it("refuses a deleted local source without reimporting its still-valid storage URL", async () => {
    const who = await seedEditor();
    pictureWorker();
    const saved = await saveToStorageFor(who)(SOURCE);
    const key = await canonicalKey(who.studioId, saved.url);
    await sql`
      UPDATE studio_assets SET deleted_at = now()
      WHERE studio_id = ${who.studioId} AND storage_key = ${key}
    `;
    const reads = pictureWorker();
    const source = { label: "Attachment 1", sourceUrl: saved.url };

    const prepared = await picturePreparerFor(who)([source]);

    expect(prepared).toEqual([{
      status: "unavailable", ...source, reason: expect.stringMatching(/live asset.*Studio/),
    }]);
    expect(reads).toEqual([]);
    expect(reached).toEqual([]);
    expect(await grantsOf(who.projectId)).toHaveLength(1);
  });

  it("prepares the deduplication winner after importing another URL with the same bytes", async () => {
    const who = await seedEditor();
    const hash = crypto.randomBytes(32).toString("hex");
    const reads = pictureWorker(hash);
    const first = await saveToStorageFor(who)(SOURCE);
    const winnerKey = await canonicalKey(who.studioId, first.url);
    const source = { label: "Search result 1", sourceUrl: "https://images.test.invalid/second/copy.bin" };

    const prepared = await picturePreparerFor(who)([source]);

    const config = getAgentConfig();
    const spec = { version: 1 as const, longEdge: config.agent_picture_long_edge, quality: config.agent_picture_quality };
    const storage = await getStorageAdapter();
    expect(prepared).toEqual([{
      status: "ready", ...source,
      url: storage.publicUrl(agentPictureKeyFor(winnerKey, spec)),
      sizeBytes: 6123, mediaType: "image/jpeg",
    }]);
    expect(reads).toEqual([expect.objectContaining({ storageKey: winnerKey, agentPicture: spec })]);
    const assets = await sql<{ storage_key: string; file_url: string }[]>`
      SELECT storage_key, file_url FROM studio_assets
      WHERE studio_id = ${who.studioId} AND content_hash = ${hash} AND deleted_at IS NULL
    `;
    expect(assets).toEqual([{ storage_key: winnerKey, file_url: first.url }]);
    const grants = await sql<{ storage_key: string; consumed_at: Date | null }[]>`
      SELECT storage_key, consumed_at FROM upload_grants WHERE project_id = ${who.projectId}
    `;
    expect(grants).toHaveLength(2);
    const loser = grants.find((grant) => grant.storage_key !== winnerKey);
    expect(loser).toMatchObject({ storage_key: expect.any(String), consumed_at: expect.any(Date) });
    expect((prepared[0] as { url: string }).url).not.toContain(loser!.storage_key);
    expect(reached.map((url) => new URL(url).pathname)).toEqual(["/fetch", "/fetch", "/media"]);
  });
});
