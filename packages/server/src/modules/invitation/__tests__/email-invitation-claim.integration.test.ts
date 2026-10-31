// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as MockModule0 from "@breatic/domain";

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import postgres from "postgres";
import fc from "fast-check";

vi.mock("@breatic/domain", async (importOriginal) => ({
  ...await importOriginal<typeof MockModule0>(),
  enqueueMail: vi.fn().mockResolvedValue(undefined),
}));

import { ConflictError, db, initCore, loadLocales, NotFoundError } from "@breatic/core";
import { enqueueMail } from "@breatic/domain";
import * as usersRepo from "@server/modules/auth/user.repo.js";
import * as projectRepo from "@server/modules/project/project.repo.js";
import { getDecisionWindowMs } from "@server/config/limits.js";
import { claimEmailInvitations } from "@server/modules/invitation/claim-email-invitations.js";
import {
  answerInvitation,
  createInvitation,
  expireInvitation,
  invitationRows,
  membershipCount,
  rejectNotificationWrites,
  revokeInvitation,
  seedEmailInvitation,
  seedInvitationFixture,
  type Scope,
  type Sql,
} from "./email-invitation.fixture.js";

let sql: Sql;

beforeAll(() => {
  initCore({ ...process.env, EMAIL_BACKEND: "console" });
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 6, prepare: false });
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(enqueueMail).mockReset().mockResolvedValue(undefined);
});

afterAll(async () => {
  await sql.end({ timeout: 1 });
});

