// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The one endpoint the ingest Worker calls (inner#1953): the keys of a web-animation model call, read before each
 * call, signed by the Worker and answered sealed to its public key. Every refusal is logged here with the execution and
 * the upstream, never a key.
 */

import { Hono } from "hono";
import { logger } from "@breatic/core";
import { MODEL_KEYS_REFUSAL_STATUS, MODEL_KEYS_SEALED_TYPE, modelKeysRequestSchema } from "@breatic/shared/space-content";
import { ingestSignature } from "@server/middleware/ingest-signature.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import { validate } from "@server/middleware/validate.js";
import { modelKeysService } from "@server/modules";

const ingest = new Hono();

ingest.post("/model-keys", rateLimitFor("ingest-model-keys"), ingestSignature(), validate("json", modelKeysRequestSchema), async (c) => {
  const request = c.req.valid("json");
  const ctx = { executionId: request.executionId, upstreams: request.upstreams };
  const answer = await modelKeysService.answerModelKeys(request);
  switch (answer.kind) {
    case "sealed":
      return c.body(answer.sealed, 200, { "content-type": MODEL_KEYS_SEALED_TYPE, "cache-control": "no-store" });
    case "refused":
      // The deployment's missing keys are named for whoever runs it; the user is told the run is unavailable.
      logger.error({ ...ctx, ...answer.refusal, ...(answer.envVars === undefined ? {} : { envVars: answer.envVars }) }, "ingest_model_keys_refused");
      return c.json(answer.refusal, MODEL_KEYS_REFUSAL_STATUS);
    case "not_running":
      logger.warn(ctx, "ingest_model_keys_not_running");
      return c.json({ code: "not_running" }, 404);
    case "not_in_plan":
      logger.error(ctx, "ingest_model_keys_not_in_plan");
      return c.json({ code: "not_in_plan" }, 403);
    case "unsealable":
      logger.error(ctx, "ingest_key_seal_public_key_unset");
      return c.json({ code: "unavailable" }, 503);
  }
});

export { ingest as ingestRoute };
