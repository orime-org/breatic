// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Uses up an account's monthly operations and leaves its studio a set balance,
 * for the smoke cases about operations past the allowance (inner#1968).
 *
 * Writes one counted `allowance` row per included operation into the period
 * the account is in now, as a success would, and charges the studio's credits
 * down to `leaveCredits` through the charge engine, so the balance, its ledger
 * and the period counts agree. Run it the way setup runs
 * `seed-smoke-account.ts`, and only on an account the case made itself.
 *
 * Reads `{ "userId": "...", "studioId": "...", "leaveCredits": 0.4 }` from stdin:
 *   echo '{"userId":"...","studioId":"...","leaveCredits":0.4}' | \
 *     pnpm exec tsx --tsconfig packages/server/tsconfig.json scripts/seed-smoke-operations.ts
 */

import { randomUUID } from "node:crypto";
import { text } from "node:stream/consumers";

// Loads the root .env and runs initCore, as the server entry does first.
await import("../packages/server/src/bootstrap-config.js");
const core = await import("../packages/core/dist/index.js");
const domain = await import("../packages/domain/dist/index.js");

const input = JSON.parse(await text(process.stdin)) as { userId?: unknown; studioId?: unknown; leaveCredits?: unknown };
if (typeof input.userId !== "string" || typeof input.studioId !== "string" || typeof input.leaveCredits !== "number") {
  console.error('Expected {"userId": string, "studioId": string, "leaveCredits": number} on stdin.');
  process.exit(1);
}
const { userId, studioId, leaveCredits } = input as { userId: string; studioId: string; leaveCredits: number };

try {
  const { operations } = await core.getMembershipReadingForUser(userId);
  await core.rawPg`
    INSERT INTO operation_ledger
      (operation_key, kind, account_user_id, studio_id, actor_user_id, status, admitted_as, expires_at, slot, period_start, counted_at)
    SELECT 'smoke-seed:' || gen_random_uuid(), 'upload', ${userId}, ${studioId}, ${userId}, 'counted', 'covered', now(),
      'allowance', ${operations.period.start.toISOString()}::timestamptz, now()
    FROM generate_series(1, ${operations.monthly}::int)`;
  const [held] = await core.rawPg<Array<{ credits: string }>>`
    SELECT coalesce(sum(remaining_credits), 0)::text AS credits FROM credit_lots
    WHERE designated_studio_id = ${studioId} AND lifecycle = 'active' AND deleted_at IS NULL`;
  const drain = Math.round((Number(held?.credits ?? 0) - leaveCredits) * 100) / 100;
  if (drain > 0) {
    const requestId = await core.db.transaction((tx) =>
      domain.creditLotService.requestCharge(
        { kind: "operation", referenceId: `smoke-drain:${randomUUID()}`, actorUserId: userId, projectId: null, studioId, amount: drain, description: "Smoke fixture" },
        tx,
      ),
    );
    if (requestId !== null) await domain.creditLotService.settleCharge(requestId);
  }
  console.log(JSON.stringify({ monthly: operations.monthly, periodStart: operations.period.start, drained: drain }));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await core.closeDb();
}
