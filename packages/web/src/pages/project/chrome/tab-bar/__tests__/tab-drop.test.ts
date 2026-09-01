// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import { arrayMove } from '@dnd-kit/sortable';

import { applyTabMove } from '@breatic/shared';
import { resolveTabDrop } from '@web/pages/project/chrome/tab-bar/tab-drop';

const IDS = ['a', 'b', 'c', 'd'];

describe('resolveTabDrop', () => {
  it('names the tab that follows the drop when dragging backwards', () => {
    expect(resolveTabDrop(IDS, 'd', 'b')).toEqual({
      spaceId: 'd',
      beforeSpaceId: 'b',
    });
  });

  it('names the tab that follows the drop when dragging forwards', () => {
    // Dropping onto a tab further along lands after it, so the anchor is
    // whatever used to sit behind that tab.
    expect(resolveTabDrop(IDS, 'a', 'c')).toEqual({
      spaceId: 'a',
      beforeSpaceId: 'd',
    });
  });

  it('has no anchor when the tab lands at the end', () => {
    expect(resolveTabDrop(IDS, 'a', 'd')).toEqual({
      spaceId: 'a',
      beforeSpaceId: null,
    });
  });

  it('resolves nothing when a tab is dropped on itself', () => {
    expect(resolveTabDrop(IDS, 'a', 'a')).toBeNull();
  });

  it('resolves nothing when the dragged tab is not in the strip', () => {
    expect(resolveTabDrop(IDS, 'zz', 'a')).toBeNull();
  });

  it('resolves nothing when the drop target is not in the strip', () => {
    expect(resolveTabDrop(IDS, 'a', 'zz')).toBeNull();
  });

  it('resolves nothing when there is no drop target', () => {
    expect(resolveTabDrop(IDS, 'a', null)).toBeNull();
  });

  it('describes every drop the same way the strip renders it', () => {
    // The strip is laid out by dnd-kit and rewritten by applyTabMove, one on
    // each side of the wire. A move that the two disagree about would show the
    // user one order on release and another once the broadcast lands.
    for (const from of IDS) {
      for (const to of IDS) {
        const drop = resolveTabDrop(IDS, from, to);
        const sorted = arrayMove(IDS, IDS.indexOf(from), IDS.indexOf(to));
        if (drop === null) {
          expect(sorted).toEqual(IDS);
          continue;
        }
        expect(
          applyTabMove(IDS, drop.spaceId, drop.beforeSpaceId),
        ).toEqual(sorted);
      }
    }
  });
});
