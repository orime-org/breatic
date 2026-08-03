// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The five things in this product that wait for a person to answer, and the
 * one shape all of them are answered through.
 *
 * Each lives in its own table with its own status vocabulary, but from the
 * decider's side they are the same interaction: a link arrives, it opens a page
 * that says what is being asked, and there are two buttons. This module is that
 * shared side — the landing page renders off these types, and the server fills
 * them in from whichever table the token resolved to.
 */

/** Which of the five flows a request belongs to. */
export type DecisionKind =
  | "studio_invite"
  | "project_invite"
  | "role_upgrade"
  | "project_transfer"
  | "studio_transfer";

/**
 * What the landing page found behind a token.
 *
 * The five tables spell their terminal statuses three different ways
 * (accepted/approved, declined/rejected, revoked/cancelled), so the server
 * collapses them here: the page renders a state, not a status column.
 *
 * There is no `invalid` member, and that is the point. A token nobody issued
 * resolves to nothing at all, which the endpoint answers with a 404 — it never
 * becomes a state, because there is no request to have one. Every state here
 * belongs to a request that genuinely exists, including `gone`: that one was
 * soft-deleted with its project, and telling its holder "invalid link" would
 * be wrong twice over.
 */
export type DecisionState =
  | "answerable"
  | "accepted"
  | "declined"
  | "expired"
  | "revoked"
  | "already_member"
  | "gone";

/**
 * Everything the landing page needs, for any of the five kinds.
 *
 * Carries no ids and no slugs: this is what an unanswered request looks like to
 * someone who has not decided yet, and the URL it was reached through is meant
 * to reveal nothing about which studio or project is involved. `destination`
 * is the one exception, and it is filled only for somebody who is already a
 * member of what it names.
 */
export interface DecisionView {
  kind: DecisionKind;
  state: DecisionState;
  /** What is being decided about — a studio name or a project name. */
  entityName: string;
  /** Who set this in motion. */
  actorName: string;
  /** The role at stake; null for transfers, which always mean ownership. */
  role: string | null;
  /** The requester's own words, role upgrades only. */
  message: string | null;
  /** Only used for the countdown on an answerable request. */
  expiresAt: string | null;
  /** Whether the signed-in viewer is the person being asked. */
  isRecipient: boolean;
  /** How long the answering window is, in days, as currently configured. */
  windowDays: number;
  /**
   * Where to go instead of answering, for the one dead end that has somewhere
   * to send you: the recipient is already in, so the invitation has nothing
   * left to offer but the thing itself is right there.
   *
   * Null everywhere else, and null for anyone who is not the recipient — this
   * is the only field that names an entity, and only somebody who demonstrably
   * already has access to it ever receives it.
   */
  destination: string | null;
}

/** Which way the recipient answered. */
export type DecisionAction = "confirm" | "decline";

/**
 * What the server says after an answer lands.
 *
 * `redirectTo` is a ready-built path rather than ids for the client to
 * assemble, and it is null for a decline: declining keeps you on the page that
 * tells you what you just did.
 */
export interface DecisionResult {
  state: DecisionState;
  redirectTo: string | null;
}
