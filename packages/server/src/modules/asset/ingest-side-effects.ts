// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Writing down what registering an upload could not do (#181, #207).
 *
 * Registration runs in a library, which holds no logger, so the things that
 * can fail beside an upload without failing it — the reclaim queue for an
 * object that lost a dedup race, the node's counts, the project's activity
 * row, a cover that could not be filed — come back as fields. Each is the
 * only account anybody gets of that failure.
 *
 * Both routes that settle an upload come through here, so a lane added later
 * writes down every flag rather than the ones somebody remembered. The worker
 * has the same pass of its own (`@worker/handlers/side-effects.js`); the two
 * read the same table, because a service cannot import another service.
 */

import { logger } from "@breatic/core";
import {
  INGEST_SIDE_EFFECT_EVENTS,
  type IngestSideEffects,
} from "@breatic/domain";

/**
 * Log every side effect that went wrong.
 * @param storageKey - The key being registered, for the log line.
 * @param outcome - What registration answered with.
 */
export function noteIngestSideEffects(
  storageKey: string,
  outcome: IngestSideEffects,
): void {
  for (const [flag, event] of Object.entries(INGEST_SIDE_EFFECT_EVENTS)) {
    if (outcome[flag as keyof IngestSideEffects] === true) {
      logger.error({ key: storageKey }, event);
    }
  }
}
