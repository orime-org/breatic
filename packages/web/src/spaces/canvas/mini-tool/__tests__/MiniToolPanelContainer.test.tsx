// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The open mini-tool panel against the canvas session (inner#888 §7.2): what a
 * run is handed, what a changed source resets, and how the panel closes.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlow } from '@xyflow/react';
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
// jsdom has no 2D rasteriser; the pixel check runs in Playwright.
vi.mock('@web/spaces/canvas/mini-tool/paint-drawing', () => ({ hasInk: vi.fn() }));

import { defaultAdjustValue, type ModelCatalog, type ModelEntry } from '@breatic/shared';

import { TooltipProvider } from '@web/components/ui/tooltip';
import type { CanvasNodeView } from '@web/data/yjs/canvas-space';
import { toast } from '@web/lib/toast';
import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';
import { MiniToolPanelContainer } from '@web/spaces/canvas/mini-tool/MiniToolPanelContainer';
import { hasInk } from '@web/spaces/canvas/mini-tool/paint-drawing';
import { runOnce } from '@web/stores/task-actions-in-flight';
import { miniToolIntent } from '@web/spaces/canvas/mini-tool/start-mini-tool-run';
import { canvasSessions } from '@web/stores/canvas-session';
import type { DrawOp } from '@web/stores/drawing-draft';

const ERASER = {
  name: 'bria-eraser',
  display_name: 'Bria Eraser',
  modality: 'image',
  mode: ['erase'],
  description: '',
  guide: '',
  tier: 'internal',
  generation_time: 15,
  takes_prompt: false,
  params: {
    image: { description: '', default: null, accepts: 'image', fill: 'tool' },
    mask_image: { description: '', default: null, accepts: 'image', fill: 'tool' },
  },
  providers: [],
} as unknown as ModelEntry;

const CATALOG = {
  image: [ERASER], video: [], audio: [], tts: [], three_d: [], total: 1, credit_multiplier: 1,
} as unknown as ModelCatalog;

const ORIENT = { turns: 0, flipX: false, flipY: false };

/**
 * The source image node holding this content.
 * @param content - Its content URL, or empty for none.
 * @returns The node view.
 */
function source(content: string): CanvasNodeView[] {
  return [
    {
      id: 'src',
      type: 'image',
      position: { x: 0, y: 0 },
      data: { handling: false, content, width: 1600, height: 1000 },
    },
  ];
}

let client: QueryClient;

/**
 * The tree under test.
 * @param nodes - The canvas nodes.
 * @param onRun - The run handler.
 * @returns The element.
 */
function tree(nodes: CanvasNodeView[], onRun: () => Promise<void>): React.JSX.Element {
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        {/* Escape is the space region's, as on the real page. */}
        <div data-region='space'>
          <ReactFlow nodes={[{ id: 'src', position: { x: 0, y: 0 }, data: {} }]} edges={[]}>
            <MiniToolPanelContainer nodes={nodes} getLastWriteWasLocal={() => false} onRun={onRun} />
          </ReactFlow>
        </div>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  canvasSessions.of('').getState().closeActivePanel();
  canvasSessions
    .of('')
    .getState()
    .openMiniTool('src', 'image.rotate', { sourceContent: 'a.png', params: { orient: ORIENT } });
});

