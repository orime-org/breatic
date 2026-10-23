// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as DomainModule from "@breatic/domain";

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import postgres from "postgres";

vi.mock("@breatic/domain", async (importOriginal) => ({
  ...await importOriginal<typeof DomainModule>(),
  enqueueMail: vi.fn().mockResolvedValue(undefined),
}));

import { ConflictError, db, initCore, loadLocales, NotFoundError } from "@breatic/core";
import { enqueueMail } from "@breatic/domain";
import { t } from "@breatic/shared";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";
import * as usersRepo from "@server/modules/auth/user.repo.js";
import { claimEmailInvitations } from "@server/modules/invitation/claim-email-invitations.js";
import * as projectRepo from "@server/modules/project/project.repo.js";
import * as projectJoins from "@server/modules/project-join-request/projectJoinRequest.service.js";
import {
  answerInvitation,
  createInvitation,
  gate,
  holdTarget,
  invitationRows,
  membershipCount,
  seedEmailInvitation,
  seedInvitationFixture,
  type InvitationFixture,
  type Scope,
  type Sql,
} from "./email-invitation.fixture.js";

let sql: Sql;

beforeAll(() => {
  initCore({ ...process.env, EMAIL_BACKEND: "console" });
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 8, prepare: false });
});

beforeEach(() => {
  vi.mocked(enqueueMail).mockReset().mockResolvedValue(undefined);
});

afterAll(async () => {
  await sql.end({ timeout: 1 });
});

/**
 * Give a pending invitation a near-future deadline before starting its waiter.
 * @param scope - The invitation kind.
 * @param id - The invitation whose deadline must pass behind the object lock.
 * @returns Once the deadline has committed.
 * @throws {Error} When persistence fails.
 */
async function setUpcomingExpiry(scope: Scope, id: string): Promise<void> {
  const table = scope === "project" ? "project_invitations" : "studio_invitations";
  await sql`UPDATE ${sql(table)} SET expires_at = clock_timestamp() + interval '2 seconds' WHERE id = ${id}`;
}

/**
 * Observe the database clock crossing a persisted deadline while still locked.
 * @param scope - The invitation kind.
 * @param id - The invitation observed by its blocked operation.
 * @returns Once an actual database read proves the invitation expired.
 * @throws {Error} When the deadline does not pass within the polling budget.
 */
async function waitUntilDatabaseExpiry(scope: Scope, id: string): Promise<void> {
  const table = scope === "project" ? "project_invitations" : "studio_invitations";
  const [before] = await sql<{ expired: boolean }[]>`
    SELECT expires_at <= clock_timestamp() AS expired FROM ${sql(table)} WHERE id = ${id}
  `;
  expect(before).toEqual({ expired: false });
  await vi.waitFor(async () => {
    const [after] = await sql<{ expired: boolean }[]>`
      SELECT expires_at <= clock_timestamp() AS expired FROM ${sql(table)} WHERE id = ${id}
    `;
    expect(after).toEqual({ expired: true });
  }, { timeout: 10_000, interval: 25 });
}

type DeliveryOutcome = { ok: true; value: { invitationId: string } } | { ok: false; error: unknown };

/**
 * Park the real Project create request at its mail queue boundary.
 * @param fixture - The invitation target and recipient.
 * @returns The request outcome and controls for its external enqueue attempt.
 * @throws {Error} When creation ends before attempting delivery.
 */
async function beginProjectDelivery(fixture: InvitationFixture): Promise<{
  completion: Promise<DeliveryOutcome>;
  succeed: () => void;
  fail: () => void;
}> {
  const entered = gate();
  const delivery = gate();
  vi.mocked(enqueueMail).mockImplementationOnce(async () => {
    entered.resolve();
    await delivery.promise;
  });
  const completion = createInvitation("project", fixture).then(
    (value): DeliveryOutcome => ({ ok: true, value }),
    (error: unknown): DeliveryOutcome => ({ ok: false, error }),
  );
  await Promise.race([
    entered.promise,
    completion.then((outcome) => {
      if (!outcome.ok) throw outcome.error;
      throw new Error("The invitation request completed before its delivery boundary");
    }),
  ]);
  return {
    completion,
    succeed: delivery.resolve,
    fail: () => delivery.reject(new Error("mail queue unavailable")),
  };
}

