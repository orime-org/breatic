// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The join panel's draft in the canvas session (inner#1825 §6.5): opened with
 * the clips a multi-selection prefilled, held as one ordered list keyed by
 * node (the first clip included), and reordered by node without moving the
 * panel off the node it hangs under.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { MiniToolSlotValue } from '@breatic/shared/mini-tools';

import { canvasSessions } from '@web/stores/canvas-session';

const A = { url: 'https://cdn/a.mp3', duration: 10, nodeId: 'a', name: 'A' } as MiniToolSlotValue;
const B = { url: 'https://cdn/b.mp3', duration: 4, nodeId: 'b', name: 'B' } as MiniToolSlotValue;
const C = { url: 'https://cdn/c.mp3', duration: 8, nodeId: 'c', name: 'C' } as MiniToolSlotValue;

/**
 * The session of the Space these cases use.
 * @returns Its current state.
 */
function session(): ReturnType<ReturnType<typeof canvasSessions.of>['getState']> {
  return canvasSessions.of('join-space').getState();
}

/**
 * The node ids the list holds, in order.
 * @returns Them.
 */
function order(): (string | undefined)[] {
  return ((session().miniTool?.slots.clips ?? []) as readonly { nodeId?: string }[]).map((value) => value.nodeId);
}

beforeEach(() => {
  session().closeActivePanel();
});

describe('the join draft (inner#1825 §6.5)', () => {
  it('opens the join panel on the first clip with the whole list prefilled, the first clip included', () => {
    session().openJoinPanel('audio.join', [A, B, C]);

    expect(session().panelKind).toBe('miniTool');
    expect(session().panelHostId).toBe('a');
    expect(session().miniTool?.toolId).toBe('audio.join');
    expect(session().miniTool?.slots.clips).toEqual([A, B, C]);
    expect(session().miniTool?.sourceContent).toBe(A.url);
  });

  it('replaces whatever the tool’s panel held before with the prefilled list', () => {
    session().openMiniTool('a', 'audio.join', { sourceContent: A.url, params: {} });
    session().openJoinPanel('audio.join', [A, C]);
    expect(order()).toEqual(['a', 'c']);
  });

  it('moves a clip by its node and keeps the panel on the node it opened on', () => {
    session().openJoinPanel('audio.join', [A, B, C]);
    session().moveMiniToolSlotItem('clips', 'c', 0);
    expect(order()).toEqual(['c', 'a', 'b']);
    expect(session().panelHostId).toBe('a');
  });
});
