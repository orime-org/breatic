// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Reads that gather a user's Studios, recent Projects and notifications from
 * every region (inner#1955, acceptances 3, 10 and 12) — real PG + Redis and a
 * real HTTP stand-in for the other region.
 *
 * The global region answers the switcher from the directory. Recent Projects
 * and notifications live in each region, so it asks every other region the
 * user has been recorded in (`user_regions`), each within
 * `cross_region_fanout_timeout_ms`, and says which regions did not answer.
 * The other region here is a local HTTP server at the address in
 * `REGION_API_URLS`; it records the signed calls it receives and can be told
 * to never answer.
 *
 * The pins:
 *
 *   1. The switcher lists a Studio in another region, with its region.
 *   2. Recent Projects merge both regions, newest first.
 *   3. The bell merges both regions' notifications and unread counts.
 *   4. A region that does not answer is named in `unavailableRegions` and the
 *      rest comes back within the timeout.
 *   5. A user recorded in no other region causes no cross-region call and no
 *      `unavailableRegions`.
 *   6. In a single-region deployment, a Studio joined through an invitation
 *      is in `GET /studios` straight away.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, inject, vi } from "vitest";

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
import http from "node:http";
import type { AddressInfo } from "node:net";
import postgres from "postgres";
import { GLOBAL_REGION_SETTINGS } from "./global-region-env.js";
import { getRedis, initCore, loadLocales, sessionCookieName, setSession } from "@breatic/core";
import type { Hono } from "hono";
import * as studioInviteService from "@server/modules/studio/studioInvite.service.js";
import { withPeer } from "../helpers/peer.js";

loadLocales();

/** One call the stand-in region received. */
interface ReceivedCall {
  fn: string;
  args: unknown[];
  signed: boolean;
}

let sql: ReturnType<typeof postgres>;
let app: Hono;
let seq = 0;
let regionServer: http.Server;
let regionMode: "answer" | "hang" = "answer";
let regionAnswers: Record<string, unknown> = {};
const received: ReceivedCall[] = [];

beforeAll(async () => {
  regionServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      const fn = (req.url ?? "").replace(/^\/internal\/region\//, "");
      const parsed = body === "" ? { args: [] } : (JSON.parse(body) as { args: unknown[] });
      received.push({ fn, args: parsed.args, signed: typeof req.headers["x-internal-signature"] === "string" });
      if (regionMode === "hang") return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: regionAnswers[fn] ?? null }));
    });
  });
  await new Promise<void>((resolve) => regionServer.listen(0, "127.0.0.1", resolve));
  const port = (regionServer.address() as AddressInfo).port;
  initCore({
    ...process.env,
    REGION: "us-west",
    GLOBAL_REGION: "us-west",
    REGION_API_URLS: JSON.stringify({ sg: `http://127.0.0.1:${port}` }),
    ...GLOBAL_REGION_SETTINGS,
    INTERNAL_API_SECRET: "cross-region-test-secret",
  });
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "cross-region-reads-test" },
  });
  const { createApp } = await import("@server/app.js");
  app = withPeer(createApp());
});

afterEach(() => {
  regionMode = "answer";
  regionAnswers = {};
  received.length = 0;
});

afterAll(async () => {
  initCore(process.env);
  regionServer.closeAllConnections();
  await new Promise<void>((resolve) => regionServer.close(() => resolve()));
  await sql?.end({ timeout: 5 });
});

/**
 * A signed-in account with a personal Studio here and its directory rows.
 * @param otherRegions - Regions to record the account in.
 * @returns Its id, the personal Studio's id and the Cookie header.
 */
async function signedIn(otherRegions: string[] = []): Promise<{ userId: string; personalId: string; cookie: string }> {
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier)
    VALUES (${`xregion-${Date.now()}-${seq++}@example.test`}, true, 'team')
    RETURNING id
  `;
  const userId = user!.id;
  const slug = `xr-${crypto.randomBytes(5).toString("hex")}`;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name) VALUES (${userId}, ${slug}, 'personal', 'Me') RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${userId}, 'admin')`;
  await sql`
    INSERT INTO studio_directory (studio_id, slug, region, type, name, admin_user_id, created_by_user_id, state)
    VALUES (${studio!.id}, ${slug}, NULL, 'personal', 'Me', ${userId}, ${userId}, 'live')
  `;
  await sql`INSERT INTO studio_directory_members (studio_id, user_id, role) VALUES (${studio!.id}, ${userId}, 'admin')`;
  for (const region of otherRegions) {
    await sql`INSERT INTO user_regions (user_id, region) VALUES (${userId}, ${region})`;
  }
  const token = crypto.randomBytes(24).toString("hex");
  await setSession(getRedis(), token, userId);
  return { userId, personalId: studio!.id, cookie: `${sessionCookieName()}=${token}` };
}

