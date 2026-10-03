// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Project covers and studio avatars as ledgered assets (#21, #294).
 *
 * Both pictures travel the ordinary asset upload: a ticket, the ingest
 * Worker, a ledger row. What makes one of them a cover or an avatar is a
 * second call that points the project or the studio at that row, and that
 * call is where the permission lives. What this pins:
 *   - a studio-scoped ticket (an avatar has no project) is issued to the
 *     studio's admin only, and lands in that studio
 *   - the purpose becomes the grant's asset source; a cover is filed as a
 *     byproduct so the project feed does not announce it
 *   - a dedup hit answers with the row's id, so the caller can point at it
 *   - `PUT /projects/:id/cover` and `PUT /studio/:slug/avatar` accept only a
 *     live image row of the same studio, and copy its URL from the ledger
 *   - `PATCH /projects/:id` no longer writes the thumbnail
 *   - the old byte-receiving avatar upload is gone
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
  initCore,
  getRedis,
  setSession,
  sessionCookieName,
  loadLocales,
} from "@breatic/core";
import type { Hono } from "hono";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

let sql: ReturnType<typeof postgres>;
let app: Hono;

beforeAll(async () => {
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "cover-avatar-assets-test" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/** A user with a session. */
async function seedUser(): Promise<{ userId: string; cookie: string }> {
  const users = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`cov-${seq++}-${crypto.randomUUID()}@example.com`}, true) RETURNING id
  `;
  const userId = users[0]!.id;
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return { userId, cookie: `${sessionCookieName()}=${token}` };
}

/** A team studio administered by `adminId`, with one project `adminId` owns. */
async function seedStudio(adminId: string): Promise<{
  studioId: string;
  slug: string;
  projectId: string;
}> {
  const slug = `cov-s-${seq++}-${crypto.randomBytes(3).toString("hex")}`;
  const studios = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${adminId}, ${slug}, 'team', 'Team') RETURNING id
  `;
  const studioId = studios[0]!.id;
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${adminId}, 'admin')
  `;
  const projectSlug = `cov-p-${seq++}`;
  const projects = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, name, slug)
    VALUES (${studioId}, ${adminId}, 'P', ${projectSlug}) RETURNING id
  `;
  const projectId = projects[0]!.id;
  await sql`
    INSERT INTO project_members (project_id, user_id, role, added_by)
    VALUES (${projectId}, ${adminId}, 'owner', null)
  `;
  return { studioId, slug, projectId };
}

/** Add `userId` to the studio at `studioRole` and to the project at `projectRole`. */
async function addMember(
  studioId: string,
  projectId: string,
  userId: string,
  studioRole: "maintainer" | "guest",
  projectRole: "editor" | "viewer" | null,
): Promise<void> {
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${studioId}, ${userId}, ${studioRole})
  `;
  if (projectRole !== null) {
    await sql`
      INSERT INTO project_members (project_id, user_id, role, added_by)
      VALUES (${projectId}, ${userId}, ${projectRole}, null)
    `;
  }
}

/** A ledger row in `studioId`; returns its id and URL. */
async function seedAsset(
  studioId: string,
  producedBy: string,
  opts: { kind?: string; deleted?: boolean; sizeBytes?: number; hash?: string } = {},
): Promise<{ id: string; fileUrl: string; hash: string; sizeBytes: number }> {
  const hash = opts.hash ?? crypto.randomBytes(32).toString("hex");
  const kind = opts.kind ?? "image";
  const sizeBytes = opts.sizeBytes ?? 4096;
  const fileUrl = `https://cdn.test.invalid/${hash}.jpg`;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studio_assets
      (studio_id, content_hash, storage_key, file_url, size_bytes,
       mime_type, kind, source, produced_by_user_id, deleted_at)
    VALUES
      (${studioId}, ${hash}, ${`image/${hash}.jpg`}, ${fileUrl}, ${sizeBytes},
       ${kind === "image" ? "image/jpeg" : "video/mp4"}, ${kind}, 'upload',
       ${producedBy}, ${opts.deleted === true ? sql`now()` : null})
    RETURNING id
  `;
  return { id: rows[0]!.id, fileUrl, hash, sizeBytes };
}

/** A ticket request body for a JPEG, with the pieces a caller varies. */
function ticketBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    filename: "cover.jpg",
    content_type: "image/jpeg",
    size: 120_000,
    client_hash: crypto.randomBytes(32).toString("hex"),
    ...overrides,
  };
}

/** Send `method path` with a JSON body as the holder of `cookie`. */
async function call(
  cookie: string,
  method: string,
  path: string,
  payload?: unknown,
): Promise<Response> {
  return app.request(`/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    ...(payload !== undefined && { body: JSON.stringify(payload) }),
  });
}

