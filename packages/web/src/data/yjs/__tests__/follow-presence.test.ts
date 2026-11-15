// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from 'vitest';

import {
  FOLLOW_FIELDS,
  pickLeaderField,
  pickLeaderView,
  readFollowField,
} from '@web/data/yjs/follow-presence';
import { readUserId } from '@web/data/yjs/awareness-user';

/** One awareness entry as the server leaves it: stamped with the connection's user. */
function entry(userId: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { user: { id: userId }, ...fields };
}

describe('follow presence fields', () => {
  it('names the five fields the follow broadcast uses', () => {
    expect(FOLLOW_FIELDS).toEqual({
      view: 'view',
      camera: 'camera',
      topBlockId: 'topBlockId',
      camera3d: 'camera3d',
      timelineView: 'timelineView',
    });
  });

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

describe('pickLeaderView', () => {
  it('prefers the focused browser tab of the leader, then the latest', () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, entry('leader', { view: { spaceId: 'old', at: 100, focused: false } })],
      [2, entry('leader', { view: { spaceId: 'working', at: 50, focused: true } })],
      [3, entry('other', { view: { spaceId: 'theirs', at: 999, focused: true } })],
    ]);
    expect(pickLeaderView(states, 'leader', 99)?.spaceId).toBe('working');
  });

  it('takes the latest when no tab of the leader is focused', () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, entry('leader', { view: { spaceId: 'a', at: 100, focused: false } })],
      [2, entry('leader', { view: { spaceId: 'b', at: 200, focused: false } })],
    ]);
    expect(pickLeaderView(states, 'leader', 99)?.spaceId).toBe('b');
  });

  it('keeps the same pick while two unfocused tabs keep their order', () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, entry('leader', { view: { spaceId: 'a', at: 100, focused: false } })],
      [2, entry('leader', { view: { spaceId: 'b', at: 200, focused: false } })],
    ]);
    const first = pickLeaderView(states, 'leader', 99);
    states.set(1, entry('leader', { view: { spaceId: 'a', at: 150, focused: false } }));
    expect(pickLeaderView(states, 'leader', 99)).toEqual(first);
  });

  it('never picks this client, malformed views or entries without a user', () => {
    const states = new Map<number, Record<string, unknown>>([
      [7, entry('leader', { view: { spaceId: 'self', at: 999, focused: true } })],
      [8, entry('leader', { view: { spaceId: 1, at: 999, focused: true } })],
      [9, { view: { spaceId: 'anon', at: 999, focused: true } }],
    ]);
    expect(pickLeaderView(states, 'leader', 7)).toBeNull();
  });
});

describe('pickLeaderField', () => {
  it('takes the latest value of one field among the leader entries', () => {
    const states = new Map<number, Record<string, unknown>>([
      [1, entry('leader', { topBlockId: { id: 'old', at: 1 } })],
      [2, entry('leader', { topBlockId: { id: 'new', at: 2 } })],
      [3, entry('leader', {})],
      [4, entry('other', { topBlockId: { id: 'theirs', at: 9 } })],
    ]);
    expect(pickLeaderField(states, 'leader', 'topBlockId', 99)).toEqual({ id: 'new', at: 2 });
    expect(pickLeaderField(states, 'leader', 'camera', 99)).toBeNull();
  });
});

describe('readUserId at its data-layer home', () => {
  it('reads the stamped user id and nothing else', () => {
    expect(readUserId({ user: { id: 'u1' } })).toBe('u1');
    expect(readUserId({ user: { id: 3 } })).toBeNull();
    expect(readUserId({})).toBeNull();
  });
});
