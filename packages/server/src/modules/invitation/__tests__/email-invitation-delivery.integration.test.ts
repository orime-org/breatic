// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as MockModule0 from "@breatic/domain";

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import postgres from "postgres";

vi.mock("@breatic/domain", async (importOriginal) => ({
  ...await importOriginal<typeof MockModule0>(),
  enqueueMail: vi.fn().mockResolvedValue(undefined),
}));

import { db, initCore, loadLocales, NotFoundError } from "@breatic/core";
import { enqueueMail } from "@breatic/domain";
import { t } from "@breatic/shared";
import * as usersRepo from "@server/modules/auth/user.repo.js";
import * as projectRepo from "@server/modules/project/project.repo.js";
import { claimEmailInvitations } from "@server/modules/invitation/claim-email-invitations.js";
import {
  answerInvitation,
  createInvitation,
  expireInvitation,
  gate,
  invitationRows,
  membershipCount,
  revokeInvitation,
  seedInvitationFixture,
  type InvitationFixture,
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
  vi.mocked(enqueueMail).mockReset().mockResolvedValue(undefined);
});

afterAll(async () => {
  await sql.end({ timeout: 1 });
});

type DeliveryOutcome = { ok: true; value: { invitationId: string } } | { ok: false; error: unknown };

/**
 * Park a real create request at its external email-queue boundary.
 * @param scope - The invitation kind.
 * @param fixture - The target and recipient.
 * @returns The request outcome and controls for its email enqueue attempt.
 * @throws {Error} When the create request ends before attempting delivery.
 */
async function beginDelivery(scope: Scope, fixture: InvitationFixture): Promise<{
  completion: Promise<DeliveryOutcome>;
  fail: () => void;
  succeed: () => void;
}> {
  const entered = gate();
  const delivery = gate();
  vi.mocked(enqueueMail).mockImplementationOnce(async () => {
    entered.resolve();
    await delivery.promise;
  });
  const completion = createInvitation(scope, fixture).then(
    (value): DeliveryOutcome => ({ ok: true, value }),
    (error: unknown): DeliveryOutcome => ({ ok: false, error }),
  );
  await Promise.race([
    entered.promise,
    completion.then((result) => {
      if (!result.ok) throw result.error;
      throw new Error("The invitation request completed before its delivery boundary");
    }),
  ]);
  return {
    completion,
    fail: () => delivery.reject(new Error("mail queue unavailable")),
    succeed: delivery.resolve,
  };
}

