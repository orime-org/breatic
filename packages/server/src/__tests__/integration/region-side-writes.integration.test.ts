// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a region that does not hold the global data tells the global region
 * about people and names (inner#1955, acceptances 3, 4 and 7) — real PG and a
 * real HTTP stand-in for the global region.
 *
 * This suite runs as the region `sg`; account reads go to the stand-in over
 * signed HTTP. Writing a membership, or a notification for someone, records
 * that the person has data here (`user_region.touched`), so the global
 * region's cross-region reads know to ask. A renamed personal Studio reaches
 * every region within a minute: the relay interval plus the profile cache
 * lifetime.
 *
 * The pins:
 *
 *   1. Inviting an existing account records that account here, and the
 *      invitation's token names this region.
 *   2. Accepting an invitation records the new member here.
 *   3. A transfer offer's link token names this region too.
 *   4. The global region keeps one `user_regions` row however often it hears.
 *   5. A personal Studio renamed here is the name the global profiles return
 *      once the event is applied, and the relay interval plus the profile
 *      cache lifetime stay within sixty seconds.
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
  sendBestEffortMail: async (): Promise<void> => {},
}));

import crypto from "node:crypto";
import postgres from "postgres";
import { getMembershipLimits, getRegionsConfig, initCore, loadLocales } from "@breatic/core";
import { regionOutboxApplyService, regionOutboxService, studioDirectoryService } from "@breatic/domain";
import * as studioService from "@server/modules/studio/studio.service.js";
import * as studioInviteService from "@server/modules/studio/studioInvite.service.js";
import * as studioTransferService from "@server/modules/studio/studioTransfer.service.js";
import { startRegionStandIn, type RegionStandIn } from "./region-harness.js";

loadLocales();

let sql: ReturnType<typeof postgres>;
let global: RegionStandIn;
let seq = 0;

/**
 * Answer the account reads the region makes, from this database.
 * @param stand - The stand-in to teach.
 */
function answerAccounts(stand: RegionStandIn): void {
  stand.answers.findAccountByEmail = async (email: unknown) => {
    const [row] = await sql<{ id: string; email_verified: boolean; locale: string }[]>`
      SELECT id, email_verified, locale FROM users WHERE email = ${String(email)} AND deleted_at IS NULL
    `;
    return row === undefined ? null : { id: row.id, emailVerified: row.email_verified, locale: row.locale };
  };
  stand.answers.getAccounts = async (ids: unknown) =>
    sql`SELECT id, email, locale FROM users WHERE id = ANY(${ids as string[]})`;
  stand.answers.getProfiles = async () => ({});
  stand.answers.getLimitsForStudio = () => getMembershipLimits("team");
}

beforeAll(async () => {
  global = await startRegionStandIn();
  initCore({
    ...process.env,
    REGION: "sg",
    GLOBAL_REGION: "us-west",
    GLOBAL_API_URL: global.url,
    IDENTITY_PUBLIC_KEYS: JSON.stringify({ k1: "unused" }),
    INTERNAL_API_SECRET: "region-side-test-secret",
  });
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "region-side-writes-test" },
  });
  answerAccounts(global);
});

afterEach(() => {
  global.reset();
  answerAccounts(global);
});

afterAll(async () => {
  initCore(process.env);
  await global.close();
  await sql?.end({ timeout: 5 });
});

/**
 * A verified account.
 * @returns Its id and email.
 */
async function account(): Promise<{ userId: string; email: string }> {
  const email = `region-side-${Date.now()}-${seq++}@example.test`;
  const [row] = await sql<{ id: string }[]>`INSERT INTO users (email, email_verified, membership_tier) VALUES (${email}, true, 'team') RETURNING id`;
  return { userId: row!.id, email };
}

/**
 * A team Studio in this region with its admin.
 * @param adminId - The admin.
 * @returns Its id and slug.
 */
async function regionStudio(adminId: string): Promise<{ studioId: string; slug: string }> {
  const slug = `rs-${crypto.randomBytes(5).toString("hex")}`;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name) VALUES (${adminId}, ${slug}, 'team', 'Team') RETURNING id
  `;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${adminId}, 'admin')`;
  return { studioId: studio!.id, slug };
}

