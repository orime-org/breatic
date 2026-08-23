// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Hono application factory.
 *
 * Registers middleware and routes. This module is separated from
 * the HTTP server (`index.ts`) to enable testing with Hono's
 * built-in test client.
 */

import { Hono } from "hono";
import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { env, MONOREPO_ROOT } from "@breatic/core";
import { corsMiddleware } from "@server/middleware/cors.js";
import { localeMiddleware } from "@server/middleware/i18n.js";
import { loggerMiddleware } from "@server/middleware/logger.js";
import { metricsMiddleware } from "@server/infra/metrics.js";
import { errorHandler } from "@server/middleware/error-handler.js";
import { authRoute } from "@server/routes/auth.js";
import { chatRoute } from "@server/routes/chat.js";
import { canvasRoute } from "@server/routes/canvas.js";
import { miniToolsRoute } from "@server/routes/mini-tools.js";
import { projectsRoute } from "@server/routes/projects.js";
import { skillsRoute } from "@server/routes/skills.js";
import { tasksRoute } from "@server/routes/tasks.js";
import { paymentRoute } from "@server/routes/payment.js";
import creditsRoute from "@server/routes/credits.js";
import { textToolsRoute } from "@server/routes/text-tools.js";
import { modelsRoute } from "@server/routes/models.js";
import { assetsRoute } from "@server/routes/assets.js";
import { accountRoute } from "@server/routes/account.js";
import { subscriptionRoute } from "@server/routes/subscription.js";
import { activitiesRoute } from "@server/routes/activities.js";
import { membersRoute } from "@server/routes/members.js";
import { usersRoute } from "@server/routes/users.js";
import { studiosRoute, studioRoute } from "@server/routes/studios.js";
import { decisionsRoute } from "@server/routes/decisions.js";
import { projectInvitesRoute } from "@server/routes/project-invitations.js";
import { notificationsRoute } from "@server/routes/notifications.js";
import {
  projectRoleUpgradeRequestsRoute,
  roleUpgradeRequestWithdrawRoute,
} from "@server/routes/role-upgrade-requests.js";

/**
 * Create and configure the Hono application.
 * @returns Configured Hono app instance
 */
export function createApp(): Hono {
  const app = new Hono();

  // ── Middleware ─────────────────────────────────
  app.use("*", corsMiddleware);
  // Locale must wrap BEFORE the route handlers so service-layer
  // `t("server.…")` calls inside them see the per-request locale.
  // It also runs before `onError` so error responses honour the
  // caller's language.
  app.use("*", localeMiddleware);
  app.use("*", loggerMiddleware);
  app.use("*", metricsMiddleware);
  app.onError(errorHandler);

  // ── Routes ────────────────────────────────────
  // Health is exposed on a separate http server (port 3001 /healthz)
  // started in `index.ts`, not on the hono main port, so probe
  // traffic stays isolated and LB per-port failure semantics stay
  // clean. See `packages/server/src/index.ts` `startHealthServer`.
  app.route("/api/v1/auth", authRoute);
  app.route("/api/v1/chat", chatRoute);
  app.route("/api/v1/canvas", canvasRoute);
  app.route("/api/v1/mini-tools", miniToolsRoute);
  app.route("/api/v1/mini-tools/text", textToolsRoute);
  app.route("/api/v1/projects", projectsRoute);
  app.route("/api/v1/projects/:pid/members", membersRoute);
  app.route("/api/v1/projects/:pid/invitations", projectInvitesRoute);
  app.route("/api/v1/users/me/notifications", notificationsRoute);
  app.route(
    "/api/v1/projects/:pid/role-upgrade-requests",
    projectRoleUpgradeRequestsRoute,
  );
  app.route(
    "/api/v1/role-upgrade-requests",
    roleUpgradeRequestWithdrawRoute,
  );
  // Spaces route removed 2026-05-23 (ADR yjs-collab-only-write-authz):
  // Space lifecycle (create / delete / lock / restore) now routes via
  // collab stateless RPC; the server no longer owns the write path.
  app.route("/api/v1/users", usersRoute);
  app.route("/api/v1/decisions", decisionsRoute);
  app.route("/api/v1/studios", studiosRoute);
  app.route("/api/v1/studio", studioRoute);
  app.route("/api/v1/skills", skillsRoute);
  app.route("/api/v1/tasks", tasksRoute);
  app.route("/api/v1/payment", paymentRoute);
  app.route("/api/v1/credits", creditsRoute);
  app.route("/api/v1/models", modelsRoute);
  app.route("/api/v1/assets", assetsRoute);
  app.route("/api/v1/account/subscription", subscriptionRoute);
  app.route("/api/v1/account", accountRoute);
  app.route("/api/v1/projects", activitiesRoute);

  // ── Static file serving (local storage) ──────
  if (env.STORAGE_PROVIDER === "local") {
    const UPLOADS_DIR = resolve(MONOREPO_ROOT, "uploads");

    app.get("/uploads/*", async (c) => {
      const reqPath = c.req.path; // e.g. /uploads/image/abc.png
      const relativePath = reqPath.slice("/uploads/".length);

      // Resolve against uploads dir and verify containment
      const normalized = resolve(UPLOADS_DIR, relativePath);
      if (!normalized.startsWith(UPLOADS_DIR + sep)) {
        return c.json({ error: "Forbidden" }, 403);
      }

      // Resolve symlinks and re-verify
      let real: string;
      try {
        real = await realpath(normalized);
      } catch {
        return c.json({ error: "File not found" }, 404);
      }
      if (!real.startsWith(UPLOADS_DIR)) {
        return c.json({ error: "Forbidden" }, 403);
      }

      try {
        const data = await readFile(real);
        const ext = real.split(".").pop() ?? "";
        // webp is here because image generation outputs it. Left out, the
        // browser is told octet-stream and downloads the file rather than
        // rendering it. (The avatar cropper used to encode webp too; it has
        // encoded png since #31.)
        const mimeTypes: Record<string, string> = {
          png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
          webp: "image/webp",
          mp4: "video/mp4", mp3: "audio/mpeg", wav: "audio/wav",
          glb: "model/gltf-binary", json: "application/json",
        };
        c.header("Content-Type", mimeTypes[ext] ?? "application/octet-stream");
        // Serve exactly the declared type. Without this a file crafted to be
        // valid in two formats at once could be re-interpreted by the browser
        // as something executable, under our own origin.
        c.header("X-Content-Type-Options", "nosniff");
        c.header("Cache-Control", "public, max-age=86400");
        return c.body(data);
      } catch {
        return c.json({ error: "File not found" }, 404);
      }
    });
  }

  return app;
}
