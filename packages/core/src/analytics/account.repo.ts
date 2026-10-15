// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The account's analytics record (inner#1442 design §4.4.6, §4.5): its ad
 * switch, the cookie choices last seen on a signed-in request, and the
 * campaign source kept at sign-up. Here because server, worker and collab all
 * read it.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import {
  adsAllowed,
  revisionInForce,
  type AdsOptOutSource,
  type AdsSharing,
  type Attribution,
  type BrowserAdsSnapshot,
  type ConsentSeen,
  type ConsentSnapshot,
} from "@breatic/shared";
import { db, rawPg } from "@core/db/client.js";
import { users } from "@core/db/schema.js";

/** The ad switch as the columns hold it. */
const sharingColumns = { at: users.adsOptedOutAt, source: users.adsOptOutSource };

/**
 * The switch the two columns describe.
 * @param row - The columns.
 * @param row.at - When ads were switched off, or null.
 * @param row.source - Who switched them off.
 * @returns The switch.
 */
function sharingOf(row: { at: Date | null; source: string | null }): AdsSharing {
  return row.at === null ? { optedOut: false, source: null } : { optedOut: true, source: row.source as AdsOptOutSource };
}

/**
 * The account's ad switch and the choices last seen.
 * @param userId - The account.
 * @returns Both, or null when the account is missing or deleted.
 */
async function readAccount(userId: string): Promise<{ sharing: AdsSharing; seen: ConsentSeen } | null> {
  const rows = await db
    .select({ ...sharingColumns, seen: users.consentSeen })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  const row = rows[0];
  return row ? { sharing: sharingOf(row), seen: row.seen ?? {} } : null;
}

/**
 * Read the account's ad switch.
 * @param userId - The account.
 * @returns The switch, or null when the account is missing or deleted.
 */
export async function getAdsSharing(userId: string): Promise<AdsSharing | null> {
  return (await readAccount(userId))?.sharing ?? null;
}

/**
 * Open or close the account's ad switch. Closing keeps the time and source of
 * a switch already closed; every time is the server's.
 * @param userId - The account.
 * @param change - `{ allowed: true }` to open it, or `{ allowed: false, source }` to close it.
 * @returns The switch afterwards, or null when the account is missing or deleted.
 */
export async function setAdsSharing(
  userId: string,
  change: { allowed: true } | { allowed: false; source: AdsOptOutSource },
): Promise<AdsSharing | null> {
  const set = change.allowed
    ? { adsOptedOutAt: null, adsOptOutSource: null }
    : {
        adsOptedOutAt: sql`coalesce(${users.adsOptedOutAt}, now())`,
        adsOptOutSource: sql`coalesce(${users.adsOptOutSource}, ${change.source})`,
      };
  const rows = await db
    .update(users)
    .set(set)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .returning(sharingColumns);
  return rows[0] ? sharingOf(rows[0]) : null;
}

/**
 * Record what a signed-in request says about the account, in one conditional
 * write: GPC closes an open ad switch, and the cookie's choices replace the
 * ones last seen when they differ. Nothing is written when neither applies.
 * @param userId - The account.
 * @param request - Whether the request carried GPC, and what it would record as seen (`consentSeenFrom`).
 * @param request.gpc - Whether it carried `Sec-GPC: 1`.
 * @param request.seen - The choices to record, or null for none.
 */
export async function recordSignedInRequest(
  userId: string,
  request: { gpc: boolean; seen: ConsentSeen | null },
): Promise<void> {
  const { gpc, seen } = request;
  if (!gpc && seen === null) return;
  const closes = sql`(${gpc} AND ${users.adsOptedOutAt} IS NULL)`;
  const replaces =
    seen === null ? sql`false` : sql`(${users.consentSeen} IS DISTINCT FROM ${JSON.stringify(seen)}::jsonb)`;
  await db
    .update(users)
    .set({
      adsOptedOutAt: sql`CASE WHEN ${closes} THEN now() ELSE ${users.adsOptedOutAt} END`,
      adsOptOutSource: sql`CASE WHEN ${closes} THEN 'gpc' ELSE ${users.adsOptOutSource} END`,
      consentSeen: sql`CASE WHEN ${replaces} THEN ${JSON.stringify(seen)}::jsonb ELSE ${users.consentSeen} END`,
    })
    .where(and(eq(users.id, userId), isNull(users.deletedAt), sql`(${closes} OR ${replaces})`));
}

/**
 * Whether ads may run for an event credited to the account (design §4.4.6):
 * the browser behind it with the account's current switch, or, with no
 * browser, the ads choice last seen.
 * @param userId - The account.
 * @param browser - The browser behind the event as it stood then; null for an event with none.
 * @returns Whether ads may run; never for a missing or deleted account.
 */
export async function adsAllowedFor(userId: string, browser: BrowserAdsSnapshot | null): Promise<boolean> {
  const account = await readAccount(userId);
  if (account === null) return adsAllowed({ browser, account: "deleted" });
  return adsAllowed({ browser, account: account.sharing, seen: account.seen.ads ?? null });
}

/**
 * The account's consent for an event no browser is behind (a renewal, a
 * collaboration conversion): the choices last seen while signed in.
 * @param userId - The account.
 * @returns The snapshot; nothing for a missing or deleted account.
 */
export async function accountOnlyConsent(userId: string): Promise<ConsentSnapshot> {
  const account = await readAccount(userId);
  const analytics = account?.seen.analytics;
  return {
    analytics: analytics?.value === true && revisionInForce(analytics.revision),
    ads:
      account !== null && adsAllowed({ browser: null, account: account.sharing, seen: account.seen.ads ?? null }),
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
 * Remove what deleted accounts' consent left behind: their ad switch, the
 * choices last seen, and the consent snapshots on their orders, upload tickets
 * and ad uploads. Only accounts already soft-deleted are touched; when any id
 * is not, nothing changes.
 * @param userIds - The accounts' `users.id`.
 * @returns The ids that are not soft-deleted (empty when the erase ran).
 */
export async function eraseAccountAnalytics(userIds: readonly string[]): Promise<{ notDeleted: string[] }> {
  const ids = [...new Set(userIds)];
  return rawPg.begin(async (tx) => {
    const deleted = await tx<{ id: string }[]>`SELECT id FROM users WHERE id = ANY(${ids}::uuid[]) AND deleted_at IS NOT NULL`;
    const found = new Set(deleted.map((r) => r.id));
    const notDeleted = ids.filter((id) => !found.has(id));
    if (notDeleted.length > 0) return { notDeleted };
    await tx`
      UPDATE users SET ads_opted_out_at = NULL, ads_opt_out_source = NULL, consent_seen = NULL
      WHERE id = ANY(${ids}::uuid[])`;
    await tx`
      UPDATE payments SET metadata = metadata - 'analyticsConsent' - 'adsBrowser'
      WHERE user_id = ANY(${ids}::uuid[]) AND metadata ?| array['analyticsConsent', 'adsBrowser']`;
    await tx`UPDATE upload_grants SET analytics_consent = NULL WHERE user_id = ANY(${ids}::uuid[]) AND analytics_consent IS NOT NULL`;
    await tx`
      UPDATE ads_conversion_uploads SET job = jsonb_set(job, '{browser}', 'null'::jsonb), updated_at = now()
      WHERE job->>'userId' = ANY(${ids}::text[]) AND job->'browser' <> 'null'::jsonb`;
    return { notDeleted: [] };
  });
}