for (const scope of ["project", "studio"] satisfies Scope[]) {
  describe(`${scope} signup invitation delivery arbitration`, () => {
    it("revokes an email invitation when enqueue fails before a verified account exists", async () => {
      const fixture = await seedInvitationFixture(sql);
      const attempt = await beginDelivery(scope, fixture);
      attempt.fail();
      const outcome = await attempt.completion;
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("Expected email delivery to fail");
      expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error).message).toBe(t(`server.${scope}.invite_mail_failed`));
      const user = await usersRepo.createUser({ locale: "en", email: fixture.email, emailVerified: true });
      await claimEmailInvitations(user);
      expect(await invitationRows(sql, scope, fixture)).toMatchObject([{
        status: "revoked", invited_user_id: null, invited_email: fixture.email, notification_id: null,
      }]);
      expect(await membershipCount(sql, scope, fixture, user.id)).toBe(0);
    });

    for (const queueSucceeds of [false, true]) {
      it(`returns ordinary delivery after conversion when enqueue ${queueSucceeds ? "succeeds" : "fails"}`, async () => {
        const fixture = await seedInvitationFixture(sql);
        const attempt = await beginDelivery(scope, fixture);
        try {
          const user = await usersRepo.createUser({ locale: "en", email: fixture.email, emailVerified: true });
          await claimEmailInvitations(user);
          if (queueSucceeds) attempt.succeed();
          else attempt.fail();
          const outcome = await attempt.completion;
          expect(outcome.ok).toBe(true);
          if (!outcome.ok) throw outcome.error;
          expect(outcome.value).toMatchObject({ pendingSignup: false, inviteeUserId: user.id });
          const rows = await invitationRows(sql, scope, fixture);
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({ status: "pending", invited_user_id: user.id, invited_email: null });
          const [notification] = await sql<{ id: string; user_id: string }[]>`
            SELECT id, user_id FROM notifications WHERE id = ${rows[0]!.notification_id}
          `;
          expect(notification).toEqual({ id: rows[0]!.notification_id, user_id: user.id });
          expect(await membershipCount(sql, scope, fixture, user.id)).toBe(0);
        } finally {
          attempt.succeed();
          await attempt.completion;
        }
      });
    }

    for (const accept of [true, false]) {
      it(`preserves a completed ${accept ? "acceptance" : "decline"} when the earlier signup email fails`, async () => {
        const fixture = await seedInvitationFixture(sql);
        const attempt = await beginDelivery(scope, fixture);
        try {
          const user = await usersRepo.createUser({ locale: "en", email: fixture.email, emailVerified: true });
          await claimEmailInvitations(user);
          const invitation = (await invitationRows(sql, scope, fixture))[0]!;
          await answerInvitation(scope, invitation.id, user.id, accept);
          attempt.fail();
          const outcome = await attempt.completion;
          expect(outcome.ok).toBe(true);
          if (!outcome.ok) throw outcome.error;
          expect(outcome.value).toMatchObject({ pendingSignup: false });
          expect((await invitationRows(sql, scope, fixture))[0]).toMatchObject({
            id: invitation.id, status: accept ? "accepted" : "declined", invited_user_id: user.id,
            notification_id: invitation.notification_id,
          });
          expect(await membershipCount(sql, scope, fixture, user.id)).toBe(accept ? 1 : 0);
          const [notification] = await sql<{ read_at: Date | null }[]>`SELECT read_at FROM notifications WHERE id = ${invitation.notification_id}`;
          expect(notification!.read_at).toBeInstanceOf(Date);
        } finally {
          attempt.succeed();
          await attempt.completion;
        }
      });
    }

    for (const closed of ["revoked", "expired", "deleted"] as const) {
      for (const queueSucceeds of [false, true]) {
        it(`preserves a ${closed} invitation when enqueue ${queueSucceeds ? "succeeds" : "fails"}`, async () => {
          const fixture = await seedInvitationFixture(sql);
          const attempt = await beginDelivery(scope, fixture);
          try {
            const invitation = (await invitationRows(sql, scope, fixture))[0]!;
            const table = scope === "project" ? "project_invitations" : "studio_invitations";
            if (closed === "revoked") await revokeInvitation(scope, fixture, invitation.id);
            else if (closed === "expired") await expireInvitation(sql, scope, invitation.id);
            else await sql`UPDATE ${sql(table)} SET deleted_at = now() WHERE id = ${invitation.id}`;
            if (queueSucceeds) attempt.succeed();
            else attempt.fail();
            const outcome = await attempt.completion;
            expect(outcome.ok).toBe(false);
            if (outcome.ok) throw new Error("Expected a closed invitation to be unavailable");
            expect(outcome.error).toBeInstanceOf(NotFoundError);
            expect((await invitationRows(sql, scope, fixture))[0]).toMatchObject({
              id: invitation.id, status: closed === "revoked" ? "revoked" : "pending",
              invited_user_id: null, invited_email: fixture.email, notification_id: null,
            });
          } finally {
            attempt.succeed();
            await attempt.completion;
          }
        });
      }
    }

    it("isolates the old delivery failure from a new invitation for the same address", async () => {
      const fixture = await seedInvitationFixture(sql);
      const attempt = await beginDelivery(scope, fixture);
      try {
        const original = (await invitationRows(sql, scope, fixture))[0]!;
        await revokeInvitation(scope, fixture, original.id);
        const fresh = await createInvitation(scope, fixture);
        attempt.fail();
        const outcome = await attempt.completion;
        expect(outcome.ok).toBe(false);
        if (outcome.ok) throw new Error("Expected the original invitation to be closed");
        expect(outcome.error).toBeInstanceOf(NotFoundError);
        const rows = await invitationRows(sql, scope, fixture);
        expect(rows).toHaveLength(2);
        expect(rows.find((row) => row.id === original.id)).toMatchObject({ status: "revoked" });
        expect(rows.find((row) => row.id === fresh.invitationId)).toMatchObject({
          status: "pending", invited_email: fixture.email, invited_user_id: null,
        });
      } finally {
        attempt.succeed();
        await attempt.completion;
      }
    });
  });
}

it("keeps a project's invalidated invitation closed when its queued email fails", async () => {
  const fixture = await seedInvitationFixture(sql);
  const attempt = await beginDelivery("project", fixture);
  try {
    const original = (await invitationRows(sql, "project", fixture))[0]!;
    await db.transaction(async (tx) => { await projectRepo.archiveProject(fixture.projectId, fixture.adminId, tx); });
    attempt.fail();
    const outcome = await attempt.completion;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("Expected an archived invitation to be closed");
    expect(outcome.error).toBeInstanceOf(NotFoundError);
    expect((await invitationRows(sql, "project", fixture))[0]).toMatchObject({
      id: original.id, status: "failed", failed_reason: "invalidated", invited_user_id: null,
    });
  } finally {
    attempt.succeed();
    await attempt.completion;
  }
});
