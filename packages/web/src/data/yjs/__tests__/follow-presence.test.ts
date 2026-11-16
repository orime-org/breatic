// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { act } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';

import {
  pickLeaderField,
  pickMemberViews,
  readFollowField,
} from '@web/data/yjs/follow-presence';
import { readUserId } from '@web/data/yjs/awareness-user';

/** One awareness entry as the server leaves it: stamped with the connection's user. */
function entry(userId: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { user: { id: userId }, ...fields };
}

const docs: Y.Doc[] = [];

/**
 * An awareness over a throwaway document.
 * @returns The awareness.
 */
function makeAwareness(): Awareness {
  const doc = new Y.Doc();
  docs.push(doc);
  return new Awareness(doc);
}

afterEach(() => {
  for (const doc of docs.splice(0)) doc.destroy();
});

describe('follow presence fields', () => {
  it('reads a well-formed view and rejects malformed ones', () => {
    expect(readFollowField(entry('u', { view: { spaceId: 's1', at: 10, focused: true } }), 'view'))
      .toEqual({ spaceId: 's1', at: 10, focused: true });
    expect(readFollowField(entry('u', { view: { spaceId: null, at: 10, focused: false } }), 'view'))
      .toEqual({ spaceId: null, at: 10, focused: false });
    for (const bad of [
      { spaceId: '', at: 10, focused: true },
      { spaceId: 's1', at: Number.NaN, focused: true },
      { spaceId: 's1', at: 10 },
      { spaceId: 7, at: 10, focused: true },
      'not an object',
      null,
    ]) {
      expect(readFollowField(entry('u', { view: bad }), 'view')).toBeNull();
    }
    expect(readFollowField(entry('u', {}), 'view')).toBeNull();
  });

  it('reads whom a tab follows, kept apart from the view, and rejects a nameless one', () => {
    expect(readFollowField(entry('u', { following: { id: 'l', at: 3 } }), 'following')).toEqual({ id: 'l', at: 3 });
    expect(readFollowField(entry('u', { following: { id: '', at: 3 } }), 'following')).toBeNull();
    expect(readFollowField(entry('u', { following: null }), 'following')).toBeNull();
  });

  it('reads a canvas camera only with a positive visible size', () => {
    expect(readFollowField(entry('u', { camera: { x: -5, y: 3, width: 800, height: 600, at: 1 } }), 'camera'))
      .toEqual({ x: -5, y: 3, width: 800, height: 600, at: 1 });
    expect(readFollowField(entry('u', { camera: { x: 0, y: 0, width: 0, height: 600, at: 1 } }), 'camera')).toBeNull();
    expect(readFollowField(entry('u', { camera: { x: 0, y: 0, width: 10, height: -1, at: 1 } }), 'camera')).toBeNull();
    expect(readFollowField(entry('u', { camera: { x: Infinity, y: 0, width: 10, height: 10, at: 1 } }), 'camera')).toBeNull();
  });

  it('reads a top block id only when it names a block', () => {
    expect(readFollowField(entry('u', { topBlockId: { id: 'b1', at: 2 } }), 'topBlockId')).toEqual({ id: 'b1', at: 2 });
    expect(readFollowField(entry('u', { topBlockId: { id: '', at: 2 } }), 'topBlockId')).toBeNull();
  });

  it('reads a 3D camera with three-component vectors and a positive field of view', () => {
    const good = { position: [1, 2, 3], target: [0, 0, 0], fov: 50, at: 3 };
    expect(readFollowField(entry('u', { camera3d: good }), 'camera3d')).toEqual(good);
    expect(readFollowField(entry('u', { camera3d: { ...good, position: [1, 2] } }), 'camera3d')).toBeNull();
    expect(readFollowField(entry('u', { camera3d: { ...good, fov: 0 } }), 'camera3d')).toBeNull();
  });

  it('reads a timeline view whose range runs forwards and whose anchor is wall-clock', () => {
    const good = {
      startFrame: 0,
      endFrame: 240,
      trackScrollTop: 0,
      frame: 12,
      intent: 'play',
      anchor: { frame: 12, at: 1_700_000_000_000 },
      at: 1_700_000_000_000,
    };
    expect(readFollowField(entry('u', { timelineView: good }), 'timelineView')).toEqual(good);
    expect(readFollowField(entry('u', { timelineView: { ...good, anchor: null, intent: 'pause' } }), 'timelineView'))
      .toEqual({ ...good, anchor: null, intent: 'pause' });
    expect(readFollowField(entry('u', { timelineView: { ...good, endFrame: -1 } }), 'timelineView')).toBeNull();
    expect(readFollowField(entry('u', { timelineView: { ...good, intent: 'stop' } }), 'timelineView')).toBeNull();
    expect(readFollowField(entry('u', { timelineView: { ...good, frame: 1.5 } }), 'timelineView')).toBeNull();
  });
});

