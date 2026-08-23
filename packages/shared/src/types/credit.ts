// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * What the credit endpoints put on the wire.
 *
 * These live here rather than beside the code that builds them because the
 * browser has to agree with the server on every field, and a copy on each side
 * agrees only until one of them is edited: the reader kept its own copy of the
 * ledger row through two reshapes of the writer's, and typecheck stayed green
 * the whole time.
 *
 * Credits arrive as numbers. They are stored as `numeric(20, 6)` and every sum
 * runs in Postgres, so the conversion happens once, at the boundary where a
 * value stops being arithmetic and becomes something to show.
 */

/** One keyset page. */
export interface CreditPage<T> {
  items: T[];
  /** Feed back as `?cursor` for the next page; null at the end. */
  nextCursor: string | null;
}

/** One purchase of this account's, as the overlay shows it. */
export interface CreditLotView {
  id: string;
  purchasedCredits: number;
  remainingCredits: number;
  /** The studio allowed to spend it; null means unassigned, so unspendable. */
  designatedStudioId: string | null;
  /** That studio, named. Null when it points at none. */
  designatedStudioName: string | null;
  /** What was paid for it, in the smallest unit of `currency`. */
  paidCents: number;
  currency: string;
  lifecycle: string;
  /** How many refund requests were refused; the lifecycle keeps no trace. */
  refundAttempts: number;
  createdAt: string;
}

/**
 * One lot a studio holds, where the buyer is a column.
 *
 * Deliberately not the buyer's view of the same lot with a name added: what
 * the purchase cost is the buyer's business, and a studio's admins are not
 * the people who paid.
 */
export interface StudioLotView {
  id: string;
  purchasedCredits: number;
  remainingCredits: number;
  /** The studio allowed to spend it, which on this page is the studio itself. */
  designatedStudioId: string | null;
  lifecycle: string;
  /** How many refund requests were refused; the lifecycle keeps no trace. */
  refundAttempts: number;
  createdAt: string;
  /** Who bought it. Absent when their personal studio is gone. */
  buyerName: string | null;
}

/**
 * One line of this account's ledger: one generation, whatever it cost.
 *
 * A generation draws on as many purchases as it needs and writes a row for
 * each, all at the same instant, so the three figures below are that
 * generation's totals rather than one purchase's share of it.
 */
export interface CreditLedgerView {
  id: string;
  actorUserId: string | null;
  /** Who spent it, by display name. */
  actorName: string | null;
  studioId: string | null;
  /** Which studio it was spent in, by name. Survives that studio's deletion. */
  studioName: string | null;
  projectId: string | null;
  /** Where it was spent, by name. */
  projectName: string | null;
  model: string | null;
  provider: string | null;
  /** What left a purchase. */
  charged: number;
  /** What the run used, debt included. */
  consumed: number;
  /** How much of it went on the tab. */
  owed: number;
  createdAt: string;
}

/** One line of a studio's ledger: everything one event moved. */
export interface StudioLedgerView {
  id: string;
  /** A generation, or a designation paying off what the studio owed. */
  kind: "generation" | "debt_repayment";
  /** Who ran it, which in a team is often not who paid. */
  actorUserId: string | null;
  actorName: string | null;
  projectId: string | null;
  /** Where it ran, by name. */
  projectName: string | null;
  model: string | null;
  provider: string | null;
  /** What left the pool. This is the figure the amount column shows. */
  charged: number;
  /** What the run used. Equal to `charged` unless a lot could not cover it. */
  consumed: number;
  /** The part of that no lot covered. */
  owed: number;
  createdAt: string;
}

/** What one studio holds and has spent, for its credits tab. */
export interface StudioCreditsView {
  /**
   * What this studio can spend right now, below zero when it owes. Present on
   * the first page only — it does not change between pages.
   */
  spendable?: number;
  /** What it owes, as a positive number. First page only. */
  debt?: number;
  /** The lots it holds right now, newest first. First page only. */
  lots?: StudioLotView[];
  /** This studio's spending, one line per event, newest first. */
  ledger: CreditPage<StudioLedgerView>;
}

/** One studio's line on the account overview. */
export interface StudioCreditSummary {
  studioId: string;
  /**
   * What to call it. Empty when the studio was deleted and the row survives
   * only because money was spent on it.
   */
  studioName: string;
  studioSlug: string;
  /** Whether it is gone, which is why its balance reads as nothing. */
  deleted: boolean;
  /** What this studio can spend of this account's money. */
  spendable: number;
  /**
   * What it owes. Reported beside `spendable` rather than subtracted from it:
   * a debt belongs to the studio and is caused by everyone generating in it,
   * so taking it off a per-account figure makes two funders each lose all of
   * it.
   */
  debt: number;
  /** What it has already spent of it. */
  spent: number;
  /** How many of this account's lots point at it. */
  lotCount: number;
}

/** What an account holds, and where. */
export interface CreditOverview {
  /** Sitting in studios, ready to spend. */
  assignedCredits: number;
  /** Bought but pointed at no live studio, so unspendable until assigned. */
  unassignedCredits: number;
  /**
   * Whether this deployment charges for generation at all. Without it a fresh
   * account and a self-hosted install look identical on the wire: three zeros
   * and no studios.
   */
  billing: boolean;
  /** Every studio this account has money in or has spent money in. */
  studios: StudioCreditSummary[];
}
