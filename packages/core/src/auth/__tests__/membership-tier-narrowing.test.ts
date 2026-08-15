// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The read side of the pair of guards on `users.membership_tier` (task #105).
 *
 * The write side is a CHECK constraint, and it is the one that stops a typo
 * from ever reaching the column. This one stops a value that got there anyway
 * — a direct connection, a restored backup, a deployment whose migration did
 * not run — from being cast unchecked into a tier the build then prices.
 *
 * It is driven directly rather than through a stored row on purpose: with the
 * constraint in place there is no longer any way to put a bad value in the
 * table, which is precisely why the two cases that used to do that (in
 * `membership-tier-lookup.integration.test.ts`) now live here.
 *
 * What the message has to carry is the reason this is a unit test at all: the
 * value, and the row an operator must go and edit. For a studio the row they
 * must edit is a `users` row, not the studio — the studio id is the thing they
 * have in hand, not the thing that is wrong.
 */

import { describe, it, expect } from "vitest";

import { asKnownTier } from "../membership.repo.js";

const ACCOUNT = "11111111-1111-1111-1111-111111111111";
const STUDIO = "22222222-2222-2222-2222-222222222222";

describe("asKnownTier", () => {
  it("passes every tier this build knows straight through", () => {
    for (const tier of ["base", "pro", "team", "self_hosted", "enterprise"]) {
      expect(asKnownTier(tier, { accountId: ACCOUNT })).toBe(tier);
    }
  });

  it("names the account and the value it could not read", () => {
    const err = (() => {
      try {
        asKnownTier("Pro", { accountId: ACCOUNT });
        return null;
      } catch (e: unknown) {
        return e as Error;
      }
    })();
    expect(err, "expected a throw").not.toBeNull();
    expect(err!.message).toContain(ACCOUNT);
    expect(err!.message).toContain("Pro");
  });

  it("names the account as well as the studio when the value came in through one", () => {
    // The load-bearing half. A studio's ceilings are its current admin's, so
    // the bad value is on that admin's account row. Reporting only the studio
    // would send whoever reads the log to a table with nothing wrong in it.
    const err = (() => {
      try {
        asKnownTier("TEAM", { accountId: ACCOUNT, studioId: STUDIO });
        return null;
      } catch (e: unknown) {
        return e as Error;
      }
    })();
    expect(err, "expected a throw").not.toBeNull();
    expect(err!.message).toContain(ACCOUNT);
    expect(err!.message).toContain(STUDIO);
    expect(err!.message).toContain("TEAM");
  });
});
