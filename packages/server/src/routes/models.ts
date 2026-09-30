// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Models route — serves the AIGC model catalog, and the voices a model offers.
 *
 * Both read local yaml: the catalog is public, and a model's voices are
 * listed inline in its entry and read behind a session.
 */

import { Hono } from "hono";
import { z } from "zod";
import { modelCatalog, listVoices, getVoice } from "@breatic/domain";
import { logger } from "@breatic/core";
import { t } from "@breatic/shared";
import { requireAuth } from "@server/middleware/auth.js";
import type { AuthVariables } from "@server/middleware/auth.js";
import { validate } from "@server/middleware/validate.js";

const models = new Hono<{ Variables: AuthVariables }>();

/** Query parameters the voice list accepts. */
const voiceListQuerySchema = z.object({
  query: z.string().max(200).optional(),
  cursor: z.string().max(500).optional(),
});

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
 * The ids are the ones the upstream accepts, which is what the panel writes
 * back on the node. The whole list is one page; the cursor is accepted and
 * ignored.
 * @returns Every voice whose name matches the search term.
 */
models.get(
  "/:modelName/voices",
  requireAuth,
  validate("query", voiceListQuerySchema),
  async (c) => {
    const modelName = c.req.param("modelName");
    const { query, cursor } = c.req.valid("query");
    const page = await listVoices(modelName, {
      ...(query ? { query } : {}),
      ...(cursor ? { cursor } : {}),
    });

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
