// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VideoToolPanelContainer } from '../video/VideoToolPanelContainer';
import { createVideoToolDraft } from '../video/video-tool-edit';
import { CanvasContext } from '../../canvas-context';
import { addNode, type CanvasNodeView } from '@web/data/yjs/canvas-space';
import { commitVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { canvasSessions } from '@web/stores/canvas-session';
import { TooltipProvider } from '@web/components/ui/tooltip';

vi.mock('@web/spaces/canvas/_shared/NodePanelMount', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../_shared/NodePanelMount')>()),
  NodePanelMount: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@web/spaces/canvas/mini-tool/video/use-video-frame-thumbnails', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../video/use-video-frame-thumbnails')>()),
  useVideoFrameThumbnails: () => ({ status: 'loading', frames: [] }),
}));

const projectId = 'portal-project'; const spaceId = 'portal-space'; const nodeId = '10000000-0000-4000-8000-000000000001';
const sourceURL = 'https://assets.example.test/canonical.webm';
afterEach(() => { destroyDoc(docName.canvasSpace(projectId, spaceId)); canvasSessions.of(spaceId).getState().closeActivePanel(); vi.restoreAllMocks(); });

describe('Run with a usable grid and an unknown presented frame', () => {
  // §97: the interval mode is removed (frames-split §10.6), so only the three kept modes are gated (4.4.5).
  it.each(['current', 'first', 'last'] as const)('gates %s by its actual frame dependency without inventing a Current time', (mode) => {
    const doc = getDoc(docName.canvasSpace(projectId, spaceId));
    addNode(projectId, spaceId, { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, name: 'Source', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
    const source = { nodeId, canonicalURL: sourceURL, mediaInfo: { width: 160, height: 240, duration: 0.28, mimeType: 'video/webm' } };
    const initial = createVideoToolDraft('video.extract-frames', source);
    const draft = { ...initial, params: { mode, frameIndex: 3 } } as typeof initial;
    commitVideoToolDraft(doc, nodeId, 'video.extract-frames', draft);
    canvasSessions.of(spaceId).getState().openMiniTool(nodeId, 'video.extract-frames', { sourceContent: sourceURL, params: {} });
    const node: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, ...source.mediaInfo } };
    const grid = { fps: { numerator: 25, denominator: 1 }, frameCount: 7 };
    const onRun = vi.fn().mockResolvedValue(undefined);
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider><CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlowProvider><VideoToolPanelContainer nodeId={nodeId} toolId='video.extract-frames' node={node} onRunVideo={onRun} presentation={{ grid, status: 'ready', sourceURL, sourceEpoch: 1, seekEpoch: 3, presentedTime: null }} /></ReactFlowProvider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
    const run = screen.getByTestId('mini-tool-run');
    if (mode === 'current') {
      expect(run).toBeDisabled();
      fireEvent.click(run);
      expect(onRun).not.toHaveBeenCalled();
    } else {
      expect(run).not.toBeDisabled();
      fireEvent.click(run);
      expect(onRun).toHaveBeenCalledOnce();
      expect(onRun.mock.calls[0]![2].params).toEqual(draft.params);
    }
  });
});
