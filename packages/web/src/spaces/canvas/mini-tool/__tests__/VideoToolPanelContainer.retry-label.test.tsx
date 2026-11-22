// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 presentation states copy: the panel's Retry buttons retry a preparation or a read, not a preview, so the
 * retryable preparation box and the analysisFailed row both say Retry (`canvas.task.action.retry`, as FocusCropControls
 * does); Retry preview stays only on the node media area.
 *
 * Fixture: a 5 s 960x540 source on a 25 fps grid of 125 frames.
 */

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as AnalysesModule from '@web/data/api/mini-tool-analyses';

vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock('@web/spaces/canvas/_shared/NodePanelMount', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  NodePanelMount: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@web/data/api/mini-tool-analyses', async (importOriginal) => {
  const actual = await importOriginal<typeof AnalysesModule>();
  // Every analysis read fails, so the panel shows its analysisFailed row.
  return { ...actual, miniToolAnalysisQuery: (runId: string) => ({ ...actual.miniToolAnalysisQuery(runId), queryFn: () => Promise.reject(new Error('read failed')) }) };
});

import { newId, t } from '@breatic/shared';
import { VideoToolPanelContainer, type VideoToolPresentation } from '../video/VideoToolPanelContainer';
import { createVideoToolDraft } from '../video/video-tool-edit';
import { CanvasContext } from '../../canvas-context';
import { addNode, type CanvasNodeView } from '@web/data/yjs/canvas-space';
import { commitVideoToolAnalysisRef, commitVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { canvasSessions } from '@web/stores/canvas-session';
import { TooltipProvider } from '@web/components/ui/tooltip';

const projectId = 'retry-project'; const spaceId = 'retry-space'; const nodeId = '10000000-0000-4000-8000-000000000001';
const sourceURL = 'https://assets.example.test/canonical.mp4';
const mediaInfo = { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' };
const source = { nodeId, canonicalURL: sourceURL, mediaInfo };
const grid = { fps: { numerator: 25, denominator: 1 }, frameCount: 125 };

/**
 * Mounts a split panel over a stored draft.
 * @param presentation - The node's presentation facts.
 * @param withAnalysis - Whether the draft has an accepted scene detection (whose read fails).
 */
function mount(presentation: VideoToolPresentation, withAnalysis: boolean): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  addNode(projectId, spaceId, { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, name: 'Source', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
  const draft = createVideoToolDraft('video.split', source);
  commitVideoToolDraft(doc, nodeId, 'video.split', draft);
  if (withAnalysis) commitVideoToolAnalysisRef(doc, nodeId, { version: 1, toolId: 'video.split', kind: 'scene_cuts', draftId: draft.draftId, analysisRunId: newId(), inputFingerprint: 'f'.repeat(64) });
  canvasSessions.of(spaceId).getState().openMiniTool(nodeId, 'video.split', { sourceContent: sourceURL, params: {} });
  const node: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, ...mediaInfo } };
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider><CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlowProvider><VideoToolPanelContainer nodeId={nodeId} toolId='video.split' node={node} presentation={presentation} onRunVideo={vi.fn()} costs={{ execution: '1' }} maxOutputs={50} /></ReactFlowProvider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
}

afterEach(() => { destroyDoc(docName.canvasSpace(projectId, spaceId)); canvasSessions.of(spaceId).getState().closeActivePanel(); vi.restoreAllMocks(); });

describe('the panel Retry buttons say Retry, not Retry preview', () => {
  it('labels the retryable preparation box Retry', () => {
    mount({ grid, status: 'ready', sourceURL, sourceEpoch: 1, seekEpoch: 1, presentedTime: 0, panelState: 'retryable', onRetry: vi.fn() }, false);
    expect(screen.getByText(t('canvas.miniTool.videoUI.preparationFailed'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('canvas.task.action.retry') })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('canvas.miniTool.videoUI.retryPreview') })).toBeNull();
  });

  it('labels the analysisFailed row Retry', async () => {
    mount({ grid, status: 'ready', sourceURL, sourceEpoch: 1, seekEpoch: 1, presentedTime: 0 }, true);
    expect(await screen.findByText(t('canvas.miniTool.videoUI.analysisFailed'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('canvas.task.action.retry') })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('canvas.miniTool.videoUI.retryPreview') })).toBeNull();
  });
});
