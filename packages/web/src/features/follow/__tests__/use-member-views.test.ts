// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { useMemberViews } from '@web/features/follow/use-member-views';

const docs: Y.Doc[] = [];
/** Everyone these cases put on the wire, online. */
const ONLINE: ReadonlySet<string> = new Set(['li', 'wang', 'me']);

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
    const { result } = renderHook(() => useMemberViews(local, ONLINE));
    arrive(local, li, { user: { id: 'li' }, view: { spaceId: 's1', at: 10, focused: true }, following: { id: 'wang', at: 10 } });
    arrive(local, wang, { user: { id: 'wang' }, view: { spaceId: 's2', at: 10, focused: true }, following: null });
    expect(result.current.get('li')).toEqual({ spaceId: 's1', following: 'wang' });
    expect(result.current.get('wang')).toEqual({ spaceId: 's2', following: null });
  });

  it('takes the browser tab of a member that is focused', () => {
    const local = makeAwareness();
    const tabA = makeAwareness();
    const tabB = makeAwareness();
    const { result } = renderHook(() => useMemberViews(local, ONLINE));
    arrive(local, tabA, { user: { id: 'li' }, view: { spaceId: 's1', at: 50, focused: true } });
    arrive(local, tabB, { user: { id: 'li' }, view: { spaceId: 's2', at: 99, focused: false } });
    expect(result.current.get('li')).toEqual({ spaceId: 's1', following: null });
  });

  it('follows a member who starts following someone', () => {
    const local = makeAwareness();
    const li = makeAwareness();
    const { result } = renderHook(() => useMemberViews(local, ONLINE));
    arrive(local, li, { user: { id: 'li' }, view: { spaceId: 's1', at: 10, focused: true } });
    arrive(local, li, { user: { id: 'li' }, view: { spaceId: 's1', at: 10, focused: true }, following: { id: 'wang', at: 11 } });
    expect(result.current.get('li')?.following).toBe('wang');
  });

  it('counts a member as following while the tab that follows is hidden and shows no view', () => {
    const local = makeAwareness();
    const shown = makeAwareness();
    const hidden = makeAwareness();
    const { result } = renderHook(() => useMemberViews(local, ONLINE));
    arrive(local, shown, { user: { id: 'li' }, view: { spaceId: 's1', at: 10, focused: true } });
    arrive(local, hidden, { user: { id: 'li' }, view: null, following: { id: 'wang', at: 5 } });
    expect(result.current.get('li')).toEqual({ spaceId: 's1', following: 'wang' });
  });

  it('keeps a member following while their entry times out and they are still online', () => {
    const local = makeAwareness();
    const hidden = makeAwareness();
    const { result } = renderHook(() => useMemberViews(local, ONLINE));
    arrive(local, hidden, { user: { id: 'li' }, view: null, following: { id: 'wang', at: 5 } });
    // A tab hidden for minutes beats about once a minute; y-protocols drops a peer silent for 30 s.
    act(() => removeAwarenessStates(local, [hidden.clientID], 'timeout'));
    expect(result.current.get('li')?.following).toBe('wang');
    // Its next beat brings the entry back as it was.
    arrive(local, hidden, { user: { id: 'li' }, view: null, following: { id: 'wang', at: 5 } });
    expect(result.current.get('li')?.following).toBe('wang');
  });

  it('forgets whom a member follows once their tab leaves or they go offline', () => {
    const local = makeAwareness();
    const left = makeAwareness();
    const silent = makeAwareness();
    const { result, rerender } = renderHook((online: ReadonlySet<string>) => useMemberViews(local, online), { initialProps: ONLINE });
    arrive(local, left, { user: { id: 'li' }, view: null, following: { id: 'wang', at: 5 } });
    arrive(local, silent, { user: { id: 'wang' }, view: null, following: { id: 'li', at: 5 } });
    // The tab closes: the provider sends its state as gone.
    left.setLocalState(null);
    act(() => applyAwarenessUpdate(local, encodeAwarenessUpdate(left, [left.clientID]), 'remote'));
    expect(result.current.get('li')?.following ?? null).toBeNull();
    // A timed-out member the server no longer counts as online.
    act(() => removeAwarenessStates(local, [silent.clientID], 'timeout'));
    expect(result.current.get('wang')?.following).toBe('li');
    rerender(new Set(['li', 'me']));
    expect(result.current.get('wang')?.following ?? null).toBeNull();
  });

  it('never lists this client, and lists nothing without an awareness', () => {
    const local = makeAwareness();
    local.setLocalState({ user: { id: 'me' }, view: { spaceId: 's1', at: 10, focused: true }, following: { id: 'x', at: 1 } });
    const { result } = renderHook(() => useMemberViews(local, ONLINE));
    expect(result.current.has('me')).toBe(false);
    const none = renderHook(() => useMemberViews(null, ONLINE));
    expect(none.result.current.size).toBe(0);
  });
});