for (const scope of ["project", "studio"] satisfies Scope[]) {
  describe(`${scope} verified email invitation claim`, () => {
    it("converts the original row and atomically attaches one notification before acceptance", async () => {
      const fixture = await seedInvitationFixture(sql);
      const invitation = await seedEmailInvitation(sql, scope, fixture);
      const user = await usersRepo.createUser({ locale: "en", email: fixture.email, emailVerified: true });
      const before = Date.now();
      await claimEmailInvitations(user);
      const rows = await invitationRows(sql, scope, fixture);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: invitation.id,
        share_token: invitation.share_token,
        invited_email: null,
        invited_user_id: user.id,
        status: "pending",
      });
      expect(rows[0]!.claimed_at!.getTime()).toBeGreaterThanOrEqual(before - 1_000);
      expect(rows[0]!.expires_at.getTime()).toBeGreaterThanOrEqual(before + getDecisionWindowMs() - 1_000);
      expect(rows[0]!.expires_at.getTime()).toBeLessThanOrEqual(Date.now() + getDecisionWindowMs() + 1_000);
      const notifications = await sql<{ id: string; user_id: string; payload: { invitationId: string; shareToken: string }; expires_at: Date }[]>`
        SELECT id, user_id, payload, expires_at FROM notifications
        WHERE payload->>'invitationId' = ${invitation.id}
      `;
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        id: rows[0]!.notification_id,
        user_id: user.id,
        payload: { invitationId: invitation.id, shareToken: invitation.share_token },
      });
      expect(notifications[0]!.expires_at.getTime()).toBe(rows[0]!.expires_at.getTime());
      expect(await membershipCount(sql, scope, fixture, user.id)).toBe(0);
      await answerInvitation(scope, invitation.id, user.id, true);
      expect(await membershipCount(sql, scope, fixture, user.id)).toBe(1);
      expect((await invitationRows(sql, scope, fixture))[0]!.status).toBe("accepted");
      await expect(createInvitation(scope, fixture)).rejects.toBeInstanceOf(ConflictError);
      expect(await invitationRows(sql, scope, fixture)).toHaveLength(1);
    });

    it("uses current stored verification instead of an untrusted supplied user snapshot", async () => {
      const fixture = await seedInvitationFixture(sql);
      const invitation = await seedEmailInvitation(sql, scope, fixture);
      const unverified = await usersRepo.createUser({ locale: "en", email: fixture.email, emailVerified: false });
      await claimEmailInvitations({ ...unverified, emailVerified: true });
      expect((await invitationRows(sql, scope, fixture))[0]).toMatchObject({
        id: invitation.id, invited_user_id: null, invited_email: fixture.email, notification_id: null,
      });
      expect(await membershipCount(sql, scope, fixture, unverified.id)).toBe(0);
    });

    it("keeps another mailbox's invitation separate", async () => {
      const fixture = await seedInvitationFixture(sql);
      const invitation = await seedEmailInvitation(sql, scope, fixture);
      const other = await usersRepo.createUser({ locale: "en", email: `other-${fixture.email}`, emailVerified: true });
      await claimEmailInvitations(other);
      expect((await invitationRows(sql, scope, fixture))[0]).toMatchObject({
        id: invitation.id, invited_user_id: null, invited_email: fixture.email, notification_id: null,
      });
    });

    it.each(["expired", "revoked", "deleted"] as const)("keeps an %s email invitation closed on registration", async (closed) => {
      const fixture = await seedInvitationFixture(sql);
      const invitation = await seedEmailInvitation(sql, scope, fixture);
      const table = scope === "project" ? "project_invitations" : "studio_invitations";
      if (closed === "expired") await expireInvitation(sql, scope, invitation.id);
      else if (closed === "revoked") await revokeInvitation(scope, fixture, invitation.id);
      else await sql`UPDATE ${sql(table)} SET deleted_at = now() WHERE id = ${invitation.id}`;
      const user = await usersRepo.createUser({ locale: "en", email: fixture.email, emailVerified: true });
      await claimEmailInvitations(user);
      expect((await invitationRows(sql, scope, fixture))[0]).toMatchObject({
        id: invitation.id, invited_user_id: null, invited_email: fixture.email, notification_id: null,
      });
      expect(await membershipCount(sql, scope, fixture, user.id)).toBe(0);
    });

    it("converts an existing email invitation before committing a duplicate rejection", async () => {
      const fixture = await seedInvitationFixture(sql);
      const invitation = await seedEmailInvitation(sql, scope, fixture);
      const user = await usersRepo.createUser({ locale: "en", email: fixture.email, emailVerified: true });
      await expect(createInvitation(scope, fixture)).rejects.toBeInstanceOf(ConflictError);
      const rows = await invitationRows(sql, scope, fixture);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: invitation.id, invited_user_id: user.id, invited_email: null });
      const notifications = await sql<{ id: string }[]>`SELECT id FROM notifications WHERE payload->>'invitationId' = ${invitation.id}`;
      expect(notifications).toEqual([{ id: rows[0]!.notification_id }]);
      expect(vi.mocked(enqueueMail)).toHaveBeenCalledTimes(0);
    });

    it("retains an email invitation when a duplicate request finds an unverified account", async () => {
      const fixture = await seedInvitationFixture(sql);
      const invitation = await seedEmailInvitation(sql, scope, fixture);
      await usersRepo.createUser({ locale: "en", email: fixture.email, emailVerified: false });
      await expect(createInvitation(scope, fixture)).rejects.toBeInstanceOf(ConflictError);
      expect((await invitationRows(sql, scope, fixture))[0]).toMatchObject({
        id: invitation.id, invited_user_id: null, invited_email: fixture.email, notification_id: null, status: "pending",
      });
      expect(vi.mocked(enqueueMail)).toHaveBeenCalledTimes(0);
    });

    it("rolls the conversion back with its notification and retries the same row", async () => {
      const fixture = await seedInvitationFixture(sql);
      const invitation = await seedEmailInvitation(sql, scope, fixture);
      const user = await usersRepo.createUser({ locale: "en", email: fixture.email, emailVerified: true });
      const restoreNotifications = await rejectNotificationWrites(sql);
      try {
        await expect(claimEmailInvitations(user)).resolves.toBeUndefined();
      } finally {
        await restoreNotifications();
      }
      expect((await invitationRows(sql, scope, fixture))[0]).toMatchObject({
        id: invitation.id, invited_user_id: null, invited_email: fixture.email, notification_id: null,
      });
      await claimEmailInvitations(user);
      expect((await invitationRows(sql, scope, fixture))[0]).toMatchObject({
        id: invitation.id, invited_user_id: user.id, invited_email: null,
      });
      const [count] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM notifications WHERE payload->>'invitationId' = ${invitation.id}`;
      expect(count!.count).toBe(1);
    });

    it("keeps repeated claims idempotent across generated mailbox casing", async () => {
      await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 5 }), fc.boolean(), async (repeats, upperCase) => {
        const fixture = await seedInvitationFixture(sql);
        const invitation = await seedEmailInvitation(sql, scope, fixture);
        const user = await usersRepo.createUser({ locale: "en", email: upperCase ? fixture.email.toUpperCase() : fixture.email, emailVerified: true });
        for (let n = 0; n < repeats; n++) await claimEmailInvitations(user);
        const rows = await invitationRows(sql, scope, fixture);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: invitation.id, invited_user_id: user.id, invited_email: null, share_token: invitation.share_token });
        const [notificationCount] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM notifications WHERE payload->>'invitationId' = ${invitation.id}`;
        expect(notificationCount!.count).toBe(1);
        expect(await membershipCount(sql, scope, fixture, user.id)).toBe(0);
      }), { numRuns: 8 });
    });
  });
}

