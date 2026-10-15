// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Product events sent from request paths (inner#1442 design §4.8) — real PG +
 * Redis. Each follows the consent in scope, carries the documented dedupe id,
 * and is sent only after its write committed.
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
vi.mock("@server/utils/send-best-effort-mail.js", () => ({
  sendBestEffortMail: async (): Promise<void> => undefined,
}));

import crypto from "node:crypto";
import postgres from "postgres";
import {
  initCore,
  getUploadStatus,
  initServerAnalytics,
  loadLocales,
  setAdsConversionConfigForTest,
  resetServerAnalyticsForTest,
  runWithConsent,
  type OutgoingEvent,
  type RequestBrowser,
} from "@breatic/core";
import type { ConsentSnapshot } from "@breatic/shared";

try {
  initCore(process.env);
} catch {
  // already initialised by a sibling suite in this worker — fine.
}
loadLocales();

const { projectService, recentService, studioService } = await import("@server/modules");
const inviteService = await import("@server/modules/project-invite/projectInvite.service.js");

let sql: ReturnType<typeof postgres>;
const sent: OutgoingEvent[] = [];
const ACCEPT: ConsentSnapshot = { analytics: true, ads: false };

beforeAll(() => {
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false });
  initServerAnalytics({
    apiKey: "0123456789abcdef0123456789abcdef",
    createClient: () => ({ track: (event) => void sent.push(event), flush: async () => undefined }),
  });
});

afterEach(() => {
  sent.splice(0);
});

afterAll(async () => {
  resetServerAnalyticsForTest();
  await sql?.end({ timeout: 5 });
});

/**
 * An account with its personal studio, on a tier with room for projects.
 * @returns The account id, email and studio id.
 */
async function member(): Promise<{ id: string; email: string; studioId: string }> {
  const email = `request-analytics-${crypto.randomUUID()}@example.test`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, membership_tier) VALUES (${email}, 'pro') RETURNING id
  `;
  const studio = await studioService.createPersonalStudio(row!.id, `ra-${crypto.randomUUID().slice(0, 12)}`);
  return { id: row!.id, email, studioId: studio.id };
}

/**
 * Events of one type, as name and properties.
 * @param type - The event name.
 * @returns What was sent.
 */
function eventsOf(type: string): OutgoingEvent[] {
  return sent.filter((e) => e.event_type === type);
}

/**
 * A browser that accepted ads, as the request context holds it.
 * @returns The snapshot.
 */
function adsAccepted(): RequestBrowser {
  return { ads: { consent: true } };
}

describe("project_created", () => {
  it("marks only the account's first project, and counts a copy", async () => {
    const me = await member();
    const first = await runWithConsent(ACCEPT, () =>
      projectService.create(me.id, me.studioId, "One", "one", "canvas"),
    );
    const second = await runWithConsent(ACCEPT, () =>
      projectService.create(me.id, me.studioId, "Two", "two", "canvas"),
    );
    const copy = await runWithConsent(ACCEPT, () => projectService.duplicate(first.id, me.id));

    expect(eventsOf("project_created").map((e) => [e.insert_id, e.event_properties])).toEqual([
      [`project:${first.id}`, { studio_id: me.studioId, project_id: first.id, space_type: "canvas", via: "create", is_first: true }],
      [`project:${second.id}`, { studio_id: me.studioId, project_id: second.id, space_type: "canvas", via: "create", is_first: false }],
      [`project:${copy.id}`, { studio_id: me.studioId, project_id: copy.id, via: "duplicate", is_first: false }],
    ]);
  });

  it("queues the first-project conversion against the sign-up click", async () => {
    setAdsConversionConfigForTest({
      customerId: "1234567890",
      actions: { first_project: "44" },
      credentials: { client_email: "svc@example.test", private_key: "key" },
    });
    try {
      const me = await member();
      const at = new Date().toISOString();
      await sql`UPDATE users SET attribution = ${sql.json({ first: { gclid: "g", at }, last: { gclid: "g", at } })} WHERE id = ${me.id}`;
      const ads = { analytics: false, ads: true };
      await runWithConsent(ads, () => projectService.create(me.id, me.studioId, "A", "a", "canvas"), adsAccepted());
      await runWithConsent(ads, () => projectService.create(me.id, me.studioId, "B", "b", "canvas"), adsAccepted());
      expect(await getUploadStatus({ conversion: "first_project", transactionId: `first-project:${me.id}` })).toBe("queued");
      const [{ n }] = await sql<[{ n: number }]>`
        SELECT count(*)::int AS n FROM ads_conversion_uploads WHERE transaction_id = ${`first-project:${me.id}`}
      `;
      expect(n).toBe(1);
    } finally {
      setAdsConversionConfigForTest(undefined);
    }
  });

  it("sends nothing without consent", async () => {
    const me = await member();
    await projectService.create(me.id, me.studioId, "Quiet", "quiet", "canvas");
    expect(sent).toEqual([]);
  });

  it("sends nothing when the create fails", async () => {
    const me = await member();
    const stranger = await member();
    await expect(
      runWithConsent(ACCEPT, () => projectService.create(stranger.id, me.studioId, "No", "no", "canvas")),
    ).rejects.toThrow();
    expect(sent).toEqual([]);
  });
});

describe("project invitations", () => {
  it("reports the invite from the inviter and the acceptance from the invitee", async () => {
    const owner = await member();
    const invitee = await member();
    const project = await projectService.create(owner.id, owner.studioId, "Shared", "shared", "canvas");

    const { invitationId } = await runWithConsent(ACCEPT, () =>
      inviteService.createInvite(project.id, owner.id, invitee.email, "editor"),
    );
    await runWithConsent(ACCEPT, () => inviteService.confirmInvite(invitationId, invitee.id));

    const props = { studio_id: owner.studioId, project_id: project.id, scope: "project", role: "editor" };
    expect(eventsOf("member_invited")).toEqual([
      expect.objectContaining({ user_id: owner.id, insert_id: `invite:${invitationId}`, event_properties: props }),
    ]);
    expect(eventsOf("invitation_accepted")).toEqual([
      expect.objectContaining({ user_id: invitee.id, insert_id: `invite-accepted:${invitationId}`, event_properties: props }),
    ]);
  });
});

describe("active_project_session", () => {
  it("dedupes opens of one project to one per UTC day", async () => {
    const me = await member();
    const project = await projectService.create(me.id, me.studioId, "Open", "open", "canvas");
    await runWithConsent(ACCEPT, async () => {
      await recentService.recordOpen(project.id, me.id);
      await recentService.recordOpen(project.id, me.id);
    });
    const day = new Date().toISOString().slice(0, 10);
    const sessions = eventsOf("active_project_session");
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map((e) => e.insert_id))).toEqual(new Set([`session:${me.id}:${project.id}:${day}`]));
    expect(sessions[0]!.event_properties).toEqual({ studio_id: me.studioId, project_id: project.id });
  });
});

