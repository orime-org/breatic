// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A server tool's press refused 402 at a spend limit (inner#1968 design 3.10).
 * The result nodes built at the press stay on the canvas, and each shows the
 * failure mark with the spend limit's sentence.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { miniToolById, type MiniToolSnapshot, type MiniToolSpec } from '@breatic/shared/mini-tools';

const SPACE = '22222222-2222-4222-8222-222222222222';

const canvas = vi.hoisted(() => ({
  addNode: vi.fn(),
  addEdge: vi.fn(() => true),
  runCanvasUndoBatch: vi.fn((_p: string, _s: string, _o: unknown, body: () => void) => {
    body();
    return { ok: true };
  }),
  createGroup: vi.fn(),
}));
vi.mock('@web/data/yjs/canvas-space', () => canvas);
const api = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@web/data/api/mini-tools', () => ({ miniToolsApi: api }));
vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
const shownNode = vi.hoisted(() => ({ id: '' }));
vi.mock('@xyflow/react', async (original) => ({ ...(await original<object>()), useNodeId: () => shownNode.id }));
vi.mock('@web/spaces/canvas/canvas-context', async (original) => ({
  ...(await original<object>()),
  useCanvasContext: () => ({ spaceId: '22222222-2222-4222-8222-222222222222' }),
}));

import { ApiException } from '@web/data/api/types';
import { spendCapMessage } from '@web/lib/spend-cap-message';
import { NodePlaceholder } from '@web/spaces/canvas/nodes/_shared/NodePlaceholder';
import { startMiniToolRun, type MiniToolRun } from '@web/spaces/canvas/mini-tool/start-mini-tool-run';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import { useUploadMarksStore } from '@web/stores/upload-marks';

const SPEND_CAP = new ApiException({
  status: 402,
  message: 'This Studio reached its monthly limit.',
  reason: 'spend_cap_reached',
  fromServer: true,
  details: { scope: 'studio', limit: '10', resetsAt: '2026-12-01T00:00:00.000Z' },
});

/**
 * A registry tool by id.
 * @param id - The tool id.
 * @returns The declaration.
 */
function tool(id: string): MiniToolSpec {
  const spec = miniToolById(id);
  if (!spec) throw new Error(id);
  return spec;
}

const SNAPSHOT: MiniToolSnapshot = { params: {}, prompt: '', source: { url: 'https://cdn/a.mp3', duration: 12 }, slots: {} };

/**
 * A press of the audio separation, a server tool.
 * @returns The run.
 */
function press(): MiniToolRun {
  return {
    projectId: '11111111-1111-4111-8111-111111111111',
    spaceId: SPACE,
    userId: 'u1',
    spec: tool('audio.separate'),
    snapshot: SNAPSHOT,
    source: { id: 'src', name: 'SONG', position: { x: 100, y: 50 }, groupOrigin: null, mimeType: 'audio/mpeg' },
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
 * The ids of the result nodes the press built.
 * @returns Them, in build order.
 */
function builtIds(): string[] {
  return canvas.addNode.mock.calls.map((call) => (call[2] as { id: string }).id);
}

/**
 * Draw one built node's empty body, which shows its failure mark.
 * @param id - The node.
 * @returns Its failure line.
 */
function drawNode(id: string): HTMLElement {
  cleanup();
  shownNode.id = id;
  render(<NodePlaceholder modality='audio' />);
  return screen.getByTestId('node-upload-error');
}

beforeEach(() => {
  vi.clearAllMocks();
  useUploadMarksStore.setState({ marks: {} });
});

afterEach(() => {
  cleanup();
  resetRunOnceForTests();
});

describe('an audio separation press refused at a spend limit', () => {
  it('keeps every result node, each saying a spend limit', async () => {
    api.run.mockRejectedValue(SPEND_CAP);
    await startMiniToolRun(press());

    expect(api.run).toHaveBeenCalledTimes(1);
    const ids = builtIds();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(drawNode(id)).toHaveTextContent(spendCapMessage('studio', '10', '2026-12-01T00:00:00.000Z'));
    }
  });
});
