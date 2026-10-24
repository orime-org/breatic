// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as CoreModule from "@breatic/core";

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import postgres from "postgres";

// Keep account creation, Redis verification, sessions and invitation persistence real.
vi.mock("@breatic/core", async (importOriginal) => ({
  ...await importOriginal<typeof CoreModule>(),
  sendMail: vi.fn().mockResolvedValue({ status: "sent" }),
}));

import { initCore, loadLocales, sendMail } from "@breatic/core";
import { getDecisionWindowMs } from "@server/config/limits.js";
import { getUserByToken, loginEmail, loginOrCreateGoogle } from "@server/modules/auth/auth.service.js";
import { startSignup, verifySignupCode } from "@server/modules/auth/signup-code.service.js";
import {
  invitationRows,
  membershipCount,
  seedEmailInvitation,
  seedInvitationFixture,
  type InvitationFixture,
  type InvitationRow,
  type Scope,
  type Sql,
} from "./email-invitation.fixture.js";

/** An original mailbox invitation whose identity must survive authentication. */
interface PendingInvitation {
  scope: Scope;
  fixture: InvitationFixture;
  original: InvitationRow;
}

let sql: Sql;

beforeAll(() => {
  initCore({ ...process.env, EMAIL_BACKEND: "console" });
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false });
});

beforeEach(() => {
  vi.mocked(sendMail).mockClear();
});

afterAll(async () => {
  await sql.end({ timeout: 1 });
});

/**
 * Seed both invitation kinds for one mailbox, with no account yet required.
 * @returns The two original invitations addressed to the same mailbox.
 * @throws {Error} When fixture persistence fails.
 */
async function pendingPair(): Promise<PendingInvitation[]> {
  const fixture = await seedInvitationFixture(sql);
  const pending: PendingInvitation[] = [];
  for (const scope of ["project", "studio"] satisfies Scope[]) {
    pending.push({ scope, fixture, original: await seedEmailInvitation(sql, scope, fixture) });
  }
  return pending;
}

/**
 * Assert that authentication without mailbox proof leaves both invitations intact.
 * @param pending - The invitations before authentication.
 * @returns Once mailbox rows and their empty notification sets are checked.
 * @throws {Error} When a database query or invariant assertion fails.
 */
async function expectUnclaimed(pending: PendingInvitation[]): Promise<void> {
  for (const { scope, fixture, original } of pending) {
    expect(await invitationRows(sql, scope, fixture)).toEqual([original]);
    const notifications = await sql<{ id: string }[]>`
      SELECT id FROM notifications WHERE payload->>'invitationId' = ${original.id}
    `;
    expect(notifications).toEqual([]);
  }
}

/**
 * Assert committed conversion through authentication, before any membership decision.
 * @param pending - The invitations before authentication.
 * @param userId - The authenticated account receiving both notifications.
 * @param before - The time immediately before the authentication call.
 * @param after - The time immediately after the authentication call.
 * @returns Once identity, delivery, renewed deadlines and membership are checked.
 * @throws {Error} When a database query or invariant assertion fails.
 */
async function expectClaimed(
  pending: PendingInvitation[],
  userId: string,
  before: number,
  after: number,
): Promise<void> {
  for (const { scope, fixture, original } of pending) {
    const rows = await invitationRows(sql, scope, fixture);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      id: original.id,
      share_token: original.share_token,
      invited_user_id: userId,
      invited_email: null,
      status: "pending",
      failed_reason: null,
    });
    expect(row.claimed_at?.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(row.claimed_at?.getTime()).toBeLessThanOrEqual(after + 1_000);
    expect(row.expires_at.getTime()).toBeGreaterThan(original.expires_at.getTime());
    expect(row.expires_at.getTime()).toBeGreaterThanOrEqual(before + getDecisionWindowMs() - 1_000);
    expect(row.expires_at.getTime()).toBeLessThanOrEqual(after + getDecisionWindowMs() + 1_000);
    const notifications = await sql<{
      id: string;
      user_id: string;
      type: string;
      payload: { invitationId: string; shareToken: string };
      expires_at: Date;
    }[]>`
      SELECT id, user_id, type, payload, expires_at FROM notifications
      WHERE payload->>'invitationId' = ${original.id}
    `;
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      id: row.notification_id,
      user_id: userId,
      type: `${scope}.invite_request`,
      payload: { invitationId: original.id, shareToken: original.share_token },
      expires_at: row.expires_at,
    });
    expect(await membershipCount(sql, scope, fixture, userId)).toBe(0);
  }
}

