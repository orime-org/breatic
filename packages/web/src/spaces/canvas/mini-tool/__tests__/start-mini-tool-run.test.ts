// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * One press of Run (inner#888 §7.5): what is built, what is sent, and what
 * stops before anything is built.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { miniToolById, type MiniToolSnapshot, type MiniToolSpec } from '@breatic/shared/mini-tools';

const canvas = vi.hoisted(() => ({
  addNode: vi.fn(),
  addEdge: vi.fn((_p: string, _s: string, _edge: { source: string; toolId?: string }) => true),
  runCanvasUndoBatch: vi.fn((_p: string, _s: string, body: () => void) => body()),
  createGroup: vi.fn(),
}));
vi.mock('@web/data/yjs/canvas-space', () => canvas);
const api = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@web/data/api/mini-tools', () => ({ miniToolsApi: api }));
vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import { UploadFailedError } from '@web/data/upload/media-upload';
import { toast } from '@web/lib/toast';
import { DrawingEmptyError } from '@web/spaces/canvas/mini-tool/export-drawing';
import { ImageTooLargeError } from '@web/spaces/canvas/mini-tool/adjust-export';
import { NODE_STEP } from '@web/spaces/canvas/drop-layout';
import { EMPTY_NODE_SIZE, mediaNodeHeight } from '@web/spaces/canvas/group-geometry';
import { outputPlacementOf } from '@web/spaces/canvas/mini-tool/output-placement';
import {
  miniToolIntent,
  startMiniToolRun,
  type ExportedFile,
  type MiniToolRun,
} from '@web/spaces/canvas/mini-tool/start-mini-tool-run';
import { getRunning, resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import { useUploadMarksStore, type UploadMark } from '@web/stores/upload-marks';

const SPACE = '22222222-2222-4222-8222-222222222222';

/**
 * The uploader's marks on the nodes this press built, in build order.
 * @returns Each node's mark.
 */
function marksOfBuilt(): (UploadMark | undefined)[] {
  const ids = canvas.addNode.mock.calls.map((call) => (call[2] as { id: string }).id);
  return ids.map((id) => useUploadMarksStore.getState().markOf(SPACE, id));
}

/**
 * Every built node carries a failed mark with this message.
 * @param message - The message.
 */
function expectAllFailed(message: object): void {
  const marks = marksOfBuilt();
  expect(marks.length).toBeGreaterThan(0);
  for (const mark of marks) expect(mark).toMatchObject({ state: 'failed', message });
}

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
    fillUploads: vi.fn(),
    exportDrawing: vi.fn(),
    exportExpand: vi.fn(),
    uploadImage: vi.fn(),
    setExporting: vi.fn(),
    stillOpen: () => true,
    onBuilt: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useUploadMarksStore.setState({ marks: {} });
  api.run.mockResolvedValue({ task_id: 't', status: 'pending' });
});

