// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How many readings of media one worker process holds at once (inner#1337
 * §3.3).
 *
 * A reading loads the media into memory, up to `max_media_bytes`, and the
 * tasks queue runs many jobs at once. A reading that finds every place taken
 * goes back to the queue instead of waiting in its worker slot.
 */

import { getUnderstandConfig, getWorkerConfig } from "@breatic/core";

import { StillRunning } from "@worker/handlers/still-running.js";

let taken = 0;

/**
 * Run one reading of media inside a place.
 * @param read - The reading.
 * @returns What the reading answered.
 * @throws {StillRunning} When every place is taken; the reading did not start.
 */
export async function withUnderstandSlot<T>(read: () => Promise<T>): Promise<T> {
  if (taken >= getUnderstandConfig().max_concurrent) {
    throw new StillRunning(Date.now() + getWorkerConfig().poll_interval);
  }
  taken += 1;
  try {
    return await read();
  } finally {
    taken -= 1;
  }
}
