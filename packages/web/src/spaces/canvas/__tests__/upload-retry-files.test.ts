// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

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
  it('stashes and retrieves a file per (project, space, node)', () => {
    const file = f('a.png');
    stashRetryFile('p1', 's1', 'n1', file);

    expect(hasRetryFile('p1', 's1', 'n1')).toBe(true);
    expect(getRetryFile('p1', 's1', 'n1')).toBe(file);
  });

  it('scopes by all three ids — a different node/space/project misses', () => {
    stashRetryFile('p1', 's1', 'n1', f('a.png'));

    expect(hasRetryFile('p1', 's1', 'n2')).toBe(false);
    expect(hasRetryFile('p1', 's2', 'n1')).toBe(false);
    expect(hasRetryFile('p2', 's1', 'n1')).toBe(false);
  });

  it('clear removes the stash (retry button disappears after success)', () => {
    stashRetryFile('p1', 's1', 'n1', f('a.png'));
    clearRetryFile('p1', 's1', 'n1');

    expect(hasRetryFile('p1', 's1', 'n1')).toBe(false);
    expect(getRetryFile('p1', 's1', 'n1')).toBeUndefined();
  });

  it('a re-stash overwrites (latest failed file wins)', () => {
    stashRetryFile('p1', 's1', 'n1', f('old.png'));
    const next = f('new.png');
    stashRetryFile('p1', 's1', 'n1', next);

    expect(getRetryFile('p1', 's1', 'n1')).toBe(next);
  });
});
