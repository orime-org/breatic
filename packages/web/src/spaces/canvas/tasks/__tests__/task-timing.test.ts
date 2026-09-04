// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a running task's row counts (#186 §7.3).
 *
 * Both numbers are derived every second from two absolute instants the server
 * decided — the moment it opened and the allowance it was given. Nothing here
 * judges anything: whether a task ran out of time is the timer's call, and a
 * row can read "0 left" for a while before the server says so.
 */

import { describe, it, expect } from 'vitest';

import {
  splitDuration,
  remainingMs,
  elapsedMs,
  formatDuration,
} from '@web/spaces/canvas/tasks/task-timing';

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
    // A row can outlive its allowance before the timer's knock arrives; the
    // number stops at zero instead of reading "-3 minutes".
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

describe('remainingMs', () => {
  const started = '2026-09-03T10:00:00.000Z';
  const startedMs = Date.parse(started);

  it('counts down from the allowance the server gave this task', () => {
    expect(remainingMs(started, 10 * MINUTE, startedMs + 4 * MINUTE)).toBe(
      6 * MINUTE,
    );
  });

  it('goes to zero once the allowance is used up', () => {
    expect(remainingMs(started, 10 * MINUTE, startedMs + 11 * MINUTE)).toBe(0);
  });

  it('reads the full allowance at the instant it opened', () => {
    expect(remainingMs(started, 10 * MINUTE, startedMs)).toBe(10 * MINUTE);
  });

  it('reads zero when the instant cannot be parsed', () => {
    // A row whose timestamp we cannot read shows no countdown at all rather
    // than a number derived from NaN.
    expect(remainingMs('not a time', 10 * MINUTE, startedMs)).toBe(0);
  });
});

describe('elapsedMs', () => {
  const started = '2026-09-03T10:00:00.000Z';
  const startedMs = Date.parse(started);

  it('counts up from the instant the server opened it', () => {
    expect(elapsedMs(started, startedMs + 90 * SECOND)).toBe(90 * SECOND);
  });

  it('reads zero on a reader whose clock is behind the server', () => {
    // Nothing is judged from this number, so a clock a few seconds behind
    // shows a stopped counter rather than a negative one.
    expect(elapsedMs(started, startedMs - 5 * SECOND)).toBe(0);
  });

  it('reads zero when the instant cannot be parsed', () => {
    expect(elapsedMs('not a time', startedMs)).toBe(0);
  });
});

describe('formatDuration', () => {
  it('reads a sub-hour duration as minutes and seconds', () => {
    expect(formatDuration(10 * 60 * SECOND)).toBe('10:00');
  });

  it('pads the seconds so the counter does not change width every tick', () => {
    expect(formatDuration(65 * SECOND)).toBe('1:05');
  });

  it('adds an hours field once there is one, padding the minutes with it', () => {
    expect(formatDuration(2 * 60 * 60 * SECOND + 5 * 60 * SECOND)).toBe(
      '2:05:00',
    );
  });

  it('keeps hours as the top unit however long the allowance is', () => {
    // A 30-hour allowance reads as 30 hours; nothing here counts in days.
    expect(formatDuration(30 * 60 * 60 * SECOND)).toBe('30:00:00');
  });

  it('reads all zeros once a task is past its allowance', () => {
    expect(formatDuration(-1)).toBe('0:00');
  });
});
