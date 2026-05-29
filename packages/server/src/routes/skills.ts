/**
 * Skill routes — built-in listing, user skill management, and marketplace.
 *
 * Built-in skills are read-only. User skills support CRUD with ownership
 * enforcement. The marketplace exposes publish/unpublish for owners and
 * install/uninstall for consumers.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { skillMarketQuerySchema } from "@server/routes/schemas.js";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { skillService } from "@breatic/core";

const skills = new Hono<{ Variables: AuthVariables }>();

skills.use(requireAuth);

// ── Built-in ────────────────────────────────────────────────────────

/** `GET /skills` — list all built-in skill metadata. */
skills.get("/", async (c) => {
  const list = skillService.listBuiltin();
  return c.json({ data: list });
});

// ── User Skills ─────────────────────────────────────────────────────

/** `GET /skills/mine` — list skills owned by or installed for the user. */
skills.get("/mine", async (c) => {
  const user = c.get("user");
  const list = await skillService.listUserSkills(user.id);
  return c.json({ data: list });
});

/** `DELETE /skills/mine/:id` — soft-delete a user-owned skill. */
skills.delete("/mine/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  await skillService.deleteUserSkill(id, user.id);
  return c.body(null, 204);
});

// ── Marketplace ─────────────────────────────────────────────────────

/** `GET /skills/market` — browse published marketplace skills. */
skills.get(
  "/market",
  zValidator("query", skillMarketQuerySchema),
  async (c) => {
    const { tags, offset, limit } = c.req.valid("query");
    const list = await skillService.listMarketSkills(tags, offset, limit);
    return c.json({ data: list });
  },
);

/** `POST /skills/mine/:id/publish` — publish a user skill to the marketplace. */
skills.post("/mine/:id/publish", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const skill = await skillService.publishSkill(id, user.id);
  return c.json({ data: skill as Record<string, unknown> });
});

/** `POST /skills/mine/:id/unpublish` — remove a skill from the marketplace. */
skills.post("/mine/:id/unpublish", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const skill = await skillService.unpublishSkill(id, user.id);
  return c.json({ data: skill as Record<string, unknown> });
});

/** `POST /skills/market/:id/install` — install a marketplace skill. */
skills.post("/market/:id/install", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const install = await skillService.installSkill(id, user.id);
  return c.json({ data: install as Record<string, unknown> }, 201);
});

/** `DELETE /skills/market/:id/install` — uninstall a marketplace skill. */
skills.delete("/market/:id/install", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  await skillService.uninstallSkill(id, user.id);
  return c.body(null, 204);
});

export { skills as skillsRoute };
