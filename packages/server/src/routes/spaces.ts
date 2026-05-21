/**
 * Space CRUD routes (v10 §10.4 / §10.5).
 *
 * Mounted under `/api/v1/projects/:pid/spaces`.
 *
 * Architecture note — Spaces have NO PG table. The canonical Space
 * record lives in the project's Yjs `meta` doc (`spaces` Y.Map).
 * The server validates permission, generates the Space id, and
 * publishes a Redis pub/sub control-plane event:
 *
 *   POST   → publish `space:created` → Collab applies `meta.spaces[id]`
 *   DELETE → publish `space:deleted` → Collab removes
 *           `meta.spaces[id]`. The server also soft-deletes the
 *           corresponding `yjs_documents` row directly via SQL so
 *           the canvas-{spaceId} doc stops being loaded by future
 *           Hocuspocus connections.
 *
 * This split avoids the "API and Collab share a process" assumption
 * baked into the spec snippet. The frontend listens on the meta
 * Y.Map's spaces observer for the visual update — there is a brief
 * (~50–200ms) delay between API 201 and the new tab actually
 * appearing, which the spec calls out as expected behaviour.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { yjsDocRepo } from "@breatic/core";
import {
  publishSpaceCreated,
  publishSpaceDeleted,
  publishSpaceLocked,
} from "@breatic/core";
import { canvasSpaceDocName } from "@breatic/shared";
import { ValidationError } from "@breatic/core";
import { requireAuth } from "../middleware/auth.js";
import { requireRole } from "../middleware/role.js";
import type { AuthRoleVariables } from "../middleware/role.js";

const spaces = new Hono<{ Variables: AuthRoleVariables }>();

spaces.use(requireAuth);

const createSpaceBodySchema = z.object({
  type: z.enum(["canvas", "document", "timeline"]),
  name: z.string().min(1).max(60),
});

/**
 * `POST /api/v1/projects/:pid/spaces` — create a new Space.
 *
 * V1 only `canvas` is implemented; `document` / `timeline` accepted
 * by the schema but rejected at the handler so the route surface
 * stays forward-compatible (spec §1.2).
 *
 * Returns 201 with `{ id, type, name }`. The frontend pairs this
 * with a `meta.spaces` Y.Map observer to render the new tab once
 * the Yjs sync arrives — usually within ~50–200ms.
 *
 * @returns `201 { data: { id, type, name } }`
 */
spaces.post(
  "/",
  requireRole("edit"),
  zValidator("json", createSpaceBodySchema),
  async (c) => {
    const user = c.get("user");
    const projectId = c.get("projectId");
    const { type, name } = c.req.valid("json");

    if (type !== "canvas") {
      throw new ValidationError(
        "Only Space type 'canvas' is implemented in V1",
      );
    }

    const spaceId = randomUUID();

    await publishSpaceCreated(projectId, {
      spaceId,
      spaceType: type,
      name,
      createdBy: user.id,
    });

    return c.json({ data: { id: spaceId, type, name } }, 201);
  },
);

/**
 * `DELETE /api/v1/projects/:pid/spaces/:sid` — soft-delete a Space.
 *
 * Two-step:
 *   1. Soft-delete the corresponding `yjs_documents` row (e.g.
 *      `project-{pid}/canvas-{sid}`) so future Hocuspocus connects
 *      stop loading the doc.
 *   2. Publish `space:deleted` so Collab removes
 *      `meta.spaces[spaceId]` for connected clients.
 *
 * The lock-check (`spaces[sid].locked`) is enforced on the
 * frontend (UX layer): the API does NOT read the meta doc here,
 * because read-meta-from-server is the cross-process gotcha that
 * pushed Spaces control-plane onto Redis pub/sub in the first
 * place. The lock is a UX guard, not a security boundary — anyone
 * with `edit` can already write to the doc; the lock just prevents
 * accidental tab-bar deletes via the abstraction we expose.
 *
 * Currently V1 only Canvas Spaces exist, so we soft-delete the
 * `canvas-{sid}` row. When document/timeline land, this route can
 * branch on the requested type from query params, but for V1 a
 * single LIKE is enough to clean up any kind of space doc with
 * matching id.
 */
spaces.delete(
  "/:sid",
  requireRole("edit"),
  async (c) => {
    const user = c.get("user");
    const projectId = c.get("projectId");
    const spaceId = c.req.param("sid");

    // Soft-delete the canvas-{sid} doc row (V1 — only Canvas exists).
    // When document/timeline kinds ship later, this route should branch
    // on the Space type and soft-delete the corresponding doc name; for
    // V1 we hard-code canvas because that's the only Space kind users
    // can actually create (POST validates `type !== 'canvas'`).
    await yjsDocRepo.softDeleteByName(canvasSpaceDocName(projectId, spaceId));

    await publishSpaceDeleted(projectId, {
      spaceId,
      deletedBy: user.id,
    });

    return c.json({ data: { ok: true } });
  },
);

/**
 * `POST /api/v1/projects/:pid/spaces/:sid/lock` — mark a Space as locked.
 *
 * Lock is a UX guard ("don't accidentally delete") — `meta.spaces[id].locked = true`
 * disables the SpaceDrawer's delete action on every client. It does
 * NOT restrict editing the Space's content doc; any user with `edit`
 * role can still mutate. Permission therefore matches DELETE (any
 * editor can toggle).
 */
spaces.post("/:sid/lock", requireRole("edit"), async (c) => {
  const user = c.get("user");
  const projectId = c.get("projectId");
  const spaceId = c.req.param("sid");

  await publishSpaceLocked(projectId, {
    spaceId,
    locked: true,
    actorId: user.id,
  });

  return c.json({ data: { ok: true, locked: true } });
});

/**
 * `DELETE /api/v1/projects/:pid/spaces/:sid/lock` — clear the Space's
 * locked flag. Symmetric counterpart to `POST /:sid/lock` so the
 * frontend's `spacesApi.setLocked(false)` call has a dedicated route
 * (vs. overloading `PATCH` which has no soft-delete semantics here).
 */
spaces.delete("/:sid/lock", requireRole("edit"), async (c) => {
  const user = c.get("user");
  const projectId = c.get("projectId");
  const spaceId = c.req.param("sid");

  await publishSpaceLocked(projectId, {
    spaceId,
    locked: false,
    actorId: user.id,
  });

  return c.json({ data: { ok: true, locked: false } });
});

export { spaces as spacesRoute };