/**
 * GET a route as a signed-in user and time it.
 * @param path - The route under `/api/v1`.
 * @param cookie - The session Cookie header.
 * @returns The status, JSON body and elapsed milliseconds.
 */
async function get(path: string, cookie: string): Promise<{ status: number; body: { data: unknown }; ms: number }> {
  const started = Date.now();
  const res = await app.request(`/api/v1${path}`, { headers: { Cookie: cookie } });
  return { status: res.status, body: (await res.json()) as { data: unknown }, ms: Date.now() - started };
}

/**
 * A Project here the user opened at a given time.
 * @param userId - The user.
 * @param studioId - The Studio it is in.
 * @param openedAt - When the user last opened it.
 * @returns The Project id.
 */
async function openedProject(userId: string, studioId: string, openedAt: Date): Promise<string> {
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, slug, name)
    VALUES (${studioId}, ${userId}, ${`xr-p-${seq++}`}, 'Here') RETURNING id
  `;
  await sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${project!.id}, ${userId}, 'owner')`;
  await sql`INSERT INTO project_last_opened (user_id, project_id, last_opened_at) VALUES (${userId}, ${project!.id}, ${openedAt})`;
  return project!.id;
}

describe("the Studio switcher", () => {
  it("lists a Studio in another region with its region", async () => {
    const { userId, personalId, cookie } = await signedIn(["sg"]);
    const remoteId = crypto.randomUUID();
    await sql`
      INSERT INTO studio_directory (studio_id, slug, region, type, name, admin_user_id, created_by_user_id, state)
      VALUES (${remoteId}, ${`xr-sg-${crypto.randomBytes(5).toString("hex")}`}, 'sg', 'team', 'Far', ${userId}, ${userId}, 'live')
    `;
    await sql`INSERT INTO studio_directory_members (studio_id, user_id, role) VALUES (${remoteId}, ${userId}, 'admin')`;

    const { status, body } = await get("/studios", cookie);

    expect(status).toBe(200);
    const rows = body.data as { id: string; region: string | null }[];
    expect(rows.find((row) => row.id === personalId)?.region).toBeNull();
    expect(rows.find((row) => row.id === remoteId)?.region).toBe("sg");
    expect(received).toEqual([]);
  });
});

describe("recent Projects", () => {
  it("merges both regions newest first", async () => {
    const { userId, personalId, cookie } = await signedIn(["sg"]);
    const older = await openedProject(userId, personalId, new Date(Date.now() - 60_000));
    const remoteProject = crypto.randomUUID();
    regionAnswers.listRecent = [
      {
        projectId: remoteProject,
        name: "Far project",
        slug: "far",
        thumbnailUrl: null,
        studioId: crypto.randomUUID(),
        studioName: "Far",
        myRole: "editor",
        lastOpenedAt: new Date().toISOString(),
      },
    ];

    const { body } = await get("/studios/recent", cookie);

    const data = body.data as { items: { projectId: string }[]; unavailableRegions: string[] };
    expect(data.items.map((item) => item.projectId)).toEqual([remoteProject, older]);
    expect(data.unavailableRegions).toEqual([]);
    expect(received).toEqual([{ fn: "listRecent", args: [userId], signed: true }]);
  });

  it("names a region that does not answer and still returns the rest within the timeout", async () => {
    const { userId, personalId, cookie } = await signedIn(["sg"]);
    const here = await openedProject(userId, personalId, new Date());
    regionMode = "hang";

    const { status, body, ms } = await get("/studios/recent", cookie);

    expect(status).toBe(200);
    const data = body.data as { items: { projectId: string }[]; unavailableRegions: string[] };
    expect(data.items.map((item) => item.projectId)).toEqual([here]);
    expect(data.unavailableRegions).toEqual(["sg"]);
    expect(ms).toBeLessThan(5_000);
  });

  it("makes no cross-region call for a user recorded in no other region", async () => {
    const { userId, personalId, cookie } = await signedIn();
    await openedProject(userId, personalId, new Date());
    regionMode = "hang";

    const { body } = await get("/studios/recent", cookie);

    expect((body.data as { unavailableRegions: string[] }).unavailableRegions).toEqual([]);
    expect(received).toEqual([]);
  });
});

