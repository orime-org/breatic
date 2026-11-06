// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/** Frame counts shown as HH:MM:SS:FF timecode at the nominal frame rate (inner#1708 W18a). */

import { describe, expect, it } from 'vitest';

import { formatTimelineTimecode } from '@web/spaces/timeline/timeline-timecode';

const FILM = { num: 24, den: 1 };
const NTSC = { num: 30000, den: 1001 };

describe('formatTimelineTimecode', () => {
  it.each([
    [0, FILM, '00:00:00:00'],
    [23, FILM, '00:00:00:23'],
    [24, FILM, '00:00:01:00'],
    [24 * 3600 + 24 * 61 + 5, FILM, '01:01:01:05'],
    [30, NTSC, '00:00:01:00'],
    [29, NTSC, '00:00:00:29'],
  ] as const)('shows frame %i at %o as %s', (frame, fps, expected) => {
    expect(formatTimelineTimecode(frame, fps)).toBe(expected);
  });

  it('lets the hours grow past two digits', () => {
    expect(formatTimelineTimecode(24 * 3600 * 100, FILM)).toBe('100:00:00:00');
  });
});
