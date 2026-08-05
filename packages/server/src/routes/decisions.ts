// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The one HTTP surface behind `/decision?token=`.
 *
 * Two endpoints serve all five waiting-for-an-answer flows: read what the token
 * points at, and answer it. Both require a signed-in caller — the token names a
 * request, it does not stand in for an identity, and who may answer is decided
 * by who you are, not by what you are holding.
 *
 * These handlers translate and nothing else. Which table the token belongs to,
 * whether the request is still open, and what a yes actually does all live in
 * the decision service.
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { NotFoundError } from "@breatic/core";
import { t } from "@breatic/shared";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import * as decisionService from "@server/modules/decision/decision.service.js";

const respondSchema = z.object({
  token: z.string().min(1),
  action: z.enum(["confirm", "decline"]),
});

const route = new Hono<{ Variables: AuthVariables }>();

route.use(requireAuth);

/**
 * `GET /api/v1/decisions/:token` — what this link points at.
 *
 * Reads only. A request that has been answered, has timed out, was withdrawn,
 * or went away with its project all resolve to a view that says so; only a
 * token no request answers to is a 404.
 */
route.get("/:token", async (c) => {
  const user = c.get("user");
  const view = await decisionService.viewByToken(c.req.param("token"), user.id);
  if (!view) throw new NotFoundError(t("server.error.not_found"));
  return c.json({ data: view });
});

/**
 * `POST /api/v1/decisions/respond` — answer it.
 *
 * The token travels in the body rather than the path: it is the one part of
 * this exchange worth keeping out of request logs and referrers, and a body is
 * where the two existing invite endpoints already put it.
 */
route.post("/respond", zValidator("json", respondSchema), async (c) => {
  const user = c.get("user");
  const { token, action } = c.req.valid("json");
  const result = await decisionService.respond(token, user.id, action);
  return c.json({ data: result });
});

export { route as decisionsRoute };
