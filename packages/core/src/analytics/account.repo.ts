// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The account's analytics record (inner#1442 design §4.4.6, §4.5): the latest
 * consent a signed-in browser reported, for events no browser causes, and
 * the campaign source kept at sign-up. Here because server, worker and
 * collab all read it.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import {
  adsAllowed,
  CONSENT_REVISION,
  revisionInForce,
  type Attribution,
  type BrowserAdsSnapshot,
  type ConsentRecord,
  type ConsentSnapshot,
  type ReportedConsent,
} from "@breatic/shared";
import { appendAccountErasure } from "@core/commerce/commerce-outbox.repo.js";
import { db } from "@core/db/client.js";
import { users } from "@core/db/schema.js";
import { eraseForAccounts as eraseModelUpstreams } from "@core/byok/account-model-upstreams.repo.js";
import { eraseForAccounts as eraseProviderKeys } from "@core/byok/account-provider-keys.repo.js";

/**
 * The account's latest report.
 * @param userId - The account.
 * @returns `{ seen }` (null without a report), or null when the account is missing or deleted.
 */
async function readAccount(userId: string): Promise<{ seen: ConsentRecord | null } | null> {
  const rows = await db
    .select({ seen: users.consentSeen })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  const row = rows[0];
  return row ? { seen: row.seen ?? null } : null;
}

/**
 * Keep what a signed-in browser reports as the account's latest consent,
 * replacing any earlier report; the last browser to report wins.
 * @param userId - The account.
 * @param report - The browser's consent per category.
 * @returns True when kept; false for a missing or deleted account.
 */
export async function recordReportedConsent(userId: string, report: ReportedConsent): Promise<boolean> {
  const record: ConsentRecord = {
    analytics: { value: report.analytics, revision: CONSENT_REVISION },
    ads: { value: report.ads, revision: CONSENT_REVISION },
    reportedAt: new Date().toISOString(),
  };
  const rows = await db
    .update(users)
    .set({ consentSeen: record })
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .returning({ id: users.id });
  return rows.length > 0;
}

/**
 * Whether ads may run for an event credited to the account (design §4.4.6):
 * the browser behind it, or, with no browser, the account's latest report.
 * @param userId - The account.
 * @param browser - The browser behind the event as it stood then; null for an event with none.
 * @returns Whether ads may run; never for a missing or deleted account.
 */
export async function adsAllowedFor(userId: string, browser: BrowserAdsSnapshot | null): Promise<boolean> {
  const account = await readAccount(userId);
  if (account === null) return adsAllowed({ browser, deleted: true });
  return adsAllowed({ browser, seen: account.seen?.ads ?? null });
}

/**
 * The account's consent for an event no browser is behind (a renewal, a
 * collaboration conversion): its latest report.
 * @param userId - The account.
 * @returns The snapshot; nothing for a missing or deleted account or one that never reported.
 */
export async function accountOnlyConsent(userId: string): Promise<ConsentSnapshot> {
  const seen = (await readAccount(userId))?.seen ?? null;
  return {
    analytics: seen?.analytics.value === true && revisionInForce(seen.analytics.revision),
    ads: adsAllowed({ browser: null, seen: seen?.ads ?? null }),
  };
}

/**
 * Read the campaign source recorded at sign-up.
 * @param userId - The account.
 * @returns It, or null when none was kept.
 */
export async function getAccountAttribution(userId: string): Promise<Attribution | null> {
  const rows = await db.select({ attribution: users.attribution }).from(users).where(eq(users.id, userId)).limit(1);
  return rows[0]?.attribution ?? null;
}

/**
 * Remove what deleted accounts' consent left behind: the latest report, and
 * the consent snapshots on their upload tickets and ad uploads, and their own
 * provider keys and model choices (inner#1953); the snapshots on their orders
 * are dropped by the billing service, told in the same transaction through
 * the outbox (inner#1993 §3.4). Only accounts already soft-deleted are touched; when any id
 * is not, nothing changes.
 * @param userIds - The accounts' `users.id`.
 * @returns The ids that are not soft-deleted (empty when the erase ran).
 */
export async function eraseAccountAnalytics(userIds: readonly string[]): Promise<{ notDeleted: string[] }> {
  const ids = [...new Set(userIds)];
  const idArray = sql`${`{${ids.join(",")}}`}::uuid[]`;
  return db.transaction(async (tx) => {
    const deleted = await tx.execute<{ id: string }>(sql`SELECT id FROM users WHERE id = ANY(${idArray}) AND deleted_at IS NOT NULL`);
    const found = new Set(deleted.map((r) => r.id));
    const notDeleted = ids.filter((id) => !found.has(id));
    if (notDeleted.length > 0) return { notDeleted };
    await tx.execute(sql`UPDATE users SET consent_seen = NULL WHERE id = ANY(${idArray})`);
    await tx.execute(sql`UPDATE upload_grants SET analytics_consent = NULL WHERE user_id = ANY(${idArray}) AND analytics_consent IS NOT NULL`);
    await tx.execute(sql`
      UPDATE ads_conversion_uploads SET job = jsonb_set(job, '{browser}', 'null'::jsonb), updated_at = now()
      WHERE job->>'userId' = ANY(${`{${ids.join(",")}}`}::text[]) AND job->'browser' <> 'null'::jsonb`);
    await eraseProviderKeys(ids, tx);
    await eraseModelUpstreams(ids, tx);
    // The orders' consent lives with the billing service, which drops it on this event.
    for (const id of ids) await appendAccountErasure(id, tx);
    return { notDeleted: [] };
  });
}
