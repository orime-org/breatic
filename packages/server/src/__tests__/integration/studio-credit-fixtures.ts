// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Seeds for suites that need a studio with credits to spend: an admin, the
 * studio, a project in it, and purchases designated to the studio.
 */

import type postgres from "postgres";
import { creditLotService } from "@breatic/domain";
import { openPaymentSource } from "./payment-source.js";

type Sql = ReturnType<typeof postgres>;

/** A user administering a studio that owns one project. */
export interface StudioFixture {
  userId: string;
  studioId: string;
  projectId: string;
}

let seq = 0;

/**
 * Insert a user, a team studio they administer and a project in it.
 * @param sql - The test's own connection.
 * @param label - A prefix that keeps this suite's rows recognisable.
 * @returns The three ids.
 */
export async function seedStudioFixture(sql: Sql, label: string): Promise<StudioFixture> {
  const n = `${label}-${seq++}-${Date.now()}`;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, email_verified) VALUES (${`${n}@example.test`}, true) RETURNING id
  `;
  const userId = user!.id;
  const [studio] = await sql<{ id: string }[]>`
    INSERT INTO studios (created_by_user_id, slug, type, name)
    VALUES (${userId}, ${`${n}-s`}, 'team', 'Hold') RETURNING id
  `;
  const studioId = studio!.id;
  await sql`INSERT INTO studio_members (studio_id, user_id, role) VALUES (${studioId}, ${userId}, 'admin')`;
  const [project] = await sql<{ id: string }[]>`
    INSERT INTO projects (studio_id, created_by_user_id, slug, name)
    VALUES (${studioId}, ${userId}, ${`${n}-p`}, 'Hold project') RETURNING id
  `;
  return { userId, studioId, projectId: project!.id };
}

/**
 * Open a paid purchase for the fixture's admin and designate it to the studio.
 * @param sql - The test's own connection.
 * @param fx - Whose purchase, and which studio it is designated to.
 * @param credits - How many credits it grants.
 * @returns The lot id.
 */
export async function seedDesignatedLot(sql: Sql, fx: StudioFixture, credits: number): Promise<string> {
  const sourceId = await openPaymentSource(sql);
  await sql`
    INSERT INTO payments (id, user_id, amount_cents, status, credits_granted)
    VALUES (${sourceId}, ${fx.userId}, 1000, 'completed', ${credits})
  `;
  const lot = await creditLotService.grantFromPayment({
    paymentId: sourceId,
    userId: fx.userId,
    purchasedCredits: credits,
  });
  await sql`UPDATE credit_lots SET designated_studio_id = ${fx.studioId} WHERE id = ${lot.id}`;
  return lot.id;
}
