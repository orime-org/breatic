// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as MockModule0 from "@breatic/domain";

import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import postgres from "postgres";

vi.mock("@breatic/domain", async (importOriginal) => ({
  ...await importOriginal<typeof MockModule0>(),
  enqueueMail: vi.fn().mockResolvedValue(undefined),
}));
import { initCore, loadLocales } from "@breatic/core";
import {
  createInvitation,
  expireInvitation,
  invitationRows,
  revokeInvitation,
  seedEmailInvitation,
  seedInvitationFixture,
  type Scope,
  type Sql,
} from "./email-invitation.fixture.js";

let sql: Sql;

beforeAll(() => {
  initCore({ ...process.env, EMAIL_BACKEND: "disabled" });
  loadLocales();
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false });
});

afterAll(async () => {
  await sql.end({ timeout: 1 });
});

for (const scope of ["project", "studio"] satisfies Scope[]) {
  describe(`${scope} email invitation database invariants`, () => {
    it.each(["both", "neither"] as const)("rejects a row with %s recipient identities", async (identities) => {
      const fixture = await seedInvitationFixture(sql);
      const table = scope === "project" ? "project_invitations" : "studio_invitations";
      const column = scope === "project" ? "project_id" : "studio_id";
      const id = scope === "project" ? fixture.projectId : fixture.studioId;
      await expect(sql`
        INSERT INTO ${sql(table)} (${sql(column)}, invited_user_id, invited_email, invited_by, role, status, expires_at, share_token)
        VALUES (${id}, ${identities === "both" ? fixture.adminId : null}, ${identities === "both" ? fixture.email : null},
                ${fixture.adminId}, ${scope === "project" ? "viewer" : "guest"}, 'pending', now() + interval '1 day',
                ${crypto.randomUUID().replaceAll("-", "").padEnd(64, "c")})
      `).rejects.toMatchObject({ code: "23514" });
    });

    it("preserves the existing registered-user recipient shape", async () => {
      const fixture = await seedInvitationFixture(sql);
      const table = scope === "project" ? "project_invitations" : "studio_invitations";
      const column = scope === "project" ? "project_id" : "studio_id";
      const id = scope === "project" ? fixture.projectId : fixture.studioId;
      await sql`
        INSERT INTO ${sql(table)} (${sql(column)}, invited_user_id, invited_by, role, status, expires_at, share_token)
        VALUES (${id}, ${fixture.adminId}, ${fixture.adminId}, ${scope === "project" ? "viewer" : "guest"},
                'pending', now() + interval '1 day', ${crypto.randomUUID().replaceAll("-", "").padEnd(64, "d")})
      `;
      expect((await invitationRows(sql, scope, fixture))[0]).toMatchObject({ invited_user_id: fixture.adminId, invited_email: null });
    });

    it("rejects two pending email rows on one object even after their deadline passes", async () => {
      const fixture = await seedInvitationFixture(sql);
      const invitation = await seedEmailInvitation(sql, scope, fixture);
      await expireInvitation(sql, scope, invitation.id);
      await expect(seedEmailInvitation(sql, scope, fixture)).rejects.toMatchObject({ code: "23505" });
      expect(await invitationRows(sql, scope, fixture)).toHaveLength(1);
    });

    it("frees the email uniqueness slot after revocation", async () => {
      const fixture = await seedInvitationFixture(sql);
      const invitation = await seedEmailInvitation(sql, scope, fixture);
      await revokeInvitation(scope, fixture, invitation.id);
      const fresh = await seedEmailInvitation(sql, scope, fixture);
      expect(fresh.id).not.toBe(invitation.id);
      expect(await invitationRows(sql, scope, fixture)).toHaveLength(2);
    });

    it("keeps identical email recipients independent across targets", async () => {
      const first = await seedInvitationFixture(sql);
      const second = await seedInvitationFixture(sql);
      second.email = first.email;
      await seedEmailInvitation(sql, scope, first);
      await seedEmailInvitation(sql, scope, second);
      expect(await invitationRows(sql, scope, first)).toHaveLength(1);
      expect(await invitationRows(sql, scope, second)).toHaveLength(1);
    });

    it("reaps an expired email row before creating an ordinary invitation", async () => {
      const fixture = await seedInvitationFixture(sql);
      const original = await seedEmailInvitation(sql, scope, fixture);
      await expireInvitation(sql, scope, original.id);
      const [user] = await sql<{ id: string }[]>`INSERT INTO users (email, email_verified) VALUES (${fixture.email}, true) RETURNING id`;
      const fresh = await createInvitation(scope, fixture);
      const rows = await invitationRows(sql, scope, fixture);
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.id === original.id)).toMatchObject({ status: "failed", failed_reason: "expired", invited_email: fixture.email });
      expect(rows.find((row) => row.id === fresh.invitationId)).toMatchObject({ status: "pending", invited_user_id: user!.id, invited_email: null });
    });
  });
}