it("converts both project and Studio invitations for one verified account", async () => {
  const fixture = await seedInvitationFixture(sql);
  const project = await seedEmailInvitation(sql, "project", fixture);
  const studio = await seedEmailInvitation(sql, "studio", fixture);
  const user = await usersRepo.createUser({ locale: "en", email: fixture.email, emailVerified: true });
  await claimEmailInvitations(user);
  expect((await invitationRows(sql, "project", fixture))[0]).toMatchObject({ id: project.id, invited_user_id: user.id, invited_email: null });
  expect((await invitationRows(sql, "studio", fixture))[0]).toMatchObject({ id: studio.id, invited_user_id: user.id, invited_email: null });
});

it("keeps an archived project's invitation closed", async () => {
  const fixture = await seedInvitationFixture(sql);
  const invitation = await seedEmailInvitation(sql, "project", fixture);
  await db.transaction(async (tx) => { await projectRepo.archiveProject(fixture.projectId, fixture.adminId, tx); });
  const user = await usersRepo.createUser({ locale: "en", email: fixture.email, emailVerified: true });
  await claimEmailInvitations(user);
  expect((await invitationRows(sql, "project", fixture))[0]).toMatchObject({
    id: invitation.id, status: "failed", failed_reason: "invalidated", invited_user_id: null, notification_id: null,
  });
});

it("preserves the earlier expiration reason when an email invitation is archived", async () => {
  const fixture = await seedInvitationFixture(sql);
  const invitation = await seedEmailInvitation(sql, "project", fixture);
  await expireInvitation(sql, "project", invitation.id);
  await db.transaction(async (tx) => { await projectRepo.archiveProject(fixture.projectId, fixture.adminId, tx); });
  expect((await invitationRows(sql, "project", fixture))[0]).toMatchObject({ status: "failed", failed_reason: "expired" });
});

it("does not let an arbitrary user accept an unclaimed email invitation", async () => {
  const fixture = await seedInvitationFixture(sql);
  const invitation = await seedEmailInvitation(sql, "project", fixture);
  const user = await usersRepo.createUser({ locale: "en", email: `stranger-${fixture.email}`, emailVerified: true });
  await expect(answerInvitation("project", invitation.id, user.id, true)).rejects.toBeInstanceOf(NotFoundError);
  expect(await membershipCount(sql, "project", fixture, user.id)).toBe(0);
});

