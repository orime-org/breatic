// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { Hono } from 'hono';
import { z } from 'zod';
import { logger, validate } from '@breatic/core';
import { videoPresentationService, VideoPresentationSourceChanged } from '@breatic/domain';
import { requireAuth, type AuthVariables } from '@server/middleware/auth.js';
import { rateLimitFor } from '@server/middleware/rate-limit.js';
import { runOnce } from '@server/middleware/run-once.js';
import { idempotencyKeyHeaderSchema } from '@server/routes/schemas.js';

const route = new Hono<{ Variables: AuthVariables }>();
const projectParam = z.object({ projectId: z.uuid() });
route.use('*', requireAuth);

route.get('/', validate('param', projectParam), validate('query', z.object({ url: z.url() })), async (c) => {
  const projectId = c.req.valid('param').projectId;
  const userId = c.get('user').id;
  const canonicalURL = c.req.valid('query').url;
  try {
    return c.json({ data: await videoPresentationService.resolveVideoPresentation({ projectId, userId, canonicalURL }) });
  } catch (err) {
    logger.error({ err, ctx: { projectId, userId, canonicalURL } }, 'video_presentation_read_failed');
    throw err;
  }
});

route.post('/repair', rateLimitFor('mini_tool', 'user'), validate('param', projectParam), validate('header', idempotencyKeyHeaderSchema),
  validate('json', z.strictObject({ canonicalURL: z.url(), sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/) })), runOnce('mini-tool'), async (c) => {
    const projectId = c.req.valid('param').projectId;
    const userId = c.get('user').id;
    const body = c.req.valid('json');
    try {
      const answer = await videoPresentationService.repairVideoPresentation({ ...body, projectId, userId, requestId: c.req.header('Idempotency-Key')! });
      return c.json({ data: answer });
    } catch (err) {
      logger.error({ err, ctx: { projectId, userId, canonicalURL: body.canonicalURL, sourceFingerprint: body.sourceFingerprint } }, 'video_presentation_repair_failed');
      if (err instanceof VideoPresentationSourceChanged) {
        return c.json({ error: { code: 409, message: err.message }, data: { sourceBinding: err.currentSourceBinding } }, 409);
      }
      throw err;
    }
  });

export { route as videoPresentationRoute };
