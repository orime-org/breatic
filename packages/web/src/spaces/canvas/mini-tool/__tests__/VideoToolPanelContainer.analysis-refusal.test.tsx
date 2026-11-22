// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1968 design 3.3a, 3.10: a scene detection refused at a monthly spend limit says that limit, with its reset day,
 * in the toast; any other refusal keeps the analysisFailed toast.
 *
 * Fixture: a 5 s 960x540 source on a 25 fps grid of 125 frames, its selected version ready.
 */

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { fireEvent, render, screen } from '@testing-library/react';
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
  return { ...actual, miniToolAnalysesApi: { ...actual.miniToolAnalysesApi, start: vi.fn() } };
});

import { t } from '@breatic/shared';
import { VideoToolPanelContainer, type VideoToolPresentation } from '../video/VideoToolPanelContainer';
import { createVideoToolDraft } from '../video/video-tool-edit';
import { CanvasContext } from '../../canvas-context';
import { addNode, type CanvasNodeView } from '@web/data/yjs/canvas-space';
import { commitVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { canvasSessions } from '@web/stores/canvas-session';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { miniToolAnalysesApi } from '@web/data/api/mini-tool-analyses';
import { ApiException } from '@web/data/api/types';
import { toast } from '@web/lib/toast';
import { spendCapMessage } from '@web/lib/spend-cap-message';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';

const projectId = 'refusal-project'; const spaceId = 'refusal-space'; const nodeId = '10000000-0000-4000-8000-000000000001';
const sourceURL = 'https://assets.example.test/canonical.mp4';
const mediaInfo = { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' };
const source = { nodeId, canonicalURL: sourceURL, mediaInfo };
const grid = { fps: { numerator: 25, denominator: 1 }, frameCount: 125 };
const presentationRef = { source: { toolInputId: 'a'.repeat(64), planSha256: 'b'.repeat(64) } };
const RESETS_AT = '2026-12-01T00:00:00.000Z';

/** Mounts a split panel over a stored draft on a ready selected version. */
function mount(): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  addNode(projectId, spaceId, { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, name: 'Source', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
  commitVideoToolDraft(doc, nodeId, 'video.split', createVideoToolDraft('video.split', source, presentationRef));
  canvasSessions.of(spaceId).getState().openMiniTool(nodeId, 'video.split', { sourceContent: sourceURL, params: {} });
  const node: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, ...mediaInfo } };
  const presentation: VideoToolPresentation = { grid, status: 'ready', sourceURL, sourceEpoch: 1, seekEpoch: 1, presentedTime: 0, presentationRef };
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider><CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlowProvider><VideoToolPanelContainer nodeId={nodeId} toolId='video.split' node={node} presentation={presentation} onRunVideo={vi.fn()} costs={{ execution: '1' }} maxOutputs={50} /></ReactFlowProvider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
}

afterEach(() => { destroyDoc(docName.canvasSpace(projectId, spaceId)); canvasSessions.of(spaceId).getState().closeActivePanel(); resetRunOnceForTests(); vi.clearAllMocks(); });

describe('a refused scene detection says why', () => {
  it('M1-07 says the spend limit and its reset day when the detection is refused at it', async () => {
    vi.mocked(miniToolAnalysesApi.start).mockRejectedValue(new ApiException({ status: 402, message: 'This Studio reached its monthly limit.', reason: 'spend_cap_reached', fromServer: true,
      details: { scope: 'studio', limit: '10', resetsAt: RESETS_AT } }));
    mount();
    fireEvent.click(screen.getByTestId('video-detect-scenes'));
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledExactlyOnceWith(spendCapMessage('studio', '10', RESETS_AT)));
  });

  it('keeps the analysisFailed toast for a refusal with no sentence of ours', async () => {
    vi.mocked(miniToolAnalysesApi.start).mockRejectedValue(new Error('down'));
    mount();
    fireEvent.click(screen.getByTestId('video-detect-scenes'));
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledExactlyOnceWith(t('canvas.miniTool.videoUI.analysisFailed')));
  });
});
