// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Each other member's view (#920): the Space from their picked awareness
 * `view`, and whom they follow from the server's following table (design
 * 4.2.1), never from a peer's awareness `following`.
 *
 * Expected signature:
 *   useMemberViews(metaAwareness: Awareness | null, following: ReadonlyMap<string, string>): MemberViews
 * where `following` is `useProjectMeta(projectId).following` (user id → the
 * user id they follow, already picked by latest `at`). A member with an entry
 * in that map and no awareness view is listed as `{ spaceId: null, following }`.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { useMemberViews } from '@web/features/follow/use-member-views';

const docs: Y.Doc[] = [];
/** Nobody follows anyone. */
const NONE: ReadonlyMap<string, string> = new Map();

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
  it('gives each other member the Space they have in front and whom the server table says they follow', () => {
    const local = makeAwareness();
    const li = makeAwareness();
    const wang = makeAwareness();
    const following = new Map([['li', 'wang']]);
    const { result } = renderHook(() => useMemberViews(local, following));
    arrive(local, li, { user: { id: 'li' }, view: { spaceId: 's1', at: 10, focused: true } });
    arrive(local, wang, { user: { id: 'wang' }, view: { spaceId: 's2', at: 10, focused: true } });
    expect(result.current.get('li')).toEqual({ spaceId: 's1', following: 'wang' });
    expect(result.current.get('wang')).toEqual({ spaceId: 's2', following: null });
  });

  it('takes the browser tab of a member that is focused', () => {
    const local = makeAwareness();
    const tabA = makeAwareness();
    const tabB = makeAwareness();
    const { result } = renderHook(() => useMemberViews(local, NONE));
    arrive(local, tabA, { user: { id: 'li' }, view: { spaceId: 's1', at: 50, focused: true } });
    arrive(local, tabB, { user: { id: 'li' }, view: { spaceId: 's2', at: 99, focused: false } });
    expect(result.current.get('li')).toEqual({ spaceId: 's1', following: null });
  });

  it('reads nothing from the following a peer declares in its awareness', () => {
    // That field is the tab's declaration to the server; members read the table.
    const local = makeAwareness();
    const li = makeAwareness();
    const { result } = renderHook(() => useMemberViews(local, NONE));
    arrive(local, li, { user: { id: 'li' }, view: { spaceId: 's1', at: 10, focused: true }, following: { id: 'wang', at: 11 } });
    expect(result.current.get('li')).toEqual({ spaceId: 's1', following: null });
  });

  it('picks up a member who starts or stops following when the table changes', () => {
    const local = makeAwareness();
    const li = makeAwareness();
    const { result, rerender } = renderHook((following: ReadonlyMap<string, string>) => useMemberViews(local, following), {
      initialProps: NONE,
    });
    arrive(local, li, { user: { id: 'li' }, view: { spaceId: 's1', at: 10, focused: true } });
    expect(result.current.get('li')?.following).toBeNull();
    rerender(new Map([['li', 'wang']]));
    expect(result.current.get('li')).toEqual({ spaceId: 's1', following: 'wang' });
    rerender(NONE);
    expect(result.current.get('li')?.following ?? null).toBeNull();
  });

  it('counts a member as following when only a hidden tab follows and no tab shows a view', () => {
    const local = makeAwareness();
    const following = new Map([['li', 'wang']]);
    const { result } = renderHook(() => useMemberViews(local, following));
    expect(result.current.get('li')).toEqual({ spaceId: null, following: 'wang' });
  });

  it('keeps a member following after awareness drops their silent tab', () => {
    // A tab hidden for minutes beats about once a minute; y-protocols drops a
    // peer silent for 30 s, while the server keeps that connection's entry.
    const local = makeAwareness();
    const hidden = makeAwareness();
    const following = new Map([['li', 'wang']]);
    const { result } = renderHook(() => useMemberViews(local, following));
    arrive(local, hidden, { user: { id: 'li' }, view: { spaceId: 's1', at: 10, focused: false } });
    act(() => removeAwarenessStates(local, [hidden.clientID], 'timeout'));
    expect(result.current.get('li')).toEqual({ spaceId: null, following: 'wang' });
  });

  it('never lists this client, and lists nothing without an awareness or a table', () => {
    const local = makeAwareness();
    local.setLocalState({ user: { id: 'me' }, view: { spaceId: 's1', at: 10, focused: true } });
    const { result } = renderHook(() => useMemberViews(local, NONE));
    expect(result.current.has('me')).toBe(false);
    const none = renderHook(() => useMemberViews(null, NONE));
    expect(none.result.current.size).toBe(0);
  });
});
