// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import postgres from "postgres";

import { initCore, loadLocales } from "@breatic/core";
import * as users from "@server/modules/auth/user.repo.js";
import * as projects from "@server/modules/project/project.service.js";
import * as projectInvites from "@server/modules/project-invite/projectInvite.service.js";
import * as projectJoins from "@server/modules/project-join-request/projectJoinRequest.service.js";
import * as roleUpgrades from "@server/modules/role-upgrade-request/roleUpgradeRequest.service.js";
import * as transfers from "@server/modules/project/projectTransfer.service.js";
import { claimInvitation } from "@server/modules/invitation/invitation-lifecycle.service.js";
import { waitUntilBlockedOn } from "@server/__tests__/integration/lock-probe.js";
import {
  holdTarget,
  invitationRows,
  membershipCount,
  seedEmailInvitation,
  seedInvitationFixture,
  type InvitationFixture,
  type Sql,
} from "@server/modules/invitation/__tests__/email-invitation.fixture.js";

type RequestTable = "role_upgrade_requests" | "project_join_requests" | "project_transfers" | "project_invitations";

interface RequestRef {
  table: RequestTable;
  id: string;
}

interface RequestState {
  status: string;
  failedReason: string | null;
  expiresAt: Date;
  notificationId: string | null;
}

let sql: Sql;

beforeAll(() => {
  initCore({ ...process.env, EMAIL_BACKEND: "disabled" });
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 8, prepare: false });
});

afterAll(async () => {
  await sql.end({ timeout: 1 });
});

/**
 * Read the one pending request filed in this fixture's table.
 * @param table - The request table.
 * @param projectId - The isolated target project.
 * @returns The pending request identity.
 * @throws {Error} When persistence or the fixture invariant fails.
 */
