// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as MockModule0 from "@breatic/domain";

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import postgres from "postgres";

vi.mock("@breatic/domain", async (importOriginal) => ({
  ...await importOriginal<typeof MockModule0>(),
  enqueueMail: vi.fn().mockResolvedValue(undefined),
}));

import { enqueueMail } from "@breatic/domain";
import { ConflictError, initCore, loadLocales, NotFoundError } from "@breatic/core";
import * as projectInvites from "@server/modules/project-invite/projectInvite.service.js";
import * as studioInvitesRepo from "@server/modules/studio/studioInvitations.repo.js";
import {
  createInvitation,
  invitationRows,
  seedInvitationFixture,
  type Scope,
  type Sql,
} from "./email-invitation.fixture.js";

let sql: Sql;

beforeAll(() => {
  initCore({ ...process.env, EMAIL_BACKEND: "console" });
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false });
});

beforeEach(() => {
  initCore({ ...process.env, EMAIL_BACKEND: "console" });
  vi.mocked(enqueueMail).mockReset().mockResolvedValue(undefined);
});

afterAll(async () => {
  await sql.end({ timeout: 1 });
});

for (const scope of ["project", "studio"] satisfies Scope[]) {
  describe(`${scope} unregistered email invitation creation`, () => {
    it("creates a normalized email invitation and queues its registration link", async () => {
      const fixture = await seedInvitationFixture(sql);
      const result = await createInvitation(scope, fixture, `  ${fixture.email.toUpperCase()}  `);
      expect(result).toMatchObject({ pendingSignup: true, inviteeUserId: null, inviteeEmail: fixture.email });
      const rows = await invitationRows(sql, scope, fixture);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: result.invitationId,
        invited_email: fixture.email,
        invited_user_id: null,
        notification_id: null,
        claimed_at: null,
        status: "pending",
      });
      expect(rows[0]!.share_token).toMatch(/^[a-f0-9]{64}$/);
      expect(vi.mocked(enqueueMail)).toHaveBeenCalledTimes(1);
      const job = vi.mocked(enqueueMail).mock.calls[0]![0];
      expect(job.mail.to).toBe(fixture.email);
      expect(job.mail.html).toContain(`/register?invite=${rows[0]!.share_token}`);
      const [notificationCount] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM notifications
        WHERE payload->>'invitationId' = ${result.invitationId}
      `;
      expect(notificationCount!.count).toBe(0);
    });

    it("lists the email recipient before an account exists", async () => {
      const fixture = await seedInvitationFixture(sql);
      const created = await createInvitation(scope, fixture);
      const listed = scope === "project"
        ? await projectInvites.listPending(fixture.projectId)
        : await studioInvitesRepo.listPendingByStudio(fixture.studioId);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ invitationId: created.invitationId, email: fixture.email, awaitingSignup: true });
    });

    it("rejects a duplicate pending recipient without queuing another email", async () => {
      const fixture = await seedInvitationFixture(sql);
      await createInvitation(scope, fixture);
      await expect(createInvitation(scope, fixture)).rejects.toBeInstanceOf(ConflictError);
      expect(await invitationRows(sql, scope, fixture)).toHaveLength(1);
      expect(vi.mocked(enqueueMail)).toHaveBeenCalledTimes(1);
    });

    it("refuses an unregistered address while mail is disabled", async () => {
      const fixture = await seedInvitationFixture(sql);
      initCore({ ...process.env, EMAIL_BACKEND: "disabled" });
      await expect(createInvitation(scope, fixture)).rejects.toBeInstanceOf(NotFoundError);
      const table = scope === "project" ? "project_invitations" : "studio_invitations";
      const targetColumn = scope === "project" ? "project_id" : "studio_id";
      const targetId = scope === "project" ? fixture.projectId : fixture.studioId;
      const [row] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM ${sql(table)} WHERE ${sql(targetColumn)} = ${targetId}
      `;
      expect(row!.count).toBe(0);
      expect(vi.mocked(enqueueMail)).toHaveBeenCalledTimes(0);
    });
  });
}
