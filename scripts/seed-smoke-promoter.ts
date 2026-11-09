// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Makes an account an approved promoter for the smoke suite (inner#1868).
 *
 * Applications are approved in the back office, which the suite does not
 * run, so the suite files the pending application through the repository and
 * approves it through the same service the back office calls.
 * The approval does not compare terms versions, so the application carries a
 * placeholder.
 *
 * Reads `{ "userId": "...", "code": "..." }` from stdin. Run it from the
 * repository root with the server's tsconfig:
 *   echo '{"userId":"…","code":"SMOKE1"}' | \
 *     pnpm exec tsx --tsconfig packages/server/tsconfig.json scripts/seed-smoke-promoter.ts
 */

import { randomUUID } from "node:crypto";
import { text } from "node:stream/consumers";

await import("../packages/server/src/bootstrap-config.js");
const core = await import("../packages/core/dist/index.js");
const applications = await import("../packages/server/src/modules/referral/promoter-application.repo.js");
const admin = await import("../packages/server/src/modules/referral/referral-admin.service.js");

const input = JSON.parse(await text(process.stdin)) as { userId?: unknown; code?: unknown };
if (typeof input.userId !== "string" || typeof input.code !== "string") {
  console.error('Expected {"userId": string, "code": string} on stdin.');
  process.exit(1);
}

try {
  await applications.insertPendingApplication({
    userId: input.userId,
    country: "SG",
    channels: ["https://example.test/smoke"],
    plan: "Smoke suite promoter",
    termsVersion: "smoke",
  });
  const latest = await applications.findLatestApplication(input.userId);
  if (latest === null) throw new Error("the pending application was not filed");
  const answer = await admin.approve(latest.id, { reason: "smoke suite", code: input.code }, {
    key: `bo-${randomUUID()}`,
    hash: "0".repeat(64),
    adminId: "smoke",
  });
  const body = answer.body as { status?: string; referralCode?: string; code?: string };
  if (body.status !== "applied") throw new Error(`approval refused: ${body.code ?? answer.status}`);
  console.log(JSON.stringify({ code: body.referralCode }));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await core.closeDb();
}
