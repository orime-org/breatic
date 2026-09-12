// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * How the canvas writes a duration out.
 *
 * One definition serves both places that show one — a running task's counter
 * and the media player's position — so the last block here is about the two
 * agreeing rather than about either of them alone.
 */

import { describe, it, expect } from 'vitest';

import {
  formatDuration,
  formatSeconds,
  splitDuration,
} from '@web/spaces/canvas/lib/duration';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

describe('splitDuration', () => {
  it('splits into hours, minutes and seconds', () => {
    expect(splitDuration(2 * HOUR + 3 * MINUTE + 4 * SECOND)).toEqual({
      hours: 2,
      minutes: 3,
      seconds: 4,
    });
  });

  it('drops the part of a second nobody reads', () => {
    expect(splitDuration(4500)).toEqual({ hours: 0, minutes: 0, seconds: 4 });
  });

  it('reads zero for a duration that has not started', () => {
    expect(splitDuration(0)).toEqual({ hours: 0, minutes: 0, seconds: 0 });
  });

  it('floors a negative duration at zero rather than counting backwards', () => {
    // A row can outlive its allowance before anyone opens the list that
    // harvests it; the number stops at zero instead of reading "-3 minutes".
    expect(splitDuration(-5 * MINUTE)).toEqual({
      hours: 0,
      minutes: 0,
      seconds: 0,
    });
  });

  it('carries hours past a day rather than adding a day unit', () => {
    // The longest allowance a task gets is measured in hours, so hours are
    // the top unit and 30 hours reads as 30 hours.
    expect(splitDuration(30 * HOUR)).toMatchObject({ hours: 30, minutes: 0 });
  });
});

describe('formatDuration', () => {
  it('reads a sub-hour duration as minutes and seconds', () => {
    expect(formatDuration(10 * MINUTE)).toBe('10:00');
  });

  it('pads the seconds so the counter does not change width every tick', () => {
    expect(formatDuration(65 * SECOND)).toBe('1:05');
  });

  it('adds an hours field once there is one, padding the minutes with it', () => {
    expect(formatDuration(2 * HOUR + 5 * MINUTE)).toBe('2:05:00');
  });

  it('keeps hours as the top unit however long the allowance is', () => {
    // A 30-hour allowance reads as 30 hours; nothing here counts in days.
    expect(formatDuration(30 * HOUR)).toBe('30:00:00');
  });

  it('reads all zeros once a task is past its allowance', () => {
    expect(formatDuration(-1)).toBe('0:00');
  });
});

describe('formatSeconds', () => {
  it('carries the hour the same way the task counter does', () => {
    // The reader sees both on one screen. An hour-long video used to read
    // "60:00" here while an hour-old task read "1:00:00".
    expect(formatSeconds(3600)).toBe(formatDuration(HOUR));
    expect(formatSeconds(3600)).toBe('1:00:00');
  });

  it('reads the start for a duration the media has not reported yet', () => {
    // A media element answers NaN for its duration until it has the metadata.
    expect(formatSeconds(Number.NaN)).toBe('0:00');
  });

  it('reads minutes and seconds below the hour', () => {
    expect(formatSeconds(75)).toBe('1:15');
  });
});
