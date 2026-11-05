// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap (inner#1790), spec W-61 and the Understand half of W-63:
 * the node and edge a press writes before its paid request go through the
 * size gateway as one add, and a refusal builds nothing and sends nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { CANVAS_NODES_KEY, t, type CanvasNodeFields } from '@breatic/shared';
import type * as ProviderModule from '@hocuspocus/provider';

vi.mock('@hocuspocus/provider', async (importOriginal) => {
  const { providerMockModule } = await import('@web/data/yjs/__tests__/helpers/size-gate-provider-mock');
  return providerMockModule(await importOriginal<typeof ProviderModule>());
});
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
import { _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { addNode, readEdges, _resetCanvasUndoCacheForTests } from '@web/data/yjs/canvas-space';
import { docName, _resetForTests } from '@web/data/yjs/manager';
import { startUnderstandRun, type UnderstandRun } from '@web/spaces/canvas/start-understand-run';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import { sizeGateProviders } from '@web/data/yjs/__tests__/helpers/size-gate-provider-mock';
import { openSizedDoc, pushSize } from '@web/data/yjs/__tests__/helpers/size-gate-harness';
import {
  COPY_EN,
  F_FULL,
  F_NORMAL,
  F_WARNING_TIGHT,
  type DocSizePush,
} from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';

const PID = 'p1';
const SID = 's1';
const NAME = docName.canvasSpace(PID, SID);

/**
 * Seeds the video node v1 being read, then delivers one push.
 * @param push - The size push.
 * @returns The canvas document.
 * @throws {Error} When seeding fails.
 */
function boardAt(push: DocSizePush): Y.Doc {
  const { doc, provider } = openSizedDoc(NAME);
  addNode(PID, SID, {
    id: 'v1',
    type: 'video',
    position: { x: 100, y: 40 },
    data: { name: 'clip', createdAt: 1, createdBy: 'u1', locked: false, attachments: [] },
  } as CanvasNodeFields);
  pushSize(provider, push);
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

beforeEach(() => {
  sizeGateProviders.length = 0;
});

afterEach(() => {
  resetRunOnceForTests();
  _resetCollabSocketForTests();
  _resetForTests();
  _resetCanvasUndoCacheForTests();
  vi.clearAllMocks();
});

describe('W-61 Understand builds nothing and sends nothing once the Space is full', () => {
  it('ends the press before the node, the edge and the request', async () => {
    const doc = boardAt(F_FULL);
    const before = Y.encodeStateAsUpdate(doc);
    const onBuilt = vi.fn();
    const outcome = await startUnderstandRun(press(onBuilt));
    expect(outcome).toEqual({ kind: 'released' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(nodeIds(doc)).toEqual(['v1']);
    expect(readEdges(doc)).toEqual([]);
    expect(canvasApi.understand).not.toHaveBeenCalled();
    expect(onBuilt).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_ADD_BLOCKED);
    expect(vi.mocked(toast.warning).mock.calls.map((call) => call[0])).not.toContain(t('canvas.understand.sourceGone'));
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('W-63 Understand when the room is short, and when it is plenty', () => {
  it('sends nothing when the node and edge do not fit in one byte', async () => {
    const doc = boardAt(F_WARNING_TIGHT);
    const before = Y.encodeStateAsUpdate(doc);
    const onBuilt = vi.fn();
    const outcome = await startUnderstandRun(press(onBuilt));
    expect(outcome).toEqual({ kind: 'released' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(nodeIds(doc)).toEqual(['v1']);
    expect(canvasApi.understand).not.toHaveBeenCalled();
    expect(onBuilt).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_NO_ROOM('1 B'));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('builds the node and its edge and sends the run with the new node id', async () => {
    const doc = boardAt(F_NORMAL);
    const onBuilt = vi.fn();
    await startUnderstandRun(press(onBuilt));
    const built = nodeIds(doc).filter((id) => id !== 'v1');
    expect(built).toHaveLength(1);
    expect(readEdges(doc).map((edge) => edge.id)).toEqual([`v1->${built[0]}`]);
    expect(canvasApi.understand).toHaveBeenCalledTimes(1);
    expect(vi.mocked(canvasApi.understand).mock.calls[0][0].node_ids).toEqual([built[0]]);
    expect(onBuilt).toHaveBeenCalledTimes(1);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
