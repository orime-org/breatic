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
  const claimed = await getRedis().set(
    noticeKey(adminUserId),
    1,
    "EX",
    getStorageNoticeWindowSeconds(),
    "NX",
  );
  return claimed === "OK";
}

/**
 * Give the slot back, because no notice went out after all.
 *
 * The key means "an account has been told", so a claim that ended in a failed
 * insert or a failed send is holding a place for something that never
 * happened. Left there, the next refusal is silenced too and the admin hears
 * nothing for a whole window about an account that is still full.
 * @param adminUserId - The account whose slot to release.
 * @throws {Error} if Redis is unreachable; the caller already has nothing to
 *   report and treats this the same way.
 */
export async function releaseNoticeWindow(adminUserId: string): Promise<void> {
  await getRedis().del(noticeKey(adminUserId));
}

/**
 * The DB0 key holding one account's notice window.
 *
 * Same shape as the other keys there (`checkRateLimit` builds
 * `${env.ENV}:ratelimit:…`): environment, service, entity, id.
 * @param adminUserId - The account the window belongs to.
 * @returns The Redis key.
 */
function noticeKey(adminUserId: string): string {
  return `${env.ENV}:server:storage-notice:${adminUserId}`;
}
