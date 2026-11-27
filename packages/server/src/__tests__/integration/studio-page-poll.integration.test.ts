// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * `GET /api/v1/studio-page/poll` — the Studio page's one poll (#1580, test spec K-01 to K-11; design §4): one answer
 * carries the bell's unread count and newest notification, the Studio's live transfer for an admin, how the asked
 * uploads ended, which of the asked Project copies are no longer being copied (inner#1706 design 5.4), and the
 * interval to the next poll. Real Postgres and Redis; only the ingest Worker is a double.
 */

import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";

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

vi.mock("@breatic/shared", async (importOriginal) =>
  (await import("../helpers/ingest-open-double.js")).sharedWithOpenDouble(importOriginal),
);

import crypto from "node:crypto";
import postgres from "postgres";
import type { Hono } from "hono";
import {
  getRateLimit,
  getRedis,
  getStreamRedis,
  getStudioPageConfig,
  initCore,
  loadLocales,
  sessionCookieName,
  setSession,
  uploadEndedChannelName,
} from "@breatic/core";
import { uploadStatusService } from "@breatic/domain";
import { COPYING_POLL_MAX_IDS, signSessionToken, UPLOAD_STATUS_MAX_KEYS } from "@breatic/shared";
import { closeFinishQueue, runQueuedFinish } from "@server/__tests__/helpers/queued-finish.js";

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
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, connection: { application_name: "studio-page-poll-test-driver" } });
  const { createApp } = await import("@server/app.js");
  app = createApp();
});

afterAll(async () => {
  await closeFinishQueue();
  await sql?.end({ timeout: 1 });
});

let seq = 0;

/** A signed-in person. */
interface Person {
  id: string;
  cookie: string;
}

/**
 * A user with a session.
 * @returns The user.
 */
async function person(): Promise<Person> {
  const [row] = await sql<{ id: string }[]>`
    insert into users (email, email_verified) values (${`spp-${seq++}-${crypto.randomUUID()}@example.test`}, true) returning id
  `;
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, row!.id);
  return { id: row!.id, cookie: `${sessionCookieName()}=${token}` };
}

/** A team Studio administered by `admin`, with `members` as guests, and a Project in it. */
interface Scene {
  studioId: string;
  slug: string;
  projectId: string;
  admin: Person;
  member: Person;
}

/**
 * A team Studio with an admin, a plain member and one Project the admin owns.
 * @returns The scene.
 */
async function scene(): Promise<Scene> {
  const admin = await person();
  const member = await person();
  const slug = `spp-${seq++}-${crypto.randomUUID().slice(0, 12)}`;
  const [studio] = await sql<{ id: string }[]>`
    insert into studios (created_by_user_id, slug, type, name) values (${admin.id}, ${slug}, 'team', 'Poll') returning id
  `;
  await sql`insert into studio_members (studio_id, user_id, role) values (${studio!.id}, ${admin.id}, 'admin'), (${studio!.id}, ${member.id}, 'guest')`;
  const [project] = await sql<{ id: string }[]>`
    insert into projects (studio_id, created_by_user_id, name, slug) values (${studio!.id}, ${admin.id}, 'Poll', ${`${slug}-p`}) returning id
  `;
  await sql`
    insert into project_members (project_id, user_id, role, added_by) values (${project!.id}, ${admin.id}, 'owner', null), (${project!.id}, ${member.id}, 'editor', null)
  `;
  return { studioId: studio!.id, slug, projectId: project!.id, admin, member };
}

/**
 * Ask the poll.
 * @param cookie - Whose session, or none.
 * @param query - The query string.
 * @returns The response.
 */
async function poll(cookie: string | null, query: string): Promise<Response> {
  return app.request(`/api/v1/studio-page/poll?${query}`, { headers: cookie === null ? {} : { cookie } });
}

/** The answer's body. */
interface Answer {
  notifications: { unread: number; latestAt: string | null };
  transfer: { id: string; status: string; updatedAt: string } | null;
  uploads: Record<string, unknown>[];
  copied: string[];
  nextPollMs: number;
}