for (const scope of ["project", "studio"] satisfies Scope[]) {
  it(`${scope} claim keeps the acceptance capacity gate in force`, async () => {
    const fixture = await seedInvitationFixture(sql);
    const invitation = await seedEmailInvitation(sql, scope, fixture);
    const user = await usersRepo.createUser({ locale: "en", email: fixture.email, emailVerified: true });
    await sql`UPDATE users SET membership_tier = 'base' WHERE id = ${fixture.adminId}`;
    if (scope === "project") {
      const { getLimitsForStudio } = await import("@breatic/core");
      const limits = await getLimitsForStudio(fixture.studioId);
      for (let n = 0; n < limits.project_members; n++) {
        const member = await usersRepo.createUser({ locale: "en", email: `capacity-${n}-${fixture.email}`, emailVerified: true });
        await sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${fixture.projectId}, ${member.id}, 'viewer')`;
      }
    }
    await claimEmailInvitations(user);
    expect((await invitationRows(sql, scope, fixture))[0]).toMatchObject({ id: invitation.id, invited_user_id: user.id, status: "pending" });
    await expect(answerInvitation(scope, invitation.id, user.id, true)).rejects.toBeInstanceOf(ConflictError);
    expect((await invitationRows(sql, scope, fixture))[0]!.status).toBe("pending");
    expect(await membershipCount(sql, scope, fixture, user.id)).toBe(0);
  });
}

for (const scope of ["project", "studio"] satisfies Scope[]) {
  it(`${scope} creation checks capacity before filing an email invitation`, async () => {
    const fixture = await seedInvitationFixture(sql);
    await sql`UPDATE users SET membership_tier = 'base' WHERE id = ${fixture.adminId}`;
    if (scope === "project") {
      const { getLimitsForStudio } = await import("@breatic/core");
      const limits = await getLimitsForStudio(fixture.studioId);
      for (let n = 0; n < limits.project_members; n++) {
        const member = await usersRepo.createUser({ locale: "en", email: `filled-${n}-${fixture.email}`, emailVerified: true });
        await sql`INSERT INTO project_members (project_id, user_id, role) VALUES (${fixture.projectId}, ${member.id}, 'viewer')`;
      }
    }
    await expect(createInvitation(scope, fixture)).rejects.toBeInstanceOf(ConflictError);
    expect(await invitationRows(sql, scope, fixture)).toEqual([]);
    expect(vi.mocked(enqueueMail)).toHaveBeenCalledTimes(0);
  });
}

for (const scope of ["project", "studio"] satisfies Scope[]) {
  it(`${scope} conversion requires the account's current mailbox to match`, async () => {
    const fixture = await seedInvitationFixture(sql);
    const invitation = await seedEmailInvitation(sql, scope, fixture);
    const other = await usersRepo.createUser({ locale: "en", email: `unrelated-${fixture.email}`, emailVerified: true });
    await claimEmailInvitations({ ...other, email: fixture.email });
    expect((await invitationRows(sql, scope, fixture))[0]).toMatchObject({
      id: invitation.id, invited_email: fixture.email, invited_user_id: null, notification_id: null,
    });
  });

  it(`${scope} conversion requires an active account`, async () => {
    const fixture = await seedInvitationFixture(sql);
    const invitation = await seedEmailInvitation(sql, scope, fixture);
    const user = await usersRepo.createUser({ locale: "en", email: fixture.email, emailVerified: true });
    await sql`UPDATE users SET deleted_at = now() WHERE id = ${user.id}`;
    await claimEmailInvitations(user);
    expect((await invitationRows(sql, scope, fixture))[0]).toMatchObject({
      id: invitation.id, invited_email: fixture.email, invited_user_id: null, notification_id: null,
    });
  });
}

it("continues processing another invitation after one notification transaction fails", async () => {
  const fixture = await seedInvitationFixture(sql);
  const project = await seedEmailInvitation(sql, "project", fixture);
  const studio = await seedEmailInvitation(sql, "studio", fixture);
  const user = await usersRepo.createUser({ locale: "en", email: fixture.email, emailVerified: true });
  const restoreNotifications = await rejectNotificationWrites(sql, true);
  try {
    await expect(claimEmailInvitations(user)).resolves.toBeUndefined();
  } finally {
    await restoreNotifications();
  }
  expect((await invitationRows(sql, "project", fixture))[0]).toMatchObject({
    id: project.id, invited_email: fixture.email, invited_user_id: null, notification_id: null,
  });
  expect((await invitationRows(sql, "studio", fixture))[0]).toMatchObject({
    id: studio.id, invited_email: null, invited_user_id: user.id,
  });
  const [notificationCount] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM notifications WHERE payload->>'invitationId' = ${studio.id}`;
  expect(notificationCount!.count).toBe(1);
});
