// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * How one turn's `web_fetch` reads pages: rate limited per user, then sent to
 * the ingest Worker, which reads them in a container of its own (inner#1664).
 */
import { checkRateLimit, env, getRedis, logger } from "@breatic/core";
import { ReadPagesRefused, type ReadPages } from "@breatic/domain";
import { readPagesAtIngest } from "@breatic/shared";

import { getRateLimit } from "@server/config/rate-limits.js";

/** The rate limit a call counts against, in `config/rate-limits.yaml`. */
const THROTTLE = "web-fetch";

/**
 * The read one turn hands its tool, bound to the user.
 *
 * One call counts once however many links it names: the container it starts
 * is what costs, and one call starts one.
 * @param who - The turn's user.
 * @param who.userId - Who the calls are counted against.
 * @returns The read.
 * @throws {never} Never; the read it returns throws.
 */
export function readPagesFor({ userId }: { userId: string }): ReadPages {
  return async (request, signal) => {
    const { max, windowSeconds } = getRateLimit(THROTTLE);
    const verdict = await checkRateLimit(getRedis(), [{ key: `${THROTTLE}:${userId}`, max, windowSeconds }]);
    if (!verdict.allowed) {
      logger.warn({ action: THROTTLE, key: userId }, "rate_limit_hit");
      throw new ReadPagesRefused("rate_limited");
    }
    return readPagesAtIngest(env.INGEST_BASE_URL, env.INGEST_SHARED_SECRET, request, signal);
  };
}