/** The grant a ticket left behind, by its storage key. */
async function grantFor(storageKey: string): Promise<{
  studio_id: string;
  project_id: string | null;
  asset_source: string | null;
  derived: boolean | null;
}> {
  const rows = await sql<
    {
      studio_id: string;
      project_id: string | null;
      asset_source: string | null;
      derived: boolean | null;
    }[]
  >`
    SELECT studio_id, project_id, asset_source, derived
    FROM upload_grants WHERE storage_key = ${storageKey}
  `;
  return rows[0]!;
}

describe("studio-scoped upload ticket", () => {
  it("issues an avatar ticket to the studio's admin, filed under that studio", async () => {
    const admin = await seedUser();
    const { studioId } = await seedStudio(admin.userId);

    const res = await call(
      admin.cookie,
      "POST",
      "/assets/upload-ticket",
      ticketBody({ studio_id: studioId, purpose: "studio_avatar", content_type: "image/png" }),
    );

    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { storageKey: string } };
    const grant = await grantFor(data.storageKey);
    expect(grant.studio_id).toBe(studioId);
    expect(grant.project_id).toBeNull();
    expect(grant.asset_source).toBe("studio_avatar");
  });

  it("refuses a studio-scoped ticket to a member below admin", async () => {
    const admin = await seedUser();
    const maintainer = await seedUser();
    const { studioId, projectId } = await seedStudio(admin.userId);
    await addMember(studioId, projectId, maintainer.userId, "maintainer", null);

    const res = await call(
      maintainer.cookie,
      "POST",
      "/assets/upload-ticket",
      ticketBody({ studio_id: studioId, purpose: "studio_avatar" }),
    );

    expect(res.status).toBe(403);
  });

  it("refuses a studio-scoped ticket for anything but an avatar", async () => {
    const admin = await seedUser();
    const { studioId } = await seedStudio(admin.userId);

    const withoutPurpose = await call(
      admin.cookie,
      "POST",
      "/assets/upload-ticket",
      ticketBody({ studio_id: studioId }),
    );
    const asCover = await call(
      admin.cookie,
      "POST",
      "/assets/upload-ticket",
      ticketBody({ studio_id: studioId, purpose: "project_cover" }),
    );

    expect(withoutPurpose.status).toBe(422);
    expect(asCover.status).toBe(422);
  });

  it("refuses a ticket naming both a project and a studio", async () => {
    const admin = await seedUser();
    const { studioId, projectId } = await seedStudio(admin.userId);

    const res = await call(
      admin.cookie,
      "POST",
      "/assets/upload-ticket",
      ticketBody({ studio_id: studioId, project_id: projectId, purpose: "studio_avatar" }),
    );

    expect(res.status).toBe(422);
  });

  it("answers a studio-scoped dedup hit with the existing row's id", async () => {
    const admin = await seedUser();
    const { studioId } = await seedStudio(admin.userId);
    const asset = await seedAsset(studioId, admin.userId);

    const res = await call(
      admin.cookie,
      "POST",
      "/assets/upload-ticket",
      ticketBody({
        studio_id: studioId,
        purpose: "studio_avatar",
        client_hash: asset.hash,
        size: asset.sizeBytes,
      }),
    );

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { alreadyExists: boolean; assetId: string; fileUrl: string };
    };
    expect(data.alreadyExists).toBe(true);
    expect(data.assetId).toBe(asset.id);
    expect(data.fileUrl).toBe(asset.fileUrl);
  });
});

