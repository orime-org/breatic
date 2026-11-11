// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space document size cap v2 (inner#1790 v2 web test spec, section 5): the
 * storyboard writes of a multi-shot video node, each classified into a kind,
 * checked against the shape it sends and gated through the row template.
 *
 * Initial content: video `v1` with three shots of 3, 3 and 4 seconds (total
 * 10) and video `v0` with an empty shot list, loaded as a peer's update.
 */

import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import * as Y from 'yjs';

vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));

import { toast } from '@web/lib/toast';
import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { _resetCanvasUndoCacheForTests } from '@web/data/yjs/canvas-space';
import {
  addStoryboardShot,
  enterStoryboardShots,
  readShots,
  removeStoryboardShot,
  retotalStoryboard,
  setStoryboardShots,
  stepStoryboardShot,
} from '@web/data/yjs/node-storyboard';
import { kindRows, loadRemote } from '@web/data/yjs/__tests__/helpers/size-v2-harness';

const PID = 'p1';
const SID = 's1';
const NAME = docName.canvasSpace(PID, SID);

/**
 * One video node with a shot list.
 * @param source - Source document.
 * @param id - Node id.
 * @param durations - The shots' durations; their ids are `shot1`, `shot2`, ...
 */
function putVideo(source: Y.Doc, id: string, durations: readonly number[]): void {
  const node = new Y.Map<unknown>();
  const data = new Y.Map<unknown>();
  const shots = new Y.Array<Y.Map<unknown>>();
  shots.push(durations.map((duration, i) => {
    const shot = new Y.Map<unknown>();
    shot.set('id', `shot${i + 1}`);
    shot.set('prompt', new Y.XmlFragment());
    shot.set('duration', duration);
    return shot;
  }));
  node.set('id', id);
  node.set('type', 'video');
  node.set('position', { x: 0, y: 0 });
  data.set('name', id);
  data.set('mode', 'multi_shot');
  data.set('shots', shots);
  node.set('data', data);
  source.getMap<Y.Map<unknown>>('nodesMap').set(id, node);
}

/**
 * A fresh registered canvas document holding `v1` and `v0`.
 * @returns The document.
 */
function seed(): Y.Doc {
  const doc = getDoc(NAME);
  loadRemote(doc, (source) => {
    putVideo(source, 'v1', [3, 3, 4]);
    putVideo(source, 'v0', []);
  });
  return doc;
}

/**
 * A node's shot durations.
 * @param id - Node id.
 * @returns The durations.
 */
function durations(id: string): number[] {
  return (readShots(PID, SID, id) ?? []).map((shot) => shot.duration);
}

const ROW = { name: NAME, seed };

beforeEach(() => {
  vi.mocked(toast.warning).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  _resetForTests();
  _resetCanvasUndoCacheForTests();
  clearAllDocSizes();
  vi.clearAllMocks();
});

describe('SB-01 storyboard adds', () => {
  kindRows({
    ...ROW,
    id: 'SB-01',
    title: 'addStoryboardShot on v1',
    kind: 'add',
    run: () => addStoryboardShot(PID, SID, 'v1', 10, 6),
    written: (result) => expect(typeof result).toBe('string'),
    refused: (result) => {
      expect(result).toBeNull();
      expect(durations('v1')).toEqual([3, 3, 4]);
    },
  });
  kindRows({
    ...ROW,
    id: 'SB-01',
    title: 'setStoryboardShots v1 [5, 5]',
    kind: 'add',
    run: () => setStoryboardShots(PID, SID, 'v1', [5, 5]),
    written: (result) => {
      expect(result).toHaveLength(2);
      expect(durations('v1')).toEqual([5, 5]);
    },
    refused: (result) => {
      expect(result).toEqual([]);
      expect(durations('v1')).toEqual([3, 3, 4]);
    },
  });
  kindRows({
    ...ROW,
    id: 'SB-01',
    title: 'enterStoryboardShots on a node with no shots',
    kind: 'add',
    run: () => enterStoryboardShots(PID, SID, 'v0', 10),
    written: () => expect(durations('v0').length).toBeGreaterThan(0),
    refused: () => expect(durations('v0')).toEqual([]),
  });
});

describe('SB-02 storyboard edits', () => {
  const edits: ReadonlyArray<{ title: string; run: () => unknown }> = [
    { title: 'retotalStoryboard v1 to 12', run: () => retotalStoryboard(PID, SID, 'v1', 12) },
    { title: 'stepStoryboardShot shot1 +1', run: () => stepStoryboardShot(PID, SID, 'v1', 'shot1', 1) },
    { title: 'enterStoryboardShots on v1, which has shots', run: () => enterStoryboardShots(PID, SID, 'v1', 12) },
  ];
  for (const edit of edits) {
    kindRows({
      ...ROW,
      id: 'SB-02',
      title: edit.title,
      kind: 'edit',
      run: edit.run,
      written: () => expect(durations('v1')).not.toEqual([3, 3, 4]),
      refused: () => expect(durations('v1')).toEqual([3, 3, 4]),
    });
  }
});

describe('SB-03 removing a shot moves its seconds to the shot before it', () => {
  kindRows({
    ...ROW,
    id: 'SB-03',
    title: 'removeStoryboardShot shot2',
    kind: 'compound',
    run: () => removeStoryboardShot(PID, SID, 'v1', 'shot2', 10),
    written: () => expect(durations('v1')).toEqual([6, 4]),
    refused: () => expect(durations('v1')).toEqual([3, 3, 4]),
  });
});
