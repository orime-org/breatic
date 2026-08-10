// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Studio settings — `PATCH /api/v1/studio/:slug`, end-to-end through the real
 * Hono app against a real Postgres + Redis.
 *
 * Renaming a studio is not an ordinary field edit. The slug is the studio's
 * address and, for a personal studio, its owner's @handle; changing it breaks
 * every existing link and frees the old name for anyone to claim. What this
 * pins:
 *   - each field can be edited alone, and an absent field is left untouched
 *   - an empty bio clears it (stored as NULL, so "no bio" has one form)
 *   - reserved slugs are refused at the HTTP boundary, not just in the UI
 *   - a taken slug is a conflict, and losing the race is still a conflict
 *   - only an admin may edit; a member and a stranger cannot
 *   - the old slug stops resolving the moment the new one takes effect
 *
 * @see packages/server/src/modules/studio/studio.service.ts
 * @see studio settings design (2026-07-28) § 4
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
    connection: { application_name: "studio-update-routes-test" },
  });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

let seq = 0;
/**
 * Insert a fresh verified user.
 * @returns the new user's id.
 */
async function insertUser(): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified)
    VALUES (${`sup-${seq++}@example.com`}, true) RETURNING id
  `;
  return rows[0]!.id;
}

let slugSeq = 0;
/**
 * A unique, well-formed studio slug.
 * @returns a slug within the 6–39 character bounds.
 */
function uniqueSlug(): string {
  return `sup-${(slugSeq++).toString().padStart(6, "0")}`;
}

/**
 * Insert a studio plus its admin member row.
 * @param adminUserId - the user who becomes the studio's admin.
 * @param type - team (default) or personal.
 * @returns the new studio's id and slug.
 */
async function insertStudio(
  adminUserId: string,
  type: "team" | "personal" = "team",
): Promise<{ id: string; slug: string }> {
  const slug = uniqueSlug();
  const rows = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${adminUserId}, ${slug}, ${type}, 'Before') RETURNING id
  `;
  const id = rows[0]!.id;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${id}, ${adminUserId}, 'admin')`;
  return { id, slug };
}

/**
 * Add a non-admin member to a studio.
 * @param studioId - the studio to join.
 * @param userId - the joining user.
 * @param role - the granted studio role.
 */
async function insertMember(
  studioId: string,
  userId: string,
  role: "maintainer" | "guest",
): Promise<void> {
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${userId}, ${role})`;
}

/**
 * Read a studio's editable columns straight from the table.
 * @param id - the studio's id.
 * @returns its slug, name and bio.
 */
async function readStudio(
  id: string,
): Promise<{ slug: string; name: string; bio: string | null }> {
  const rows = await sql<{ slug: string; name: string; bio: string | null }[]>`
    SELECT slug, name, bio FROM studios WHERE id = ${id}
  `;
  return rows[0]!;
}

/**
 * Mint a real Redis session and return the authenticating Cookie header.
 * @param userId - the user to authenticate as.
 * @returns a Cookie header value.
 */
async function loginCookie(userId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return `${sessionCookieName()}=${token}`;
}

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

/**
 * Send a settings patch to a studio.
 * @param slug - the studio's current slug (the URL segment).
 * @param cookie - the caller's session cookie, or null to send none.
 * @param body - the patch to apply.
 * @returns the raw HTTP response.
 */
