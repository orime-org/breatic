// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The figures a task's reading runs under (inner#1367).
 *
 * A reading on the canvas is a task, and a task's chain is bounded by its
 * deadline and by nothing of its own: the fetch, the read of the body and the
 * model call each get what is left of it, and the deadline travels as the
 * signal so a resend cannot stretch it. The Agent tool's reading is not a
 * canvas task and keeps its own figures from `config/agent.yaml`.
 */

import { MAX_TIMER_MS, signalUntil } from "@breatic/shared";
import type { FetchMediaRequest, UnderstandRequest } from "@domain/understand/types.js";

/** The four timing figures and the signal a reading takes. */
export type ReadingLimits = Pick<
  FetchMediaRequest,
  "fetchTimeoutMs" | "minBytesPerSec" | "readFloorMs"
> &
  Pick<UnderstandRequest, "timeoutMs"> & { signal: AbortSignal };

/**
 * Every figure of a reading, from what is left before the task's deadline.
 * @param deadlineAt - When the task runs out, in epoch ms.
 * @param maxBytes - The largest file the reading takes.
 * @param now - The clock now, in epoch ms.
 * @returns The figures and the signal.
 * @throws {DeadlinePassed} When the deadline has already come.
 */
export function readingLimitsUntil(
  deadlineAt: number,
  maxBytes: number,
  now: number = Date.now(),
): ReadingLimits {
  const signal = signalUntil(deadlineAt, now);
  const left = Math.min(deadlineAt - now, MAX_TIMER_MS);
  return {
    fetchTimeoutMs: left,
    readFloorMs: left,
    timeoutMs: left,
    // The read budget is max(floor, size / rate). At this rate the largest
    // file arrives in exactly what is left, so no size stretches the read past
    // the deadline.
    minBytesPerSec: Math.max(1, Math.ceil((maxBytes * 1000) / left)),
    signal,
  };
}
