// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The account's analytics record (inner#1442 design §4.4.6, §4.5): the consent
 * receipts its browsers reported, when a signed-in request last carried GPC,
 * and the campaign source kept at sign-up. Here because server, worker and
 * collab all read it.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import {
  CONSENT_MAX_AGE_DAYS,
  CONSENT_REVISION,
  accountAnalyticsValue,
  adsAllowed,
  choiceInForce,
  NO_CONSENT,
  type AccountAdsHistory,
  type AccountAdsReceipt,
  type AdsSource,
  type Attribution,
  type BrowserAdsSnapshot,
  type ConsentReport,
  type ConsentSnapshot,
  type Ownership,
} from "@breatic/shared";
import { db, rawPg } from "@core/db/client.js";
import { analyticsConsentEvents, users } from "@core/db/schema.js";

// Time between two GPC writes for the same account, so a browser sending GPC on every request writes once an hour.
const GPC_REFRESH = "1 hour";

const DAY_MS = 86_400_000;

/**
 * Record a signed-in browser's report, one receipt per decision. A decision
 * already on file, on this account or another, is left as it is; nothing is
 * recorded for a deleted account. The browser's clock is corrected by how far
 * it was off when it sent the report, and no receipt is dated in the future.
 * @param userId - The account.
 * @param report - The validated report.
 * @param receivedAt - When the server received it, epoch ms.
 */
export async function recordConsentReceipts(userId: string, report: ConsentReport, receivedAt: number): Promise<void> {
  const skew = report.sentAt === undefined ? 0 : receivedAt - Date.parse(report.sentAt);
  for (const d of report.decisions) {
    const decidedAt = new Date(Math.min(Date.parse(d.decidedAt) + skew, receivedAt)).toISOString();
    // An override seen under the GPC notice counts as a plain consent (§4.4.6), so only `account` is kept.
    const notice = d.noticeShown === "account" ? "account" : null;
    await db.execute(sql`
      INSERT INTO analytics_consent_events
        (decision_id, user_id, category, value, source, notice_shown, gpc_at_decision, decided_at, revision)
      SELECT ${d.decisionId}, ${userId}, ${d.category}, ${d.value}, ${d.source}, ${notice},
             ${d.gpcAtDecision}, ${decidedAt}, ${report.revision}
      WHERE EXISTS (SELECT 1 FROM users WHERE id = ${userId} AND deleted_at IS NULL)
      ON CONFLICT (decision_id) DO NOTHING`);
  }
}

/**
 * Record an ads refusal an operator made on the person's behalf (`request`).
 * @param userId - The account.
 * @param decisionId - A fresh id for the receipt.
 * @param revision - The policy revision in force.
 * @returns Whether it was recorded; false for a missing or deleted account.
 */
export async function recordOptOutRequest(userId: string, decisionId: string, revision: number): Promise<boolean> {
  const rows = await db.execute(sql`
    INSERT INTO analytics_consent_events (decision_id, user_id, category, value, source, decided_at, revision)
    SELECT ${decisionId}, ${userId}, 'ads', false, 'request', now(), ${revision}
    WHERE EXISTS (SELECT 1 FROM users WHERE id = ${userId} AND deleted_at IS NULL)
    RETURNING decision_id`);
  return rows.length > 0;
}

/**
 * The account's ads receipts still in force and its GPC signal.
 * @param userId - The account.
 * @param now - The current time, epoch ms.
 * @returns The history, or null when the account is missing or deleted; callers treat null as not allowed.
 */
export async function getAccountAdsEvents(userId: string, now: number): Promise<AccountAdsHistory | null> {
  const account = await db
    .select({ gpcSeenAt: users.analyticsGpcSeenAt })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);
  if (account.length === 0) return null;
  const rows = await db
    .select()
    .from(analyticsConsentEvents)
    .where(and(eq(analyticsConsentEvents.userId, userId), eq(analyticsConsentEvents.category, "ads")));
  const receipts = rows
    .map(
      (r): AccountAdsReceipt => ({
        decisionId: r.decisionId,
        value: r.value,
        source: r.source as AdsSource,
        noticeShown: r.noticeShown === "account" ? "account" : false,
        decidedAt: r.decidedAt.toISOString(),
        revision: r.revision,
      }),
    )
    .filter((r) => choiceInForce(r, now));
  return { receipts, gpcSeenAt: account[0]!.gpcSeenAt?.toISOString() ?? null };
}

/**
 * The account's analytics value, for events no browser is behind.
 * @param userId - The account.
 * @param now - The current time, epoch ms.
 * @returns The value, or null when none is in force or the account is missing or deleted.
 */
