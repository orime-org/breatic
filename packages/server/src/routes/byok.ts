// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bring-your-own-key routes (inner#1953). `/account/byok` is the caller's own settings: reading them, saving, re-checking and deleting a key under `/keys/:upstream`, and
 * pointing a media model at an upstream under `/models/:model`. `/projects/:projectId/key-plan` tells a Project's
 * panels whose keys its runs use. Translation only; `byokService` decides. No request or answer here is logged with
 * its body: a saved key's body is the key.
 */

import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import { validate } from "@server/middleware/validate.js";
import { byokService } from "@server/modules";

const byok = new Hono<{ Variables: AuthVariables }>();
byok.use(requireAuth);

/** The key as pasted: bounded and checked by the service, which never repeats it. */
const keyBody = z.object({ key: z.string() });
const modelBody = z.object({ upstream: z.string().min(1).max(64).nullable() });
const upstreamParam = z.object({ upstream: z.string().min(1).max(64) });
const modelParam = z.object({ model: z.string().min(1).max(100) });

/** `GET /account/byok` — the caller's keys (hints only), model choices and what each media model may be pointed at. */
byok.get("/", async (c) => c.json({ data: await byokService.readSettings(c.get("user").id) }));

/** `PUT /account/byok/keys/:upstream` — check a key with its upstream, then save it sealed, replacing the live one. */
byok.put(
  "/keys/:upstream",
  rateLimitFor("byok-key-write", "user"),
  validate("param", upstreamParam),
  validate("json", keyBody),
  async (c) => {
    const { upstream } = c.req.valid("param");
    return c.json({ data: await byokService.saveKey(c.get("user").id, upstream, c.req.valid("json").key) });
  },
);

/** `POST /account/byok/keys/:upstream/check` — check the saved key again and record what was found. */
byok.post("/keys/:upstream/check", rateLimitFor("byok-key-check", "user"), validate("param", upstreamParam), async (c) => {
  const { upstream } = c.req.valid("param");
  return c.json({ data: await byokService.recheckKey(c.get("user").id, upstream) });
});

/** `DELETE /account/byok/keys/:upstream` — delete the key and every model choice naming its upstream. */
byok.delete("/keys/:upstream", validate("param", upstreamParam), async (c) => {
  await byokService.deleteKey(c.get("user").id, c.req.valid("param").upstream);
  return c.json({ data: null });
});

/** `PUT /account/byok/models/:model` — point a media model at an upstream, or back at the deployment's keys. */
byok.put("/models/:model", rateLimitFor("byok-model-write", "user"), validate("param", modelParam), validate("json", modelBody), async (c) => {
  await byokService.setModelUpstream(c.get("user").id, c.req.valid("param").model, c.req.valid("json").upstream);
  return c.json({ data: null });
});

/** The key-plan route, mounted under `/projects`. */
const keyPlan = new Hono<{ Variables: AuthVariables }>();

/** `GET /projects/:projectId/key-plan` — whose keys the Project's runs use; any member may read it. */
keyPlan.get("/:projectId/key-plan", requireAuth, validate("param", z.object({ projectId: z.uuid() })), async (c) =>
  c.json({ data: await byokService.readKeyPlan(c.req.valid("param").projectId, c.get("user").id) }));

export { byok as byokRoute, keyPlan as keyPlanRoute };
