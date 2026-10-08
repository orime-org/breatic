// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, beforeEach } from 'vitest';

import {
  stashRetryFile,
  getRetryUpload,
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
    expect(getRetryUpload('p1', 's1', 't1')).toEqual({ file });
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
    expect(getRetryUpload('p1', 's1', 't1')).toBeUndefined();
  });

  it('keeps two failures on one node apart (#186 §3.7.2)', () => {
    // Two uploads onto the same node each keep their own File, so retrying
    // one re-sends what that one was carrying.
    const first = f('first.png');
    const second = f('second.png');
    stashRetryFile('p1', 's1', 't1', first);
    stashRetryFile('p1', 's1', 't2', second);

    expect(getRetryUpload('p1', 's1', 't1')?.file).toBe(first);
    expect(getRetryUpload('p1', 's1', 't2')?.file).toBe(second);

    // …and clearing one leaves the other alone.
    clearRetryFile('p1', 's1', 't1');
    expect(getRetryUpload('p1', 's1', 't2')?.file).toBe(second);
  });

  it('a re-stash overwrites (latest failed file wins)', () => {
    stashRetryFile('p1', 's1', 't1', f('old.png'));
    const next = f('new.png');
    stashRetryFile('p1', 's1', 't1', next);

    expect(getRetryUpload('p1', 's1', 't1')?.file).toBe(next);
  });

  // inner#888 §7.5: a browser tool's export uploads with the tool named on
  // the ticket, so its task row reads as that tool. A retry that dropped the
  // context would come back as a plain upload.
  it('hands back the upload context the failed upload carried', () => {
    const file = f('rotated.png');
    const context = { source: 'mini_tool' as const, toolName: 'image.rotate' };
    stashRetryFile('p1', 's1', 't1', file, context);

    expect(getRetryUpload('p1', 's1', 't1')).toEqual({ file, context });
  });
});