export async function getAccountAnalytics(userId: string, now: number): Promise<boolean | null> {
  const rows = await db
    .select({ value: analyticsConsentEvents.value, decidedAt: analyticsConsentEvents.decidedAt, revision: analyticsConsentEvents.revision })
    .from(analyticsConsentEvents)
    .innerJoin(users, eq(users.id, analyticsConsentEvents.userId))
    .where(
      and(eq(analyticsConsentEvents.userId, userId), eq(analyticsConsentEvents.category, "analytics"), isNull(users.deletedAt)),
    );
  return accountAnalyticsValue(
    rows.map((r) => ({ ...r, decidedAt: r.decidedAt.toISOString() })),
    now,
  );
}

/**
 * The account's consent for an event no browser is behind (a renewal, a
 * collaboration conversion): analytics from its receipts, ads from its events alone.
 * @param userId - The account.
 * @param now - The current time, epoch ms.
 * @returns The snapshot; nothing for a missing or deleted account.
 */
export async function accountOnlyConsent(userId: string, now: number): Promise<ConsentSnapshot> {
  const history = await getAccountAdsEvents(userId, now);
  if (history === null) return NO_CONSENT;
  const ads = adsAllowed(history, null, "none", now).allowed;
  return { analytics: (await getAccountAnalytics(userId, now)) ?? false, ads };
}

/**
 * Whether ads may run for an event credited to the account (inner#1442 design
 * §4.4.6): the account's events plus the browser behind it, if any.
 * @param userId - The account.
 * @param browser - The browser behind the event as it stood then; null for an event with none.
 * @param now - The current time, epoch ms.
 * @returns Whether ads may run; never for a missing or deleted account.
 */
export async function adsAllowedFor(userId: string, browser: BrowserAdsSnapshot | null, now: number): Promise<boolean> {
  const history = await getAccountAdsEvents(userId, now);
  if (history === null) return false;
  const ownership = browser === null ? "none" : await adsOwnership(userId, browser.choice?.decisionId);
  return adsAllowed(history, browser, ownership, now).allowed;
}

/**
 * Whose receipt a browser's decision is.
 * @param userId - The signed-in account.
 * @param decisionId - The decision id in the browser's cookie, if any.
 * @returns `self`, `other`, or `none` when no account recorded it.
 */
export async function adsOwnership(userId: string, decisionId: string | undefined): Promise<Ownership> {
  if (decisionId === undefined) return "none";
  const rows = await db
    .select({ userId: analyticsConsentEvents.userId })
    .from(analyticsConsentEvents)
    .where(eq(analyticsConsentEvents.decisionId, decisionId))
    .limit(1);
  if (rows.length === 0) return "none";
  return rows[0]!.userId === userId ? "self" : "other";
}

/**
 * Record that a signed-in request carried GPC. Written when nothing is on
 * record, when the last write is over an hour old, or when it predates the
 * account's latest ads consent, so a consent given after it is opted out again.
 * @param userId - The account.
 */
export async function recordGpcSignal(userId: string): Promise<void> {
  await db.execute(sql`
    UPDATE users SET analytics_gpc_seen_at = now()
    WHERE id = ${userId} AND deleted_at IS NULL
      AND (analytics_gpc_seen_at IS NULL
        OR analytics_gpc_seen_at < now() - ${GPC_REFRESH}::interval
        OR analytics_gpc_seen_at < (SELECT max(decided_at) FROM analytics_consent_events
                                    WHERE user_id = ${userId} AND category = 'ads' AND value))`);
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
 * Delete the receipts that no longer count: analytics receipts of either value
 * and ads consents past 395 days or from an older policy revision. Ads
 * refusals stay until the account is deleted.
 * @param now - The current time, epoch ms.
 * @returns How many receipts were deleted.
 */
export async function pruneConsentReceipts(now: number): Promise<number> {
  const cutoff = new Date(now - CONSENT_MAX_AGE_DAYS * DAY_MS).toISOString();
  const rows = await rawPg`
    DELETE FROM analytics_consent_events
    WHERE (category = 'analytics' OR value)
      AND (decided_at < ${cutoff} OR revision < ${CONSENT_REVISION})
    RETURNING decision_id`;
  return rows.length;
}

/**
 * Remove what deleted accounts' consent left behind: their receipts, their GPC
 * signal, and the consent snapshots on their orders, upload tickets and ad
 * uploads. Only accounts already soft-deleted are touched; when any id is not,
 * nothing changes.
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
    await tx`DELETE FROM analytics_consent_events WHERE user_id = ANY(${ids}::uuid[])`;
    await tx`UPDATE users SET analytics_gpc_seen_at = NULL WHERE id = ANY(${ids}::uuid[])`;
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
