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
  accountAdsEvents,
  accountAnalyticsValue,
  adsDecision,
  choiceInForce,
  NO_CONSENT,
  type AccountAdsReceipt,
  type AdsSource,
  type Attribution,
  type ConsentReport,
  type ConsentSnapshot,
  type Ownership,
} from "@breatic/shared";
import { db } from "@core/db/client.js";
import { analyticsConsentEvents, users } from "@core/db/schema.js";

/** The account's ads receipts still in force and its GPC signal. */
export interface AccountAdsHistory {
  readonly receipts: AccountAdsReceipt[];
  readonly gpcSeenAt: string | null;
}

// Time between two GPC writes for the same account, so a browser sending GPC on every request writes once an hour.
const GPC_REFRESH = "1 hour";

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
  const ads = adsDecision(accountAdsEvents(history.receipts, history.gpcSeenAt, now)).allowed;
  return { analytics: (await getAccountAnalytics(userId, now)) ?? false, ads };
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