async function pendingRequest(table: RequestTable, projectId: string): Promise<RequestRef> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM ${sql(table)} WHERE project_id = ${projectId} AND status = 'pending'
  `;
  expect(rows).toHaveLength(1);
  return { table, id: rows[0]!.id };
}

/**
 * File the other request kinds swept by the same archive transaction.
 * @param fixture - The Project and its Studio administrator.
 * @returns One role-upgrade, join and ownership-transfer request.
 * @throws {Error} When fixture creation or a real service fails.
 */
async function seedRelatedRequests(fixture: InvitationFixture): Promise<RequestRef[]> {
  const member = await users.createUser({ locale: "en", email: `${crypto.randomUUID()}@example.test`, emailVerified: true });
  const guest = await users.createUser({ locale: "en", email: `${crypto.randomUUID()}@example.test`, emailVerified: true });
  await sql`
    INSERT INTO studio_members (studio_id, user_id, role)
    VALUES (${fixture.studioId}, ${member.id}, 'maintainer'), (${fixture.studioId}, ${guest.id}, 'guest')
  `;
  await sql`
    INSERT INTO project_members (project_id, user_id, role)
    VALUES (${fixture.projectId}, ${member.id}, 'viewer')
  `;
  await roleUpgrades.request({ requesterUserId: member.id, projectId: fixture.projectId, projectName: "Clock Project" });
  await transfers.requestProjectTransfer(fixture.projectId, fixture.adminId, member.id);
  await projectJoins.request({ projectId: fixture.projectId, requesterUserId: guest.id });
  return Promise.all([
    pendingRequest("role_upgrade_requests", fixture.projectId),
    pendingRequest("project_join_requests", fixture.projectId),
    pendingRequest("project_transfers", fixture.projectId),
  ]);
}

/**
 * Read a persisted request and the notification associated with it.
 * @param request - The table and immutable row id.
 * @returns The stored state and original deadline.
 * @throws {Error} When the row cannot be read.
 */
async function requestState(request: RequestRef): Promise<RequestState> {
  const rows = await sql<RequestState[]>`
    SELECT status, failed_reason AS "failedReason", expires_at AS "expiresAt", notification_id AS "notificationId"
    FROM ${sql(request.table)} WHERE id = ${request.id}
  `;
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/**
 * Set deadlines that remain live until a waiting transaction has started.
 * @param requests - The rows whose expiry the operation will classify.
 * @param crossesExpiry - Whether their deadlines should pass during the wait.
 * @returns The stored deadlines in matching row order.
 * @throws {Error} When persistence fails.
 */
async function setDeadlines(requests: RequestRef[], crossesExpiry: boolean): Promise<Date[]> {
  const interval = crossesExpiry ? "2 seconds" : "1 hour";
  const deadlines: Date[] = [];
  for (const request of requests) {
    const [row] = await sql<{ expiresAt: Date }[]>`
      UPDATE ${sql(request.table)} SET expires_at = clock_timestamp() + ${interval}::interval
      WHERE id = ${request.id} RETURNING expires_at AS "expiresAt"
    `;
    deadlines.push(row!.expiresAt);
  }
  return deadlines;
}

/**
 * Check expiry using the database's current execution clock.
 * @param requests - The rows classified by the waiting operation.
 * @param expired - The expected expiry state.
 * @returns Once every row has the expected expiry state.
 * @throws {Error} When a database query or expiry assertion fails.
 */
async function expectExpiry(requests: RequestRef[], expired: boolean): Promise<void> {
  for (const request of requests) {
    const rows = await sql<{ expired: boolean }[]>`
      SELECT expires_at <= clock_timestamp() AS expired FROM ${sql(request.table)} WHERE id = ${request.id}
    `;
    expect(rows).toEqual([{ expired }]);
  }
}

/**
 * Check that failing a request preserves its deadline and retires its bell.
 * @param request - The request whose closing operation committed.
 * @param deadline - Its deadline before the operation.
 * @param reason - The chronological reason it ended.
 * @returns Once state, deadline and notification invariants are checked.
 * @throws {Error} When persistence or an invariant assertion fails.
 */
async function expectFailed(request: RequestRef, deadline: Date, reason: "expired" | "invalidated"): Promise<void> {
  const state = await requestState(request);
  expect(state).toMatchObject({ status: "failed", failedReason: reason, expiresAt: deadline });
  if (state.notificationId !== null) {
    const notices = await sql<{ readAt: Date | null }[]>`
      SELECT read_at AS "readAt" FROM notifications WHERE id = ${state.notificationId}
    `;
    expect(notices).toEqual([{ readAt: expect.any(Date) }]);
  }
}

describe("request failure reasons use the execution clock after Project lock waits", () => {
  for (const recipient of ["mailbox", "ordinary", "converted"] as const) {
    for (const crossesExpiry of [true, false]) {
      it(`archives a ${recipient} invitation as ${crossesExpiry ? "expired after waiting across its deadline" : "invalidated before its deadline"}`, async () => {
        const fixture = await seedInvitationFixture(sql);
        let invitationId: string;
        let userId: string | null = null;
        if (recipient === "ordinary") {
          const user = await users.createUser({ locale: "en", email: fixture.email, emailVerified: true });
          userId = user.id;
          invitationId = (await projectInvites.createInvite(fixture.projectId, fixture.adminId, fixture.email, "viewer")).invitationId;
        } else {
          invitationId = (await seedEmailInvitation(sql, "project", fixture)).id;
          if (recipient === "converted") {
            const user = await users.createUser({ locale: "en", email: fixture.email, emailVerified: true });
            userId = user.id;
            await claimInvitation("project", invitationId, fixture.projectId, user.id);
          }
        }
        const original = (await invitationRows(sql, "project", fixture))[0]!;
        const requests: RequestRef[] = [{ table: "project_invitations", id: invitationId }];
        if (recipient === "mailbox") requests.push(...await seedRelatedRequests(fixture));
        const deadlines = await setDeadlines(requests, crossesExpiry);
        const held = await holdTarget(sql, "project", fixture);
        const archiving = projects.archive(fixture.projectId, fixture.adminId).then(
          () => ({ error: null }),
          (error: unknown) => ({ error }),
        );
        try {
          await waitUntilBlockedOn(sql, ["projects", "for update"]);
          await expectExpiry(requests, false);
          if (crossesExpiry) {
            await vi.waitFor(() => expectExpiry(requests, true), { timeout: 10_000, interval: 25 });
          }
        } finally {
          held.release();
          await held.done;
          await archiving;
        }
        expect((await archiving).error).toBeNull();
        for (const [index, request] of requests.entries()) {
          await expectFailed(request, deadlines[index]!, crossesExpiry ? "expired" : "invalidated");
        }
        const row = (await invitationRows(sql, "project", fixture))[0]!;
        expect(row).toMatchObject({
          id: original.id,
          share_token: original.share_token,
          invited_email: original.invited_email,
          invited_user_id: original.invited_user_id,
          notification_id: original.notification_id,
          claimed_at: original.claimed_at,
        });
        const [project] = await sql<{ archivedAt: Date | null }[]>`
          SELECT archived_at AS "archivedAt" FROM projects WHERE id = ${fixture.projectId}
        `;
        expect(project!.archivedAt).toBeInstanceOf(Date);
        if (userId !== null) expect(await membershipCount(sql, "project", fixture, userId)).toBe(0);
      });
    }
  }

  for (const crossesExpiry of [true, false]) {
    it(`settles a join request as ${crossesExpiry ? "expired after acceptance waits across its deadline" : "invalidated when acceptance precedes its deadline"}`, async () => {
      const fixture = await seedInvitationFixture(sql);
      const user = await users.createUser({ locale: "en", email: fixture.email, emailVerified: true });
      await sql`
        INSERT INTO studio_members (studio_id, user_id, role) VALUES (${fixture.studioId}, ${user.id}, 'guest')
      `;
      await projectJoins.request({ projectId: fixture.projectId, requesterUserId: user.id });
      const join = await pendingRequest("project_join_requests", fixture.projectId);
      const invitation = await projectInvites.createInvite(fixture.projectId, fixture.adminId, fixture.email, "viewer");
      const deadlines = await setDeadlines([join], crossesExpiry);
      const held = await holdTarget(sql, "project", fixture);
      const accepting = projectInvites.confirmInvite(invitation.invitationId, user.id).then(
        () => ({ error: null }),
        (error: unknown) => ({ error }),
      );
      try {
        await waitUntilBlockedOn(sql, ["projects", "for update"]);
        await expectExpiry([join], false);
        if (crossesExpiry) {
          await vi.waitFor(() => expectExpiry([join], true), { timeout: 10_000, interval: 25 });
        }
      } finally {
        held.release();
        await held.done;
        await accepting;
      }
      expect((await accepting).error).toBeNull();
      await expectFailed(join, deadlines[0]!, crossesExpiry ? "expired" : "invalidated");
      expect(await membershipCount(sql, "project", fixture, user.id)).toBe(1);
      expect(await invitationRows(sql, "project", fixture)).toMatchObject([{
        id: invitation.invitationId,
        status: "accepted",
        invited_user_id: user.id,
        failed_reason: null,
      }]);
    });
  }
});
