// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { useMemberViews } from '@web/features/follow/use-member-views';

const docs: Y.Doc[] = [];

/**
 * An awareness over a throwaway meta document.
 * @returns The awareness.
 */
function makeAwareness(): Awareness {
  const doc = new Y.Doc();
  docs.push(doc);
  return new Awareness(doc);
}

/**
 * Make a peer's state arrive on the local awareness, the way the provider does.
 * @param local - This client's awareness.
 * @param peer - The peer's awareness.
 * @param state - The state the peer publishes.
 */
function arrive(local: Awareness, peer: Awareness, state: Record<string, unknown>): void {
  peer.setLocalState(state);
  act(() => {
    applyAwarenessUpdate(local, encodeAwarenessUpdate(peer, [peer.clientID]), 'remote');
  });
}

afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
});

describe('useMemberViews', () => {
  it('gives each other member the Space they have in front and whom they follow', () => {
    const local = makeAwareness();
    const li = makeAwareness();
    const wang = makeAwareness();
    const { result } = renderHook(() => useMemberViews(local));
    arrive(local, li, { user: { id: 'li' }, view: { spaceId: 's1', at: 10, focused: true, following: 'wang' } });
    arrive(local, wang, { user: { id: 'wang' }, view: { spaceId: 's2', at: 10, focused: true, following: null } });
    expect(result.current.get('li')).toEqual({ spaceId: 's1', following: 'wang' });
    expect(result.current.get('wang')).toEqual({ spaceId: 's2', following: null });
  });

  it('takes the browser tab of a member that is focused', () => {
    const local = makeAwareness();
    const tabA = makeAwareness();
    const tabB = makeAwareness();
    const { result } = renderHook(() => useMemberViews(local));
    arrive(local, tabA, { user: { id: 'li' }, view: { spaceId: 's1', at: 50, focused: true, following: null } });
    arrive(local, tabB, { user: { id: 'li' }, view: { spaceId: 's2', at: 99, focused: false, following: 'wang' } });
    expect(result.current.get('li')).toEqual({ spaceId: 's1', following: null });
  });

  it('follows a member who starts following someone', () => {
    const local = makeAwareness();
    const li = makeAwareness();
    const { result } = renderHook(() => useMemberViews(local));
    arrive(local, li, { user: { id: 'li' }, view: { spaceId: 's1', at: 10, focused: true, following: null } });
    arrive(local, li, { user: { id: 'li' }, view: { spaceId: 's1', at: 11, focused: true, following: 'wang' } });
    expect(result.current.get('li')?.following).toBe('wang');
  });

  it('never lists this client, and lists nothing without an awareness', () => {
    const local = makeAwareness();
    local.setLocalState({ user: { id: 'me' }, view: { spaceId: 's1', at: 10, focused: true, following: null } });
    const { result } = renderHook(() => useMemberViews(local));
    expect(result.current.has('me')).toBe(false);
    const none = renderHook(() => useMemberViews(null));
    expect(none.result.current.size).toBe(0);
  });
});
