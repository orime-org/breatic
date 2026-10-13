// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Creates one account for the smoke and visual suites (inner#1434).
 *
 * The suites need accounts to run their flows with, one pair per worker, and
 * `POST /auth/register` is limited to ten an hour per address — a budget the
 * specs that test registering need for themselves. So the suite's setup
 * creates its accounts here, through the same `authService.register` the
 * route calls when email is off: the row is the one a sign-up writes. The
 * personal studio is still made by setup through `/auth/setup-studio` once
 * the account has signed in.
 *
 * Reads `{ "email": "...", "password": "..." }` from stdin, so the password
 * stays out of the process list. Run it from the repository root, with the
 * server's tsconfig so the server's own `@server/*` imports resolve:
 *   echo '{"email":"a@b.test","password":"..."}' | \
 *     pnpm exec tsx --tsconfig packages/server/tsconfig.json scripts/seed-smoke-account.ts
 */

import { text } from "node:stream/consumers";

// Loads the root .env and runs initCore, as the server entry does first.
await import("../packages/server/src/bootstrap-config.js");
// The same file the server source reaches through `@breatic/core`, so the
// database pool it closes below is the one `register` opened.
const core = await import("../packages/core/dist/index.js");
const authService = await import("../packages/server/src/modules/auth/auth.service.js");

const input = JSON.parse(await text(process.stdin)) as { email?: unknown; password?: unknown };
if (typeof input.email !== "string" || typeof input.password !== "string") {
  console.error('Expected {"email": string, "password": string} on stdin.');
  process.exit(1);
}

core.loadLocales();
try {
  const { user } = await authService.register(input.email, input.password);
  console.log(JSON.stringify({ userId: user.id }));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await core.closeDb();
}
