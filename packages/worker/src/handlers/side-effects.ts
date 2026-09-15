// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Writing down what registration could not do (#181, #207).
 *
 * Registration runs in a library that holds no logger, so the things that can
 * fail beside an upload without failing it — the reclaim queue for an object
 * that lost a dedup race, the node's counts, the project's activity row, a
 * cover that could not be filed — come back as fields. Each is the only
 * account anybody gets of that failure.
 *
 * One pass over the table that names them, so a field added later is written
 * down by every lane rather than by the ones somebody remembered.
 */

import { logger } from "@breatic/core";
import {
  INGEST_SIDE_EFFECT_EVENTS,
  type IngestSideEffects,
} from "@breatic/domain";

/**
 * Log every side effect that went wrong.
 * @param effects - What the report handed back.
 * @param ctx - What names this upload in the log.
 */
export function noteSideEffects(
  effects: IngestSideEffects,
  ctx: Record<string, unknown>,
): void {
  for (const [flag, event] of Object.entries(INGEST_SIDE_EFFECT_EVENTS)) {
    if (effects[flag as keyof IngestSideEffects] === true) {
      logger.error(ctx, event);
    }
  }
}
