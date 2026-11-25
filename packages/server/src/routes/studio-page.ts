// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * `GET /api/v1/studio-page/poll` — the Studio page's one poll (#1580). The page asks again `nextPollMs` after each
 * answer while its tab is shown.
 */

import { Hono } from "hono";
import { validate } from "@breatic/core";
import { UPLOAD_STATUS_MAX_KEYS } from "@breatic/shared";
import { z } from "zod";
import { requireAuth, type AuthVariables } from "@server/middleware/auth.js";
import { rateLimitFor } from "@server/middleware/rate-limit.js";
import { pollStudioPage } from "@server/modules/studio/studioPagePoll.service.js";

const studioPage = new Hono<{ Variables: AuthVariables }>();

studioPage.get(
  "/poll",
  requireAuth,
  rateLimitFor("studio-page-poll", "user"),
  validate(
    "query",
    z.object({
      // The Studio the page shows; absent on the Recent page, which shows none.
      studio: z.string().min(1).max(128).optional(),
      // The keys the page waits for, comma-separated; absent when it waits for none.
      uploads: z
        .string()
        .optional()
        .transform((v) => (v === undefined || v === "" ? [] : v.split(",")))
        .pipe(z.array(z.string().min(1).max(512)).max(UPLOAD_STATUS_MAX_KEYS)),
    }),
  ),
  async (c) => {
    const { studio, uploads } = c.req.valid("query");
    return c.json({ data: await pollStudioPage(c.get("user").id, studio, uploads) });
  },
);

export { studioPage as studioPageRoute };
