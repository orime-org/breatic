// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type { TimelineRate } from '@breatic/shared';

/**
 * Two digits, zero-padded.
 * @param value - A non-negative whole number.
 * @returns The padded text.
 * @throws {never} Never.
 */
function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * A frame count as HH:MM:SS:FF timecode, counted at the nominal (rounded) frame rate as non-drop-frame timecode is.
 * @param frame - The whole frame count.
 * @param fps - The Timeline's frame rate.
 * @returns The timecode.
 * @throws {never} Never.
 */
export function formatTimelineTimecode(frame: number, fps: TimelineRate): string {
  const nominal = Math.max(1, Math.round(fps.num / fps.den));
  const seconds = Math.floor(frame / nominal);
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}:${pad(frame % nominal)}`;
}
