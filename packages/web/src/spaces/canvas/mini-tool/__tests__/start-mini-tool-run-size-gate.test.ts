// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap (inner#1790), spec W-62 and the mini-tool half of W-63: the
 * result nodes, edges and group a Run writes before its request go through
 * the size gateway as one add, and a refusal builds nothing and sends nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { CANVAS_NODES_KEY, type CanvasNodeFields } from '@breatic/shared';
import { miniToolById, type MiniToolSnapshot, type MiniToolSpec } from '@breatic/shared/mini-tools';
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
const api = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@web/data/api/mini-tools', () => ({ miniToolsApi: api }));

import { toast } from '@web/lib/toast';
import { _resetCollabSocketForTests } from '@web/data/yjs/collab-socket';
import { addNode, readEdges, _resetCanvasUndoCacheForTests } from '@web/data/yjs/canvas-space';
import { docName, _resetForTests } from '@web/data/yjs/manager';
import { startMiniToolRun, type MiniToolRun } from '@web/spaces/canvas/mini-tool/start-mini-tool-run';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import { useUploadMarksStore } from '@web/stores/upload-marks';
import { sizeGateProviders } from '@web/data/yjs/__tests__/helpers/size-gate-provider-mock';
import { openSizedDoc, pushSize } from '@web/data/yjs/__tests__/helpers/size-gate-harness';
import {
  COPY_EN,
  F_FULL,
  F_NORMAL,
  F_WARNING_TIGHT,
  type DocSizePush,
} from '@web/data/yjs/__tests__/helpers/doc-size-fixtures';

const PID = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';
const NAME = docName.canvasSpace(PID, SID);

/**
 * A registry tool by id.
 * @param id - The tool id.
 * @returns The declaration.
 * @throws {Error} When the registry has no such tool.
 */
function tool(id: string): MiniToolSpec {
  const spec = miniToolById(id);
  if (!spec) throw new Error(id);
  return spec;
}

/**
 * Seeds the source node, then delivers one push.
 * @param type - The source node's modality.
 * @param push - The size push.
 * @returns The canvas document.
 * @throws {Error} When seeding fails.
 */
function boardAt(type: 'image' | 'audio', push: DocSizePush): Y.Doc {
  const { doc, provider } = openSizedDoc(NAME);
  addNode(PID, SID, {
    id: 'src',
    type,
    position: { x: 0, y: 0 },
    data: { name: 'SRC', createdAt: 1, createdBy: 'u1', locked: false, attachments: [] },
  } as CanvasNodeFields);
  pushSize(provider, push);
  vi.mocked(toast.warning).mockClear();
  return doc;
}

const AUDIO_SNAPSHOT: MiniToolSnapshot = { params: {}, prompt: '', source: { url: 'https://cdn/a.mp3', duration: 12 }, slots: {} };

/**
 * A press of a grouped two-tile grid on an image (two results, `groupOutputs: true`).
 * @returns The run.
 */
function gridPress(): MiniToolRun {
  const files = [0, 1].map((i) => ({ file: new File(['x'], `t${i}.png`, { type: 'image/png' }) }));
  return {
    ...basePress(),
    spec: tool('image.grid'),
    snapshot: { params: { rows: 1, cols: 2 }, prompt: '', source: { url: 'https://cdn/a.png' }, slots: {} },
    source: { id: 'src', name: 'SRC', position: { x: 0, y: 0 }, groupOrigin: null, mimeType: 'image/png', width: 400, height: 300 },
    exportFile: vi.fn(() => Promise.resolve(files)),
  };
}

/**
 * A press of a server tool with two results on an audio node.
 * @returns The run.
 */
function separatePress(): MiniToolRun {
  return {
    ...basePress(),
    spec: tool('audio.separate'),
    snapshot: AUDIO_SNAPSHOT,
    source: { id: 'src', name: 'SRC', position: { x: 0, y: 0 }, groupOrigin: null, mimeType: 'audio/mpeg' },
  };
}

/**
 * The callbacks every press carries.
 * @returns The shared part of a run.
 */
function basePress(): Omit<MiniToolRun, 'spec' | 'snapshot' | 'source'> {
  return {
    projectId: PID,
    spaceId: SID,
    userId: 'u1',
    sourceExists: () => true,
    exportFile: vi.fn(),
    fillUpload: vi.fn(),
    fillUploads: vi.fn(),
    exportDrawing: vi.fn(),
    exportExpand: vi.fn(),
    uploadImage: vi.fn(),
    setExporting: vi.fn(),
    stillOpen: () => true,
    onBuilt: vi.fn(),
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
  useUploadMarksStore.setState({ marks: {} });
  api.run.mockResolvedValue({ task_id: 't', status: 'pending' });
});

afterEach(() => {
  resetRunOnceForTests();
  _resetCollabSocketForTests();
  _resetForTests();
  _resetCanvasUndoCacheForTests();
  vi.clearAllMocks();
});

describe('W-62 a mini-tool builds nothing and sends nothing once the Space is full', () => {
  it('writes no result node, edge or group, opens no mark and runs nothing', async () => {
    const doc = boardAt('image', F_FULL);
    const before = Y.encodeStateAsUpdate(doc);
    const run = gridPress();
    const outcome = await startMiniToolRun(run);
    expect(outcome).toEqual({ kind: 'released' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(nodeIds(doc)).toEqual(['src']);
    expect(readEdges(doc)).toEqual([]);
    expect(useUploadMarksStore.getState().marks).toEqual({});
    expect(run.exportFile).not.toHaveBeenCalled();
    expect(run.fillUploads).not.toHaveBeenCalled();
    expect(api.run).not.toHaveBeenCalled();
    expect(run.onBuilt).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_ADD_BLOCKED);
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('W-63 a mini-tool when the room is short, and when it is plenty', () => {
  it('sends nothing when the results do not fit in one byte', async () => {
    const doc = boardAt('audio', F_WARNING_TIGHT);
    const before = Y.encodeStateAsUpdate(doc);
    const run = separatePress();
    const outcome = await startMiniToolRun(run);
    expect(outcome).toEqual({ kind: 'released' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    expect(nodeIds(doc)).toEqual(['src']);
    expect(api.run).not.toHaveBeenCalled();
    expect(run.onBuilt).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(COPY_EN.T_NO_ROOM('1 B'));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('builds the results and their edges and sends their ids', async () => {
    const doc = boardAt('audio', F_NORMAL);
    await startMiniToolRun(separatePress());
    const built = nodeIds(doc).filter((id) => id !== 'src');
    expect(built).toHaveLength(2);
    expect(readEdges(doc).map((edge) => edge.id).sort()).toEqual(built.map((id) => `src->${id}`).sort());
    expect(api.run).toHaveBeenCalledTimes(1);
    expect([...(api.run.mock.calls[0][0] as { node_ids: string[] }).node_ids].sort()).toEqual(built);
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
