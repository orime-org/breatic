// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as MockModule0 from "@breatic/domain";

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import postgres from "postgres";

vi.mock("@breatic/domain", async (importOriginal) => ({
  ...await importOriginal<typeof MockModule0>(),
  enqueueMail: vi.fn().mockResolvedValue(undefined),
}));

import { ConflictError, db, initCore, loadLocales } from "@breatic/core";
import { enqueueMail } from "@breatic/domain";
import * as usersRepo from "@server/modules/auth/user.repo.js";
import * as projectRepo from "@server/modules/project/project.repo.js";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";
import { claimEmailInvitations } from "@server/modules/invitation/claim-email-invitations.js";
import {
  createInvitation,
  gate,
  holdTarget,
  invitationRows,
  membershipCount,
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
  sql = postgres(inject("DATABASE_URL"), { max: 8, prepare: false });
});

beforeEach(() => {
  vi.mocked(enqueueMail).mockReset().mockResolvedValue(undefined);
});

afterAll(async () => {
  await sql.end({ timeout: 1 });
});

for (const scope of ["project", "studio"] satisfies Scope[]) {
  describe(`${scope} invitation object-lock serialization`, () => {
    for (const registered of [false, true]) {
      it(`takes the object lock when creating an ${registered ? "ordinary" : "email"} invitation`, async () => {
        const fixture = await seedInvitationFixture(sql);
        if (registered) await usersRepo.createUser({ locale: "en", email: fixture.email, emailVerified: true });
        const held = await holdTarget(sql, scope, fixture);
        const attempt = createInvitation(scope, fixture).then(
          (value) => ({ value, error: null }),
          (error: unknown) => ({ value: null, error }),
        );
        try {
          await waitUntilBlockedOn(sql, [scope === "project" ? "projects" : "studios", "for update"]);
        } finally {
          held.release();
          await held.done;
          await attempt;
        }
        const result = await attempt;
        expect(result.error).toBeNull();
        expect(await invitationRows(sql, scope, fixture)).toHaveLength(1);
      });
    }

    it("takes the object lock before converting an email invitation", async () => {
      const fixture = await seedInvitationFixture(sql);
      const invitation = await seedEmailInvitation(sql, scope, fixture);
      const user = await usersRepo.createUser({ locale: "en", email: fixture.email, emailVerified: true });
      const held = await holdTarget(sql, scope, fixture);
      const conversion = claimEmailInvitations(user);
      try {
        await waitUntilBlockedOn(sql, [scope === "project" ? "projects" : "studios", "for update"]);
        expect((await invitationRows(sql, scope, fixture))[0]).toMatchObject({ id: invitation.id, invited_user_id: null, notification_id: null });
      } finally {
        held.release();
        await held.done;
        await conversion;
      }
      expect((await invitationRows(sql, scope, fixture))[0]).toMatchObject({ id: invitation.id, invited_user_id: user.id, invited_email: null });
    });

    for (const conversionFirst of [false, true]) {
      it(`${conversionFirst ? "converts then revokes" : "revokes then attempts conversion"} behind one object lock`, async () => {
        const fixture = await seedInvitationFixture(sql);
        const invitation = await seedEmailInvitation(sql, scope, fixture);
        const user = await usersRepo.createUser({ locale: "en", email: fixture.email, emailVerified: true });
        const held = await holdTarget(sql, scope, fixture);
        const first = conversionFirst
          ? claimEmailInvitations(user)
          : revokeInvitation(scope, fixture, invitation.id);
        const operations: Promise<void>[] = [first];
        try {
          await waitUntilBlockedOn(sql, [scope === "project" ? "projects" : "studios", "for update"], 1);
          operations.push(conversionFirst
            ? revokeInvitation(scope, fixture, invitation.id)
            : claimEmailInvitations(user));
          await waitUntilBlockedOn(sql, [scope === "project" ? "projects" : "studios", "for update"], 2);
        } finally {
          held.release();
          await held.done;
          await Promise.all(operations);
        }
        const row = (await invitationRows(sql, scope, fixture))[0]!;
        expect(row.status).toBe("revoked");
        expect(row.invited_user_id).toBe(conversionFirst ? user.id : null);
        expect(await membershipCount(sql, scope, fixture, user.id)).toBe(0);
        const notifications = await sql<{ id: string; read_at: Date | null }[]>`
          SELECT id, read_at FROM notifications WHERE payload->>'invitationId' = ${invitation.id}
        `;
        expect(notifications).toHaveLength(conversionFirst ? 1 : 0);
        if (conversionFirst) {
          expect(notifications[0]!.id).toBe(row.notification_id);
          expect(notifications[0]!.read_at).toBeInstanceOf(Date);
        }
      });
    }

    it("re-reads the account under the lock across registration and two competing creators", async () => {
      const fixture = await seedInvitationFixture(sql);
      const held = await holdTarget(sql, scope, fixture);
      const first = createInvitation(scope, fixture).then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      );
      let second: typeof first | undefined;
      let userId = "";
      try {
        await waitUntilBlockedOn(sql, [scope === "project" ? "projects" : "studios", "for update"], 1);
        const user = await usersRepo.createUser({ locale: "en", email: fixture.email, emailVerified: true });
        userId = user.id;
        second = createInvitation(scope, fixture).then(
          (value) => ({ value, error: null }),
          (error: unknown) => ({ value: null, error }),
        );
        await waitUntilBlockedOn(sql, [scope === "project" ? "projects" : "studios", "for update"], 2);
      } finally {
        held.release();
        await held.done;
        await first;
        if (second) await second;
      }
      const results = await Promise.all([first, second]);
      expect(results.filter((result) => result.error === null)).toHaveLength(1);
      expect(results.filter((result) => result.error instanceof ConflictError)).toHaveLength(1);
      const rows = await invitationRows(sql, scope, fixture);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "pending", invited_email: null, invited_user_id: userId });
      const [count] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM notifications WHERE payload->>'invitationId' = ${rows[0]!.id}`;
      expect(count!.count).toBe(1);
      const signupAttempts = vi.mocked(enqueueMail).mock.calls.filter(([job]) => job.mail.html.includes("/register?invite="));
      expect(signupAttempts).toHaveLength(0);
    });

    it("takes the object lock before compensating a failed email enqueue", async () => {
      const fixture = await seedInvitationFixture(sql);
      const entered = gate();
      const delivery = gate();
      vi.mocked(enqueueMail).mockImplementationOnce(async () => {
        entered.resolve();
        await delivery.promise;
      });
      const completion = createInvitation(scope, fixture).then(
        () => ({ error: null }),
        (error: unknown) => ({ error }),
      );
      await Promise.race([
        entered.promise,
        completion.then(({ error }) => { throw error ?? new Error("No email enqueue was attempted"); }),
      ]);
      const held = await holdTarget(sql, scope, fixture);
      try {
        delivery.reject(new Error("mail queue unavailable"));
        await waitUntilBlockedOn(sql, [scope === "project" ? "projects" : "studios", "for update"]);
        expect((await invitationRows(sql, scope, fixture))[0]!.status).toBe("pending");
      } finally {
        held.release();
        await held.done;
        await completion;
      }
      expect((await completion).error).toBeInstanceOf(Error);
      expect((await invitationRows(sql, scope, fixture))[0]!.status).toBe("revoked");
    });
  });
}

for (const conversionFirst of [false, true]) {
  it(`${conversionFirst ? "converts before archiving" : "archives before converting"} a project under its object lock`, async () => {
    const fixture = await seedInvitationFixture(sql);
    const invitation = await seedEmailInvitation(sql, "project", fixture);
    const user = await usersRepo.createUser({ locale: "en", email: fixture.email, emailVerified: true });
    const held = await holdTarget(sql, "project", fixture);
    /**
     * Commit the existing project archive operation.
     * @throws {Error} When the archive transaction fails.
     */
    const archive = async (): Promise<void> => {
      await db.transaction(async (tx) => { await projectRepo.archiveProject(fixture.projectId, fixture.adminId, tx); });
    };
    const first = conversionFirst ? claimEmailInvitations(user) : archive();
    const operations: Promise<void>[] = [first];
    try {
      await waitUntilBlockedOn(sql, ["projects", "for update"], 1);
      operations.push(conversionFirst ? archive() : claimEmailInvitations(user));
      await waitUntilBlockedOn(sql, ["projects", "for update"], 2);
    } finally {
      held.release();
      await held.done;
      await Promise.all(operations);
    }
    const row = (await invitationRows(sql, "project", fixture))[0]!;
    expect(row).toMatchObject({ id: invitation.id, status: "failed", failed_reason: "invalidated" });
    expect(row.invited_user_id).toBe(conversionFirst ? user.id : null);
    expect(await membershipCount(sql, "project", fixture, user.id)).toBe(0);
    const notifications = await sql<{ read_at: Date | null }[]>`SELECT read_at FROM notifications WHERE payload->>'invitationId' = ${invitation.id}`;
    expect(notifications).toHaveLength(conversionFirst ? 1 : 0);
    if (conversionFirst) expect(notifications[0]!.read_at).toBeInstanceOf(Date);
  });
}