describe('MiniToolPanelContainer', () => {
  it('runs on the snapshot taken at the press', () => {
    const onRun = vi.fn(() => Promise.resolve());
    render(tree(source('a.png'), onRun));
    fireEvent.click(screen.getByTestId('mini-tool-orient-right'));
    fireEvent.click(screen.getByTestId('mini-tool-run'));
    expect(onRun).toHaveBeenCalledWith(
      'src',
      expect.objectContaining({ id: 'image.rotate' }),
      expect.objectContaining({
        params: { orient: { turns: 1, flipX: false, flipY: false } },
        source: { url: 'a.png' },
      }),
      undefined,
      { width: 1600, height: 1000 },
    );
  });

  // inner#1304: pressing Run leaves picking, as pressing generate does.
  it('ends a pick still under way when Run is pressed, and runs', () => {
    const onRun = vi.fn(() => Promise.resolve());
    render(tree(source('a.png'), onRun));
    act(() => canvasSessions.of('').getState().startMiniToolSlotPick('src', 'style', 3));
    expect(canvasSessions.of('').getState().pickSession).not.toBeNull();
    fireEvent.click(screen.getByTestId('mini-tool-run'));
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(canvasSessions.of('').getState().pickSession).toBeNull();
  });

  it('shows a press under way while the draft says it is exporting', () => {
    render(tree(source('a.png'), () => Promise.resolve()));
    act(() => canvasSessions.of('').getState().setMiniToolExporting(true, canvasSessions.of('').getState().panelSession));
    const run = screen.getByTestId('mini-tool-run');
    expect(run).toHaveAttribute('aria-busy', 'true');
    expect(run).toHaveAttribute('aria-disabled', 'true');
  });

  // inner#1490: the press lives in the run-once registry, so a panel opened
  // while it waits shows it under way and takes no press.
  it('shows a press under way while the registry holds one for this tool and node', () => {
    const onRun = vi.fn(() => Promise.resolve());
    let release: (() => void) | undefined;
    void runOnce(miniToolIntent('', 'src', 'image.rotate'), {
      scope: 'mini-tool',
      prepare: () =>
        new Promise<null>((resolve) => {
          release = () => resolve(null);
        }),
      send: vi.fn(),
    });
    render(tree(source('a.png'), onRun));
    const run = screen.getByTestId('mini-tool-run');
    expect(run).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(run);
    expect(onRun).not.toHaveBeenCalled();
    release?.();
  });

  it('stops waiting once the export is over, whichever way it went', () => {
    // `startMiniToolRun` clears the flag in a `finally`, after a delivered
    // export and a failed one alike.
    render(tree(source('a.png'), () => Promise.resolve()));
    const session = canvasSessions.of('').getState().panelSession;
    act(() => canvasSessions.of('').getState().setMiniToolExporting(true, session));
    const run = screen.getByTestId('mini-tool-run');
    expect(run).toHaveAttribute('aria-busy', 'true');
    act(() => canvasSessions.of('').getState().setMiniToolExporting(false, session));
    expect(run).not.toHaveAttribute('aria-busy');
    expect(run).not.toHaveAttribute('aria-disabled');
  });

  // A7: nothing to export yet, so nothing is started and the reader is told.
  it('tells the reader and runs nothing while the source shows nothing', () => {
    const onRun = vi.fn(() => Promise.resolve());
    render(tree(source(''), onRun));
    fireEvent.click(screen.getByTestId('mini-tool-run'));
    expect(onRun).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledOnce();
  });

  it('resets what was measured on the source when the source changes', () => {
    canvasSessions.of('').getState().setMiniToolParam('orient', { turns: 2, flipX: true, flipY: false });
    const view = render(tree(source('a.png'), () => Promise.resolve()));
    view.rerender(tree(source('b.png'), () => Promise.resolve()));
    const draft = canvasSessions.of('').getState().miniTool;
    expect(draft?.sourceContent).toBe('b.png');
    expect(draft?.params.orient).toEqual(ORIENT);
    expect(toast.warning).toHaveBeenCalledOnce();
  });

  it('picks every grid tile again when the source changes', () => {
    canvasSessions.of('').getState().openMiniTool('src', 'image.grid', {
      sourceContent: 'a.png',
      params: { rows: 3, cols: 3, skip: [] },
    });
    canvasSessions.of('').getState().setMiniToolParam('skip', [1, 2]);
    const view = render(tree(source('a.png'), () => Promise.resolve()));
    view.rerender(tree(source('b.png'), () => Promise.resolve()));
    expect(canvasSessions.of('').getState().miniTool?.params).toEqual({ rows: 3, cols: 3, skip: [] });
  });

  // The crop is converted with the size the crop box read off the shown
  // picture, the size the export crops in (inner#888 §7.4.1); the node's own
  // record of its size can be missing or stale.
  it('a crop tool waits for the size the crop box read off the picture', () => {
    canvasSessions.of('').getState().openMiniTool('src', 'image.crop', {
      sourceContent: 'a.png',
      params: { aspect: 'free', rect: null },
    });
    const onRun = vi.fn(() => Promise.resolve());
    const view = render(tree(source('a.png'), onRun));
    expect(screen.queryByTestId('mini-tool-rect-w')).toBeNull();
    fireEvent.click(screen.getByTestId('mini-tool-run'));
    expect(onRun).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledOnce();
    canvasSessions.of('').getState().setMiniToolSourceSize({ width: 800, height: 600 });
    view.rerender(tree(source('a.png'), onRun));
    expect((screen.getByTestId('mini-tool-rect-w') as HTMLInputElement).value).toBe('800');
  });

  // A7: a grid lays its tiles out from the source's pixels. A node that does
  // not record them has them read off the picture it shows (round 2, R8).
  it('runs a grid with the size read off the shown picture when the node records none', () => {
    const shown = document.createElement('div');
    shown.className = 'react-flow__node';
    shown.dataset.id = 'src';
    const img = document.createElement('img');
    img.dataset.testid = 'image-node-img';
    Object.defineProperty(img, 'naturalWidth', { value: 1200 });
    Object.defineProperty(img, 'naturalHeight', { value: 800 });
    shown.append(img);
    document.body.append(shown);
    canvasSessions.of('').getState().openMiniTool('src', 'image.grid', { sourceContent: 'a.png', params: {} });
    const onRun = vi.fn(() => Promise.resolve());
    const sizeless: CanvasNodeView[] = [
      { id: 'src', type: 'image', position: { x: 0, y: 0 }, data: { handling: false, content: 'a.png' } },
    ];
    render(tree(sizeless, onRun));
    fireEvent.click(screen.getByTestId('mini-tool-run'));
    expect(onRun).toHaveBeenCalledWith('src', expect.objectContaining({ id: 'image.grid' }), expect.anything(), undefined, {
      width: 1200,
      height: 800,
    });
    shown.remove();
  });

  // inner#1303 §6.7: an adjust's result is the source's size, which its node
  // is built at; a node that does not record it has it read off the picture.
  it('runs an adjust with the size read off the shown picture when the node records none', () => {
    const shown = document.createElement('div');
    shown.className = 'react-flow__node';
    shown.dataset.id = 'src';
    const img = document.createElement('img');
    img.dataset.testid = 'image-node-img';
    Object.defineProperty(img, 'naturalWidth', { value: 300 });
    Object.defineProperty(img, 'naturalHeight', { value: 800 });
    shown.append(img);
    document.body.append(shown);
    canvasSessions.of('').getState().openMiniTool('src', 'image.adjust', {
      sourceContent: 'a.png',
      params: { value: { ...defaultAdjustValue, exposure: 20 } },
    });
    const onRun = vi.fn(() => Promise.resolve());
    const sizeless: CanvasNodeView[] = [
      { id: 'src', type: 'image', position: { x: 0, y: 0 }, data: { handling: false, content: 'a.png' } },
    ];
    render(tree(sizeless, onRun));
    fireEvent.click(screen.getByTestId('mini-tool-run'));
    expect(onRun).toHaveBeenCalledWith('src', expect.objectContaining({ id: 'image.adjust' }), expect.anything(), undefined, {
      width: 300,
      height: 800,
    });
    shown.remove();
  });

  // A12: the range shows the whole clip until dragged, and that is what runs.
  it('runs a cut nobody dragged on the whole clip', () => {
    canvasSessions.of('').getState().openMiniTool('src', 'video.cut', { sourceContent: 'a.mp4', params: { range: null } });
    const onRun = vi.fn(() => Promise.resolve());
    const video: CanvasNodeView[] = [
      { id: 'src', type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: 'a.mp4', duration: 12 } },
    ];
    render(tree(video, onRun));
    fireEvent.click(screen.getByTestId('mini-tool-run'));
    expect(onRun).toHaveBeenCalledWith(
      'src',
      expect.objectContaining({ id: 'video.cut' }),
      expect.objectContaining({ params: { range: { start: 0, end: 12 } } }),
      undefined,
      undefined,
    );
  });

  it('closes on Escape', () => {
    render(tree(source('a.png'), () => Promise.resolve()));
    fireEvent.keyDown(screen.getByTestId('mini-tool-panel-title'), { key: 'Escape' });
    expect(canvasSessions.of('').getState().panelKind).toBeNull();
  });

  // inner#1302 B5: Execute stays off until the drawing leaves some ink.
  describe('a drawing tool', () => {
    const STROKE: DrawOp = { kind: 'stroke', erase: false, size: 5, color: '#FF3B30', points: [[0.1, 0.1]] };

    beforeEach(() => {
      vi.mocked(hasInk).mockImplementation((ops) => ops.length > 0);
      client.setQueryData(modelCatalogQuery().queryKey, CATALOG);
      canvasSessions.of('').getState().openMiniTool('src', 'image.erase', { sourceContent: 'a.png', params: {} });
    });

    it('keeps Execute off with nothing drawn', () => {
      render(tree(source('a.png'), () => Promise.resolve()));
      expect(screen.getByTestId('mini-tool-run')).toBeDisabled();
    });

    it('asks hasInk about the visible ops on the source shape and follows its answer', () => {
      canvasSessions.of('').getState().addDrawingStep(STROKE);
      vi.mocked(hasInk).mockReturnValue(false);
      const view = render(tree(source('a.png'), () => Promise.resolve()));
      expect(hasInk).toHaveBeenLastCalledWith([STROKE], 'mask', 1.6);
      expect(screen.getByTestId('mini-tool-run')).toBeDisabled();
      vi.mocked(hasInk).mockReturnValue(true);
      canvasSessions.of('').getState().addDrawingStep({ ...STROKE, points: [[0.2, 0.2]] });
      view.rerender(tree(source('a.png'), () => Promise.resolve()));
      expect(screen.getByTestId('mini-tool-run')).toBeEnabled();
    });

    // B11: a drawing made on the old picture does not stay on the new one.
    it('drops what was drawn when the source takes new content, and says so', () => {
      canvasSessions.of('').getState().addDrawingStep(STROKE);
      const view = render(tree(source('a.png'), () => Promise.resolve()));
      view.rerender(tree(source('b.png'), () => Promise.resolve()));
      expect(canvasSessions.of('').getState().miniTool?.drawing?.steps).toEqual([]);
      expect(toast.warning).toHaveBeenCalledOnce();
      expect(screen.getByTestId('mini-tool-run')).toBeDisabled();
    });

    it('hands the run the visible ops at the press', () => {
      const onRun = vi.fn(() => Promise.resolve());
      canvasSessions.of('').getState().addDrawingStep(STROKE);
      canvasSessions.of('').getState().addDrawingStep({ kind: 'clear' });
      canvasSessions.of('').getState().addDrawingStep({ ...STROKE, points: [[0.2, 0.2]] });
      render(tree(source('a.png'), onRun));
      fireEvent.click(screen.getByTestId('mini-tool-run'));
      expect(onRun).toHaveBeenCalledWith(
        'src',
        expect.objectContaining({ id: 'image.erase' }),
        expect.anything(),
        { kind: 'strokes', ops: [{ ...STROKE, points: [[0.2, 0.2]] }] },
        { width: 1600, height: 1000 },
      );
    });
  });

  describe('markup', () => {
    const RECT = { id: 'r', kind: 'rect', color: '#FF3B30', size: 5, x: 0.1, y: 0.1, w: 0.2, h: 0.2 } as const;
    const TEXT = { id: 't', kind: 'text', color: '#FF3B30', size: 5, x: 0.5, y: 0.5, text: 'look' } as const;

    beforeEach(() => {
      canvasSessions.of('').getState().openMiniTool('src', 'image.mark', { sourceContent: 'a.png', params: {} });
    });

    it('leaves the text being edited at the press and hands the run the objects as they then stand', () => {
      const onRun = vi.fn(() => Promise.resolve());
      const session = canvasSessions.of('').getState();
      session.commitMark([RECT]);
      session.setMarkEditingText('look');
      // The canvas writes the text back when it leaves the edit.
      session.registerMarkChannel({
        exitEditing: () => {
          canvasSessions.of('').getState().commitMark([RECT, TEXT]);
          canvasSessions.of('').getState().setMarkEditingText(null);
        },
        discardSelection: () => undefined,
      });
      render(tree(source('a.png'), onRun));
      fireEvent.click(screen.getByTestId('mini-tool-run'));
      expect(onRun).toHaveBeenCalledWith(
        'src',
        expect.objectContaining({ id: 'image.mark' }),
        expect.anything(),
        { kind: 'mark', objects: [RECT, TEXT] },
        { width: 1600, height: 1000 },
      );
    });

    // A4, §6.6: the only text emptied in its edit leaves nothing; the press
    // leaves the edit and finds nothing to run.
    it('runs nothing when leaving the edit leaves the markup empty', () => {
      const onRun = vi.fn(() => Promise.resolve());
      const session = canvasSessions.of('').getState();
      session.commitMark([TEXT]);
      session.selectMark('t');
      session.setMarkEditingText('look');
      session.registerMarkChannel({
        exitEditing: () => {
          canvasSessions.of('').getState().commitMark([]);
          canvasSessions.of('').getState().setMarkEditingText(null);
        },
        discardSelection: () => undefined,
      });
      render(tree(source('a.png'), onRun));
      act(() => canvasSessions.of('').getState().setMarkEditingText(''));
      expect(screen.getByTestId('mini-tool-run')).toBeDisabled();
      fireEvent.click(screen.getByTestId('mini-tool-run'));
      expect(onRun).not.toHaveBeenCalled();
    });
  });

  describe('expand', () => {
    // A 1600×1000 source: 1:1 wraps it at 1600×1600, 16:9 at 1778×1000.
    const GENFILL = { ...ERASER, name: 'bria-genfill', mode: ['expand'], max_output_side: 1700 } as unknown as ModelEntry;

    beforeEach(() => {
      client.setQueryData(modelCatalogQuery().queryKey, { ...CATALOG, image: [GENFILL] });
      canvasSessions.of('').getState().openMiniTool('src', 'image.expand', { sourceContent: 'a.png', params: {} });
    });

    // inner#1303 round 14: an earlier press still waiting holds Run only.
    it('leaves the ratios live while an earlier press still waits', () => {
      let release: (() => void) | undefined;
      void runOnce(miniToolIntent('', 'src', 'image.expand'), {
        scope: 'mini-tool',
        prepare: () =>
          new Promise<null>((resolve) => {
            release = () => resolve(null);
          }),
        send: vi.fn(),
      });
      render(tree(source('a.png'), () => Promise.resolve()));
      expect(screen.getByTestId('mini-tool-run')).toHaveAttribute('aria-busy', 'true');
      expect(screen.getByTestId('mini-tool-expand-ratio-1:1')).not.toHaveAttribute('aria-disabled', 'true');
      release?.();
    });

    it('holds the ratios to the model\'s longest side', () => {
      render(tree(source('a.png'), () => Promise.resolve()));
      expect(screen.getByTestId('mini-tool-expand-ratio-1:1')).not.toHaveAttribute('aria-disabled', 'true');
      expect(screen.getByTestId('mini-tool-expand-ratio-16:9')).toHaveAttribute('aria-disabled', 'true');
    });
  });
});

