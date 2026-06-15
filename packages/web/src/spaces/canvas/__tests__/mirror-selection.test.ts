// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import type { Node } from '@xyflow/react';

import { mergeMirroredSelection } from '@web/spaces/canvas/mirror-selection';

describe('mergeMirroredSelection', () => {
  it('carries forward selected + dragging by id while taking data/position from the fresh nodes', () => {
    const prev = [
      {
        id: 'a',
        type: 'text',
        position: { x: 0, y: 0 },
        data: {},
        selected: true,
        dragging: true,
      },
      { id: 'b', type: 'image', position: { x: 0, y: 0 }, data: {}, selected: false },
    ] as Node[];
    // Fresh nodes come straight from the Yjs mirror — no selection field, and
    // `a` has moved (a collaborator dragged it).
    const fresh = [
      { id: 'a', type: 'text', position: { x: 9, y: 9 }, data: { name: 'A' } },
      { id: 'b', type: 'image', position: { x: 0, y: 0 }, data: {} },
      { id: 'c', type: 'audio', position: { x: 5, y: 5 }, data: {} },
    ] as Node[];

    const merged = mergeMirroredSelection(prev, fresh);

    const a = merged.find((n) => n.id === 'a');
    expect(a?.selected).toBe(true); // selection survives the mirror rebuild
    expect(a?.dragging).toBe(true);
    expect(a?.position).toEqual({ x: 9, y: 9 }); // position still from Yjs
    expect((a?.data as { name?: string }).name).toBe('A');

    expect(merged.find((n) => n.id === 'b')?.selected).toBe(false);
    // A brand-new node (just created) is left unselected here; the auto-select
    // effect selects it explicitly once it appears.
    expect(merged.find((n) => n.id === 'c')?.selected).toBeUndefined();
  });
});