/**
 * Read the actual generated code at the outbound mail transport boundary.
 * @param email - The signup mailbox whose message was captured.
 * @returns The six digits delivered by the real signup mail renderer.
 * @throws {Error} When no signup code was delivered to this mailbox.
 */
function deliveredCode(email: string): string {
  const mails = vi.mocked(sendMail).mock.calls.filter(([mail]) => mail.to === email);
  expect(mails).toHaveLength(1);
  const match = /\b(\d{6})\b/.exec(mails[0]![0].text ?? "");
  if (!match) throw new Error("The signup mail did not contain a six-digit code");
  return match[1]!;
}

describe("real authentication claims Project and Studio mailbox invitations", () => {
  it("converts both original invitations only after the emailed signup code verifies", async () => {
    const pending = await pendingPair();
    const email = pending[0]!.fixture.email;
    const started = await startSignup({ ticket: null, email, password: "signup-invite-password", locale: "en" });
    const accountsBefore = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email}`;
    expect(accountsBefore).toEqual([]);
    await expectUnclaimed(pending);

    const before = Date.now();
    const user = await verifySignupCode(started.ticket, deliveredCode(email));
    const after = Date.now();
    expect(user).toMatchObject({ email, emailVerified: true });
    const stored = await sql<{ id: string; email_verified: boolean }[]>`
      SELECT id, email_verified FROM users WHERE email = ${email} AND deleted_at IS NULL
    `;
    expect(stored).toEqual([{ id: user.id, email_verified: true }]);
    await expectClaimed(pending, user.id, before, after);
  });

  it("converts both original invitations when an authoritative Google identity creates an account and session", async () => {
    const pending = await pendingPair();
    const email = pending[0]!.fixture.email;
    const googleId = crypto.randomUUID();
    const before = Date.now();
    const result = await loginOrCreateGoogle(googleId, email, true);
    const after = Date.now();

    expect(result.created).toBe(true);
    expect(result.user).toMatchObject({ email, googleId, emailVerified: true });
    expect(await getUserByToken(result.token)).toMatchObject({ id: result.user.id, email, emailVerified: true });
    await expectClaimed(pending, result.user.id, before, after);
  });

  it("preserves both mailbox invitations for non-authoritative Google login and converts them when that identity later verifies", async () => {
    const pending = await pendingPair();
    const email = pending[0]!.fixture.email;
    const googleId = crypto.randomUUID();
    const unverified = await loginOrCreateGoogle(googleId, email, false);

    expect(unverified.created).toBe(true);
    expect(unverified.user).toMatchObject({ email, googleId, emailVerified: false });
    expect(await getUserByToken(unverified.token)).toMatchObject({ id: unverified.user.id, emailVerified: false });
    await expectUnclaimed(pending);
    for (const { scope, fixture } of pending) {
      expect(await membershipCount(sql, scope, fixture, unverified.user.id)).toBe(0);
    }

    const before = Date.now();
    const verified = await loginOrCreateGoogle(googleId, email, true);
    const after = Date.now();
    expect(verified.created).toBe(false);
    expect(verified.user).toMatchObject({ id: unverified.user.id, email, googleId, emailVerified: true });
    expect(await getUserByToken(verified.token)).toMatchObject({ id: unverified.user.id, emailVerified: true });
    await expectClaimed(pending, verified.user.id, before, after);
  });

  it("claims invitations awaiting an already verified account when its real email password login opens a session", async () => {
    const fixture = await seedInvitationFixture(sql);
    const password = "verified-invite-password";
    const started = await startSignup({ ticket: null, email: fixture.email, password, locale: "en" });
    const user = await verifySignupCode(started.ticket, deliveredCode(fixture.email));
    expect(user.emailVerified).toBe(true);

    const pending: PendingInvitation[] = [];
    for (const scope of ["project", "studio"] satisfies Scope[]) {
      pending.push({ scope, fixture, original: await seedEmailInvitation(sql, scope, fixture) });
    }
    await expectUnclaimed(pending);
    const before = Date.now();
    const result = await loginEmail(fixture.email, password);
    const after = Date.now();

    expect(result.user).toMatchObject({ id: user.id, email: fixture.email, emailVerified: true });
    expect(await getUserByToken(result.token)).toMatchObject({ id: user.id, emailVerified: true });
    await expectClaimed(pending, user.id, before, after);
  });
});
