// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * One "storage is full" notice per account per window (#89).
 *
 * KEYED BY THE ADMIN'S ACCOUNT, NOT BY STUDIO. The ceiling is a sum over every
 * studio that account administers, so what filled up is the account. Keyed by
 * studio, one event would produce a notice per studio — and all but one of
 * them would name a studio holding hardly anything.
 *
 * `SET key 1 NX EX <window>` and nothing else. One command, so the claim is
 * atomic against any number of concurrent refusals; the repo's other throttle
 * (`checkRateLimit`) cannot be reused here for three separate reasons — it is
 * a Hono middleware with a `(c, next)` signature, it keys on ip-or-user rather
 * than "this studio's admin", and it answers with a 429 that would displace
 * the 507. It is also several commands in a `pipeline()`, which batches the
 * round trips without making them one step.
 */

import { env, getRedis } from "@breatic/core";
import { getStorageNoticeWindowSeconds } from "@server/config/limits.js";

/**
 * Take this window's single notice slot for an account.
 * @param adminUserId - The account whose storage is full.
 * @returns `true` if this caller took the slot and should send the notice,
 *   `false` if this window's notice already went out.
 * @throws {Error} if Redis is unreachable — the caller decides what a lost
 *   claim means, and for a notice about a full account the answer is to send
 *   it anyway rather than go quiet.
 */
export async function claimNoticeWindow(adminUserId: string): Promise<boolean> {
  // Same shape as the other DB0 keys (`checkRateLimit` builds
  // `${env.ENV}:ratelimit:…`): environment, service, entity, id.
  const key = `${env.ENV}:server:storage-notice:${adminUserId}`;
  const claimed = await getRedis().set(
    key,
    1,
    "EX",
    getStorageNoticeWindowSeconds(),
    "NX",
  );
  return claimed === "OK";
}
