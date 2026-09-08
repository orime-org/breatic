// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Models route — serves the AIGC model catalog, and the voices a model offers.
 *
 * The catalog is public and read from local yaml. The voice list is neither:
 * every miss reaches a vendor on our key and against our quota, so it takes a
 * session, a throttle, and a cache window in front of it.
 */

import { Hono } from "hono";
import { z } from "zod";
import { modelCatalog, listVoices, getVoice } from "@breatic/domain";
import type { VoicePage } from "@breatic/domain";
import { env, getRedis, logger } from "@breatic/core";
import { t } from "@breatic/shared";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import { validate } from "@server/middleware/validate.js";
import { getVoiceCatalogCacheSeconds } from "@server/config/limits.js";

const models = new Hono<{ Variables: AuthVariables }>();

/** Query parameters the voice list accepts. */
const voiceListQuerySchema = z.object({
  query: z.string().max(200).optional(),
  cursor: z.string().max(500).optional(),
});

/**
 * The Redis key one voice answer is stored under.
 *
 * Environment-prefixed like every other key here: two deployments sharing one
 * Redis must not read each other's answers, and the provider a deployment
 * resolved to decides what an id even means.
 * @param modelName - The model whose voices were listed.
 * @param query - The search term, empty when none was given.
 * @param cursor - The page cursor, empty on the first page.
 * @returns The full key.
 */
function voicesCacheKey(modelName: string, query: string, cursor: string): string {
  return `${env.ENV}:server:voices:${modelName}:${query}:${cursor}`;
}

/**
 * `GET /api/v1/models` — full model catalog.
 *
 * Returns all available models grouped by modality (image, video, audio,
 * tts, three_d, understand). Each model includes params, tier, providers,
 * and cost info. Models without configured API keys are excluded.
 *
 * Frontend should call this once at startup and cache the result.
 * @returns Model catalog with total count
 */
models.get("/", (c) => {
  const catalog = modelCatalog.getModelCatalog();

  return c.json({ data: catalog }, 200, {
    "Cache-Control": "public, max-age=300",
  });
});

/**
 * `GET /api/v1/models/:modelName/voices` — the voices that model offers.
 *
 * Answers in the value domain of the provider this deployment resolved to,
 * which is the domain the panel must write back on the node. Paging is an
 * opaque cursor: the vendors behind it disagree on what a page is.
 * @returns One page of voices, and a cursor when more remain.
 */
models.get(
  "/:modelName/voices",
  requireAuth,
  rateLimitFor("voices", "user"),
  validate("query", voiceListQuerySchema),
  async (c) => {
    const modelName = c.req.param("modelName");
    const { query, cursor } = c.req.valid("query");
    const key = voicesCacheKey(modelName, query ?? "", cursor ?? "");

    const redis = getRedis();
    const cached = await redis.get(key);
    if (cached) {
      return c.json({ data: JSON.parse(cached) as VoicePage });
    }

    const page = await listVoices(modelName, {
      ...(query ? { query } : {}),
      ...(cursor ? { cursor } : {}),
    });
    await redis.set(key, JSON.stringify(page), "EX", getVoiceCatalogCacheSeconds());

    logger.info(
      { userId: c.get("user").id, model: modelName, count: page.voices.length },
      "voice_catalog_read",
    );
    return c.json({ data: page });
  },
);

/**
 * `GET /api/v1/models/:modelName/voices/:voiceId` — one voice by its id.
 *
 * A node stores the id, and an id is a 20-character string or a uuid. The
 * panel reads a name back through here so the trigger says who is speaking.
 * @returns The voice, or 404 when this provider no longer carries that id.
 */
models.get(
  "/:modelName/voices/:voiceId",
  requireAuth,
  rateLimitFor("voices", "user"),
  async (c) => {
    const modelName = c.req.param("modelName");
    const voiceId = c.req.param("voiceId");

    const voice = await getVoice(modelName, voiceId);
    if (!voice) {
      return c.json(
        { error: { code: 404, message: t("server.canvas.voices_model_not_found") } },
        404,
      );
    }
    return c.json({ data: voice });
  },
);

export { models as modelsRoute };
