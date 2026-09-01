// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The queue a video's cover extraction is asked for on (#173, design §5.3).
 *
 * Two paths ask. A report that registered a new video asks for its cover; a
 * dedup hit that resolved to a video whose cover has not been extracted yet
 * asks to be told when it is. Both put one job per waiting node on the same
 * queue, so the handle lives here rather than inside either of them.
 */

import { createQueue } from "@breatic/core";
import { VIDEO_COVER_QUEUE } from "@breatic/domain";

/**
 * Built on first use, not at import: `createQueue` reads the Redis URL out of
 * the validated config, and this module is reachable from imports that run
 * before an entry point has called `initCore`.
 */
let queue: ReturnType<typeof createQueue> | null = null;

/**
 * The cover queue, created on first use.
 * @returns The shared BullMQ queue handle.
 */
export function getCoverQueue(): ReturnType<typeof createQueue> {
  queue ??= createQueue(VIDEO_COVER_QUEUE);
  return queue;
}
