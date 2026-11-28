// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Per-file setup for collab's integration suite, run after
 * `@breatic/integration-tests/env` (inner#2043).
 *
 * Core's `db` logs in as collab's own login, as collab does in production
 * with `COLLAB_DATABASE_URL`; tests seed fixtures through the admin URL,
 * `inject("DATABASE_URL")`. Queues are forbidden as in collab's entry, and a
 * file fails when anything tried to open one, even if the caller caught it.
 */

import { afterAll, expect, inject } from "vitest";
import { forbidQueues, forbiddenQueueAttempts } from "@breatic/core";

process.env.DATABASE_URL = inject("COLLAB_DATABASE_URL");
forbidQueues();

afterAll(() => {
  expect(forbiddenQueueAttempts(), "collab code tried to open a queue").toBe(0);
});