describe('startMiniToolRun', () => {
  // inner#1490: the press waits outside the panel, so pressing again from a
  // reopened panel builds no second set of nodes and sends nothing.
  it('builds one set of nodes and sends one run for a press made while the first waits', async () => {
    let finish: (() => void) | undefined;
    api.run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ task_id: 't', status: 'pending' });
        }),
    );
    const first = startMiniToolRun(press());
    const again = startMiniToolRun(press());
    await vi.waitFor(() => expect(api.run).toHaveBeenCalledTimes(1));
    expect(getRunning(miniToolIntent('22222222-2222-4222-8222-222222222222', 'src', 'audio.separate')) !== undefined).toBe(true);
    finish?.();
    await Promise.all([first, again]);

    expect(canvas.addNode).toHaveBeenCalledTimes(2);
    expect(api.run).toHaveBeenCalledTimes(1);
    expect(api.run.mock.calls[0]?.[1]).toEqual(expect.any(String));
    expect(getRunning(miniToolIntent('22222222-2222-4222-8222-222222222222', 'src', 'audio.separate')) !== undefined).toBe(false);
  });

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
    // Each node's footprint, which the camera frames.
    expect(run.onBuilt).toHaveBeenCalledWith(
      nodes.map((node) => ({ id: node.id, position: node.position, ...EMPTY_NODE_SIZE })),
      undefined,
    );
  });

  // §6.7: a result the size of its source is built at that size, so the node
  // reads and lays out as tall as it will be, for everyone, and the camera
  // frames all of it.
  it('builds a result the size of its source at that size', async () => {
    const run = press({
      spec: tool('image.adjust'),
      snapshot: { ...SNAPSHOT, params: {} },
      source: { id: 'src', name: 'IMG', position: { x: 0, y: 0 }, groupOrigin: null, mimeType: 'image/png', width: 1600, height: 1200 },
      exportFile: vi.fn(() => Promise.resolve([{ file: new File(['x'], 'a.png', { type: 'image/png' }) }])),
    });
    await startMiniToolRun(run);
    const [node] = canvas.addNode.mock.calls.map((call) => call[2]);
    // A picture's own size lives in `mediaWidth` / `mediaHeight`; `width` /
    // `height` are a Group's footprint, which a result's write never touches.
    expect(node.data).toMatchObject({ mediaWidth: 1600, mediaHeight: 1200 });
    expect(node.data).not.toHaveProperty('width');
    expect(run.onBuilt).toHaveBeenCalledWith(
      [{ id: node.id, position: node.position, width: EMPTY_NODE_SIZE.width, height: mediaNodeHeight(1600, 1200) }],
      undefined,
    );
  });

  it('builds each grid tile at its own cut size', async () => {
    const files = [0, 1].map((i) => new File(['x'], `t${i}.png`, { type: 'image/png' }));
    const run = press({
      spec: tool('image.grid'),
      snapshot: { ...SNAPSHOT, params: { rows: 1, cols: 2 } },
      source: { id: 'src', name: 'IMG', position: { x: 0, y: 0 }, groupOrigin: null, mimeType: 'image/png', width: 1001, height: 100 },
      exportFile: vi.fn(() => Promise.resolve(files.map((file) => ({ file })))),
    });
    await startMiniToolRun(run);
    const nodes = canvas.addNode.mock.calls.map((call) => call[2]);
    expect(nodes.map((node) => [node.data.mediaWidth, node.data.mediaHeight])).toEqual([[501, 100], [500, 100]]);
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
    }, expect.any(String));
  });

  // A8, A13: a refused request opened no row, so the nodes it built say so; they stay.
  it('says a refused request on the nodes it built and keeps them', async () => {
    api.run.mockRejectedValue(new Error('network'));
    await startMiniToolRun(press());
    expect(toast.error).not.toHaveBeenCalled();
    expect(canvas.addNode).toHaveBeenCalledTimes(2);
    expectAllFailed({ key: 'canvas.miniTool.panel.couldNotStart' });
  });

  // inner#1490: a press let go with its request out and no final answer (the
  // account changed, the server would no longer remember it) stops the wait.
  it('ends the wait on the nodes when the press is let go without an answer', async () => {
    let drop: (err: unknown) => void = () => undefined;
    api.run.mockReturnValue(new Promise((_, reject) => (drop = reject)));
    const work = startMiniToolRun(press());
    await vi.waitFor(() => expect(api.run).toHaveBeenCalled());
    expect(marksOfBuilt().every((mark) => mark?.state === 'waiting')).toBe(true);
    resetRunOnceForTests();
    drop(new Error('network'));
    await expect(work).resolves.toEqual({ kind: 'released' });
    expect(marksOfBuilt()).toEqual([undefined, undefined]);
  });

  // A13: the server's answer is what ends the wait.
  it('marks the nodes waiting until the server takes the run, then clears them', async () => {
    let accept: (value: unknown) => void = () => undefined;
    api.run.mockReturnValue(new Promise((resolve) => (accept = resolve)));
    const work = startMiniToolRun(press());
    await vi.waitFor(() => expect(api.run).toHaveBeenCalled());
    expect(marksOfBuilt().map((mark) => mark?.state)).toEqual(['waiting', 'waiting']);
    accept({ task_id: 't', status: 'pending' });
    await work;
    expect(marksOfBuilt()).toEqual([undefined, undefined]);
  });

  // A13: the nodes are on the canvas before the browser starts its export.
  it('builds the nodes of a browser tool before its export, waiting', async () => {
    let done: (files: ExportedFile[]) => void = () => undefined;
    const run = press({
      spec: tool('image.adjust'),
      exportFile: vi.fn(() => new Promise<ExportedFile[]>((resolve) => (done = resolve))),
    });
    const work = startMiniToolRun(run);
    await vi.waitFor(() => expect(run.exportFile).toHaveBeenCalled());
    expect(canvas.addNode).toHaveBeenCalledTimes(1);
    expect(run.onBuilt).toHaveBeenCalledOnce();
    expect(marksOfBuilt().map((mark) => mark?.state)).toEqual(['waiting']);
    // A14: the mark says which tool the collaborators should see it running.
    expect(marksOfBuilt()[0]).toMatchObject({ action: 'image.adjust' });
    done([{ file: new File(['x'], 'a.png', { type: 'image/png' }) }]);
    await work;
  });

  it('uploads a browser tool export into its node, tagged with the tool', async () => {
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    const run = press({
      spec: tool('image.rotate'),
      source: { id: 'src', name: 'IMG', position: { x: 0, y: 0 }, groupOrigin: null, mimeType: 'image/png' },
      exportFile: vi.fn(() => Promise.resolve([{ file }])),
    });
    await startMiniToolRun(run);
    const [node] = canvas.addNode.mock.calls.map((call) => call[2]);
    // The upload carries the press's own operation on to the server's answer,
    // so the collaborators keep reading the tool (§6.8).
    const [mark] = marksOfBuilt();
    expect(mark).toMatchObject({ state: 'waiting', action: 'image.rotate' });
    expect(run.fillUpload).toHaveBeenCalledWith(
      node.id,
      file,
      'image',
      { source: 'mini_tool', toolName: 'image.rotate' },
      mark!.op,
    );
    expect(api.run).not.toHaveBeenCalled();
  });

  it('names and places the tiles of a grid and fills them in one batch', async () => {
    const files = [0, 1, 2, 3].map((i) => new File(['x'], `t${i}.png`, { type: 'image/png' }));
    const run = press({
      spec: tool('image.grid'),
      snapshot: { ...SNAPSHOT, params: { rows: 2, cols: 2 } },
      source: { id: 'src', name: 'IMG', position: { x: 0, y: 0 }, groupOrigin: null, mimeType: 'image/png' },
      exportFile: vi.fn(() => Promise.resolve(files.map((file) => ({ file })))),
    });

    await startMiniToolRun(run);

    const nodes = canvas.addNode.mock.calls.map((call) => call[2]);
    expect(nodes.map((node) => node.data.name)).toEqual(['GRID-r1c1-IMG', 'GRID-r1c2-IMG', 'GRID-r2c1-IMG', 'GRID-r2c2-IMG']);
    expect(nodes[1].position.x - nodes[0].position.x).toBe(NODE_STEP.x);
    expect(run.fillUploads).toHaveBeenCalledWith(
      nodes.map((node, i) => ({ nodeId: node.id, file: files[i], markOp: marksOfBuilt()[i]!.op })),
      { source: 'mini_tool', toolName: 'image.grid' },
    );
    expect(marksOfBuilt().map((mark) => mark?.action)).toEqual(['image.grid', 'image.grid', 'image.grid', 'image.grid']);
    expect(run.fillUpload).not.toHaveBeenCalled();
  });

  // A13: the tiles are laid out before the export, from the source's own size.
  it('lays the tiles out from the source size before the export', async () => {
    const files = [0, 1, 2, 3].map((i) => new File(['x'], `t${i}.png`, { type: 'image/png' }));
    const run = press({
      spec: tool('image.grid'),
      snapshot: { ...SNAPSHOT, params: { rows: 2, cols: 2 } },
      source: { id: 'src', name: 'IMG', position: { x: 0, y: 0 }, groupOrigin: null, mimeType: 'image/png', width: 400, height: 300 },
      exportFile: vi.fn(() => Promise.resolve(files.map((file) => ({ file })))),
    });

    await startMiniToolRun(run);

    const expected = outputPlacementOf(run.spec, { rows: 2, cols: 2 }, Array.from({ length: 4 }, () => ({ width: 200, height: 150 })), 'IMG');
    const nodes = canvas.addNode.mock.calls.map((call) => call[2]);
    expect(nodes.map((node) => node.position.y)).toEqual(expected.map((placed) => placed.y));
  });

  it('puts the tiles of a grid in a group named after the source, in the same undo entry', async () => {
    const files = [0, 1, 2, 3].map((i) => new File(['x'], `t${i}.png`, { type: 'image/png' }));
    const run = press({
      spec: tool('image.grid'),
      snapshot: { ...SNAPSHOT, params: { rows: 2, cols: 2 } },
      source: { id: 'src', name: 'IMG', position: { x: 0, y: 0 }, groupOrigin: null, mimeType: 'image/png' },
      exportFile: vi.fn(() => Promise.resolve(files.map((file) => ({ file })))),
    });

    // One undo takes back the tiles and their group, so both are written
    // inside the one batch.
    let inBatch = false;
    const writtenInBatch: boolean[] = [];
    canvas.runCanvasUndoBatch.mockImplementationOnce((_p: string, _s: string, body: () => void) => {
      inBatch = true;
      body();
      inBatch = false;
    });
    for (let i = 0; i < 4; i++) canvas.addNode.mockImplementationOnce(() => void writtenInBatch.push(inBatch));
    canvas.createGroup.mockImplementationOnce(() => void writtenInBatch.push(inBatch));

    await startMiniToolRun(run);

    expect(canvas.runCanvasUndoBatch).toHaveBeenCalledOnce();
    expect(canvas.createGroup).toHaveBeenCalledOnce();
    expect(writtenInBatch).toEqual([true, true, true, true, true]);
    const [, , group, members] = canvas.createGroup.mock.calls[0]!;
    const nodes = canvas.addNode.mock.calls.map((call) => call[2]);
    expect(group.data.name).toBe('GRID-IMG');
    expect(members.map((member: { id: string }) => member.id)).toEqual(nodes.map((node) => node.id));
    expect(run.onBuilt).toHaveBeenCalledWith(
      nodes.map((node) => expect.objectContaining({ id: node.id, position: node.position })),
      { id: group.id, position: group.position, width: group.data.width, height: group.data.height },
    );
  });

  it('puts a single picked tile in its group too, and hands the group to the press', async () => {
    const file = new File(['x'], 't.png', { type: 'image/png' });
    const run = press({
      spec: tool('image.grid'),
      snapshot: { ...SNAPSHOT, params: { rows: 3, cols: 3, skip: [0, 1, 2, 3, 5, 6, 7, 8] } },
      source: { id: 'src', name: 'IMG', position: { x: 0, y: 0 }, groupOrigin: null, mimeType: 'image/png' },
      exportFile: vi.fn(() => Promise.resolve([{ file }])),
    });

    await startMiniToolRun(run);

    const nodes = canvas.addNode.mock.calls.map((call) => call[2]);
    expect(nodes.map((node) => node.data.name)).toEqual(['GRID-r2c2-IMG']);
    expect(canvas.createGroup).toHaveBeenCalledOnce();
    const [, , group, members] = canvas.createGroup.mock.calls[0]!;
    expect(group.data.name).toBe('GRID-IMG');
    expect(members.map((member: { id: string }) => member.id)).toEqual([nodes[0].id]);
    expect(vi.mocked(run.onBuilt).mock.calls[0]![1]).toEqual({
      id: group.id,
      position: group.position,
      width: group.data.width,
      height: group.data.height,
    });
  });

  it('makes no group for a tool that does not group its results', async () => {
    const run = press();
    await startMiniToolRun(run);
    expect(canvas.createGroup).not.toHaveBeenCalled();
    expect(vi.mocked(run.onBuilt).mock.calls[0]![1]).toBeUndefined();
  });

  it('says on its node that the picture is too large for the adjust', async () => {
    await startMiniToolRun(
      press({ spec: tool('image.adjust'), exportFile: vi.fn(() => Promise.reject(new ImageTooLargeError())) }),
    );
    expect(toast.warning).not.toHaveBeenCalled();
    expectAllFailed({ key: 'canvas.miniTool.panel.imageTooLarge' });
  });

  it('says on its node that the export failed, and keeps the node', async () => {
    await startMiniToolRun(
      press({ spec: tool('image.rotate'), exportFile: vi.fn(() => Promise.reject(new Error('cors'))) }),
    );
    expect(toast.warning).not.toHaveBeenCalled();
    expect(canvas.addNode).toHaveBeenCalledTimes(1);
    expectAllFailed({ key: 'canvas.miniTool.panel.exportFailed' });
  });

  // §7.2: the source went while the export ran.
  it('says on the nodes that the source is gone, and sends nothing', async () => {
    await startMiniToolRun(press({ sourceExists: () => false }));
    expect(toast.warning).not.toHaveBeenCalled();
    expect(api.run).not.toHaveBeenCalled();
    expectAllFailed({ key: 'canvas.miniTool.panel.sourceGone' });
  });

  // inner#1302 §6.5: a reader who closed the panel and opened another keeps its selection.
  it('builds the nodes without selecting them once the panel was opened again', async () => {
    const run = press({ stillOpen: () => false });
    await startMiniToolRun(run);
    expect(canvas.addNode).toHaveBeenCalledTimes(2);
    expect(run.onBuilt).not.toHaveBeenCalled();
  });

  it('places the nodes from the absolute position of a grouped source', async () => {
    await startMiniToolRun(press({ source: { ...press().source, groupOrigin: { x: 1000, y: 2000 } } }));
    expect(canvas.addNode.mock.calls[0]?.[2].position).toEqual({ x: 1100 + NODE_STEP.x, y: 2050 });
  });

  // inner#1302 §6.5: a drawing tool exports and uploads its images before
  // anything is built, and the request carries them.
  describe('the expand tool', () => {
    const IMAGE = { id: 'src', name: 'IMG', position: { x: 0, y: 0 }, groupOrigin: null, mimeType: 'image/png' };
    const FRAME = { x: -0.25, y: 0, width: 1.5, height: 1 };
    const SIZE = { width: 1600, height: 1000 };

    it('uploads the padded picture and its mask together and sends both', async () => {
      const run = press({
        spec: tool('image.expand'),
        source: IMAGE,
        snapshot: { ...SNAPSHOT, source: { url: 'https://cdn/a.png' }, prompt: '' },
        capture: { kind: 'expand', frame: FRAME, sourceSize: SIZE },
        exportExpand: vi.fn(() =>
          Promise.resolve({ image: new Blob(['i'], { type: 'image/png' }), mask: new Blob(['m'], { type: 'image/png' }) }),
        ),
        uploadImage: vi.fn((file: File) => Promise.resolve(`https://cdn/${file.name}`)),
      });

      await startMiniToolRun(run);

      expect(run.exportExpand).toHaveBeenCalledWith('https://cdn/a.png', FRAME, SIZE);
      expect(vi.mocked(run.uploadImage).mock.calls.map(([file]) => file.name).sort()).toEqual([
        'EXPAND-image.png',
        'EXPAND-mask.png',
      ]);
      expect(api.run).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: 'image.expand',
          expand: { image: 'https://cdn/EXPAND-image.png', mask: 'https://cdn/EXPAND-mask.png' },
        }),
        expect.any(String),
      );
      expect(vi.mocked(run.setExporting).mock.calls).toEqual([[true], [false]]);
    });

    it('says on its node that the export failed', async () => {
      const run = press({
        spec: tool('image.expand'),
        source: IMAGE,
        capture: { kind: 'expand', frame: FRAME, sourceSize: SIZE },
        exportExpand: vi.fn(() => Promise.reject(new Error('cors'))),
      });
      await startMiniToolRun(run);
      expect(toast.warning).not.toHaveBeenCalled();
      expect(api.run).not.toHaveBeenCalled();
      expectAllFailed({ key: 'canvas.miniTool.panel.exportFailed' });
    });
  });

  describe('a drawing tool', () => {
    const STROKE = { kind: 'stroke', erase: false, size: 5, color: '#FF3B30', points: [[0.1, 0.1]] } as const;
    const IMAGE = { id: 'src', name: 'IMG', position: { x: 0, y: 0 }, groupOrigin: null, mimeType: 'image/jpeg' };
    const PICTURE = { ...SNAPSHOT, source: { url: 'https://cdn/a.jpg' }, prompt: 'a cat' };

    /**
     * A press of a drawing tool whose export and uploads succeed.
     * @param id - The tool.
     * @param kind - Its drawing kind.
     * @param over - Fields to override.
     * @returns The run.
     */
    function drawingPress(id: string, kind: 'mask' | 'sketch', over: Partial<MiniToolRun> = {}): MiniToolRun {
      const image = new Blob(['i'], { type: 'image/png' });
      const mask = new Blob(['m'], { type: 'image/png' });
      return press({
        spec: tool(id),
        source: IMAGE,
        snapshot: PICTURE,
        capture: { kind: 'strokes', ops: [STROKE] },
        exportDrawing: vi.fn(() => Promise.resolve(kind === 'mask' ? { mask } : { image })),
        uploadImage: vi.fn((file: File) => Promise.resolve(`https://cdn/${file.name}`)),
        ...over,
      });
    }

    it('uploads the mask alone and sends it, with its node built first', async () => {
      const run = drawingPress('image.inpaint', 'mask');
      vi.mocked(run.setExporting).mockImplementation((busy) => {
        if (busy) expect(canvas.addNode).toHaveBeenCalled();
      });
      await startMiniToolRun(run);
      expect(run.exportDrawing).toHaveBeenCalledWith('https://cdn/a.jpg', 'mask', [STROKE]);
      expect(vi.mocked(run.setExporting).mock.calls).toEqual([[true], [false]]);
      expect(api.run).toHaveBeenCalledWith(
        expect.objectContaining({
          tool: 'image.inpaint',
          prompt: 'a cat',
          drawing: { mask: 'https://cdn/INPAINT-mask.png' },
        }),
        expect.any(String),
      );
    });

    it('sends a sketch as one picture', async () => {
      await startMiniToolRun(drawingPress('image.sketch', 'sketch'));
      expect(api.run).toHaveBeenCalledWith(
        expect.objectContaining({ drawing: { image: 'https://cdn/SKETCH-sketch.png' } }),
        expect.any(String),
      );
    });

    it('asks for a drawing on its node when the drawing leaves nothing', async () => {
      const run = drawingPress('image.erase', 'mask', {
        exportDrawing: vi.fn(() => Promise.reject(new DrawingEmptyError())),
      });
      await startMiniToolRun(run);
      expect(toast.warning).not.toHaveBeenCalled();
      expect(api.run).not.toHaveBeenCalled();
      expect(vi.mocked(run.setExporting).mock.calls).toEqual([[true], [false]]);
      expectAllFailed({ key: 'canvas.miniTool.panel.drawingEmpty' });
    });

    it('says on its node why an upload of the drawing failed', async () => {
      const run = drawingPress('image.inpaint', 'mask', {
        uploadImage: vi.fn(() => Promise.reject(new UploadFailedError('storage'))),
      });
      await startMiniToolRun(run);
      expect(toast.error).not.toHaveBeenCalled();
      expect(api.run).not.toHaveBeenCalled();
      expectAllFailed({ key: 'canvas.upload.storageFull' });
    });
  });

  it('hands a browser tool its capture from the press to export from', async () => {
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    const capture = { kind: 'mark' as const, objects: [] };
    const run = press({ spec: tool('image.mark'), capture, exportFile: vi.fn(() => Promise.resolve([{ file }])) });
    await startMiniToolRun(run);
    expect(run.exportFile).toHaveBeenCalledWith(run.spec, run.snapshot, capture);
  });

  it('holds a browser tool busy through its export, and a server tool not at all', async () => {
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    const browser = press({ spec: tool('image.rotate'), exportFile: vi.fn(() => Promise.resolve([{ file }])) });
    await startMiniToolRun(browser);
    expect(vi.mocked(browser.setExporting).mock.calls).toEqual([[true], [false]]);
    const server = press();
    await startMiniToolRun(server);
    expect(server.setExporting).not.toHaveBeenCalled();
  });
});
