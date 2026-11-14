// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The one-off reconciliation after upgrading the global region (inner#1955,
 * acceptances 9 and 11) — real PG.
 *
 * While old processes were still running, they wrote Studios, members,
 * Projects, transfers and removals to the region tables without touching the
 * directory. Once they have all exited, `reconcileDirectoryAfterUpgrade`
 * aligns the directory with the region tables one Studio at a time, changes a
 * mismatched admin only through `changeDirectoryAdmin` (which releases the old
 * admin's designations), leaves the admin of a Studio with an accepting
 * transfer alone, and records that it is done.
 *
 * The pins:
 *
 *   1. Studios, members and Projects written only to region tables appear in
 *      the directory.
 *   2. A transfer completed by old code moves the directory admin and releases
 *      the old admin's designation.
 *   3. A member removed by old code leaves the directory's members.
 *   4. `transfer_pending_until` follows the unexpired pending offer only.
 *   5. A Studio with an accepting transfer keeps its directory admin.
 *   6. A second run does nothing.
 *   7. Running alongside a role change and a rename on the same Studio, it
 *      neither deadlocks nor leaves the directory behind the region.
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
import { creditLotService, studioDirectoryService } from "@breatic/domain";
import * as studioService from "@server/modules/studio/studio.service.js";
import * as studioMemberService from "@server/modules/studio/studioMember.service.js";
import { waitUntilBlockedOn } from "./lock-probe.js";
import { openPaymentSource } from "./payment-source.js";

loadLocales();

let sql: ReturnType<typeof postgres>;
let seq = 0;

const SUITE_ENV = {
  ...process.env,
  PAYMENT_ENABLED: "true",
  // Only the start-up check reads these; no Stripe call is made here.
  STRIPE_SECRET_KEY: "sk_test_unused_by_this_suite",
  STRIPE_WEBHOOK_SECRET: "whsec_unused_by_this_suite",
  REGION: "us-west",
  GLOBAL_REGION: "us-west",
};

beforeAll(async () => {
  initCore(SUITE_ENV);
  sql = postgres(inject("DATABASE_URL"), {
    max: 4,
    prepare: false,
    connection: { application_name: "reconcile-directory-test" },
  });
});

afterAll(async () => {
  initCore(process.env);
  await sql?.end({ timeout: 5 });
});

/**
 * A verified account.
 * @returns Its id.
 */
async function user(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`reconcile-${Date.now()}-${seq++}@example.test`}, true)
    RETURNING id
  `;
  return row!.id;
}

/**
 * A team Studio as old code wrote it: region rows only, no directory rows.
 * @returns Its id, slug, admin, a maintainer and a Project.
 */
async function oldCodeStudio(): Promise<{ studioId: string; slug: string; adminId: string; memberId: string; projectId: string }> {
  const adminId = await user();
  const memberId = await user();
  const slug = `rc-${crypto.randomBytes(5).toString("hex")}`;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name) VALUES (${adminId}, ${slug}, 'team', 'Old') RETURNING id
  `;
  const studioId = studio!.id;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${adminId}, 'admin')`;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${memberId}, 'maintainer')`;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, slug, name)
    VALUES (${studioId}, ${adminId}, ${`${slug}-p`}, 'Old project') RETURNING id
  `;
  return { studioId, slug, adminId, memberId, projectId: project!.id };
}

/**
 * Give a Studio the directory rows it had before the window opened.
 * @param studioId - The Studio.
 * @param adminId - Its admin then.
 * @param memberIds - Its other members then, as maintainers.
 */
async function directoryBeforeWindow(studioId: string, adminId: string, memberIds: string[]): Promise<void> {
  const [studio] = await sql<{ slug: string; name: string }[]>`SELECT slug, name FROM studios WHERE id = ${studioId}`;
  await sql`
    INSERT INTO studio_directory (studio_id, slug, region, type, name, admin_user_id, created_by_user_id, state)
    VALUES (${studioId}, ${studio!.slug}, NULL, 'team', ${studio!.name}, ${adminId}, ${adminId}, 'live')
  `;
  await sql`INSERT INTO studio_directory_members (studio_id, user_id, role) VALUES (${studioId}, ${adminId}, 'admin')`;
  for (const memberId of memberIds) {
    await sql`INSERT INTO studio_directory_members (studio_id, user_id, role) VALUES (${studioId}, ${memberId}, 'maintainer')`;
  }
}

/**
 * Start the reconciliation afresh, as an upgrade would, by retiring the
 * completion mark a previous case left.
 * @returns Once no live completion mark remains.
 */
async function freshUpgrade(): Promise<void> {
  await sql`UPDATE directory_reconciliations SET deleted_at = now() WHERE deleted_at IS NULL`;
}

/**
 * The directory's view of a Studio.
 * @param studioId - The Studio.
 * @returns Its admin, members and pending-transfer expiry.
 */
async function directory(studioId: string): Promise<{
  admin: string | undefined;
  members: Record<string, string>;
  pendingUntil: Date | null | undefined;
}> {
  const [row] = await sql<{ admin: string; until: Date | null }[]>`
    SELECT admin_user_id AS admin, transfer_pending_until AS until FROM studio_directory WHERE studio_id = ${studioId}
  `;
  const members = await sql<{ user_id: string; role: string }[]>`
    SELECT user_id, role FROM studio_directory_members WHERE studio_id = ${studioId} AND deleted_at IS NULL
  `;
  return {
    admin: row?.admin,
    members: Object.fromEntries(members.map((m) => [m.user_id, m.role])),
    pendingUntil: row?.until,
  };
}

/**
 * The region's member roles of a Studio.
 * @param studioId - The Studio.
 * @returns Them.
 */
async function regionMembers(studioId: string): Promise<Record<string, string>> {
  const rows = await sql<{ user_id: string; role: string }[]>`
    SELECT user_id, role FROM studio_members WHERE studio_id = ${studioId} AND deleted_at IS NULL
  `;
  return Object.fromEntries(rows.map((m) => [m.user_id, m.role]));
}

describe("reconcileDirectoryAfterUpgrade", () => {
  it("adds Studios, members and Projects that old code wrote only to region tables", async () => {
    await freshUpgrade();
    const { studioId, adminId, memberId, projectId } = await oldCodeStudio();

    await studioDirectoryService.reconcileDirectoryAfterUpgrade();

    const view = await directory(studioId);
    expect(view.admin).toBe(adminId);
    expect(view.members).toEqual({ [adminId]: "admin", [memberId]: "maintainer" });
    const [project] = await sql<{ studio_id: string }[]>`SELECT studio_id FROM project_directory WHERE project_id = ${projectId}`;
    expect(project?.studio_id).toBe(studioId);
  });

  it("moves the admin after an old-code transfer and releases the old admin's designation", async () => {
    await freshUpgrade();
    const { studioId, adminId, memberId } = await oldCodeStudio();
    await directoryBeforeWindow(studioId, adminId, [memberId]);
    const sourceId = await openPaymentSource(sql);
    await sql`
      INSERT INTO payments (id, user_id, amount_cents, status, credits_granted)
      VALUES (${sourceId}, ${adminId}, 1000, 'completed', 10)
    `;
    const lot = await creditLotService.grantFromPayment({ paymentId: sourceId, userId: adminId, purchasedCredits: 10 });
    await sql`UPDATE credit_lots SET designated_studio_id = ${studioId} WHERE id = ${lot.id}`;
    await sql`UPDATE studio_members SET role = 'maintainer' WHERE studio_id = ${studioId} AND user_id = ${adminId}`;
    await sql`UPDATE studio_members SET role = 'admin' WHERE studio_id = ${studioId} AND user_id = ${memberId}`;

    await studioDirectoryService.reconcileDirectoryAfterUpgrade();

    expect((await directory(studioId)).admin).toBe(memberId);
    const [after] = await sql<{ studio: string | null }[]>`SELECT designated_studio_id AS studio FROM credit_lots WHERE id = ${lot.id}`;
    expect(after!.studio).toBeNull();
  });

  it("drops a member that old code removed", async () => {
    await freshUpgrade();
    const { studioId, adminId, memberId } = await oldCodeStudio();
    await directoryBeforeWindow(studioId, adminId, [memberId]);
    await sql`UPDATE studio_members SET deleted_at = now() WHERE studio_id = ${studioId} AND user_id = ${memberId}`;

    await studioDirectoryService.reconcileDirectoryAfterUpgrade();

    expect((await directory(studioId)).members).toEqual({ [adminId]: "admin" });
  });

  it("follows only the unexpired pending offer for transfer_pending_until", async () => {
    await freshUpgrade();
    const live = await oldCodeStudio();
    const lapsed = await oldCodeStudio();
    const expiresAt = new Date(Date.now() + 3_600_000);
    await sql`
      INSERT INTO studio_transfers (studio_id, from_user_id, to_user_id, status, expires_at, share_token)
      VALUES (${live.studioId}, ${live.adminId}, ${live.memberId}, 'pending', ${expiresAt}, ${crypto.randomBytes(16).toString("hex")})
    `;
    await sql`
      INSERT INTO studio_transfers (studio_id, from_user_id, to_user_id, status, expires_at, share_token)
      VALUES (${lapsed.studioId}, ${lapsed.adminId}, ${lapsed.memberId}, 'pending', ${new Date(Date.now() - 1_000)}, ${crypto.randomBytes(16).toString("hex")})
    `;

    await studioDirectoryService.reconcileDirectoryAfterUpgrade();

    expect((await directory(live.studioId)).pendingUntil?.getTime()).toBe(expiresAt.getTime());
    expect((await directory(lapsed.studioId)).pendingUntil).toBeNull();
  });

  it("keeps the directory admin of a Studio with an accepting transfer", async () => {
    await freshUpgrade();
    const { studioId, adminId, memberId } = await oldCodeStudio();
    await directoryBeforeWindow(studioId, adminId, [memberId]);
    await sql`
      INSERT INTO studio_transfers (studio_id, from_user_id, to_user_id, status, expires_at, share_token)
      VALUES (${studioId}, ${adminId}, ${memberId}, 'accepting', ${new Date(Date.now() + 3_600_000)}, ${crypto.randomBytes(16).toString("hex")})
    `;
    await sql`UPDATE studio_members SET role = 'maintainer' WHERE studio_id = ${studioId} AND user_id = ${adminId}`;
    await sql`UPDATE studio_members SET role = 'admin' WHERE studio_id = ${studioId} AND user_id = ${memberId}`;

    await studioDirectoryService.reconcileDirectoryAfterUpgrade();

    expect((await directory(studioId)).admin).toBe(adminId);
  });

  it("does nothing on a second run", async () => {
    await freshUpgrade();
    await studioDirectoryService.reconcileDirectoryAfterUpgrade();
    const { studioId } = await oldCodeStudio();

    await studioDirectoryService.reconcileDirectoryAfterUpgrade();

    expect((await directory(studioId)).admin).toBeUndefined();
  });

  it("does nothing outside the global region, whose directory tables are not in use", async () => {
    await freshUpgrade();
    const { studioId } = await oldCodeStudio();
    initCore({
      ...SUITE_ENV,
      REGION: "sg",
      GLOBAL_API_URL: "http://global.invalid",
      IDENTITY_PUBLIC_KEYS: JSON.stringify({ k1: "unused" }),
      INTERNAL_API_SECRET: "reconcile-test-secret",
    });
    try {
      expect(await studioDirectoryService.reconcileDirectoryAfterUpgrade()).toBe(0);
    } finally {
      initCore(SUITE_ENV);
    }

    expect((await directory(studioId)).admin).toBeUndefined();
  });

  it("neither deadlocks nor falls behind when a role change and a rename run alongside it", async () => {
    await freshUpgrade();
    const { studioId, slug, adminId, memberId } = await oldCodeStudio();
    await directoryBeforeWindow(studioId, adminId, [memberId]);
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
    const gate = sql.begin(async (tx) => {
      await tx`SELECT id FROM studios WHERE id = ${studioId} FOR UPDATE`;
      locked();
      await released;
    });
    await lockTaken;

    const running = Promise.all([
      studioDirectoryService.reconcileDirectoryAfterUpgrade(),
      studioMemberService.updateMemberRole(slug, memberId, "guest"),
      studioService.updateStudio(slug, { name: "Renamed" }),
    ]);
    await waitUntilBlockedOn(sql, ["studios"], 3);
    release();
    await gate;
    await running;

    const view = await directory(studioId);
    expect(view.members).toEqual(await regionMembers(studioId));
    const [names] = await sql<{ region: string; dir: string }[]>`
      SELECT s.name AS region, d.name AS dir FROM studios s JOIN studio_directory d ON d.studio_id = s.id WHERE s.id = ${studioId}
    `;
    expect(names!.dir).toBe(names!.region);
  });
});
