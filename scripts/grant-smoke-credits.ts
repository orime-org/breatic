// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Gives an account credits in its personal studio the way an operator gift
 * does, for the smoke cases that need a top-up without a checkout (inner#1968).
 *
 * Goes through the server's operator grant service, so the grant operation,
 * the gift source, its lot designated to the personal studio and any debt
 * repayment are written as the back office's grant writes them. The grant is
 * refused while payments are off. Run it the way setup runs
 * `seed-smoke-account.ts`, and only on an account the case made itself.
 *
 * Reads `{ "userId": "...", "studioId": "...", "credits": "20" }` from stdin,
 * where `studioId` is the account's personal studio:
 *   echo '{"userId":"...","studioId":"...","credits":"20"}' | \
 *     pnpm exec tsx --tsconfig packages/server/tsconfig.json scripts/grant-smoke-credits.ts
 */

import { createHash, randomUUID } from "node:crypto";
import { text } from "node:stream/consumers";

// Loads the root .env and runs initCore, as the server entry does first.
await import("../packages/server/src/bootstrap-config.js");
const core = await import("../packages/core/dist/index.js");
const { grant } = await import("../packages/server/src/modules/credit-grant/credit-grant.service.js");

const input = JSON.parse(await text(process.stdin)) as { userId?: unknown; studioId?: unknown; credits?: unknown };
if (typeof input.userId !== "string" || typeof input.studioId !== "string" || typeof input.credits !== "string") {
  console.error('Expected {"userId": string, "studioId": string, "credits": string} on stdin.');
  process.exit(1);
}
const { userId, studioId, credits } = input as { userId: string; studioId: string; credits: string };

try {
  const body = { kind: "gift" as const, credits, reason: "Smoke fixture", expectedPersonalStudioId: studioId };
  const answer = await grant({
    userId, key: `bo-${randomUUID()}`, adminId: randomUUID(), body,
    hash: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
  });
  const result = answer.body as { status?: string; code?: string; lotId?: string };
  if (result.status !== "applied") throw new Error(`grant not applied: ${JSON.stringify(answer.body)}`);
  console.log(JSON.stringify({ lotId: result.lotId }));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await core.closeDb();
}
