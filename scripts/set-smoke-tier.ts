// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Moves an account the smoke suite made onto another membership tier (inner#1034).
 *
 * A local install registers every account on `self_hosted`, whose ceilings
 * nobody reaches, so a case about a tier's ceiling needs an account of its own
 * on a real one. This calls core's `changeMembershipTier`, the one writer of a
 * tier outside registration, with the reason `manual`. Run it the way setup
 * runs `seed-smoke-account.ts`, and never on the suite's shared accounts:
 * other cases running at the same time rely on their `self_hosted` limits.
 *
 * Reads `{ "userId": "...", "tier": "base" | "self_hosted" }` from stdin:
 *   echo '{"userId":"...","tier":"base"}' | \
 *     pnpm exec tsx --tsconfig packages/server/tsconfig.json scripts/set-smoke-tier.ts
 */

import { text } from "node:stream/consumers";

// Loads the root .env and runs initCore, as the server entry does first.
await import("../packages/server/src/bootstrap-config.js");
const core = await import("../packages/core/dist/index.js");

const input = JSON.parse(await text(process.stdin)) as { userId?: unknown; tier?: unknown };
if (typeof input.userId !== "string" || (input.tier !== "base" && input.tier !== "self_hosted")) {
  console.error('Expected {"userId": string, "tier": "base" | "self_hosted"} on stdin.');
  process.exit(1);
}

try {
  console.log(JSON.stringify(await core.changeMembershipTier(input.userId, input.tier, "manual")));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await core.closeDb();
}
