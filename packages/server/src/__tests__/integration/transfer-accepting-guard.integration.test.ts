// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A transfer being accepted holds the Studio's roles still (inner#1955,
 * acceptance 5 and demo section 6) — real PG.
 *
 * Accepting a transfer changes the admin in the global region first and swaps
 * the roles here second. Between the two the offer is `accepting`; withdrawing
 * it, removing a member or changing a role in that window would undo what the
 * global region already recorded. Each is refused with 409
 * `studio_transfer_processing` and a sentence the web shows as a toast.
 *
 * The pins:
 *
 *   1. Withdrawing an accepting offer is refused.
 *   2. Removing a member while an offer is accepting is refused.
 *   3. Changing a member's role while an offer is accepting is refused.
 *   4. Each refusal leaves the offer and the roles as they were.
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
import { initCore, loadLocales } from "@breatic/core";
import * as studioMemberService from "@server/modules/studio/studioMember.service.js";
import * as studioTransferService from "@server/modules/studio/studioTransfer.service.js";

loadLocales();

const PROCESSING = "This Studio's transfer is being processed. Please try again later.";

let sql: ReturnType<typeof postgres>;
let seq = 0;

beforeAll(() => {
  initCore({ ...process.env, REGION: "us-west", GLOBAL_REGION: "us-west" });
  sql = postgres(inject("DATABASE_URL"), {
    max: 2,
    prepare: false,
    connection: { application_name: "transfer-accepting-guard-test" },
  });
});

afterAll(async () => {
  initCore(process.env);
  await sql?.end({ timeout: 5 });
});

/**
 * A verified account on the team tier.
 * @returns Its id.
 */
async function user(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified, membership_tier)
    VALUES (${`accepting-${Date.now()}-${seq++}@example.test`}, true, 'team') RETURNING id
  `;
  return row!.id;
}

/**
 * A team Studio with an admin, an heir and a third member, and an offer to the
 * heir that is being accepted.
 * @returns The Studio, its people and the offer.
 */
async function acceptingStudio(): Promise<{
  studioId: string;
  slug: string;
  adminId: string;
  heirId: string;
  otherId: string;
  offerId: string;
}> {
  const adminId = await user();
  const heirId = await user();
  const otherId = await user();
  const slug = `acc-${crypto.randomBytes(5).toString("hex")}`;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name) VALUES (${adminId}, ${slug}, 'team', 'Team') RETURNING id
  `;
  const studioId = studio!.id;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${adminId}, 'admin')`;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${heirId}, 'maintainer')`;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${otherId}, 'maintainer')`;
  await sql`
    INSERT INTO studio_directory (studio_id, slug, region, type, name, admin_user_id, created_by_user_id, state)
    VALUES (${studioId}, ${slug}, NULL, 'team', 'Team', ${adminId}, ${adminId}, 'live')
  `;
  await studioTransferService.requestTransfer(slug, adminId, heirId);
  const [offer] = await sql<{ id: string }[]>`SELECT id FROM studio_transfers WHERE studio_id = ${studioId} AND status = 'pending'`;
  await sql`UPDATE studio_transfers SET status = 'accepting' WHERE id = ${offer!.id}`;
  return { studioId, slug, adminId, heirId, otherId, offerId: offer!.id };
}

/**
 * The reason and message a refused call carries.
 * @param operation - The call.
 * @returns Its reason and message, or "resolved".
 */
async function refusalOf(operation: Promise<unknown>): Promise<{ reason?: string; message: string } | "resolved"> {
  return operation.then(
    () => "resolved" as const,
    (err: unknown) => ({ reason: (err as { reason?: string }).reason, message: (err as Error).message }),
  );
}

/**
 * The roles in a Studio by member.
 * @param studioId - The Studio.
 * @returns Role per user id.
 */
async function roles(studioId: string): Promise<Record<string, string>> {
  const rows = await sql<{ user_id: string; role: string }[]>`
    SELECT user_id, role FROM studio_members WHERE studio_id = ${studioId} AND deleted_at IS NULL
  `;
  return Object.fromEntries(rows.map((row) => [row.user_id, row.role]));
}

describe("while a transfer is being accepted", () => {
  it.each([
    ["withdrawing the offer", (s: Awaited<ReturnType<typeof acceptingStudio>>) =>
      studioTransferService.withdrawTransfer(s.offerId, s.slug)],
    ["removing a member", (s: Awaited<ReturnType<typeof acceptingStudio>>) =>
      studioMemberService.removeMember(s.slug, s.otherId)],
    ["changing a member's role", (s: Awaited<ReturnType<typeof acceptingStudio>>) =>
      studioMemberService.updateMemberRole(s.slug, s.otherId, "guest")],
  ])("refuses %s and leaves the offer and roles as they were", async (_label, act) => {
    const studio = await acceptingStudio();
    const before = await roles(studio.studioId);

    const refusal = await refusalOf(act(studio));

    expect(refusal).toEqual({ reason: "studio_transfer_processing", message: PROCESSING });
    const [offer] = await sql<{ status: string }[]>`SELECT status FROM studio_transfers WHERE id = ${studio.offerId}`;
    expect(offer!.status).toBe("accepting");
    expect(await roles(studio.studioId)).toEqual(before);
  });
});
