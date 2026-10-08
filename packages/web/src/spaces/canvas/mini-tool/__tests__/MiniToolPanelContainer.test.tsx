// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The open mini-tool panel against the canvas session (inner#888 §7.2): what a
 * run is handed, what a changed source resets, and how the panel closes.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { ReactFlow } from '@xyflow/react';
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import { TooltipProvider } from '@web/components/ui/tooltip';
import type { CanvasNodeView } from '@web/data/yjs/canvas-space';
import { toast } from '@web/lib/toast';
import { MiniToolPanelContainer } from '@web/spaces/canvas/mini-tool/MiniToolPanelContainer';
import { canvasSessions } from '@web/stores/canvas-session';

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
      data: { kind: 'image', handling: false, content, width: 1600, height: 1000 },
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
    );
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

  // A12: the range shows the whole clip until dragged, and that is what runs.
  it('runs a cut nobody dragged on the whole clip', () => {
    canvasSessions.of('').getState().openMiniTool('src', 'video.cut', { sourceContent: 'a.mp4', params: { range: null } });
    const onRun = vi.fn(() => Promise.resolve());
    const video: CanvasNodeView[] = [
      { id: 'src', type: 'video', position: { x: 0, y: 0 }, data: { kind: 'video', handling: false, content: 'a.mp4', duration: 12 } },
    ];
    render(tree(video, onRun));
    fireEvent.click(screen.getByTestId('mini-tool-run'));
    expect(onRun).toHaveBeenCalledWith(
      'src',
      expect.objectContaining({ id: 'video.cut' }),
      expect.objectContaining({ params: { range: { start: 0, end: 12 } } }),
    );
  });

  it('closes on Escape', () => {
    render(tree(source('a.png'), () => Promise.resolve()));
    fireEvent.keyDown(screen.getByTestId('mini-tool-panel-title'), { key: 'Escape' });
    expect(canvasSessions.of('').getState().panelKind).toBeNull();
  });
});
