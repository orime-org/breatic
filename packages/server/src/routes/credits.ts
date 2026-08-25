// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Credit routes (task #11) — the account's own view of its credits, and the
 * one write that decides whether they can be spent.
 *
 * Credits are bought per purchase and each purchase is assigned to one studio.
 * A purchase starts assigned to nothing, so until somebody points it at a
 * studio it buys nothing — which makes the designation endpoint below the
 * switch that turns money into capacity.
 *
 * The studio-facing view lives on `/studio/:slug/credits` next to that
 * studio's other tabs, so it sits behind the studio role gate rather than
 * repeating a membership check here.
 */

import { Hono } from "hono";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { validate } from "@server/middleware/validate.js";
import { creditLotService } from "@breatic/domain";
import { creditViewService } from "@server/modules";
import {
  creditLotQuerySchema,
  creditLedgerQuerySchema,
  designationSchema,
  lotParamSchema,
} from "@server/routes/schemas.js";

const credits = new Hono<{ Variables: AuthVariables }>();

credits.use(requireAuth);

/**
 * `GET /credits/overview` — what this account holds and where it went.
 *
 * Reports what is assigned and what is not as two separate numbers, because
 * they are not interchangeable: unassigned credits cannot be spent anywhere
 * until they are pointed at a studio.
 * @returns `200` with the overview.
 */
credits.get("/overview", async (c) => {
  const user = c.get("user");
  const data = await creditViewService.getOverview(user.id);
  return c.json({ data });
});

/**
 * `GET /credits/lots` — this account's purchases, newest first.
 * @returns `200` with one keyset page.
 */
credits.get("/lots", validate("query", creditLotQuerySchema), async (c) => {
  const user = c.get("user");
  const { limit, cursor, lifecycle } = c.req.valid("query");
  const data = await creditViewService.listLots(user.id, limit, cursor, lifecycle);
  return c.json({ data });
});

/**
 * `GET /credits/ledger` — every movement of this account's credits.
 *
 * Always taken by payer. Who spent them is a column on each row, so a team's
 * buyer sees what their money paid for and who ran it.
 * @returns `200` with one keyset page.
 */
credits.get("/ledger", validate("query", creditLedgerQuerySchema), async (c) => {
  const user = c.get("user");
  const { limit, cursor, studioId } = c.req.valid("query");
  const data = await creditViewService.listLedger(user.id, limit, cursor, studioId);
  return c.json({ data });
});

/**
 * `PATCH /credits/lots/:id/designation` — decide which studio may spend a
 * purchase, or take it back.
 *
 * `studioId: null` means unassigned and is a real instruction, so the field is
 * required: a body that simply omits it is a malformed request, not a request
 * to unassign.
 * @returns `200` with the purchase as it now stands; `403` when the caller
 *   does not administer the target studio, `404` when the purchase is not
 *   theirs, `409` when it is in the refund flow, `422` on a malformed body.
 */
credits.patch(
  "/lots/:id/designation",
  validate("param", lotParamSchema),
  validate("json", designationSchema),
  async (c) => {
    const user = c.get("user");
    const data = await creditLotService.designateLot({
      lotId: c.req.valid("param").id,
      requestingUserId: user.id,
      studioId: c.req.valid("json").studioId,
    });
    return c.json({ data });
  },
);

export default credits;