/**
 * The `user_region.touched` events written for a user.
 * @param userId - The user.
 * @returns How many.
 */
async function touchedEvents(userId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM region_outbox
    WHERE event_type = 'user_region.touched' AND payload->>'userId' = ${userId}
  `;
  return row!.n;
}

describe("recording who has data in this region", () => {
  it("records an invited account and gives the invitation a token naming this region", async () => {
    const admin = await account();
    const invitee = await account();
    const { slug } = await regionStudio(admin.userId);

    const invite = await studioInviteService.createInvite(slug, admin.userId, invitee.email, "maintainer");

    expect(await touchedEvents(invitee.userId)).toBeGreaterThan(0);
    const [row] = await sql<{ token: string }[]>`SELECT share_token AS token FROM studio_invitations WHERE id = ${invite.invitationId}`;
    expect(row!.token.startsWith("sg.")).toBe(true);
  });

  it("records the new member when an invitation is accepted", async () => {
    const admin = await account();
    const invitee = await account();
    const { slug } = await regionStudio(admin.userId);
    const invite = await studioInviteService.createInvite(slug, admin.userId, invitee.email, "maintainer");
    await sql`DELETE FROM region_outbox WHERE payload->>'userId' = ${invitee.userId}`;

    await studioInviteService.confirmInvite(invite.invitationId, invitee.userId);

    expect(await touchedEvents(invitee.userId)).toBeGreaterThan(0);
  });

  it("gives a transfer offer a link token naming this region", async () => {
    const admin = await account();
    const heir = await account();
    const { studioId, slug } = await regionStudio(admin.userId);
    await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${heir.userId}, 'maintainer')`;

    await studioTransferService.requestTransfer(slug, admin.userId, heir.userId);

    const [row] = await sql<{ token: string }[]>`
      SELECT share_token AS token FROM studio_transfers WHERE studio_id = ${studioId} AND status = 'pending'
    `;
    expect(row!.token.startsWith("sg.")).toBe(true);
  });

  it("keeps one user_regions row however often the global region hears", async () => {
    const { userId } = await account();
    const event = (id: number): regionOutboxService.OutboxEvent => ({
      id: String(id),
      aggregateKey: `user:${userId}`,
      type: "user_region.touched",
      payload: { userId },
    });

    await regionOutboxApplyService.applyRegionEvent("sg", event(1_000_000_001));
    await regionOutboxApplyService.applyRegionEvent("sg", event(1_000_000_002));

    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM user_regions WHERE user_id = ${userId} AND region = 'sg'`;
    expect(row!.n).toBe(1);
  });
});

describe("a renamed personal Studio", () => {
  it("is the name the global profiles return once its event is applied", async () => {
    const { userId } = await account();
    const slug = `rs-p-${crypto.randomBytes(5).toString("hex")}`;
    const [studio] = await sql<{ id: string }[]>`
      INSERT INTO studios (created_by_user_id, slug, type, name) VALUES (${userId}, ${slug}, 'personal', 'Before') RETURNING id
    `;
    await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studio!.id}, ${userId}, 'admin')`;
    await sql`
      INSERT INTO studio_directory (studio_id, slug, region, type, name, admin_user_id, created_by_user_id, state)
      VALUES (${studio!.id}, ${slug}, 'sg', 'personal', 'Before', ${userId}, ${userId}, 'live')
    `;

    await studioService.updateStudio(slug, { name: "After" });
    await regionOutboxService.relayOutbox({ deliver: (event) => regionOutboxApplyService.applyRegionEvent("sg", event) });

    const profiles = await studioDirectoryService.getProfiles([userId]);
    expect(profiles[userId]?.name).toBe("After");
  });

  it("reaches every region within sixty seconds by configuration", () => {
    const regions = getRegionsConfig();
    expect(regions.outbox_relay_interval_ms + regions.profile_cache_ttl_ms).toBeLessThanOrEqual(60_000);
  });
});
