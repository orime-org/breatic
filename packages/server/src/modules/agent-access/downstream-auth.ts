// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Authenticating a request by its downstream token (#1488 §5.5).
 *
 * `requireAuth` hands a request with no session cookie here. A bearer token is
 * accepted only when it is a live downstream token and the request is for a
 * route in `DOWNSTREAM_TOKEN_ROUTES`; the request then runs as the token's
 * user, with the connection it came through beside it. An agent's own OAuth
 * or personal access token is not a downstream token and is refused.
 */

import type { Context, Next } from "hono";
import * as Sentry from "@sentry/node";
import { logger, type AgentCredential } from "@breatic/core";
import { t } from "@breatic/shared";
import { authService } from "@server/modules";
import { findDownstreamToken } from "@server/modules/agent-access/agent-token-store.js";
import { matchDownstreamRoute } from "@server/modules/agent-access/downstream-routes.js";
import { limitDownstreamTotal } from "@server/modules/agent-access/downstream-rate-limit.js";

/** The external agent a downstream request comes from. */
export interface DownstreamAgent {
  connectionId: string;
  credential: AgentCredential;
  clientName: string;
}

/** The scheme an `Authorization` header carries a downstream token in. */
const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * Answer an unauthenticated request.
 * @param c - The request context.
 * @param reason - Why, for the log.
 * @returns The 401.
 */
function refuse(c: Context, reason: string): Response {
  logger.warn({ reason, path: c.req.path }, "auth_rejected");
  return c.json({ error: { code: 401, message: t("server.auth.not_authenticated") } }, 401);
}

/**
 * Authenticate a request that carries no session cookie by its downstream
 * token, then count it (`limitDownstreamTotal`).
 * @param c - The request context; `user` and `agent` are set on it.
 * @param next - The rest of the chain.
 * @returns A 401 unless the token is live and the route whitelisted, a 429 when the user's total is spent; otherwise what the chain answers.
 * @throws {Error} When Redis or the database cannot be read.
 */
export async function authenticateDownstream(c: Context, next: Next): Promise<Response | void> {
  const token = BEARER.exec(c.req.header("Authorization") ?? "")?.[1];
  if (!token) return refuse(c, "no_token");
  const payload = await findDownstreamToken(token);
  if (!payload) return refuse(c, "downstream_token_invalid");
  if (!matchDownstreamRoute(c)) return refuse(c, "downstream_route_refused");
  const user = await authService.getUserById(payload.userId);
  if (!user) return refuse(c, "downstream_user_gone");
  c.set("user", { id: user.id, email: user.email, membershipTier: user.membershipTier, locale: user.locale });
  c.set("agent", { connectionId: payload.connectionId, credential: payload.credential, clientName: payload.clientName });
  Sentry.setUser({ id: user.id });
  return limitDownstreamTotal(c, next);
}