for (const scope of ["project", "studio"] satisfies Scope[]) {
  describe(`${scope} invitation deadlines after object-lock waits`, () => {
    it("does not convert a mailbox invitation whose deadline passed while waiting", async () => {
      const fixture = await seedInvitationFixture(sql);
      const original = await seedEmailInvitation(sql, scope, fixture);
      const user = await usersRepo.createUser({ locale: "en", email: fixture.email, emailVerified: true });
      await setUpcomingExpiry(scope, original.id);
      const held = await holdTarget(sql, scope, fixture);
      const claiming = claimEmailInvitations(user);
      try {
        await waitUntilBlockedOn(sql, [scope === "project" ? "projects" : "studios", "for update"]);
        await waitUntilDatabaseExpiry(scope, original.id);
      } finally {
        held.release();
        await held.done;
        await claiming;
      }
      expect(await invitationRows(sql, scope, fixture)).toMatchObject([{
        id: original.id,
        share_token: original.share_token,
        status: "pending",
        invited_email: fixture.email,
        invited_user_id: null,
        claimed_at: null,
        notification_id: null,
      }]);
      const notifications = await sql<{ id: string }[]>`
        SELECT id FROM notifications WHERE payload->>'invitationId' = ${original.id}
      `;
      expect(notifications).toEqual([]);
      expect(await membershipCount(sql, scope, fixture, user.id)).toBe(0);
      expect(enqueueMail).not.toHaveBeenCalled();
    });

    it("refuses acceptance when an ordinary invitation expires behind the object lock", async () => {
      const fixture = await seedInvitationFixture(sql);
      const user = await usersRepo.createUser({ locale: "en", email: fixture.email, emailVerified: true });
      await createInvitation(scope, fixture);
      const original = (await invitationRows(sql, scope, fixture))[0]!;
      await setUpcomingExpiry(scope, original.id);
      const held = await holdTarget(sql, scope, fixture);
      const accepting = answerInvitation(scope, original.id, user.id, true).then(
        () => ({ error: null }),
        (error: unknown) => ({ error }),
      );
      try {
        await waitUntilBlockedOn(sql, [scope === "project" ? "projects" : "studios", "for update"]);
        await waitUntilDatabaseExpiry(scope, original.id);
      } finally {
        held.release();
        await held.done;
        await accepting;
      }
      expect((await accepting).error).toBeInstanceOf(NotFoundError);
      expect(await invitationRows(sql, scope, fixture)).toMatchObject([{
        id: original.id,
        share_token: original.share_token,
        invited_user_id: user.id,
        invited_email: null,
        notification_id: original.notification_id,
        status: "pending",
        failed_reason: null,
      }]);
      expect(await membershipCount(sql, scope, fixture, user.id)).toBe(0);
      const notifications = await sql<{ id: string; read_at: Date | null }[]>`
        SELECT id, read_at FROM notifications WHERE payload->>'invitationId' = ${original.id}
      `;
      expect(notifications).toEqual([{ id: original.notification_id, read_at: null }]);
    });

    for (const registered of [false, true]) {
      it(`reclaims an expired ${registered ? "user" : "mailbox"} pending row after a create request waits`, async () => {
        const fixture = await seedInvitationFixture(sql);
        const user = registered
          ? await usersRepo.createUser({ locale: "en", email: fixture.email, emailVerified: true })
          : null;
        await createInvitation(scope, fixture);
        const original = (await invitationRows(sql, scope, fixture))[0]!;
        await setUpcomingExpiry(scope, original.id);
        const held = await holdTarget(sql, scope, fixture);
        const creating = createInvitation(scope, fixture).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        try {
          await waitUntilBlockedOn(sql, [scope === "project" ? "projects" : "studios", "for update"]);
          await waitUntilDatabaseExpiry(scope, original.id);
        } finally {
          held.release();
          await held.done;
          await creating;
        }
        const outcome = await creating;
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) throw outcome.error;
        expect(outcome.value.invitationId).not.toBe(original.id);
        expect(outcome.value).toMatchObject({ pendingSignup: !registered, inviteeUserId: user?.id ?? null });
        const rows = await invitationRows(sql, scope, fixture);
        expect(rows).toHaveLength(2);
        expect(rows.find((row) => row.id === original.id)).toMatchObject({
          id: original.id,
          share_token: original.share_token,
          invited_email: original.invited_email,
          invited_user_id: original.invited_user_id,
          status: "failed",
          failed_reason: "expired",
        });
        expect(rows.filter((row) => row.status === "pending")).toMatchObject([{
          id: outcome.value.invitationId,
          invited_email: registered ? null : fixture.email,
          invited_user_id: user?.id ?? null,
          status: "pending",
          failed_reason: null,
        }]);
        const [freshDeadline] = await sql<{ live: boolean }[]>`
          SELECT expires_at > clock_timestamp() AS live
          FROM ${sql(scope === "project" ? "project_invitations" : "studio_invitations")}
          WHERE id = ${outcome.value.invitationId}
        `;
        expect(freshDeadline).toEqual({ live: true });
      });
    }
  });
}

