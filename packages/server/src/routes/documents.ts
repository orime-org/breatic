// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Document snapshots (inner#1129): save, list, read, rename and delete.
 *
 * Every route first asks the project for the caller's role, so a stranger gets
 * 404 and a role below the one needed gets 403; an archived project makes
 * everyone a viewer. Every read or write of one snapshot also names the
 * project and document it must belong to, so another project's or another
 * document's id answers 404.
 */

import { Hono } from "hono";
import { z } from "zod";
import { logger } from "@breatic/core";
import {
  documentVersionListQuerySchema,
  documentVersionRenameSchema,
  documentVersionSaveSchema,
  documentVersionScopeSchema,
  t,
} from "@breatic/shared";
import { requireAuth, type AuthVariables } from "@server/middleware/auth.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import { acceptTransferBody } from "@server/middleware/transfer-body.js";
import { validate } from "@server/middleware/validate.js";
import { documentVersionService, projectService } from "@server/modules";

const documents = new Hono<{ Variables: AuthVariables }>();

documents.use("*", requireAuth);

const idParam = z.object({ id: z.string().uuid() });

/**
 * `POST /documents/versions` — keep a snapshot of a document's body.
 * @param c - Hono context with a validated `documentVersionSaveSchema` body.
 * @returns `201` with `{ version }`, or `409` with `reason: 'document_versions_full'`.
 * @throws {AppError} 404 with no role on the project, 403 below editor.
 */
documents.post(
  "/versions",
  rateLimitFor("document-version-save", "user"),
  acceptTransferBody("document_version_save"),
  validate("json", documentVersionSaveSchema),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    await projectService.assertAccess(body.project_id, user.id, "editor");
    const saved = await documentVersionService.saveVersion({
      projectId: body.project_id,
      spaceId: body.space_id,
      userId: user.id,
      name: body.name,
      content: body.content,
      schemaVersion: body.schema_version,
    });
    if (!saved.ok) {
      return c.json(
        { error: { code: 409, message: t("server.document.versions_full", { limit: saved.limit }), reason: saved.reason } },
        409,
      );
    }
    logger.info({ userId: user.id, projectId: body.project_id, spaceId: body.space_id, versionId: saved.version.id }, "document_version_saved");
    return c.json({ data: { version: saved.version } }, 201);
  },
);

/**
 * `GET /documents/versions` — a document's snapshots, newest first, one page.
 * @param c - Hono context with a validated `documentVersionListQuerySchema` query.
 * @returns `200` with `{ versions, nextCursor }`.
 * @throws {AppError} 404 with no role on the project.
 */
documents.get("/versions", validate("query", documentVersionListQuerySchema), async (c) => {
  const user = c.get("user");
  const query = c.req.valid("query");
  await projectService.assertAccess(query.project_id, user.id, "viewer");
  const page = await documentVersionService.listVersions(query.project_id, query.space_id, query.cursor);
  return c.json({ data: page }, 200);
});

/**
 * `GET /documents/versions/:id` — one snapshot with its body.
 * @param c - Hono context with a validated id and scope.
 * @returns `200` with `{ version, content }`.
 * @throws {AppError} 404 with no role, or when the snapshot is not this document's.
 */
documents.get(
  "/versions/:id",
  validate("param", idParam),
  validate("query", documentVersionScopeSchema),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const scope = c.req.valid("query");
    await projectService.assertAccess(scope.project_id, user.id, "viewer");
    const found = await documentVersionService.getVersion({ id, projectId: scope.project_id, spaceId: scope.space_id });
    return c.json({ data: found }, 200);
  },
);

/**
 * `PATCH /documents/versions/:id` — rename a snapshot, or clear its name.
 * @param c - Hono context with a validated id and `documentVersionRenameSchema` body.
 * @returns `200` with `{}`.
 * @throws {AppError} 404 with no role or no such snapshot here, 403 below editor.
 */
documents.patch(
  "/versions/:id",
  rateLimitFor("document-version-edit", "user"),
  validate("param", idParam),
  validate("json", documentVersionRenameSchema),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    await projectService.assertAccess(body.project_id, user.id, "editor");
    await documentVersionService.renameVersion({ id, projectId: body.project_id, spaceId: body.space_id }, body.name);
    logger.info({ userId: user.id, projectId: body.project_id, spaceId: body.space_id, versionId: id }, "document_version_renamed");
    return c.json({ data: {} }, 200);
  },
);

/**
 * `DELETE /documents/versions/:id` — delete a snapshot; the row stays, marked deleted.
 * @param c - Hono context with a validated id and scope.
 * @returns `200` with `{}`.
 * @throws {AppError} 404 with no role or no such snapshot here, 403 below editor.
 */
documents.delete(
  "/versions/:id",
  rateLimitFor("document-version-edit", "user"),
  validate("param", idParam),
  validate("query", documentVersionScopeSchema),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const scope = c.req.valid("query");
    await projectService.assertAccess(scope.project_id, user.id, "editor");
    await documentVersionService.deleteVersion({ id, projectId: scope.project_id, spaceId: scope.space_id }, user.id);
    logger.info({ userId: user.id, projectId: scope.project_id, spaceId: scope.space_id, versionId: id }, "document_version_deleted");
    return c.json({ data: {} }, 200);
  },
);

export { documents as documentsRoute };