describe("project cover ticket", () => {
  it("files a cover as a byproduct under the project_cover source", async () => {
    const admin = await seedUser();
    const { projectId } = await seedStudio(admin.userId);

    const res = await call(
      admin.cookie,
      "POST",
      "/assets/upload-ticket",
      ticketBody({ project_id: projectId, purpose: "project_cover" }),
    );

    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { storageKey: string } };
    const grant = await grantFor(data.storageKey);
    expect(grant.project_id).toBe(projectId);
    expect(grant.asset_source).toBe("project_cover");
    expect(grant.derived).toBe(true);
  });

  it("answers a project-scoped dedup hit with the existing row's id", async () => {
    const admin = await seedUser();
    const { studioId, projectId } = await seedStudio(admin.userId);
    const asset = await seedAsset(studioId, admin.userId);

    const res = await call(
      admin.cookie,
      "POST",
      "/assets/upload-ticket",
      ticketBody({
        project_id: projectId,
        purpose: "project_cover",
        client_hash: asset.hash,
        size: asset.sizeBytes,
      }),
    );

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { assetId: string } };
    expect(data.assetId).toBe(asset.id);
  });
});

describe("PUT /projects/:id/cover", () => {
  it("points the project at the row's own URL", async () => {
    const owner = await seedUser();
    const { studioId, projectId } = await seedStudio(owner.userId);
    const asset = await seedAsset(studioId, owner.userId);

    const res = await call(owner.cookie, "PUT", `/projects/${projectId}/cover`, {
      asset_id: asset.id,
    });

    expect(res.status).toBe(200);
    const rows = await sql<{ thumbnail_url: string | null }[]>`
      SELECT thumbnail_url FROM projects WHERE id = ${projectId}
    `;
    expect(rows[0]!.thumbnail_url).toBe(asset.fileUrl);
  });

  it("keeps the previous cover's row when a new one replaces it", async () => {
    const owner = await seedUser();
    const { studioId, projectId } = await seedStudio(owner.userId);
    const first = await seedAsset(studioId, owner.userId);
    const second = await seedAsset(studioId, owner.userId);

    await call(owner.cookie, "PUT", `/projects/${projectId}/cover`, { asset_id: first.id });
    await call(owner.cookie, "PUT", `/projects/${projectId}/cover`, { asset_id: second.id });

    const project = await sql<{ thumbnail_url: string | null }[]>`
      SELECT thumbnail_url FROM projects WHERE id = ${projectId}
    `;
    expect(project[0]!.thumbnail_url).toBe(second.fileUrl);
    const old = await sql<{ deleted_at: Date | null }[]>`
      SELECT deleted_at FROM studio_assets WHERE id = ${first.id}
    `;
    expect(old).toHaveLength(1);
    expect(old[0]!.deleted_at).toBeNull();
  });

  it("lets an editor change it, and refuses a viewer", async () => {
    const owner = await seedUser();
    const editor = await seedUser();
    const viewer = await seedUser();
    const { studioId, projectId } = await seedStudio(owner.userId);
    await addMember(studioId, projectId, editor.userId, "maintainer", "editor");
    await addMember(studioId, projectId, viewer.userId, "maintainer", "viewer");
    const asset = await seedAsset(studioId, owner.userId);

    const refused = await call(viewer.cookie, "PUT", `/projects/${projectId}/cover`, {
      asset_id: asset.id,
    });
    expect(refused.status).toBe(403);
    const before = await sql<{ thumbnail_url: string | null }[]>`
      SELECT thumbnail_url FROM projects WHERE id = ${projectId}
    `;
    expect(before[0]!.thumbnail_url).toBeNull();

    const res = await call(editor.cookie, "PUT", `/projects/${projectId}/cover`, {
      asset_id: asset.id,
    });
    expect(res.status).toBe(200);
    const after = await sql<{ thumbnail_url: string | null }[]>`
      SELECT thumbnail_url FROM projects WHERE id = ${projectId}
    `;
    expect(after[0]!.thumbnail_url).not.toBeNull();
  });

  it("refuses a row from another studio, a deleted row and a non-image row", async () => {
    const owner = await seedUser();
    const { studioId, projectId } = await seedStudio(owner.userId);
    const other = await seedStudio(owner.userId);
    const foreign = await seedAsset(other.studioId, owner.userId);
    const deleted = await seedAsset(studioId, owner.userId, { deleted: true });
    const video = await seedAsset(studioId, owner.userId, { kind: "video" });

    for (const assetId of [foreign.id, deleted.id, video.id, crypto.randomUUID()]) {
      const res = await call(owner.cookie, "PUT", `/projects/${projectId}/cover`, {
        asset_id: assetId,
      });
      expect(res.status).toBe(404);
    }
    const rows = await sql<{ thumbnail_url: string | null }[]>`
      SELECT thumbnail_url FROM projects WHERE id = ${projectId}
    `;
    expect(rows[0]!.thumbnail_url).toBeNull();
  });
});