describe("Project delivery after a decided invitation is archived", () => {
  for (const accept of [true, false]) {
    for (const queueSucceeds of [false, true]) {
      it(`returns ordinary success after ${accept ? "acceptance" : "decline"}, archive and enqueue ${queueSucceeds ? "success" : "failure"}`, async () => {
        const fixture = await seedInvitationFixture(sql);
        const attempt = await beginProjectDelivery(fixture);
        try {
          const original = (await invitationRows(sql, "project", fixture))[0]!;
          const user = await usersRepo.createUser({ locale: "en", email: fixture.email, emailVerified: true });
          await claimEmailInvitations(user);
          const converted = (await invitationRows(sql, "project", fixture))[0]!;
          const committedNotifications = await sql<{ id: string; user_id: string }[]>`
            SELECT id, user_id FROM notifications WHERE payload->>'invitationId' = ${original.id}
          `;
          expect(committedNotifications).toEqual([{ id: converted.notification_id, user_id: user.id }]);
          await answerInvitation("project", original.id, user.id, accept);
          await db.transaction(async (tx) => { await projectRepo.archiveProject(fixture.projectId, fixture.adminId, tx); });
          const [project] = await sql<{ archived_at: Date | null }[]>`
            SELECT archived_at FROM projects WHERE id = ${fixture.projectId}
          `;
          expect(project!.archived_at).toBeInstanceOf(Date);
          if (queueSucceeds) attempt.succeed();
          else attempt.fail();
          const outcome = await attempt.completion;
          expect(outcome.ok).toBe(true);
          if (!outcome.ok) throw outcome.error;
          expect(outcome.value).toMatchObject({
            invitationId: original.id,
            inviteeUserId: user.id,
            pendingSignup: false,
          });
          expect(await invitationRows(sql, "project", fixture)).toMatchObject([{
            id: original.id,
            share_token: original.share_token,
            invited_user_id: user.id,
            invited_email: null,
            notification_id: converted.notification_id,
            status: accept ? "accepted" : "declined",
            failed_reason: null,
          }]);
          expect(await membershipCount(sql, "project", fixture, user.id)).toBe(accept ? 1 : 0);
          const notifications = await sql<{ id: string; user_id: string; read_at: Date | null }[]>`
            SELECT id, user_id, read_at FROM notifications WHERE payload->>'invitationId' = ${original.id}
          `;
          expect(notifications).toEqual([{
            id: converted.notification_id,
            user_id: user.id,
            read_at: expect.any(Date),
          }]);
        } finally {
          attempt.succeed();
          await attempt.completion;
        }
      });
    }
  }
});

it("reports already_member after a real approved join request leaves an older invitation pending", async () => {
  const fixture = await seedInvitationFixture(sql);
  const user = await usersRepo.createUser({ locale: "en", email: fixture.email, emailVerified: true });
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${fixture.studioId}, ${user.id}, 'guest')
  `;
  await createInvitation("project", fixture);
  const original = (await invitationRows(sql, "project", fixture))[0]!;
  await projectJoins.request({ projectId: fixture.projectId, requesterUserId: user.id });
  const requests = await sql<{ id: string; status: string }[]>`
    SELECT id, status FROM project_join_requests
    WHERE project_id = ${fixture.projectId} AND requester_user_id = ${user.id}
  `;
  expect(requests).toEqual([{ id: expect.any(String), status: "pending" }]);
  await projectJoins.approve({ requestId: requests[0]!.id, ownerUserId: fixture.adminId, role: "viewer" });
  expect(await membershipCount(sql, "project", fixture, user.id)).toBe(1);
  expect(await invitationRows(sql, "project", fixture)).toEqual([original]);
  const reinviting = createInvitation("project", fixture);
  await expect(reinviting).rejects.toBeInstanceOf(ConflictError);
  await expect(reinviting).rejects.toMatchObject({ message: t("server.project.already_member") });
  expect(await membershipCount(sql, "project", fixture, user.id)).toBe(1);
  expect(await invitationRows(sql, "project", fixture)).toEqual([original]);
  const [request] = await sql<{ status: string; granted_role: string }[]>`
    SELECT status, granted_role FROM project_join_requests WHERE id = ${requests[0]!.id}
  `;
  expect(request).toEqual({ status: "approved", granted_role: "viewer" });
});
