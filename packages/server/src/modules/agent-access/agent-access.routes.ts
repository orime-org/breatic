// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * External-agent routes (#1488).
 *
 * `/api/v1/agent-access`: the settings page's "External agents" section
 * (§5.4) — the user's connections, personal access tokens, renaming and
 * disconnecting. Session cookie only, except `GET /connections/names`, which
 * the MCP service also calls with a downstream token (§5.6).
 *
 * `/api/v1/agent`: `POST /view-captures/:requestId`, where the owner's
 * browser uploads the capture a `view_user_screen` command asked for
 * (§19.1). Session cookie only.
 */

import { Hono } from "hono";
import { z } from "zod";
import { agentAccessService, logger } from "@breatic/core";
import { REQUEST_SHAPE_PARAMS } from "@breatic/shared";
import { requireAuth, type AuthVariables } from "@server/middleware/auth.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import { validate } from "@server/middleware/validate.js";
import * as service from "@server/modules/agent-access/agent-access.service.js";
import { credentialId } from "@server/modules/agent-access/agent-token-store.js";

/** A connection's or a token's name: trimmed, 1 to 64 characters. */
const nameSchema = z.string().trim().min(1).max(64);

const connectionParam = z.object({ id: z.string().uuid() });

const agentAccess = new Hono<{ Variables: AuthVariables }>();
agentAccess.use("*", requireAuth);

/**
 * `GET /agent-access/connections` — the signed-in user's own live connections.
 * @returns `{ data: AgentConnectionView[] }`, newest first.
 */
agentAccess.get("/connections", async (c) => {
  return c.json({ data: await agentAccessService.listConnections(c.get("user").id) });
});

/**
 * `GET /agent-access/connections/names?ids=` — names by connection id,
 * deleted connections included, so history can still say who acted.
 * @returns `{ data: Array<{ id, name }> }`; unknown ids are left out.
 */
agentAccess.get(
  "/connections/names",
  rateLimitFor("agent-connection-names", "user"),
  validate(
    "query",
    z.object({
      ids: z
        .string()
        .transform((raw) => [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0))])
        .pipe(z.array(z.string().uuid()).min(1).max(100)),
    }),
  ),
  async (c) => {
    return c.json({ data: await agentAccessService.connectionNames(c.req.valid("query").ids) });
  },
);

/**
 * `POST /agent-access/personal-access-tokens` — create a token; its plaintext
 * is in this answer and nowhere else, ever.
 * @returns `201` with `{ data: { token, connectionId } }`.
 * @throws {ConflictError} 409 at `pat.max_active_per_user` live tokens.
 */
agentAccess.post(
  "/personal-access-tokens",
  rateLimitFor("pat-create", "user"),
  validate(
    "json",
    z.object({
      name: nameSchema,
      expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365), z.null()]),
    }),
  ),
  async (c) => {
    const user = c.get("user");
    const { name, expiresInDays } = c.req.valid("json");
    const created = await service.createToken(user.id, name, expiresInDays);
    logger.info({ userId: user.id, connectionId: created.connectionId, expiresInDays }, "mcp_pat_created");
    return c.json({ data: created }, 201);
  },
);

/**
 * `PATCH /agent-access/connections/:id` — rename one of the user's connections.
 * @returns `{ data: { id, name } }`.
 * @throws {NotFoundError} 404 unless it is the user's own live connection.
 */
agentAccess.patch(
  "/connections/:id",
  rateLimitFor("agent-connection-rename", "user"),
  validate("param", connectionParam),
  validate("json", z.object({ name: nameSchema })),
  async (c) => {
    const { id } = c.req.valid("param");
    const { name } = c.req.valid("json");
    await service.rename(id, c.get("user").id, name);
    return c.json({ data: { id, name } });
  },
);

/**
 * `DELETE /agent-access/connections/:id` — disconnect, revoke or remove one
 * of the user's connections: every credential under it ends, with the
 * downstream tokens traded for them.
 * @returns `{ data: { id } }`.
 * @throws {NotFoundError} 404 unless it is the user's own live connection.
 */
agentAccess.delete("/connections/:id", validate("param", connectionParam), async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const outcome = await service.disconnect(id, user.id);
  const credentialIds = outcome.revoked.map(credentialId);
  logger.info({ userId: user.id, connectionId: id, credentialIds }, "mcp_credential_revoked");
  if (outcome.signalFailure !== undefined) {
    logger.error({ err: outcome.signalFailure, ctx: { userId: user.id, connectionId: id, credentialIds } }, "mcp_credential_revoked_signal_failed");
  }
  return c.json({ data: { id } });
});

/** Image types a capture arrives in: WebP, or JPEG and PNG where the browser cannot encode WebP. */
const CAPTURE_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/webp", "image/jpeg", "image/png"]);

const captureSchema = z
  .object({
    image: z.instanceof(File).refine((f) => CAPTURE_IMAGE_TYPES.has(f.type), { params: REQUEST_SHAPE_PARAMS }).optional(),
    note: z.string().min(1).max(2000).optional(),
    view: z.string().transform((raw, ctx) => {
      try {
        return { raw, value: JSON.parse(raw) as service.JsonValue };
      } catch {
        ctx.addIssue({ code: "custom", message: "view is not JSON", params: REQUEST_SHAPE_PARAMS });
        return z.NEVER;
      }
    }),
  })
  .refine((body) => (body.image === undefined) !== (body.note === undefined), {
    message: "a capture carries an image or a note",
    params: REQUEST_SHAPE_PARAMS,
  });

const agent = new Hono<{ Variables: AuthVariables }>();
agent.use("*", requireAuth);

/**
 * `POST /agent/view-captures/:requestId` — the owner's browser hands back the
 * capture a command asked for: multipart `image` (or `note` when no Space is
 * open) and `view`, the on-screen data as JSON.
 * @returns `{ data: { requestId } }`.
 * @throws {AppError} 410 when the request is unknown or expired; 413 over a size limit.
 * @throws {ForbiddenError} 403 to anyone but the owner it was sent to.
 * @throws {ConflictError} 409 when the command already has a reply.
 */
agent.post(
  "/view-captures/:requestId",
  validate("param", z.object({ requestId: z.string().uuid() })),
  validate("form", captureSchema),
  async (c) => {
    const { requestId } = c.req.valid("param");
    const { image, note, view } = c.req.valid("form");
    await service.submitViewCapture(requestId, c.get("user").id, { image, note, view });
    return c.json({ data: { requestId } });
  },
);

export { agentAccess as agentAccessRoute, agent as agentRoute };