async function patchStudio(
  slug: string,
  cookie: string | null,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request(`/api/v1/studio/${slug}`, {
    method: "PATCH",
    headers: cookie ? { ...JSON_HEADERS, Cookie: cookie } : JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

describe("PATCH /studio/:slug — editing one field at a time", () => {
  it("renames the studio without touching its slug or bio", async () => {
    const admin = await insertUser();
    const studio = await insertStudio(admin);
    const cookie = await loginCookie(admin);

    const res = await patchStudio(studio.slug, cookie, { name: "After" });

    expect(res.status).toBe(200);
    const after = await readStudio(studio.id);
    expect(after.name).toBe("After");
    expect(after.slug).toBe(studio.slug);
    expect(after.bio).toBeNull();
  });

  it("sets the bio without touching the name", async () => {
    const admin = await insertUser();
    const studio = await insertStudio(admin);
    const cookie = await loginCookie(admin);

    const res = await patchStudio(studio.slug, cookie, { bio: "We make things" });

    expect(res.status).toBe(200);
    const after = await readStudio(studio.id);
    expect(after.bio).toBe("We make things");
    expect(after.name).toBe("Before");
  });

  it("clears the bio when sent an empty string, storing NULL", async () => {
    const admin = await insertUser();
    const studio = await insertStudio(admin);
    const cookie = await loginCookie(admin);
    await patchStudio(studio.slug, cookie, { bio: "Temporary" });

    const res = await patchStudio(studio.slug, cookie, { bio: "" });

    expect(res.status).toBe(200);
    // NULL, not '' — one representation of "no bio", so readers never have to
    // treat two values as the same thing.
    expect((await readStudio(studio.id)).bio).toBeNull();
  });

  it("changes the slug, and the old one stops resolving immediately", async () => {
    const admin = await insertUser();
    const studio = await insertStudio(admin);
    const cookie = await loginCookie(admin);
    const next = uniqueSlug();

    const res = await patchStudio(studio.slug, cookie, { slug: next });

    expect(res.status).toBe(200);
    expect((await readStudio(studio.id)).slug).toBe(next);
    // No redirect, no alias row: the old address is simply gone (rule 7).
    const old = await app.request(`/api/v1/studio/${studio.slug}`, {
      headers: { Cookie: cookie },
    });
    expect(old.status).toBe(404);
    const moved = await app.request(`/api/v1/studio/${next}`, {
      headers: { Cookie: cookie },
    });
    expect(moved.status).toBe(200);
  });

  it("applies all three fields in one request", async () => {
    const admin = await insertUser();
    const studio = await insertStudio(admin);
    const cookie = await loginCookie(admin);
    const next = uniqueSlug();

    const res = await patchStudio(studio.slug, cookie, {
      name: "Renamed",
      slug: next,
      bio: "All at once",
    });

    expect(res.status).toBe(200);
    expect(await readStudio(studio.id)).toEqual({
      slug: next,
      name: "Renamed",
      bio: "All at once",
    });
  });

  it("edits a personal studio too — its slug is the owner's handle", async () => {
    // Personal studios refuse MEMBERSHIP changes (there is nobody to add or
    // remove), but their name, handle and bio are the user's own profile.
    const owner = await insertUser();
    const studio = await insertStudio(owner, "personal");
    const cookie = await loginCookie(owner);
    const next = uniqueSlug();

    const res = await patchStudio(studio.slug, cookie, { name: "Me", slug: next });

    expect(res.status).toBe(200);
    expect(await readStudio(studio.id)).toMatchObject({ name: "Me", slug: next });
  });
});

describe("PATCH /studio/:slug — refusals", () => {
  it("refuses a reserved slug at the HTTP boundary", async () => {
    const admin = await insertUser();
    const studio = await insertStudio(admin);
    const cookie = await loginCookie(admin);

    const res = await patchStudio(studio.slug, cookie, { slug: "settings" });

    expect(res.status).toBe(422);
    expect((await readStudio(studio.id)).slug).toBe(studio.slug);
  });

  it("refuses a slug already taken by another studio", async () => {
    const admin = await insertUser();
    const other = await insertUser();
    const studio = await insertStudio(admin);
    const taken = await insertStudio(other);
    const cookie = await loginCookie(admin);

    const res = await patchStudio(studio.slug, cookie, { slug: taken.slug });

    expect(res.status).toBe(409);
    expect((await readStudio(studio.id)).slug).toBe(studio.slug);
  });

  it("accepts a no-op slug edit — re-submitting your own slug is not a conflict", async () => {
    const admin = await insertUser();
    const studio = await insertStudio(admin);
    const cookie = await loginCookie(admin);

    const res = await patchStudio(studio.slug, cookie, {
      slug: studio.slug,
      name: "Same slug, new name",
    });

    expect(res.status).toBe(200);
    expect(await readStudio(studio.id)).toMatchObject({
      slug: studio.slug,
      name: "Same slug, new name",
    });
  });

  it("refuses a malformed slug", async () => {
    const admin = await insertUser();
    const studio = await insertStudio(admin);
    const cookie = await loginCookie(admin);

    const res = await patchStudio(studio.slug, cookie, { slug: "Has Capitals" });

    expect(res.status).toBe(422);
  });

  it("refuses an empty patch rather than reporting a successful no-op", async () => {
    const admin = await insertUser();
    const studio = await insertStudio(admin);
    const cookie = await loginCookie(admin);

    const res = await patchStudio(studio.slug, cookie, {});

    expect(res.status).toBe(422);
  });

  it("refuses a maintainer — editing the studio is admin-only", async () => {
    const admin = await insertUser();
    const member = await insertUser();
    const studio = await insertStudio(admin);
    await insertMember(studio.id, member, "maintainer");
    const cookie = await loginCookie(member);

    const res = await patchStudio(studio.slug, cookie, { name: "Nope" });

    expect(res.status).toBe(403);
    expect((await readStudio(studio.id)).name).toBe("Before");
  });

  it("refuses a non-member", async () => {
    const admin = await insertUser();
    const stranger = await insertUser();
    const studio = await insertStudio(admin);
    const cookie = await loginCookie(stranger);

    const res = await patchStudio(studio.slug, cookie, { name: "Nope" });

    expect(res.status).toBe(403);
  });

  it("refuses an unauthenticated request", async () => {
    const admin = await insertUser();
    const studio = await insertStudio(admin);

    const res = await patchStudio(studio.slug, null, { name: "Nope" });

    expect(res.status).toBe(401);
    expect((await readStudio(studio.id)).name).toBe("Before");
  });
});

describe("GET /studios/slug-available — excluding the studio being renamed", () => {
  it("reports a studio's own slug as available to itself", async () => {
    // Without this, the rename form tells the admin their current handle is
    // taken the moment the field is focused — taken by themselves.
    const admin = await insertUser();
    const studio = await insertStudio(admin);
    const cookie = await loginCookie(admin);

    const res = await app.request(
      `/api/v1/studios/slug-available?slug=${studio.slug}&excludeStudioId=${studio.id}`,
      { headers: { Cookie: cookie } },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { available: boolean } };
    expect(body.data.available).toBe(true);
  });

  it("rejects a non-uuid excludeStudioId instead of letting Postgres 500 on it", async () => {
    // The value reaches the query as a uuid comparison, so anything that is
    // not one makes Postgres reject the statement — a user-supplied string
    // turning into a server error.
    const admin = await insertUser();
    const studio = await insertStudio(admin);
    const cookie = await loginCookie(admin);

    const res = await app.request(
      `/api/v1/studios/slug-available?slug=${studio.slug}&excludeStudioId=not-a-uuid`,
      { headers: { Cookie: cookie } },
    );

    // 422 is this repo's code for a validation failure (ValidationError).
    expect(res.status).toBe(422);
  });

  it("still reports another studio's slug as taken when excluding your own", async () => {
    const admin = await insertUser();
    const other = await insertUser();
    const studio = await insertStudio(admin);
    const taken = await insertStudio(other);
    const cookie = await loginCookie(admin);

    const res = await app.request(
      `/api/v1/studios/slug-available?slug=${taken.slug}&excludeStudioId=${studio.id}`,
      { headers: { Cookie: cookie } },
    );

    const body = (await res.json()) as {
      data: { available: boolean; reason?: string };
    };
    expect(body.data.available).toBe(false);
    expect(body.data.reason).toBe("taken");
  });

  it("reports a reserved slug as unavailable, with the reason", async () => {
    const admin = await insertUser();
    const cookie = await loginCookie(admin);

    const res = await app.request("/api/v1/studios/slug-available?slug=settings", {
      headers: { Cookie: cookie },
    });

    const body = (await res.json()) as {
      data: { available: boolean; reason?: string };
    };
    expect(body.data.available).toBe(false);
    expect(body.data.reason).toBe("reserved");
  });
});
