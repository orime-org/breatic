// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Account routes — what one account is on and what it has spent (task #90).
 *
 * Account-level, which is what "account" means here: the tier a person holds
 * and the two allowances counted across everything they control. Anything
 * scoped to one studio — how many projects it has room for, how many members
 * — belongs to that studio's own page and is not answered here.
 *
 * Translation layer only (prohibition #1): the answer is assembled in
 * `membership.service`, which is also where the tiers worth comparing and the
 * enterprise fork are decided.
 */

import { Hono } from "hono";
import { requireAuth } from "@server/middleware/auth.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { membershipService } from "@server/modules";

const account = new Hono<{ Variables: AuthVariables }>();

account.use(requireAuth);

/**
 * `GET /api/v1/account/membership` — everything the membership panel shows.
 *
 * The account is the caller's; nothing in the request names one.
 * @param c - Hono context with the authenticated user
 * @returns `200` with `{ data: AccountMembership }` — tier, that tier's
 *   ceilings (`null` for enterprise, which negotiates its own), the two
 *   account-level usage figures, the tiers offered for comparison with their
 *   prices, and what the account's subscription is doing
 */
account.get("/membership", rateLimitFor("membership-read", "user"), async (c) => {
  const user = c.get("user");
  const membership = await membershipService.readAccountMembership(user.id);
  return c.json({ data: membership });
});

export { account as accountRoute };
