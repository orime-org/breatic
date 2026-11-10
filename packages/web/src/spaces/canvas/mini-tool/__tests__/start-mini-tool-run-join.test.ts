// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * One press of the join tool's Run (inner#1825 §6.5): the list's first clip is
 * the request's source and the rest are its `clips`; the result lands right of
 * the clip furthest right on the canvas (a grouped clip measured at its group
 * origin plus its own position), and every clip still on the canvas is wired
 * into it with the tool's id. A clip whose node was deleted still joins, since
 * the list holds its address, but gets no edge.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { miniToolById, type MiniToolSlotValue, type MiniToolSnapshot, type MiniToolSpec } from '@breatic/shared/mini-tools';

const canvas = vi.hoisted(() => ({
  addNode: vi.fn(),
  addEdge: vi.fn((_p: string, _s: string, _edge: { source: string; target: string; toolId?: string }) => true),
  runCanvasUndoBatch: vi.fn((_p: string, _s: string, body: () => void) => body()),
  createGroup: vi.fn(),
}));
vi.mock('@web/data/yjs/canvas-space', () => canvas);
const api = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@web/data/api/mini-tools', () => ({ miniToolsApi: api }));
vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import { NODE_STEP } from '@web/spaces/canvas/drop-layout';
import { startMiniToolRun, type MiniToolRun } from '@web/spaces/canvas/mini-tool/start-mini-tool-run';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import { useUploadMarksStore } from '@web/stores/upload-marks';

/**
 * A registry tool by id.
 * @param id - The tool id.
 * @returns The declaration.
 * @throws {Error} When the registry has no such tool.
 */
function tool(id: string): MiniToolSpec {
  const spec = miniToolById(id);
  if (!spec) throw new Error(`the registry has no ${id}`);
  return spec;
}

/** Where each clip's node sits: stored position and its group's origin. */
type Placement = { position: { x: number; y: number }; groupOrigin: { x: number; y: number } | null };

const A = { url: 'https://cdn/a.mp4', duration: 4, nodeId: 'a', name: 'A' } as MiniToolSlotValue;
const B = { url: 'https://cdn/b.mp4', duration: 5, nodeId: 'b', name: 'B' } as MiniToolSlotValue;
const C = { url: 'https://cdn/c.mp4', duration: 6, nodeId: 'c', name: 'C' } as MiniToolSlotValue;

/**
 * `b` is stored at x 50 inside a group at x 1000, so it sits at x 1050 and is
 * the clip furthest right; `c` at x 900 would be, read without the origin.
 */
const PLACEMENTS: Record<string, Placement> = {
  a: { position: { x: 100, y: 50 }, groupOrigin: null },
  b: { position: { x: 50, y: 30 }, groupOrigin: { x: 1000, y: 0 } },
  c: { position: { x: 900, y: 300 }, groupOrigin: null },
};

const SNAPSHOT: MiniToolSnapshot = {
  params: { crossfade: 0 },
  prompt: '',
  source: { url: A.url, duration: 4 },
  slots: { clips: [B, C] },
};

/**
 * A join press over a, b and c, with defaults the case overrides.
 * @param placements - Where each clip's node is; a missing one was deleted.
 * @returns The run.
 */
function press(placements: Record<string, Placement> = PLACEMENTS): MiniToolRun {
  return {
    projectId: '11111111-1111-4111-8111-111111111111',
    spaceId: '22222222-2222-4222-8222-222222222222',
    userId: 'u1',
    spec: tool('video.join'),
    snapshot: SNAPSHOT,
    source: { id: 'a', name: 'A', ...PLACEMENTS.a!, mimeType: 'video/mp4' },
    sourceExists: () => true,
    placementOf: (nodeId: string) => placements[nodeId],
    exportFile: vi.fn(),
    fillUpload: vi.fn(),
    fillUploads: vi.fn(),
    exportDrawing: vi.fn(),
    exportExpand: vi.fn(),
    uploadImage: vi.fn(),
    setExporting: vi.fn(),
    stillOpen: () => true,
    onBuilt: vi.fn(),
  } as MiniToolRun;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRunOnceForTests();
  useUploadMarksStore.setState({ marks: {} });
  api.run.mockResolvedValue({ task_id: 't', status: 'pending' });
});