// inner#1305 §7.3: the enhance model's ceilings are said on the press, in the
// reader's terms, and nothing runs.
describe('an enhance source past the model\'s ceilings', () => {
  const ENHANCE = {
    name: 'veed-clean-audio',
    display_name: 'Clean Audio',
    modality: 'audio',
    mode: ['enhance'],
    description: '',
    guide: '',
    tier: 'internal',
    generation_time: 30,
    takes_prompt: false,
    params: {
      audio: { description: '', default: null, accepts: 'audio', fill: 'tool', max_total_duration: 1800, max_bytes: 536_870_912 },
      strength: { description: '', default: 0.85, min: 0, max: 1, step: 0.05, fill: 'tool' },
    },
    providers: [],
  } as unknown as ModelEntry;

  /**
   * The source audio node.
   * @param duration - Its length in seconds.
   * @param size - Its size in bytes.
   * @returns The node view.
   */
  function audio(duration: number, size: number): CanvasNodeView[] {
    return [
      { id: 'src', type: 'audio', position: { x: 0, y: 0 }, data: { handling: false, content: 'a.m4a', duration, size } },
    ] as unknown as CanvasNodeView[];
  }

  beforeEach(() => {
    client.setQueryData(modelCatalogQuery().queryKey, {
      ...CATALOG,
      audio: [ENHANCE],
    } as unknown as ModelCatalog);
    canvasSessions.of('').getState().closeActivePanel();
    canvasSessions.of('').getState().openMiniTool('src', 'audio.enhance', { sourceContent: 'a.m4a', params: {} });
  });

  it('says how long a source the tool takes', () => {
    const onRun = vi.fn(() => Promise.resolve());
    render(tree(audio(1801, 1_000), onRun));
    fireEvent.click(screen.getByTestId('mini-tool-run'));
    expect(onRun).not.toHaveBeenCalled();
    expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(expect.stringContaining('30'));
  });

  it('says how large a source the tool takes', () => {
    const onRun = vi.fn(() => Promise.resolve());
    render(tree(audio(60, 600_000_000), onRun));
    fireEvent.click(screen.getByTestId('mini-tool-run'));
    expect(onRun).not.toHaveBeenCalled();
    expect(vi.mocked(toast.warning)).toHaveBeenCalledWith(expect.stringContaining('512'));
  });
});
