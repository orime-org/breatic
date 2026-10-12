// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What a running task's row counts (#186 §7.3): the time since the instant
 * the server opened it, derived every second. Nothing here judges anything.
 */

import { describe, it, expect } from 'vitest';

import { elapsedMs } from '@web/spaces/canvas/tasks/task-timing';

const SECOND = 1000;

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
