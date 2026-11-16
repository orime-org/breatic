// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The OAuth authorization server's routes (#1488 §5.2, §5.3).
 *
 * `oauthServerRoute`, mounted at the root: `/oauth/*` and
 * `/.well-known/oauth-authorization-server` go to oidc-provider, which runs
 * on Node's own request and response and writes the answer itself.
 *
 * `oauthInteractionsRoute`, at `/api/v1/oauth/interactions`: what the
 * consent page `/connect/:uid` reads and sends. Session cookie only; the
 * browser also carries the authorization server's interaction cookie, which
 * ties the request to the browser that started it.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Hono, type Context } from "hono";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { z } from "zod";
import { logger } from "@breatic/core";
import { t } from "@breatic/shared";
import { requireAuth, type AuthVariables } from "@server/middleware/auth.js";
import { validate } from "@server/middleware/validate.js";
import {
  abortInteraction,
  confirmInteraction,
  handleOAuthRequest,
  interactionView,
} from "@server/modules/agent-access/oauth-provider.js";

/**
 * Node's request and response under this request.
 * @param c - The request context, served by `@hono/node-server`.
 * @returns Them.
 */
function nodeOf(c: Context): { req: IncomingMessage; res: ServerResponse } {
  const { incoming, outgoing } = c.env as { incoming: IncomingMessage; outgoing: ServerResponse };
  return { req: incoming, res: outgoing };
}

/**
 * Hand the request to oidc-provider.
 * @param c - The request context.
 * @returns The marker telling `@hono/node-server` the response is already written.
 * @throws {Error} When the authorization server fails outright.
 */
async function handOver(c: Context): Promise<Response> {
  const { req, res } = nodeOf(c);
  await handleOAuthRequest(req, res);
  return RESPONSE_ALREADY_SENT;
}

const oauthServer = new Hono();
oauthServer.all("/oauth/*", handOver);
oauthServer.get("/.well-known/oauth-authorization-server", handOver);

/**
 * The 404 for an interaction that is not this browser's or no longer exists.
 * @param c - The request context.
 * @returns The response, marked `request_expired` for the consent page.
 */
function expired(c: Context): Response {
  return c.json({ error: { code: 404, message: t("server.agent_access.oauth_request_expired"), reason: "request_expired" } }, 404);
}

const uidParam = z.object({ uid: z.string().min(1).max(128) });

const interactions = new Hono<{ Variables: AuthVariables }>();
interactions.use("*", requireAuth);

/**
 * `GET /oauth/interactions/:uid` — who is asking and where the answer goes.
 * @returns `{ data: { clientName, redirectHosts, localhostOnly } }`; 404 `request_expired` when gone.
 */
interactions.get("/:uid", validate("param", uidParam), async (c) => {
  const { req, res } = nodeOf(c);
  const view = await interactionView(req, res, c.req.valid("param").uid);
  return view ? c.json({ data: view }) : expired(c);
});

/**
 * `POST /oauth/interactions/:uid/confirm` — the user allows the agent.
 * @returns `{ data: { redirectTo } }`; 404 `request_expired` when gone.
 */
interactions.post("/:uid/confirm", validate("param", uidParam), async (c) => {
  const user = c.get("user");
  const { req, res } = nodeOf(c);
  const confirmed = await confirmInteraction(req, res, c.req.valid("param").uid, user.id);
  if (!confirmed) return expired(c);
  logger.info({ userId: user.id, clientId: confirmed.clientId, connectionId: confirmed.connectionId }, "mcp_client_authorized");
  return c.json({ data: { redirectTo: confirmed.redirectTo } });
});

/**
 * `POST /oauth/interactions/:uid/abort` — the user refuses; the agent gets `access_denied`.
 * @returns `{ data: { redirectTo } }`; 404 `request_expired` when gone.
 */
interactions.post("/:uid/abort", validate("param", uidParam), async (c) => {
  const { req, res } = nodeOf(c);
  const redirectTo = await abortInteraction(req, res, c.req.valid("param").uid);
  return redirectTo === null ? expired(c) : c.json({ data: { redirectTo } });
});

export { oauthServer as oauthServerRoute, interactions as oauthInteractionsRoute };
