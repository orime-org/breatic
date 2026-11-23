// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a node shows as uploading in its reference list (#1580): this page's own crop until its bytes are sent, then
 * the node's `focusUploads`, which every member sees, the way a node's upload shows its local mark and then its task
 * row.
 */

import { describe, expect, it } from 'vitest';

import { uploadingFocusOf } from '@web/spaces/canvas/focus/focus-uploading';

const LOCAL = [
  { id: 'a', nodeId: 'n1', name: 'Mine' },
  { id: 'b', nodeId: 'n2', name: 'Other node' },
];

describe('uploadingFocusOf', () => {
  it('shows this page\'s crop for the node before the node knows of it', () => {
    expect(uploadingFocusOf(LOCAL, 'n1', { focusUploads: [], focusImages: [] })).toEqual([{ id: 'a', name: 'Mine' }]);
  });

  it('shows a member\'s crop the node holds as uploading, and this page\'s same crop once', () => {
    const data = { focusUploads: [{ id: 'a', name: 'Mine', width: 4, height: 3 }, { id: 'c', name: 'Theirs', width: 4, height: 3 }] };
    expect(uploadingFocusOf(LOCAL, 'n1', data)).toEqual([{ id: 'a', name: 'Mine' }, { id: 'c', name: 'Theirs' }]);
  });

  it('never shows as uploading a crop already in the pool', () => {
    const data = { focusImages: [{ id: 'a', url: 'https://cdn.test/a.png', name: 'Mine', width: 4, height: 3 }] };
    expect(uploadingFocusOf(LOCAL, 'n1', data)).toEqual([]);
  });

  it('reads untrusted lists through the shared readers', () => {
    expect(uploadingFocusOf([], 'n1', { focusUploads: [{ id: '', name: 'x', width: 1, height: 1 }, 'junk'] })).toEqual([]);
    expect(uploadingFocusOf([], 'n1', undefined)).toEqual([]);
  });
});
