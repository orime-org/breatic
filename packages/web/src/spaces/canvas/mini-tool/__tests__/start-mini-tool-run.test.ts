// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One press of Run (inner#888 §7.5): what is built, what is sent, and what
 * stops before anything is built.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { miniToolById, type MiniToolSnapshot, type MiniToolSpec } from '@breatic/shared';

const canvas = vi.hoisted(() => ({
  addNode: vi.fn(),
  addEdge: vi.fn((_p: string, _s: string, _edge: { source: string; toolId?: string }) => true),
  runCanvasUndoBatch: vi.fn((_p: string, _s: string, body: () => void) => body()),
}));
vi.mock('@web/data/yjs/canvas-space', () => canvas);
const api = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@web/data/api/mini-tools', () => ({ miniToolsApi: api }));
vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import { toast } from '@web/lib/toast';
import { NODE_STEP } from '@web/spaces/canvas/drop-layout';
import { startMiniToolRun, type MiniToolRun } from '@web/spaces/canvas/mini-tool/start-mini-tool-run';

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

const SNAPSHOT: MiniToolSnapshot = {
  params: {},
  prompt: '',
  source: { url: 'https://cdn/a.mp3', duration: 12 },
  slots: {},
};

/**
 * A press with defaults the case overrides.
 * @param over - Fields to override.
 * @returns The run.
 */
function press(over: Partial<MiniToolRun> = {}): MiniToolRun {
  return {
    projectId: '11111111-1111-4111-8111-111111111111',
    spaceId: '22222222-2222-4222-8222-222222222222',
    userId: 'u1',
    spec: tool('audio.separate'),
    snapshot: SNAPSHOT,
    source: {
      id: 'src',
      name: 'SONG',
      position: { x: 100, y: 50 },
      groupOrigin: null,
      mimeType: 'audio/mpeg',
    },
    sourceExists: () => true,
    exportFile: vi.fn(),
    fillUpload: vi.fn(),
    onBuilt: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.run.mockResolvedValue({ task_id: 't', status: 'pending' });
});

describe('startMiniToolRun', () => {
  // A6: one node per declared output, named after the source, stacked to its right.
  it('builds one node per output to the right of the source, in one undo entry', async () => {
    const run = press();
    await startMiniToolRun(run);
    expect(canvas.runCanvasUndoBatch).toHaveBeenCalledOnce();
    const nodes = canvas.addNode.mock.calls.map((call) => call[2]);
    expect(nodes.map((node) => [node.type, node.data.name, node.position])).toEqual([
      ['audio', 'VOCALS-SONG', { x: 100 + NODE_STEP.x, y: 50 }],
      ['audio', 'INSTRUMENTAL-SONG', { x: 100 + NODE_STEP.x, y: 50 + NODE_STEP.y }],
    ]);
    const edges = canvas.addEdge.mock.calls.map((call) => call[2]);
    expect(edges.every((edge) => edge.source === 'src' && edge.toolId === 'audio.separate')).toBe(true);
    expect(run.onBuilt).toHaveBeenCalledWith(nodes.map((node) => ({ id: node.id, position: node.position })));
  });

  it('sends the snapshot with the new nodes for a server tool', async () => {
    await startMiniToolRun(press());
    const nodes = canvas.addNode.mock.calls.map((call) => call[2]);
    expect(api.run).toHaveBeenCalledWith({
      tool: 'audio.separate',
      project_id: '11111111-1111-4111-8111-111111111111',
      space_id: '22222222-2222-4222-8222-222222222222',
      node_ids: nodes.map((node) => node.id),
      source: { url: 'https://cdn/a.mp3', mime_type: 'audio/mpeg', duration: 12 },
      params: {},
      slots: {},
    });
  });

  // A8: a refused request opened no row, so the press is where it is said; the nodes stay.
  it('says a refused request and keeps the nodes', async () => {
    api.run.mockRejectedValue(new Error('network'));
    await startMiniToolRun(press());
    expect(toast.error).toHaveBeenCalledOnce();
    expect(canvas.addNode).toHaveBeenCalledTimes(2);
  });

  it('uploads a browser tool export into its node, tagged with the tool', async () => {
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    const run = press({
      spec: tool('image.rotate'),
      source: { id: 'src', name: 'IMG', position: { x: 0, y: 0 }, groupOrigin: null, mimeType: 'image/png' },
      exportFile: vi.fn(() => Promise.resolve(file)),
    });
    await startMiniToolRun(run);
    const [node] = canvas.addNode.mock.calls.map((call) => call[2]);
    expect(run.fillUpload).toHaveBeenCalledWith(node.id, file, 'image', {
      source: 'mini_tool',
      toolName: 'image.rotate',
    });
    expect(api.run).not.toHaveBeenCalled();
  });

  // §7.5 2b: an export that fails builds nothing.
  it('builds nothing when the export fails', async () => {
    await startMiniToolRun(
      press({ spec: tool('image.rotate'), exportFile: vi.fn(() => Promise.reject(new Error('cors'))) }),
    );
    expect(toast.warning).toHaveBeenCalledOnce();
    expect(canvas.addNode).not.toHaveBeenCalled();
  });

  // §7.2: the source went while the export ran.
  it('builds nothing when the source is gone by build time', async () => {
    await startMiniToolRun(press({ sourceExists: () => false }));
    expect(toast.warning).toHaveBeenCalledOnce();
    expect(canvas.addNode).not.toHaveBeenCalled();
    expect(api.run).not.toHaveBeenCalled();
  });

  it('places the nodes from the absolute position of a grouped source', async () => {
    await startMiniToolRun(press({ source: { ...press().source, groupOrigin: { x: 1000, y: 2000 } } }));
    expect(canvas.addNode.mock.calls[0]?.[2].position).toEqual({ x: 1100 + NODE_STEP.x, y: 2050 });
  });
});