describe("the bell", () => {
  it("merges both regions' notifications and unread counts", async () => {
    const { userId, cookie } = await signedIn(["sg"]);
    await sql`
      INSERT INTO notifications (user_id, type, payload) VALUES (${userId}, 'membership.ended', ${sql.json({})})
    `;
    const remoteId = crypto.randomUUID();
    regionAnswers.listNotifications = {
      items: [
        {
          id: remoteId,
          userId,
          type: "studio.invite_request",
          payload: {},
          readAt: null,
          createdAt: new Date().toISOString(),
        },
      ],
      resolved: { users: {}, studios: {}, projects: {} },
    };
    regionAnswers.countUnread = 1;

    const list = await get("/users/me/notifications", cookie);
    const count = await get("/users/me/notifications/count", cookie);

    const items = (list.body.data as { items: { id: string; region: string | null }[] }).items;
    expect(items.find((item) => item.id === remoteId)?.region).toBe("sg");
    expect(items.some((item) => item.region === null)).toBe(true);
    expect((count.body.data as { count: number }).count).toBe(2);
  });

  it("names a region that does not answer in the list and the count", async () => {
    const { cookie } = await signedIn(["sg"]);
    regionMode = "hang";

    const list = await get("/users/me/notifications", cookie);
    const count = await get("/users/me/notifications/count", cookie);

    expect((list.body.data as { unavailableRegions: string[] }).unavailableRegions).toEqual(["sg"]);
    expect((count.body.data as { unavailableRegions: string[] }).unavailableRegions).toEqual(["sg"]);
    expect(list.ms).toBeLessThan(5_000);
    expect(count.ms).toBeLessThan(5_000);
  });
});

describe("the credits ledger", () => {
  it("names a Project in another region from that region, and one here from here", async () => {
    const { userId, personalId, cookie } = await signedIn(["sg"]);
    const farStudio = crypto.randomUUID();
    const farProject = crypto.randomUUID();
    await sql`
      INSERT INTO studio_directory (studio_id, slug, region, type, name, admin_user_id, created_by_user_id, state)
      VALUES (${farStudio}, ${`xr-l-${seq++}-${Date.now()}`}, 'sg', 'team', 'Far', ${userId}, ${userId}, 'live')
    `;
    await sql`INSERT INTO studio_directory_members (studio_id, user_id, role) VALUES (${farStudio}, ${userId}, 'admin')`;
    await sql`INSERT INTO project_directory (project_id, studio_id) VALUES (${farProject}, ${farStudio})`;
    const [here] = await sql<{ id: string }[]>`
      INSERT INTO projects (studio_id, created_by_user_id, slug, name)
      VALUES (${personalId}, ${userId}, ${`xr-lp-${seq++}`}, 'Near project') RETURNING id
    `;
    await sql`INSERT INTO project_directory (project_id, studio_id) VALUES (${here!.id}, ${personalId})`;
    const spends: [string, string][] = [[farStudio, farProject], [personalId, here!.id]];
    for (const [studioId, projectId] of spends) {
      await sql`
        INSERT INTO credit_ledger (payer_user_id, actor_user_id, studio_id, project_id, entry_type, amount, reference_id)
        VALUES (${userId}, ${userId}, ${studioId}, ${projectId}, 'spend', -5, ${`xr-ref-${seq++}`})
      `;
    }
    regionAnswers.projectNames = { [farProject]: "Far project" };

    const page = await get("/credits/ledger?amountFormat=decimal-v1", cookie);

    const names = Object.fromEntries(
      (page.body.data as { items: { projectId: string; projectName: string | null }[] }).items.map((item) => [item.projectId, item.projectName]),
    );
    expect(names).toEqual({ [farProject]: "Far project", [here!.id]: "Near project" });
    expect(received).toEqual([{ fn: "projectNames", args: [[farProject]], signed: true }]);
  });
});

describe("the directory", () => {
  it("names the region of a Studio by slug and of a Project by id", async () => {
    const { userId, cookie } = await signedIn();
    const slug = `xr-sg-${crypto.randomBytes(5).toString("hex")}`;
    const studioId = crypto.randomUUID();
    await sql`
      INSERT INTO studio_directory (studio_id, slug, region, type, name, admin_user_id, created_by_user_id, state)
      VALUES (${studioId}, ${slug}, 'sg', 'team', 'Far', ${userId}, ${userId}, 'live')
    `;
    const projectId = crypto.randomUUID();
    await sql`INSERT INTO project_directory (project_id, studio_id) VALUES (${projectId}, ${studioId})`;

    expect((await get(`/directory/studios/${slug}`, cookie)).body.data).toEqual({ region: "sg" });
    expect((await get(`/directory/projects/${projectId}`, cookie)).body.data).toEqual({ region: "sg" });
  });

  it("answers 404 for a slug or Project the directory does not hold", async () => {
    const { cookie } = await signedIn();

    expect((await get("/directory/studios/no-such-studio-slug", cookie)).status).toBe(404);
    expect((await get(`/directory/projects/${crypto.randomUUID()}`, cookie)).status).toBe(404);
  });
});

