// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The panel follows a video node's shots as they change: shots entered, a
 * shot's seconds moved, here or by a collaborator.
 */

import { act, renderHook } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import type { CanvasNodeFields } from '@breatic/shared';
import * as Y from 'yjs';

import { _resetForTests } from '@web/data/yjs/manager';
import { addNode } from '@web/data/yjs/canvas-space';
import { enterStoryboardShots, stepStoryboardShot } from '@web/data/yjs/node-storyboard';
import { useShots } from '@web/data/yjs/use-storyboard';

const PID = 'p1';
const SID = 's1';

const VIDEO: CanvasNodeFields = {
  id: 'v1',
  type: 'video',
  position: { x: 0, y: 0 },
  data: { name: 'V', createdAt: 1, createdBy: 'u1', locked: false, attachments: [] },
};

describe('following the shots', () => {
  beforeEach(() => {
    _resetForTests();
    addNode(PID, SID, VIDEO);
  });

  it('starts with no shots', () => {
    const { result } = renderHook(() => useShots(PID, SID, 'v1'));
    expect(result.current).toEqual([]);
  });

  it('follows the shots entering the mode brings', () => {
    const { result } = renderHook(() => useShots(PID, SID, 'v1'));
    act(() => enterStoryboardShots(PID, SID, 'v1', 5));
    expect(result.current?.map((s) => s.duration)).toEqual([2, 3]);
  });

  it('follows a shot seconds change', () => {
    const { result } = renderHook(() => useShots(PID, SID, 'v1'));
    act(() => enterStoryboardShots(PID, SID, 'v1', 5));
    const first = result.current?.[0]?.id ?? '';
    act(() => stepStoryboardShot(PID, SID, 'v1', first, 1));
    expect(result.current?.map((s) => s.duration)).toEqual([3, 2]);
  });

  it('keeps the same read while words are typed inside a shot', () => {
    const { result } = renderHook(() => useShots(PID, SID, 'v1'));
    act(() => enterStoryboardShots(PID, SID, 'v1', 5));
    const before = result.current;
    act(() => {
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('a paper boat')]);
      before?.[0]?.prompt.insert(0, [paragraph]);
    });
    expect(result.current).toBe(before);
  });

  it('sees a change made after its read and before it subscribed', () => {
    let changed = false;
    const { result } = renderHook(() => {
      const shots = useShots(PID, SID, 'v1');
      // A collaborator's write landing between the render-time read and the
      // subscription in the effect.
      if (!changed) {
        changed = true;
        enterStoryboardShots(PID, SID, 'v1', 5);
      }
      return shots;
    });
    expect(result.current).toHaveLength(2);
  });
});
