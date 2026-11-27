// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * inner#1306 frames-split design §10.7 output cap (packages/web/AGENTS.md#disabled-controls): a split whose planned segments
 * outnumber the tool's `max_outputs` (config `executions."video.split".max_outputs`, served by `GET /canvas/limits`) has an
 * `aria-disabled` Run, and a press says the limit in a toast instead of creating nodes the server would refuse.
 *
 * Fixture: a 5 s 960x540 source at 25 fps.
 */

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock('@web/spaces/canvas/_shared/NodePanelMount', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  NodePanelMount: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { t } from '@breatic/shared';
import { VideoToolPanelContainer, type VideoToolPresentation } from '../video/VideoToolPanelContainer';
import { createVideoToolDraft } from '../video/video-tool-edit';
import { CanvasContext } from '../../canvas-context';
import { addNode, type CanvasNodeView } from '@web/data/yjs/canvas-space';
import { commitVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { canvasSessions } from '@web/stores/canvas-session';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { toast } from '@web/lib/toast';

const projectId = 'split-project'; const spaceId = 'split-space'; const nodeId = '10000000-0000-4000-8000-000000000001';
const sourceURL = 'https://assets.example.test/canonical.mp4';
const mediaInfo = { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' };
const source = { nodeId, canonicalURL: sourceURL, mediaInfo };
// The selected version's grid at 25 fps.
const grid = { fps: { numerator: 25, denominator: 1 }, frameCount: 125 };

/**
 * Mounts a split panel over a committed draft.
 * @param cuts - The split cuts.
 * @param maxOutputs - The configured output cap.
 * @param onRunVideo - The execution entry.
 * @returns Nothing.
 */
function mount(cuts: number[], maxOutputs: number, onRunVideo: () => Promise<unknown> = vi.fn()): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  addNode(projectId, spaceId, { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, name: 'Source', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
  const initial = createVideoToolDraft('video.split', source);
  commitVideoToolDraft(doc, nodeId, 'video.split', { ...initial, params: { ...initial.params, cuts } });
  canvasSessions.of(spaceId).getState().openMiniTool(nodeId, 'video.split', { sourceContent: sourceURL, params: {} });
  const presentation = { grid, status: 'ready', sourceURL, sourceEpoch: 1, seekEpoch: 1, presentedTime: 0 } as VideoToolPresentation;
  const node: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, ...mediaInfo } };
  const proposed: object = { maxOutputs };
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider><CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlowProvider><VideoToolPanelContainer nodeId={nodeId} toolId='video.split' node={node} presentation={presentation} onRunVideo={onRunVideo} costs={{ execution: '1' }} {...proposed} /></ReactFlowProvider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { destroyDoc(docName.canvasSpace(projectId, spaceId)); canvasSessions.of(spaceId).getState().closeActivePanel(); vi.restoreAllMocks(); });

describe('the split output cap on Run (frames-split §10.7 output cap)', () => {
  it('runs when the planned segments fit max_outputs', () => {
    const onRunVideo = vi.fn().mockResolvedValue({ kind: 'done', result: {} });
    mount([1, 2], 3, onRunVideo);
    const run = screen.getByTestId('mini-tool-run');
    expect(run).not.toHaveAttribute('aria-disabled', 'true');
    act(() => run.click());
    expect(onRunVideo).toHaveBeenCalledOnce();
  });

  it('refuses more planned segments than max_outputs and names the limit', () => {
    const onRunVideo = vi.fn();
    mount([1, 2, 3], 3, onRunVideo);
    const run = screen.getByTestId('mini-tool-run');
    expect(run).toHaveAttribute('aria-disabled', 'true');
    expect(run).not.toBeDisabled();
    act(() => run.click());
    expect(toast.warning).toHaveBeenCalledExactlyOnceWith(t('canvas.miniTool.videoUI.tooManyOutputs', { max: 3 }));
    expect(onRunVideo).not.toHaveBeenCalled();
  });

  // frames-split §10.7 "displays the cap"; demo main.tsx output-cap line.
  it('says the cap and the planned count in the panel only while the plan exceeds it', () => {
    mount([1, 2, 3], 3);
    expect(screen.getByTestId('video-output-cap')).toHaveTextContent(t('canvas.miniTool.videoUI.outputCapExceeded', { cap: 3, count: 4 }));
    expect(screen.getByTestId('video-output-cap')).toHaveTextContent('Up to 3 outputs; this plan makes 4');
  });

  it('shows no cap line when the plan fits', () => {
    mount([1, 2], 3);
    expect(screen.queryByTestId('video-output-cap')).toBeNull();
  });
});
