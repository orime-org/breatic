// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * What a node shows as uploading in its reference list (#1580): this page's own crop until its bytes are sent, then
 * the node's `focusUploads`, which every member sees, the way a node's upload shows its local mark and then its task
 * row.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { uploadingFocusOf, useUploadingFocus } from '@web/spaces/canvas/focus/focus-uploading';

const NOW = 1_000_000;
const LATER = NOW + 60_000;

const LOCAL = [
  { id: 'a', nodeId: 'n1', name: 'Mine' },
  { id: 'b', nodeId: 'n2', name: 'Other node' },
];

describe('uploadingFocusOf', () => {
  it('shows this page\'s crop for the node before the node knows of it', () => {
    expect(uploadingFocusOf(LOCAL, 'n1', { focusUploads: [], focusImages: [] }, NOW)).toEqual([{ id: 'a', name: 'Mine' }]);
  });

  it('shows a member\'s crop the node holds as uploading, and this page\'s same crop once', () => {
    const data = { focusUploads: [{ id: 'a', name: 'Mine', width: 4, height: 3, deadlineAt: LATER }, { id: 'c', name: 'Theirs', width: 4, height: 3, deadlineAt: LATER }] };
    expect(uploadingFocusOf(LOCAL, 'n1', data, NOW)).toEqual([{ id: 'a', name: 'Mine' }, { id: 'c', name: 'Theirs' }]);
  });

  it('never shows as uploading a crop already in the pool', () => {
    const data = { focusImages: [{ id: 'a', url: 'https://cdn.test/a.png', name: 'Mine', width: 4, height: 3 }] };
    expect(uploadingFocusOf(LOCAL, 'n1', data, NOW)).toEqual([]);
  });

  it('stops showing a crop whose time is up, as a task row past its budget is over', () => {
    const data = { focusUploads: [{ id: 'c', name: 'Theirs', width: 4, height: 3, deadlineAt: NOW }, { id: 'd', name: 'Still', width: 4, height: 3, deadlineAt: LATER }] };
    expect(uploadingFocusOf([], 'n1', data, NOW)).toEqual([{ id: 'd', name: 'Still' }]);
  });

  it('reads untrusted lists through the shared readers', () => {
    expect(uploadingFocusOf([], 'n1', { focusUploads: [{ id: '', name: 'x', width: 1, height: 1, deadlineAt: LATER }, 'junk'] }, NOW)).toEqual([]);
    expect(uploadingFocusOf([], 'n1', undefined, NOW)).toEqual([]);
  });
});

describe('useUploadingFocus', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops a crop from the rail at its deadline with nothing else changing', () => {
    vi.useFakeTimers({ now: NOW });
    const data = { focusUploads: [{ id: 'c', name: 'Theirs', width: 4, height: 3, deadlineAt: LATER }] };
    const { result } = renderHook(() => useUploadingFocus([], 'n1', data));
    expect(result.current).toEqual([{ id: 'c', name: 'Theirs' }]);
    act(() => {
      vi.advanceTimersByTime(LATER - NOW);
    });
    expect(result.current).toEqual([]);
  });
});
