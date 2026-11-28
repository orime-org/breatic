// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The admin connection collab's integration tests write fixtures with
 * (inner#2043). In these suites core's `db` and `rawPg` log in as collab's own
 * login, which may write only collab's tables; users, Studios, Projects,
 * members and every other fixture outside collab's scope are written here,
 * through `inject("DATABASE_URL")`. postgres.js connects on the first query;
 * the pool is closed when the importing file ends.
 */

import { afterAll, inject } from "vitest";
import { createTestDb } from "@breatic/core";

const admin = createTestDb(inject("DATABASE_URL"), 3);

/** The admin account's postgres.js client. */
export const adminSql = admin.client;

/** The admin account's Drizzle client over the same pool. */
export const adminDb = admin.db;

afterAll(async () => {
  await adminSql.end({ timeout: 1 });
});