describe('pickMemberViews', () => {
  it('prefers the focused browser tab of each member, then the latest', () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, entry('leader', { view: { spaceId: 'old', at: 100, focused: false } })],
      [2, entry('leader', { view: { spaceId: 'working', at: 50, focused: true } })],
      [3, entry('other', { view: { spaceId: 'theirs', at: 999, focused: true } })],
      [4, entry('third', { view: { spaceId: 'a', at: 100, focused: false } })],
      [5, entry('third', { view: { spaceId: 'b', at: 200, focused: false } })],
    ]);
    const views = pickMemberViews(states, 99, new Map());
    expect(views.get('leader')?.spaceId).toBe('working');
    expect(views.get('other')?.spaceId).toBe('theirs');
    expect(views.get('third')?.spaceId).toBe('b');
  });

  it('keeps the same pick while two unfocused tabs keep their order', () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, entry('leader', { view: { spaceId: 'a', at: 100, focused: false } })],
      [2, entry('leader', { view: { spaceId: 'b', at: 200, focused: false } })],
    ]);
    const first = pickMemberViews(states, 99, new Map()).get('leader');
    states.set(1, entry('leader', { view: { spaceId: 'a', at: 150, focused: false } }));
    expect(pickMemberViews(states, 99, new Map()).get('leader')).toEqual(first);
  });

  it('takes whom a member follows from the server table, not from awareness, a member with no view included', () => {
    // #920 design 4.2.1: `following` in awareness is only a tab's declaration
    // to the server; the third argument is the table read by user id.
    const states = new Map<number, Record<string, unknown>>([
      [1, entry('u', { view: { spaceId: 's1', at: 10, focused: true } })],
      [2, entry('u', { following: { id: 'stale', at: 5 } })],
      [3, entry('declaredOnly', { view: { spaceId: 's2', at: 10, focused: true }, following: { id: 'l', at: 5 } })],
    ]);
    const views = pickMemberViews(states, 99, new Map([['u', 'l'], ['hiddenOnly', 'l']]));
    expect(views.get('u')).toEqual({ spaceId: 's1', following: 'l' });
    expect(views.get('hiddenOnly')).toEqual({ spaceId: null, following: 'l' });
    expect(views.get('declaredOnly')).toEqual({ spaceId: 's2', following: null });
  });

  it('never lists this client, malformed fields or entries without a user', () => {
    const states = new Map<number, Record<string, unknown>>([
      [7, entry('leader', { view: { spaceId: 'self', at: 999, focused: true }, following: { id: 'x', at: 1 } })],
      [8, entry('leader', { view: { spaceId: 1, at: 999, focused: true }, following: { id: '', at: 1 } })],
      [9, { view: { spaceId: 'anon', at: 999, focused: true } }],
    ]);
    expect(pickMemberViews(states, 7, new Map()).size).toBe(0);
  });
});

describe('pickLeaderField', () => {
  it('takes the latest value of one field among the leader clients on an awareness', () => {
    const local = makeAwareness();
    for (const fields of [
      entry('leader', { topBlockId: { id: 'old', at: 1 } }),
      entry('leader', { topBlockId: { id: 'new', at: 2 } }),
      entry('leader', {}),
      entry('other', { topBlockId: { id: 'theirs', at: 9 } }),
    ]) {
      const peer = makeAwareness();
      peer.setLocalState(fields);
      act(() => applyAwarenessUpdate(local, encodeAwarenessUpdate(peer, [peer.clientID]), 'remote'));
    }
    local.setLocalState(entry('leader', { topBlockId: { id: 'mine', at: 99 } }));
    expect(pickLeaderField(local, 'leader', 'topBlockId')).toEqual({ id: 'new', at: 2 });
    expect(pickLeaderField(local, 'leader', 'camera')).toBeNull();
  });
});

describe('readUserId at its data-layer home', () => {
  it('reads the stamped user id and nothing else', () => {
    expect(readUserId({ user: { id: 'u1' } })).toBe('u1');
    expect(readUserId({ user: { id: 3 } })).toBeNull();
    expect(readUserId({})).toBeNull();
  });
});
