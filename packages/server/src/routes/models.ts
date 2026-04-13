/**
 * Models route — serves the AIGC model catalog.
 *
 * Returns all available models grouped by modality, filtered by
 * configured API keys. No auth required — model catalog is public.
 */

import { Hono } from "hono";
import { modelCatalog } from "@breatic/core";

const models = new Hono();

/**
 * `GET /api/v1/models` — full model catalog.
 *
 * Returns all available models grouped by modality (image, video, audio,
 * tts, three_d, understand). Each model includes params, tier, providers,
 * and cost info. Models without configured API keys are excluded.
 *
 * Frontend should call this once at startup and cache the result.
 *
 * @returns Model catalog with total count
 */
models.get("/", (c) => {
  const catalog = modelCatalog.getModelCatalog();

  return c.json({ data: catalog }, 200, {
    "Cache-Control": "public, max-age=300",
  });
});

export { models as modelsRoute };