/**
 * Ask the poll and read a 200 answer.
 * @param cookie - Whose session.
 * @param query - The query string.
 * @returns The answer.
 * @throws {Error} When the poll did not answer 200.
 */
async function answer(cookie: string, query: string): Promise<Answer> {
  const res = await poll(cookie, query);
  if (res.status !== 200) throw new Error(`the poll answered ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { data: Answer }).data;
}

/**
 * A notification for `userId`.
 * @param userId - Whose bell.
 * @param at - When it was made.
 * @param state - Unread, read, deleted, or an actionable one past its expiry.
 * @returns Its created_at as the database holds it.
 */
async function notification(userId: string, at: Date, state: "unread" | "read" | "deleted" | "expired" = "unread"): Promise<string> {
  const [row] = await sql<{ created_at: string }[]>`
    insert into notifications (user_id, type, payload, created_at, read_at, deleted_at, expires_at)
    values (${userId}, 'membership.ended', '{}'::jsonb, ${at},
      ${state === "read" ? at : null}, ${state === "deleted" ? at : null}, ${state === "expired" ? new Date(at.getTime() + 1000) : null})
    returning created_at::text
  `;
  return row!.created_at;
}

/**
 * A pending Studio transfer from the admin to the member.
 * @param s - The scene.
 * @param expiresAt - When the offer lapses.
 * @returns Its id and updated_at.
 */
async function studioTransfer(s: Scene, expiresAt: Date): Promise<{ id: string; updatedAt: string }> {
  const [row] = await sql<{ id: string; updated_at: string }[]>`
    insert into studio_transfers (studio_id, from_user_id, to_user_id, status, expires_at, share_token)
    values (${s.studioId}, ${s.admin.id}, ${s.member.id}, 'pending', ${expiresAt}, ${crypto.randomBytes(32).toString("hex")})
    returning id, updated_at
  `;
  return { id: row!.id, updatedAt: new Date(row!.updated_at).toISOString() };
}

/**
 * Open an upload through the real ticket endpoint.
 * @param s - The scene.
 * @param who - The uploader.
 * @returns Its storage key.
 */
async function ticket(s: Scene, who: Person): Promise<string> {
  const res = await app.request("/api/v1/assets/upload-ticket", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: who.cookie },
    body: JSON.stringify({
      filename: "cover.png", content_type: "image/png", project_id: s.projectId, size: 4096,
      client_hash: crypto.randomBytes(32).toString("hex"),
    }),
  });
  return ((await res.json()) as { data: { storageKey: string } }).data.storageKey;
}

/**
 * Finish an upload the way the browser and the Worker do, with the Worker storing it.
 * @param key - The upload's key.
 * @param who - The uploader.
 * @returns Once the queued finish has run.
 * @throws {Error} When the finish route did not queue the finish.
 */
async function finishStored(key: string, who: Person): Promise<void> {
  const token = await signSessionToken(
    { storageKey: key, uploadId: "r2-upload-id", contentType: "image/png", expiresAt: Date.now() + 900_000, partSize: 8 * 1024 * 1024, totalParts: 1 },
    INGEST_SECRET,
  );
  vi.stubGlobal("fetch", vi.fn(async () => new Response(
    JSON.stringify({ sha256: crypto.randomBytes(32).toString("hex"), sizeBytes: 4096, contentType: "image/png", width: 64, height: 48 }),
    { status: 200, headers: { "content-type": "application/json" } },
  )));
  try {
    const res = await app.request("/api/v1/assets/uploads/r2-upload-id/complete", {
      method: "POST",
      headers: { "content-type": "application/json", "x-upload-token": token, cookie: who.cookie },
      body: JSON.stringify({ parts: [{ partNumber: 1, etag: "etag-1" }] }),
    });
    if (res.status !== 202) throw new Error(`the finish route answered ${res.status}`);
    await runQueuedFinish(key);
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("who may poll", () => {
  it("K-01 answers 401 to a request with no session", async () => {
    const s = await scene();
    expect((await poll(null, `studio=${s.slug}`)).status).toBe(401);
  });

  it("K-02 is limited under studio-page-poll", async () => {
    const s = await scene();
    const { max } = getRateLimit("studio-page-poll");
    for (let i = 0; i < max; i += 1) expect((await poll(s.member.cookie, `studio=${s.slug}`)).status).toBe(200);
    expect((await poll(s.member.cookie, `studio=${s.slug}`)).status).toBe(429);
  });

  it("K-11 answers a Studio page the caller is not in, or one that does not exist, with their own bell and no transfer", async () => {
    // Any signed-in user may open a Studio's page (studio.service getStudioDetail), so its bell keeps catching up there.
    const s = await scene();
    const stranger = await person();
    for (const slug of [s.slug, `no-such-${crypto.randomUUID()}`]) {
      const res = await poll(stranger.cookie, `studio=${slug}`);
      expect(res.status).toBe(200);
      const { data } = (await res.json()) as { data: { transfer: unknown; notifications: { unread: number } } };
      expect(data.transfer).toBeNull();
      expect(data.notifications.unread).toBe(0);
    }
  });
});

describe("the bell", () => {
  it("K-03 counts the unread and names the newest notification still there", async () => {
    const s = await scene();
    const base = Date.now() - 60_000;
    await notification(s.member.id, new Date(base), "read");
    await notification(s.member.id, new Date(base + 1000), "expired");
    await notification(s.member.id, new Date(base + 2000));
    const newest = await notification(s.member.id, new Date(base + 3000));
    await notification(s.member.id, new Date(base + 4000), "deleted");
    const got = await answer(s.member.cookie, `studio=${s.slug}`);
    expect(got.notifications.unread).toBe(2);
    expect(new Date(got.notifications.latestAt!).toISOString()).toBe(new Date(newest).toISOString());
  });

  it("K-04 is zero and no time for someone with no notifications", async () => {
    const s = await scene();
    expect((await answer(s.member.cookie, `studio=${s.slug}`)).notifications).toEqual({ unread: 0, latestAt: null });
  });
});

describe("the Studio's transfer", () => {
  it("K-05 is the live offer for an admin, and null when there is none", async () => {
    const s = await scene();
    expect((await answer(s.admin.cookie, `studio=${s.slug}`)).transfer).toBeNull();
    const offer = await studioTransfer(s, new Date(Date.now() + 86_400_000));
    const got = await answer(s.admin.cookie, `studio=${s.slug}`);
    expect(got.transfer).toEqual({ id: offer.id, status: "pending", updatedAt: expect.any(String) });
    expect(new Date(got.transfer!.updatedAt).toISOString()).toBe(offer.updatedAt);
  });

  it("K-06 is null for a member who is not an admin", async () => {
    const s = await scene();
    await studioTransfer(s, new Date(Date.now() + 86_400_000));
    expect((await answer(s.member.cookie, `studio=${s.slug}`)).transfer).toBeNull();
  });

  it("K-07 is null once the offer has lapsed, though it is still pending", async () => {
    const s = await scene();
    await studioTransfer(s, new Date(Date.now() - 1000));
    expect((await answer(s.admin.cookie, `studio=${s.slug}`)).transfer).toBeNull();
  });
});

describe("the asked uploads", () => {
  it("K-08 are told in the order asked, as the upload status read tells them", async () => {
    const s = await scene();
    const k1 = await ticket(s, s.admin);
    await finishStored(k1, s.admin);
    const k2 = await ticket(s, s.member);
    const k3 = await ticket(s, s.admin);
    const got = await answer(s.admin.cookie, `studio=${s.slug}&uploads=${[k1, k2, k3].map(encodeURIComponent).join(",")}`);
    expect(got.uploads.map((u) => u.state)).toEqual(["completed", "unknown", "finishing"]);
    expect(got.uploads).toEqual(await uploadStatusService.statusOf(s.admin.id, [k1, k2, k3]));
  });

  it("K-09 are none when none are asked", async () => {
    const s = await scene();
    expect((await answer(s.admin.cookie, `studio=${s.slug}`)).uploads).toEqual([]);
  });

  it("K-09 refuses more keys than one request may carry, as request validation does", async () => {
    const s = await scene();
    const keys = Array.from({ length: UPLOAD_STATUS_MAX_KEYS + 1 }, (_v, i) => `uploads/k-${i}.png`);
    expect((await poll(s.admin.cookie, `studio=${s.slug}&uploads=${keys.join(",")}`)).status).toBe(422);
  });
});

/**
 * A copy of the scene's Project in a Studio, as the duplicate request leaves it, optionally already completed.
 * @param studioId - Where the copy is.
 * @param s - The scene whose Project and admin it copies.
 * @param completed - Whether collab has recorded the copy as completed.
 * @returns The copy's id.
 */
async function copyOf(studioId: string, s: Scene, completed: boolean): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into projects (studio_id, created_by_user_id, name, slug, duplicated_from_id, duplicate_completed_at)
    values (${studioId}, ${s.admin.id}, 'Poll copy', ${`${s.slug}-c-${seq++}`}, ${s.projectId}, ${completed ? new Date() : null})
    returning id
  `;
  return row!.id;
}

describe("the asked copies", () => {
  it("K-12 are named when they are no longer being copied, in the order asked", async () => {
    const s = await scene();
    const done = await copyOf(s.studioId, s, true);
    const copying = await copyOf(s.studioId, s, false);
    const got = await answer(s.member.cookie, `studio=${s.slug}&copying=${[copying, done, s.projectId].join(",")}`);
    expect(got.copied).toEqual([done, s.projectId]);
  });

  it("K-13 leave out a Project outside the polled Studio, and are none for someone outside it", async () => {
    const s = await scene();
    const other = await scene();
    const elsewhere = await copyOf(other.studioId, s, true);
    const done = await copyOf(s.studioId, s, true);
    expect((await answer(s.member.cookie, `studio=${s.slug}&copying=${[elsewhere, done].join(",")}`)).copied).toEqual([done]);
    const stranger = await person();
    expect((await answer(stranger.cookie, `studio=${s.slug}&copying=${done}`)).copied).toEqual([]);
  });

  it("K-14 are none when none are asked, and on the Recent page", async () => {
    const s = await scene();
    const done = await copyOf(s.studioId, s, true);
    expect((await answer(s.member.cookie, `studio=${s.slug}`)).copied).toEqual([]);
    expect((await answer(s.member.cookie, `copying=${done}`)).copied).toEqual([]);
  });

  it("K-15 refuses more ids than one request may carry, or one that is not a Project id", async () => {
    const s = await scene();
    const ids = Array.from({ length: COPYING_POLL_MAX_IDS + 1 }, () => crypto.randomUUID());
    expect((await poll(s.member.cookie, `studio=${s.slug}&copying=${ids.join(",")}`)).status).toBe(422);
    expect((await poll(s.member.cookie, `studio=${s.slug}&copying=not-a-project`)).status).toBe(422);
  });
});

describe("the interval", () => {
  it("K-10 is the configured poll interval", async () => {
    const s = await scene();
    expect((await answer(s.member.cookie, `studio=${s.slug}`)).nextPollMs).toBe(getStudioPageConfig().poll_interval_ms);
  });
});

describe("an upload's ending, two ways", () => {
  it("B-18 the poll tells it as the message to the uploader did", async () => {
    const heard: { userId?: string; status?: { key?: string } }[] = [];
    const subscriber = getStreamRedis().duplicate();
    subscriber.on("message", (_channel: string, message: string) => {
      heard.push(JSON.parse(message) as { userId?: string; status?: { key?: string } });
    });
    await subscriber.subscribe(uploadEndedChannelName());
    try {
      const s = await scene();
      const key = await ticket(s, s.admin);
      await finishStored(key, s.admin);
      await vi.waitFor(() => expect(heard.some((h) => h.status?.key === key)).toBe(true));
      const told = heard.find((h) => h.status?.key === key)!;
      const got = await answer(s.admin.cookie, `studio=${s.slug}&uploads=${encodeURIComponent(key)}`);
      expect(got.uploads).toEqual([told.status]);
    } finally {
      await subscriber.quit();
    }
  });
});
