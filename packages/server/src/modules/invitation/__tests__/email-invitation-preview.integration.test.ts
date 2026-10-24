// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import postgres from "postgres";
import { initCore, loadLocales, NotFoundError } from "@breatic/core";
import * as usersRepo from "@server/modules/auth/user.repo.js";
import { claimEmailInvitations } from "@server/modules/invitation/claim-email-invitations.js";
import { getInvitationPreview } from "@server/modules/invitation/invitation.service.js";
import {
  answerInvitation,
  expireInvitation,
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
  sql = postgres(inject("DATABASE_URL"), { max: 4, prepare: false });
});

afterAll(async () => {
  await sql.end({ timeout: 1 });
});

for (const scope of ["project", "studio"] satisfies Scope[]) {
  describe(`${scope} registration invitation preview`, () => {
    it("returns the address and invitation details only while the email invitation is open", async () => {
      const fixture = await seedInvitationFixture(sql);
      const invitation = await seedEmailInvitation(sql, scope, fixture);
      expect(await getInvitationPreview(invitation.share_token)).toEqual({
        state: "open",
        email: fixture.email,
        inviterName: "Inviting Admin",
        kind: scope,
        targetName: scope === "project" ? "Invitation Project" : "Invitation Studio",
        role: scope === "project" ? "viewer" : "guest",
      });
    });

    it.each(["expired", "revoked", "target-deleted"] as const)("returns closed for an %s email invitation", async (closed) => {
      const fixture = await seedInvitationFixture(sql);
      const invitation = await seedEmailInvitation(sql, scope, fixture);
      if (closed === "expired") await expireInvitation(sql, scope, invitation.id);
      else if (closed === "revoked") await revokeInvitation(scope, fixture, invitation.id);
      else {
        const table = scope === "project" ? "projects" : "studios";
        const id = scope === "project" ? fixture.projectId : fixture.studioId;
        await sql`UPDATE ${sql(table)} SET deleted_at = now() WHERE id = ${id}`;
      }
      expect(await getInvitationPreview(invitation.share_token)).toEqual({ state: "closed" });
    });

    it.each(["pending", "accepted", "declined", "revoked", "expired"] as const)("returns only claimed for a converted %s invitation", async (status) => {
      const fixture = await seedInvitationFixture(sql);
      const invitation = await seedEmailInvitation(sql, scope, fixture);
      const user = await usersRepo.createUser({ locale: "en", email: fixture.email, emailVerified: true });
      await claimEmailInvitations(user);
      if (status === "accepted") await answerInvitation(scope, invitation.id, user.id, true);
      else if (status === "declined") await answerInvitation(scope, invitation.id, user.id, false);
      else if (status === "revoked") await revokeInvitation(scope, fixture, invitation.id);
      else if (status === "expired") await expireInvitation(sql, scope, invitation.id);
      expect(await getInvitationPreview(invitation.share_token)).toEqual({ state: "claimed" });
    });
  });
}

it("answers missing tokens with NotFound", async () => {
  await expect(getInvitationPreview(crypto.randomUUID().replaceAll("-", "").padEnd(64, "b"))).rejects.toBeInstanceOf(NotFoundError);
});
