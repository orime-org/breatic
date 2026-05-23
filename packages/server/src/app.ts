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
import { corsMiddleware } from "./middleware/cors.js";
import { loggerMiddleware } from "./middleware/logger.js";
import { errorHandler } from "./middleware/error-handler.js";
import { healthRoute } from "./routes/health.js";
import { authRoute } from "./routes/auth.js";
import { chatRoute } from "./routes/chat.js";
import { canvasRoute } from "./routes/canvas.js";
import { miniToolsRoute } from "./routes/mini-tools.js";
import { projectsRoute } from "./routes/projects.js";
import { skillsRoute } from "./routes/skills.js";
import { tasksRoute } from "./routes/tasks.js";
import { paymentRoute } from "./routes/payment.js";
import { textToolsRoute } from "./routes/text-tools.js";
import { modelsRoute } from "./routes/models.js";
import { assetsRoute } from "./routes/assets.js";
import { membersRoute } from "./routes/members.js";
import { usersRoute } from "./routes/users.js";

/**
 * Create and configure the Hono application.
 *
 * @returns Configured Hono app instance
 */
export function createApp(): Hono {
  const app = new Hono();

  // ── Middleware ─────────────────────────────────
  app.use("*", corsMiddleware);
  app.use("*", loggerMiddleware);
  app.onError(errorHandler);

  // ── Routes ────────────────────────────────────
  app.route("/api/health", healthRoute);
  app.route("/api/v1/auth", authRoute);
  app.route("/api/v1/chat", chatRoute);
  app.route("/api/v1/canvas", canvasRoute);
  app.route("/api/v1/mini-tools", miniToolsRoute);
  app.route("/api/v1/mini-tools/text", textToolsRoute);
  app.route("/api/v1/projects", projectsRoute);
  app.route("/api/v1/projects/:pid/members", membersRoute);
  // Spaces route removed 2026-05-23 (ADR yjs-collab-only-write-authz):
  // Space lifecycle (create / delete / lock / restore) now routes via
  // collab stateless RPC; the server no longer owns the write path.
  app.route("/api/v1/users", usersRoute);
  app.route("/api/v1/skills", skillsRoute);
  app.route("/api/v1/tasks", tasksRoute);
  app.route("/api/v1/payment", paymentRoute);
  app.route("/api/v1/models", modelsRoute);
  app.route("/api/v1/assets", assetsRoute);

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
        const mimeTypes: Record<string, string> = {
          png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
          mp4: "video/mp4", mp3: "audio/mpeg", wav: "audio/wav",
          glb: "model/gltf-binary", json: "application/json",
        };
        c.header("Content-Type", mimeTypes[ext] ?? "application/octet-stream");
        c.header("Cache-Control", "public, max-age=86400");
        return c.body(data);
      } catch {
        return c.json({ error: "File not found" }, 404);
      }
    });
  }

  return app;
}
