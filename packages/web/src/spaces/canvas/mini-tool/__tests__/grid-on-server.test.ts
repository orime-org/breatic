// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The grid is cut on the server (inner#1968 design 3.2.2, test spec B-12,
 * B-82). A press still builds a node per picked tile, sized by the shared
 * tile function the container cuts with, and then sends one mini-tool run
 * carrying the source address, rows, cols, skip and the result node ids, as
 * any server tool does: the browser cuts nothing and uploads nothing. The
 * panel's price footer still says free, from the tool's `billing: "free"`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gridTileRects, miniToolById, type MiniToolSpec } from '@breatic/shared/mini-tools';

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

import { startMiniToolRun, type MiniToolRun } from '@web/spaces/canvas/mini-tool/start-mini-tool-run';
import { creditMode } from '@web/spaces/canvas/mini-tool/mini-tool-view';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import { useUploadMarksStore } from '@web/stores/upload-marks';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const SPACE = '22222222-2222-4222-8222-222222222222';
const SOURCE_URL = 'https://cdn/a.png';
const WIDTH = 1000;
const HEIGHT = 700;

/**
 * The grid's registry entry.
 * @returns The declaration.
 */
function grid(): MiniToolSpec {
  const spec = miniToolById('image.grid');
  if (!spec) throw new Error('image.grid');
  return spec;
}

/**
 * A 4 x 4 grid press of a 1000 x 700 picture, tile 5 skipped.
 * @returns The run.
 */
function press(): MiniToolRun {
  return {
    projectId: PROJECT,
    spaceId: SPACE,
    userId: 'u1',
    spec: grid(),
    snapshot: { params: { rows: 4, cols: 4, skip: [5] }, prompt: '', source: { url: SOURCE_URL }, slots: {} },
    source: { id: 'src', name: 'IMG', position: { x: 0, y: 0 }, groupOrigin: null, mimeType: 'image/png', width: WIDTH, height: HEIGHT },
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
 * The nodes the press built, in build order.
 * @returns Each node's id and planned media size.
 */
function built(): { id: string; width: unknown; height: unknown }[] {
  return canvas.addNode.mock.calls.map((call) => {
    const node = call[2] as { id: string; data: { mediaWidth?: unknown; mediaHeight?: unknown } };
    return { id: node.id, width: node.data.mediaWidth, height: node.data.mediaHeight };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useUploadMarksStore.setState({ marks: {} });
});

afterEach(() => {
  resetRunOnceForTests();
});

describe('B-82 a grid press runs on the server', () => {
  it('sends one run with the source address, rows, cols, skip and the result node ids, and cuts or uploads nothing', async () => {
    api.run.mockResolvedValue({ task_id: 't1' });
    const run = press();
    await startMiniToolRun(run);

    expect(run.exportFile).not.toHaveBeenCalled();
    expect(run.fillUploads).not.toHaveBeenCalled();
    expect(run.fillUpload).not.toHaveBeenCalled();
    expect(run.uploadImage).not.toHaveBeenCalled();
    expect(api.run).toHaveBeenCalledTimes(1);
    const body = api.run.mock.calls[0][0] as Record<string, unknown>;
    const nodes = built();
    expect(nodes).toHaveLength(15);
    expect(body).toMatchObject({
      tool: 'image.grid',
      project_id: PROJECT,
      space_id: SPACE,
      node_ids: nodes.map((node) => node.id),
      source: { url: SOURCE_URL },
      params: { rows: 4, cols: 4, skip: [5] },
    });
  });

  it('sizes each result node as the shared tile function cuts its tile', async () => {
    api.run.mockResolvedValue({ task_id: 't1' });
    await startMiniToolRun(press());

    const tiles = gridTileRects(WIDTH, HEIGHT, 4, 4).filter((_tile, index) => index !== 5);
    expect(built().map(({ width, height }) => ({ width, height }))).toEqual(
      tiles.map(({ width, height }) => ({ width, height })),
    );
  });
});

describe('B-12 the grid panel price footer', () => {
  it('says free for the grid, now a container tool', () => {
    const spec = grid();
    expect(spec.run.kind).toBe('container');
    expect(creditMode(spec)).toBe('free');
  });

  it('still bills another container tool by usage', () => {
    const other = miniToolById('video.cut');
    expect(other?.run.kind).toBe('container');
    expect(creditMode(other!)).toBe('usage');
  });
});
