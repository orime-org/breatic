// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap v2 (inner#1790 v2 web spec RQ-13 and the Understand half of
 * RQ-15): the node and edge an Understand or Transcribe press writes before
 * its paid request are one `add`; a refusal builds nothing and sends nothing,
 * so no credits are spent.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { CANVAS_NODES_KEY, type CanvasNodeFields } from '@breatic/shared';
vi.mock('@web/data/yjs/collab-failure-report', () => ({ reportCollabFailure: vi.fn() }));
vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));
vi.mock('@web/data/api/canvas', () => ({
  canvasApi: {
    understand: vi.fn(async () => ({ task_id: 't-1', status: 'pending' })),
    transcribe: vi.fn(async () => ({ task_id: 't-2', status: 'pending' })),
  },
  getCachedUnderstandMaxBytes: vi.fn(() => 20 * 1024 * 1024),
  getCachedUnderstandLongMediaMaxBytes: vi.fn(() => 2 * 1024 * 1024 * 1024),
}));

import { canvasApi } from '@web/data/api/canvas';
import { toast } from '@web/lib/toast';
import { addNode, readEdges, _resetCanvasUndoCacheForTests } from '@web/data/yjs/canvas-space';
import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { startTranscribeRun, startUnderstandRun, type UnderstandRun } from '@web/spaces/canvas/start-understand-run';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import {
  SIZE_COPY_EN,
  captureWriteAsync,
  enterSize,
  expectKindShape,
  expectSizeToast,
  type SizeCode,
} from '@web/data/yjs/__tests__/helpers/size-v2-harness';

const PID = 'p1';
const SID = 's1';
const NAME = docName.canvasSpace(PID, SID);

/**
 * Seeds the video node v1 being read, then puts the Space in one size state.
 * @param code - The size state.
 * @returns The canvas document.
 * @throws {Error} When seeding fails.
 */
function boardAt(code: SizeCode): Y.Doc {
  const doc = getDoc(NAME);
  addNode(PID, SID, {
    id: 'v1',
    type: 'video',
    position: { x: 100, y: 40 },
    data: { name: 'clip', createdAt: 1, createdBy: 'u1', locked: false, attachments: [] },
  } as CanvasNodeFields);
  enterSize(NAME, code);
  vi.mocked(toast.warning).mockClear();
  return doc;
}

/**
 * One Understand press on v1.
 * @param onBuilt - Told about the built node.
 * @returns The press.
 */
function press(onBuilt: UnderstandRun['onBuilt']): UnderstandRun {
  return {
    projectId: PID,
    spaceId: SID,
    userId: 'u1',
    onBuilt,
    source: {
      id: 'v1',
      name: 'clip',
      kind: 'video',
      url: 'https://assets.invalid/video/a.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 1024,
      position: { x: 100, y: 40 },
      groupOrigin: null,
    },
  };
}

/**
 * Node ids on the board.
 * @param doc - Canvas document.
 * @returns The ids, sorted.
 */
function nodeIds(doc: Y.Doc): string[] {
  return [...doc.getMap(CANVAS_NODES_KEY).keys()].sort();
}

afterEach(() => {
  resetRunOnceForTests();
  clearAllDocSizes();
  _resetForTests();
  _resetCanvasUndoCacheForTests();
  vi.clearAllMocks();
});

const READINGS = [
  ['understand', (onBuilt: UnderstandRun['onBuilt']) => startUnderstandRun(press(onBuilt)), () => canvasApi.understand],
  ['transcribe', (onBuilt: UnderstandRun['onBuilt']) => startTranscribeRun({ ...press(onBuilt), keepFillers: false }), () => canvasApi.transcribe],
] as const;

describe('RQ-13 Understand and Transcribe build nothing and send nothing when the Space cannot take an add', () => {
  describe.each(READINGS)('%s', (_reading, start, request) => {
    it.each([
      ['F', SIZE_COPY_EN.T_ADD],
      ['O', SIZE_COPY_EN.T_OVER],
      ['Z', null],
    ] as const)('RQ-13 [%s] ends the press before the node, the edge and the request', async (code, sentence) => {
      const doc = boardAt(code);
      const before = Y.encodeStateAsUpdate(doc);
      const onBuilt = vi.fn();
      const outcome = await start(onBuilt);
      expect(outcome).toEqual({ kind: 'released' });
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
      expect(nodeIds(doc)).toEqual(['v1']);
      expect(readEdges(doc)).toEqual([]);
      expect(canvasApi.understand).not.toHaveBeenCalled();
      expect(canvasApi.transcribe).not.toHaveBeenCalled();
      expect(request()).not.toHaveBeenCalled();
      expect(onBuilt).not.toHaveBeenCalled();
      expectSizeToast(sentence);
    });
  });
});

describe('RQ-15 Understand and Transcribe near full write the node and edge once, then ask once', () => {
  describe.each(READINGS)('%s', (_reading, start, request) => {
    it('RQ-15 [W] builds the node and its edge as one add and sends the run with the new node id', async () => {
      const doc = boardAt('W');
      const onBuilt = vi.fn();
      const captured = await captureWriteAsync(doc, () => start(onBuilt));
      expectKindShape('add', captured);
      const built = nodeIds(doc).filter((id) => id !== 'v1');
      expect(built).toHaveLength(1);
      expect(readEdges(doc).map((edge) => edge.id)).toEqual([`v1->${built[0]}`]);
      expect(request()).toHaveBeenCalledTimes(1);
      expect(vi.mocked(request()).mock.calls[0][0].node_ids).toEqual([built[0]]);
      expect(onBuilt).toHaveBeenCalledTimes(1);
      expectSizeToast(null);
    });
  });
});
