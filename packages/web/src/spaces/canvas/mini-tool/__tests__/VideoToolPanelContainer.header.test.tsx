// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Demo main.tsx tool panel header: the tool's icon before its title and, beside it, how many outputs the run plans; the
 * expand panel keeps the image Expand panel's header (demo outpaint-controls.tsx OutpaintPanel).
 */

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/lib/toast', () => ({ toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock('@web/spaces/canvas/_shared/NodePanelMount', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  NodePanelMount: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { t } from '@breatic/shared';
import type { VideoToolId } from '@breatic/shared/mini-tools';
import { VideoToolPanelContainer, type VideoToolPresentation } from '../video/VideoToolPanelContainer';
import { CanvasContext } from '../../canvas-context';
import { addNode, type CanvasNodeView } from '@web/data/yjs/canvas-space';
import { commitVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { canvasSessions } from '@web/stores/canvas-session';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { createVideoToolDraft } from '../video/video-tool-edit';

const projectId = 'header-project'; const spaceId = 'header-space'; const nodeId = '10000000-0000-4000-8000-000000000001';
const sourceURL = 'https://assets.example.test/canonical.mp4';
const mediaInfo = { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' };
// The selected version's grid at 25 fps.
const grid = { fps: { numerator: 25, denominator: 1 }, frameCount: 125 };
const name = docName.canvasSpace(projectId, spaceId);

/**
 * Mounts a tool panel on a video node.
 * @param toolId - The tool.
 * @param cuts - Split cuts to seed.
 * @param table - The selected version's grid, null while it is not usable.
 */
function open(toolId: VideoToolId, cuts?: number[], table: typeof grid | null = grid): void {
  addNode(projectId, spaceId, { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, name: 'Source', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
  if (cuts !== undefined) {
    const seeded = createVideoToolDraft('video.split', { nodeId, canonicalURL: sourceURL, mediaInfo });
    commitVideoToolDraft(getDoc(name), nodeId, 'video.split', { ...seeded, params: { cuts } }, false);
  }
  canvasSessions.of(spaceId).getState().openMiniTool(nodeId, toolId, { sourceContent: sourceURL, params: {} });
  const presentation = { grid: table, status: 'ready', sourceURL, sourceEpoch: 1, seekEpoch: 1, presentedTime: 0,
    presentationRef: { source: { toolInputId: 'd'.repeat(64), planSha256: 'f'.repeat(64) } } } as VideoToolPresentation;
  const node: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, ...mediaInfo } };
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider><CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlowProvider><VideoToolPanelContainer nodeId={nodeId} toolId={toolId} node={node} presentation={presentation} onRunVideo={vi.fn()} costs={{ execution: '1' }} /></ReactFlowProvider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
}

afterEach(() => { destroyDoc(name); canvasSessions.of(spaceId).getState().closeActivePanel(); });

describe('a video tool panel header', () => {
  it('shows the tool icon before its title and the one output a run makes', () => {
    open('video.extract-frames');
    const title = screen.getByTestId('mini-tool-panel-title');
    expect(title.firstElementChild?.tagName.toLowerCase()).toBe('svg');
    expect(screen.getByText(t('canvas.miniTool.videoUI.outputCount', { count: 1 }))).toBeInTheDocument();
  });

  it('counts one output per planned split segment', async () => {
    open('video.split', [1, 2]);
    await waitFor(() => expect(screen.getByText(t('canvas.miniTool.videoUI.outputCount', { count: 3 }))).toBeInTheDocument());
  });

  // Cuts are grid frame numbers; without the grid no cut can be judged past the end, so only 0 and repeats drop out.
  it('counts the normalized cuts while the grid is not usable', async () => {
    open('video.split', [2, 1, 1, 0], null);
    await waitFor(() => expect(screen.getByText(t('canvas.miniTool.videoUI.outputCount', { count: 3 }))).toBeInTheDocument());
  });

});
