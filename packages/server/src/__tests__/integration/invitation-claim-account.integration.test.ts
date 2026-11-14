// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Claiming an email invitation checks the account its caller read, under the
 * target's lock, and asks the global region for nothing while the lock is
 * held (inner#1955) — real PG.
 *
 * The pins:
 *
 *   1. An account whose verified address matches the invitation claims it.
 *   2. An account whose address does not match claims nothing.
 *   3. No account is read from the global region during the claim.
 */

import { describe, it, expect, beforeAll, afterAll, inject, vi } from "vitest";
import crypto from "node:crypto";
import postgres from "postgres";
import { initCore, loadLocales } from "@breatic/core";
import { globalApi } from "@breatic/domain";
import { claimInvitation } from "@server/modules/invitation/invitation-lifecycle.service.js";
import {
  invitationRows,
  seedEmailInvitation,
  seedInvitationFixture,
} from "@server/modules/invitation/__tests__/email-invitation.fixture.js";

loadLocales();

let sql: ReturnType<typeof postgres>;

beforeAll(() => {
  initCore(process.env);
  sql = postgres(inject("DATABASE_URL"), { max: 2, prepare: false, connection: { application_name: "invitation-claim-account-test" } });
});

afterAll(async () => {
  await sql?.end({ timeout: 1 });
});

/**
 * A verified account under an address.
 * @param email - The address.
 * @returns The account as a caller passes it.
 */
async function account(email: string): Promise<{ id: string; email: string; emailVerified: boolean }> {
  const [user] = await sql<{ id: string }[]>`INSERT INTO users (email, email_verified) VALUES (${email}, true) RETURNING id`;
  return { id: user!.id, email, emailVerified: true };
}

describe("claiming an email invitation", () => {
  it("claims it for the account whose verified address it names, reading no account during the claim", async () => {
    const fixture = await seedInvitationFixture(sql);
    const invitation = await seedEmailInvitation(sql, "project", fixture);
    const user = await account(fixture.email);
    const readAccounts = vi.spyOn(globalApi(), "getAccounts");

    await claimInvitation("project", invitation.id, fixture.projectId, user);

    const [row] = await invitationRows(sql, "project", fixture);
    expect(row).toMatchObject({ invited_user_id: user.id });
    expect(readAccounts).not.toHaveBeenCalled();
    readAccounts.mockRestore();
  });

  it("claims nothing for an account under another address", async () => {
    const fixture = await seedInvitationFixture(sql);
    const invitation = await seedEmailInvitation(sql, "project", fixture);
    const other = await account(`other-${crypto.randomUUID()}@example.test`);

    await claimInvitation("project", invitation.id, fixture.projectId, other);

    const [row] = await invitationRows(sql, "project", fixture);
    expect(row!.invited_user_id).toBeNull();
  });
});
