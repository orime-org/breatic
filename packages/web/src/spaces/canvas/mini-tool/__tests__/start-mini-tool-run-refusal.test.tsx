// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * A server tool's press refused 402 (inner#1968 design 3.3, row "server
 * tool, grid included"; section 21 row 21). The result nodes built at the
 * press stay on the canvas, and each shows the failure mark with the server's
 * sentence. When the month's operations are used up the sentence carries a
 * 充值 button that opens the credits overlay (`setActiveOverlayId('credits-overlay')`);
 * a spend-limit refusal carries none, since topping up does not lift a limit.
 * The grid is cut on the server, so its press is refused the same way.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '@breatic/shared';
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
import { NodePlaceholder } from '@web/spaces/canvas/nodes/_shared/NodePlaceholder';
import { startMiniToolRun, type MiniToolRun } from '@web/spaces/canvas/mini-tool/start-mini-tool-run';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import { useUIStore } from '@web/stores/ui';
import { useUploadMarksStore } from '@web/stores/upload-marks';

const SENTENCE = '本月操作次数已用完，积分不足 0.5。充值后可继续。';
const OPERATIONS = new ApiException({ status: 402, message: SENTENCE, reason: 'operations_exhausted', fromServer: true });
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
 * A press of one server tool.
 * @param which - The audio separation, or a 1 x 2 grid of a picture.
 * @returns The run.
 */
function press(which: 'separate' | 'grid'): MiniToolRun {
  const grid = which === 'grid';
  return {
    projectId: '11111111-1111-4111-8111-111111111111',
    spaceId: SPACE,
    userId: 'u1',
    spec: tool(grid ? 'image.grid' : 'audio.separate'),
    snapshot: grid ? { ...SNAPSHOT, source: { url: 'https://cdn/a.png' }, params: { rows: 1, cols: 2 } } : SNAPSHOT,
    source: grid
      ? { id: 'src', name: 'IMG', position: { x: 0, y: 0 }, groupOrigin: null, mimeType: 'image/png', width: 1000, height: 100 }
      : { id: 'src', name: 'SONG', position: { x: 100, y: 50 }, groupOrigin: null, mimeType: 'audio/mpeg' },
    sourceExists: () => true,
    exportFile: vi.fn(),
    fillUpload: vi.fn(),
    exportDrawing: vi.fn(),
    exportExpand: vi.fn(),
    uploadImage: vi.fn(),
    setExporting: vi.fn(),
    stillOpen: () => true,
    onBuilt: vi.fn(),
  } as MiniToolRun;
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
 * @param modality - What the node holds.
 * @returns Its failure line.
 */
function drawNode(id: string, modality: 'audio' | 'image'): HTMLElement {
  cleanup();
  shownNode.id = id;
  render(<NodePlaceholder modality={modality} />);
  return screen.getByTestId('node-upload-error');
}

const CASES = [
  ['audio separation', 'separate', 'audio'],
  ['grid', 'grid', 'image'],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  useUploadMarksStore.setState({ marks: {} });
  useUIStore.getState().setActiveOverlayId(null);
  setLocale('zh-CN');
});

afterEach(() => {
  cleanup();
  resetRunOnceForTests();
  setLocale('en');
});

describe.each(CASES)('a %s press refused 402', (_name, which, modality) => {
  it('keeps every result node, each saying the sentence with a 充值 button that opens the credits overlay', async () => {
    api.run.mockRejectedValue(OPERATIONS);
    await startMiniToolRun(press(which));

    expect(api.run).toHaveBeenCalledTimes(1);
    const ids = builtIds();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const line = drawNode(id, modality);
      expect(line).toHaveTextContent(SENTENCE);
      act(() => useUIStore.getState().setActiveOverlayId(null));
      fireEvent.click(within(line).getByRole('button', { name: '充值' }));
      expect(useUIStore.getState().activeOverlayId).toBe('credits-overlay');
    }
  });

  it('keeps every result node, each saying a spend limit with no 充值 button', async () => {
    api.run.mockRejectedValue(SPEND_CAP);
    await startMiniToolRun(press(which));

    expect(api.run).toHaveBeenCalledTimes(1);
    const ids = builtIds();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const line = drawNode(id, modality);
      expect(line.textContent?.trim()).not.toBe('');
      expect(within(line).queryByRole('button', { name: '充值' })).toBeNull();
    }
  });
});
