// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Who is doing what on an empty node (inner#1303 §6.8, A14): the activity a
 * client publishes comes only from its own upload marks, and a reader shows,
 * per node, the other person who started last.
 */

import { describe, expect, it } from 'vitest';

import {
  activityFromMarks,
  collectPeerActivity,
  fillActionOf,
  samePeerActivity,
} from '@web/spaces/canvas/node-activity';
import type { UploadMark } from '@web/stores/upload-marks';

describe('activityFromMarks', () => {
  it('lists each waiting node with its action and start time', () => {
    const marks: Record<string, UploadMark> = {
      a: { op: '1', state: 'waiting', action: 'upload', at: 10 },
      b: { op: '2', state: 'waiting', action: 'image.grid', at: 20 },
    };
    expect(activityFromMarks(marks)).toEqual([
      { nodeId: 'a', action: 'upload', at: 10 },
      { nodeId: 'b', action: 'image.grid', at: 20 },
    ]);
  });

  it('leaves out a node whose operation already failed', () => {
    const marks: Record<string, UploadMark> = {
      a: { op: '1', state: 'failed', action: 'upload', at: 10, message: { key: 'canvas.upload.failed' } },
    };
    expect(activityFromMarks(marks)).toEqual([]);
  });

  it('is empty without marks', () => {
    expect(activityFromMarks(undefined)).toEqual([]);
  });
});

/**
 * An awareness state with a user and some activity.
 * @param userId - Who the connection belongs to.
 * @param activity - What it publishes.
 * @returns The state.
 */
function state(userId: string, activity: unknown): Record<string, unknown> {
  return { user: { id: userId }, activity };
}

describe('collectPeerActivity', () => {
  it('names the person working on a node and what they are doing', () => {
    const states = new Map([[2, state('bob', [{ nodeId: 'a', action: 'upload', at: 5 }])]]);
    expect(collectPeerActivity(states, 1).get('a')).toEqual({ userId: 'bob', action: 'upload', at: 5 });
  });

  it('leaves out this client’s own activity', () => {
    const states = new Map([[1, state('me', [{ nodeId: 'a', action: 'upload', at: 5 }])]]);
    expect(collectPeerActivity(states, 1).size).toBe(0);
  });

  it('shows whoever started last when several people work on one node', () => {
    const states = new Map([
      [2, state('bob', [{ nodeId: 'a', action: 'upload', at: 5 }])],
      [3, state('carol', [{ nodeId: 'a', action: 'image.adjust', at: 9 }])],
      [4, state('dave', [{ nodeId: 'a', action: 'readText', at: 7 }])],
    ]);
    expect(collectPeerActivity(states, 1).get('a')).toEqual({ userId: 'carol', action: 'image.adjust', at: 9 });
  });

  it('ignores a state without a user or with a malformed activity', () => {
    const states = new Map<number, Record<string, unknown>>([
      [2, { activity: [{ nodeId: 'a', action: 'upload', at: 5 }] }],
      [3, state('carol', 'not a list')],
      [4, state('dave', [{ nodeId: 7, action: 'upload', at: 5 }, { nodeId: 'b', action: 'upload' }])],
    ]);
    expect(collectPeerActivity(states, 1).size).toBe(0);
  });
});

describe('samePeerActivity', () => {
  it('treats two tables naming the same people and actions as the same', () => {
    const a = new Map([['n', { userId: 'bob', action: 'upload', at: 5 }]]);
    const b = new Map([['n', { userId: 'bob', action: 'upload', at: 5 }]]);
    expect(samePeerActivity(a, b)).toBe(true);
  });

  it('tells apart a different person, action or start time', () => {
    const a = new Map([['n', { userId: 'bob', action: 'upload', at: 5 }]]);
    expect(samePeerActivity(a, new Map([['n', { userId: 'carol', action: 'upload', at: 5 }]]))).toBe(false);
    expect(samePeerActivity(a, new Map([['n', { userId: 'bob', action: 'readText', at: 5 }]]))).toBe(false);
    expect(samePeerActivity(a, new Map([['n', { userId: 'bob', action: 'upload', at: 6 }]]))).toBe(false);
    expect(samePeerActivity(a, new Map())).toBe(false);
  });
});

describe('fillActionOf', () => {
  it('calls a file whose bytes go to storage an upload', () => {
    expect(fillActionOf({ needsUpload: true })).toBe('upload');
  });

  it('calls a text file read into the node reading the file', () => {
    expect(fillActionOf({ needsUpload: false })).toBe('readText');
  });
});