describe("marking the bell read", () => {
  /**
   * Send one write to the API.
   * @param method - The HTTP method.
   * @param path - The path under the API base.
   * @param cookie - The session cookie.
   * @returns The status and body.
   */
  async function send(method: string, path: string, cookie: string): Promise<{ status: number; body: { data?: unknown; error?: { reason?: string } } }> {
    const res = await app.request(`/api/v1${path}`, { method, headers: { Cookie: cookie } });
    return { status: res.status, body: (await res.json()) as { data?: unknown; error?: { reason?: string } } };
  }

  it("marks a notification read in the region the bell listed it under", async () => {
    const { userId, cookie } = await signedIn(["sg"]);
    const remoteId = crypto.randomUUID();
    regionAnswers.markNotificationRead = true;

    const res = await send("PATCH", `/users/me/notifications/${remoteId}/read?region=sg`, cookie);

    expect(res.status).toBe(200);
    expect(received).toEqual([{ fn: "markNotificationRead", args: [remoteId, userId], signed: true }]);
  });

  it("answers 404 when the region has no such notification and 503 when it does not answer", async () => {
    const { cookie } = await signedIn(["sg"]);
    regionAnswers.markNotificationRead = false;
    expect((await send("PATCH", `/users/me/notifications/${crypto.randomUUID()}/read?region=sg`, cookie)).status).toBe(404);

    regionMode = "hang";
    const hung = await send("PATCH", `/users/me/notifications/${crypto.randomUUID()}/read?region=sg`, cookie);
    expect(hung.status).toBe(503);
    expect(hung.body.error?.reason).toBe("region_unavailable");
  });

  it("marks everything read here and in each other region, counting what answered", async () => {
    const { userId, cookie } = await signedIn(["sg"]);
    await sql`
      INSERT INTO notifications (user_id, type, payload) VALUES (${userId}, 'membership.ended', ${sql.json({})})
    `;
    regionAnswers.markAllNotificationsRead = 2;

    const res = await send("POST", "/users/me/notifications/read-all", cookie);

    expect((res.body.data as { count: number }).count).toBe(3);
    expect(received).toEqual([{ fn: "markAllNotificationsRead", args: [userId], signed: true }]);
  });
});

describe("a single-region deployment", () => {
  it("shows a Studio joined through an invitation in GET /studios straight away", async () => {
    initCore(process.env);
    try {
      const inviter = await signedIn();
      const invitee = await signedIn();
      const slug = `xr-team-${crypto.randomBytes(5).toString("hex")}`;
      const [team] = await sql<{ id: string }[]>`
        INSERT INTO studios (created_by_user_id, slug, type, name) VALUES (${inviter.userId}, ${slug}, 'team', 'Team') RETURNING id
      `;
      await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${team!.id}, ${inviter.userId}, 'admin')`;
      await sql`
        INSERT INTO studio_directory (studio_id, slug, region, type, name, admin_user_id, created_by_user_id, state)
        VALUES (${team!.id}, ${slug}, NULL, 'team', 'Team', ${inviter.userId}, ${inviter.userId}, 'live')
      `;
      await sql`INSERT INTO studio_directory_members (studio_id, user_id, role) VALUES (${team!.id}, ${inviter.userId}, 'admin')`;
      const [email] = await sql<{ email: string }[]>`SELECT email FROM users WHERE id = ${invitee.userId}`;
      const invite = await studioInviteService.createInvite(slug, inviter.userId, email!.email, "maintainer");

      await studioInviteService.confirmInvite(invite.invitationId, invitee.userId);
      const { body } = await get("/studios", invitee.cookie);

      expect((body.data as { id: string }[]).some((row) => row.id === team!.id)).toBe(true);
    } finally {
      initCore({
        ...process.env,
        REGION: "us-west",
        GLOBAL_REGION: "us-west",
        REGION_API_URLS: JSON.stringify({ sg: `http://127.0.0.1:${(regionServer.address() as AddressInfo).port}` }),
        ...GLOBAL_REGION_SETTINGS,
        INTERNAL_API_SECRET: "cross-region-test-secret",
      });
    }
  });
});
