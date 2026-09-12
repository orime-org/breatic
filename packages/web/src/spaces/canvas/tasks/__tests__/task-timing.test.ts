// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a running task's row counts (#186 §7.3).
 *
 * Both numbers are derived every second from two absolute instants the server
 * decided — the moment it opened and the allowance it was given. Nothing here
 * judges anything: whether a task ran out of time is settled server-side when
 * somebody reads the node's task list, so a row can read "0 left" for a while
 * before the server says so.
 */

import { describe, it, expect } from 'vitest';

import { remainingMs, elapsedMs } from '@web/spaces/canvas/tasks/task-timing';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

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
