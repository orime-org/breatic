// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, beforeEach } from 'vitest';

import {
  stashRetryFile,
  getRetryFile,
  clearRetryFile,
  hasRetryFile,
  resetRetryFilesForTests,
} from '@web/spaces/canvas/upload-retry-files';

const f = (name: string): File => new File(['x'], name, { type: 'image/png' });

beforeEach(() => {
  resetRetryFilesForTests();
});

describe('upload retry file stash — session-scoped File references', () => {
  it('stashes and retrieves a file per (project, space, task)', () => {
    const file = f('a.png');
    stashRetryFile('p1', 's1', 't1', file);

    expect(hasRetryFile('p1', 's1', 't1')).toBe(true);
    expect(getRetryFile('p1', 's1', 't1')).toBe(file);
  });

  it('scopes by all three ids — a different task/space/project misses', () => {
    stashRetryFile('p1', 's1', 't1', f('a.png'));

    expect(hasRetryFile('p1', 's1', 't2')).toBe(false);
    expect(hasRetryFile('p1', 's2', 't1')).toBe(false);
    expect(hasRetryFile('p2', 's1', 't1')).toBe(false);
  });

  it('clear removes the stash (retry button disappears after success)', () => {
    stashRetryFile('p1', 's1', 't1', f('a.png'));
    clearRetryFile('p1', 's1', 't1');

    expect(hasRetryFile('p1', 's1', 't1')).toBe(false);
    expect(getRetryFile('p1', 's1', 't1')).toBeUndefined();
  });

  it('keeps two failures on one node apart (#186 §3.7.2)', () => {
    // Two uploads onto the same node each keep their own File, so retrying
    // one re-sends what that one was carrying.
    const first = f('first.png');
    const second = f('second.png');
    stashRetryFile('p1', 's1', 't1', first);
    stashRetryFile('p1', 's1', 't2', second);

    expect(getRetryFile('p1', 's1', 't1')).toBe(first);
    expect(getRetryFile('p1', 's1', 't2')).toBe(second);

    // …and clearing one leaves the other alone.
    clearRetryFile('p1', 's1', 't1');
    expect(getRetryFile('p1', 's1', 't2')).toBe(second);
  });

  it('a re-stash overwrites (latest failed file wins)', () => {
    stashRetryFile('p1', 's1', 't1', f('old.png'));
    const next = f('new.png');
    stashRetryFile('p1', 's1', 't1', next);

    expect(getRetryFile('p1', 's1', 't1')).toBe(next);
  });
});