describe("PATCH /projects/:id", () => {
  it("no longer writes the thumbnail", async () => {
    const owner = await seedUser();
    const { projectId } = await seedStudio(owner.userId);

    const onlyThumbnail = await call(owner.cookie, "PATCH", `/projects/${projectId}`, {
      thumbnail_url: "https://evil.test.invalid/x.png",
    });
    const withName = await call(owner.cookie, "PATCH", `/projects/${projectId}`, {
      name: "Renamed",
      thumbnail_url: "https://evil.test.invalid/x.png",
    });

    expect(onlyThumbnail.status).toBe(422);
    expect(withName.status).toBe(200);
    const rows = await sql<{ name: string; thumbnail_url: string | null }[]>`
      SELECT name, thumbnail_url FROM projects WHERE id = ${projectId}
    `;
    expect(rows[0]!.name).toBe("Renamed");
    expect(rows[0]!.thumbnail_url).toBeNull();
  });
});

describe("PUT /studio/:slug/avatar", () => {
  it("points the studio at the row's own URL", async () => {
    const admin = await seedUser();
    const { studioId, slug } = await seedStudio(admin.userId);
    const asset = await seedAsset(studioId, admin.userId);

    const res = await call(admin.cookie, "PUT", `/studio/${slug}/avatar`, {
      asset_id: asset.id,
    });

    expect(res.status).toBe(200);
    const rows = await sql<{ avatar_url: string | null }[]>`
      SELECT avatar_url FROM studios WHERE id = ${studioId}
    `;
    expect(rows[0]!.avatar_url).toBe(asset.fileUrl);
  });

  it("refuses a member below admin", async () => {
    const admin = await seedUser();
    const maintainer = await seedUser();
    const { studioId, slug, projectId } = await seedStudio(admin.userId);
    await addMember(studioId, projectId, maintainer.userId, "maintainer", null);
    const asset = await seedAsset(studioId, admin.userId);

    const res = await call(maintainer.cookie, "PUT", `/studio/${slug}/avatar`, {
      asset_id: asset.id,
    });

    expect(res.status).toBe(403);
  });

  it("refuses a row from another studio", async () => {
    const admin = await seedUser();
    const { studioId, slug } = await seedStudio(admin.userId);
    const other = await seedStudio(admin.userId);
    const foreign = await seedAsset(other.studioId, admin.userId);

    const res = await call(admin.cookie, "PUT", `/studio/${slug}/avatar`, {
      asset_id: foreign.id,
    });

    expect(res.status).toBe(404);
    const rows = await sql<{ avatar_url: string | null }[]>`
      SELECT avatar_url FROM studios WHERE id = ${studioId}
    `;
    expect(rows[0]!.avatar_url).toBeNull();
  });

  it("clears the avatar for the admin and refuses anyone below", async () => {
    const admin = await seedUser();
    const maintainer = await seedUser();
    const { studioId, slug, projectId } = await seedStudio(admin.userId);
    await addMember(studioId, projectId, maintainer.userId, "maintainer", null);
    const asset = await seedAsset(studioId, admin.userId);
    await call(admin.cookie, "PUT", `/studio/${slug}/avatar`, { asset_id: asset.id });

    const refused = await call(maintainer.cookie, "DELETE", `/studio/${slug}/avatar`);
    const cleared = await call(admin.cookie, "DELETE", `/studio/${slug}/avatar`);

    expect(refused.status).toBe(403);
    expect(cleared.status).toBe(200);
    const rows = await sql<{ avatar_url: string | null }[]>`
      SELECT avatar_url FROM studios WHERE id = ${studioId}
    `;
    expect(rows[0]!.avatar_url).toBeNull();
    const kept = await sql<{ deleted_at: Date | null }[]>`
      SELECT deleted_at FROM studio_assets WHERE id = ${asset.id}
    `;
    expect(kept[0]!.deleted_at).toBeNull();
  });

  it("no longer takes the picture's bytes directly", async () => {
    const admin = await seedUser();
    const { slug } = await seedStudio(admin.userId);

    const res = await app.request(`/api/v1/studio/${slug}/avatar`, {
      method: "POST",
      headers: { "content-type": "image/png", cookie: admin.cookie },
      body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    });

    expect(res.status).toBe(404);
  });
});
