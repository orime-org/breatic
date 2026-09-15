// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How much of the caller's window the container may still have (#207 §7.6.1).
 *
 * One call covers two stages that are not alike. The transfer, the assembly
 * and the hash have to succeed — they are the upload. Reading a resolution and
 * cutting a poster is beside it: storage rule 3 says a video whose frame could
 * not be lifted is a successful upload with no thumbnail.
 *
 * Sharing one deadline between them lets the second stage spend what the first
 * one needs. When it does, the caller's own timer fires on an object that is
 * already stored and hashed, the transfer is thrown away, and the reason the
 * node shows names the source. So the run is held to what is left rather than
 * to its own figure.
 */

import type { MediaLimits } from "@breatic/shared";

/**
 * The limits to hold one container run to, or null to ask for no run.
 * @param limits - What the caller said a run may have, or null for no run.
 * @param answerBy - When this call has to be answered, as epoch ms; null when
 *   the caller named no window, which the lanes that send their own bytes do.
 * @param now - The current instant, as epoch ms.
 * @returns The limits to send, or null when there is no room for a run.
 */
export function runWindowLeft(
  limits: MediaLimits | null,
  answerBy: number | null,
  now: number,
): MediaLimits | null {
  if (limits === null) return null;
  if (answerBy === null) return limits;
  const left = answerBy - now;
  if (left <= 0) return null;
  return {
    ...limits,
    runDeadlineMs: Math.min(limits.runDeadlineMs, left),
  };
}