describe('a join press (inner#1825 §6.5)', () => {
  it('sends the first clip as the source and the rest as clips, in list order', async () => {
    await startMiniToolRun(press());
    expect(api.run).toHaveBeenCalledTimes(1);
    const body = api.run.mock.calls[0]?.[0] as { tool: string; source: { url: string }; slots: Record<string, unknown> };
    expect(body.tool).toBe('video.join');
    expect(body.source.url).toBe(A.url);
    expect(body.slots.clips).toEqual([
      { url: B.url, duration: 5 },
      { url: C.url, duration: 6 },
    ]);
  });

  it('places the one result right of the clip furthest right, a grouped clip at its group origin', async () => {
    await startMiniToolRun(press());
    const built = canvas.addNode.mock.calls.map((call) => call[2] as { type: string; position: { x: number; y: number } });
    expect(built).toHaveLength(1);
    expect(built[0]?.type).toBe('video');
    expect(built[0]?.position).toEqual({ x: 1050 + NODE_STEP.x, y: 30 });
  });

  it('wires every clip into the result with the tool id', async () => {
    await startMiniToolRun(press());
    const result = (canvas.addNode.mock.calls[0]?.[2] as { id: string }).id;
    const edges = canvas.addEdge.mock.calls.map((call) => call[2]);
    expect(edges.map((edge) => edge.source).sort()).toEqual(['a', 'b', 'c']);
    expect(edges.every((edge) => edge.target === result && edge.toolId === 'video.join')).toBe(true);
  });

  it('draws no edge from a clip whose node was deleted, and still sends it', async () => {
    const { c: _gone, ...left } = PLACEMENTS;
    await startMiniToolRun(press(left));
    const edges = canvas.addEdge.mock.calls.map((call) => call[2]);
    expect(edges.map((edge) => edge.source).sort()).toEqual(['a', 'b']);
    const body = api.run.mock.calls[0]?.[0] as { slots: Record<string, unknown> };
    expect(body.slots.clips).toEqual([
      { url: B.url, duration: 5 },
      { url: C.url, duration: 6 },
    ]);
  });
});

/**
 * §6.5 (decided): only the panel's host going away stops a press. After a
 * reorder the list's first clip is another node; that node being deleted still
 * sends its copied address as the source, with no edge from it.
 */
describe('a join press whose first clip is not the host (inner#1825 §6.5)', () => {
  const H = { url: 'https://cdn/h.mp4', duration: 7, nodeId: 'h', name: 'H' } as MiniToolSlotValue;
  const HOST: Placement = { position: { x: 0, y: 0 }, groupOrigin: null };

  /**
   * A press opened on `h` whose list was reordered to b, h, c.
   * @param over - Whether the host still exists, and where each clip's node is.
   * @param over.hostExists - Whether the host node is still on the canvas.
   * @param over.placements - Where each clip's node is; a missing one was deleted.
   * @returns The run.
   */
  function reordered(over: { hostExists: boolean; placements: Record<string, Placement> }): MiniToolRun {
    return {
      ...press(over.placements),
      snapshot: { params: { crossfade: 0 }, prompt: '', source: { url: B.url, duration: 5 }, slots: { clips: [H, C] } },
      source: { id: 'h', name: 'H', ...HOST, mimeType: 'video/mp4' },
      sourceExists: () => over.hostExists,
    } as MiniToolRun;
  }

  it('still sends a deleted first clip as the source and draws no edge from it', async () => {
    await startMiniToolRun(reordered({ hostExists: true, placements: { h: HOST, c: PLACEMENTS.c! } }));
    expect(api.run).toHaveBeenCalledTimes(1);
    const body = api.run.mock.calls[0]?.[0] as { source: { url: string }; slots: Record<string, unknown> };
    expect(body.source.url).toBe(B.url);
    expect(body.slots.clips).toEqual([
      { url: H.url, duration: 7 },
      { url: C.url, duration: 6 },
    ]);
    const edges = canvas.addEdge.mock.calls.map((call) => call[2]);
    expect(edges.map((edge) => edge.source).sort()).toEqual(['c', 'h']);
  });

  it('stops with sourceGone when the host itself was deleted', async () => {
    await startMiniToolRun(reordered({ hostExists: false, placements: { b: PLACEMENTS.b!, c: PLACEMENTS.c! } }));
    expect(api.run).not.toHaveBeenCalled();
    const ids = canvas.addNode.mock.calls.map((call) => (call[2] as { id: string }).id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(useUploadMarksStore.getState().markOf('22222222-2222-4222-8222-222222222222', id)).toMatchObject({
        state: 'failed',
        message: { key: 'canvas.miniTool.panel.sourceGone' },
      });
    }
  });
});
