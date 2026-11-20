// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 frames-split design §7.12 last paragraph: the transitions panel derives each input's state on its own and
 * shows the worst of the current video and every picked input, in the order unsupported, retryable, waiting-presentation,
 * usable. A picked input that is not usable keeps Run unavailable and shows its state the way the current
 * video's does, and a retryable input's Retry repairs that input.
 */

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock('@web/spaces/canvas/_shared/NodePanelMount', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  NodePanelMount: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@web/spaces/canvas/video-presentation/video-presentation-query', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  repairVideoPresentation: vi.fn().mockReturnValue(new Promise(() => undefined)),
}));
// The track editor and the GL preview are not under test; jsdom cannot draw either.
vi.mock('@xzdarcy/react-timeline-editor', async () => ({ Timeline: (await import('react')).forwardRef(() => null) }));
vi.mock('@web/spaces/canvas/mini-tool/video/VideoTimelinePreview', () => ({ VideoTimelinePreview: () => null }));

import { t, type VideoPresentationResponse } from '@breatic/shared';
import { VideoToolPanelContainer, type VideoToolPresentation } from '../video/VideoToolPanelContainer';
import { createVideoToolDraft } from '../video/video-tool-edit';
import { CanvasContext } from '../../canvas-context';
import { addNode, type CanvasNodeView } from '@web/data/yjs/canvas-space';
import { commitVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { canvasSessions } from '@web/stores/canvas-session';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { toast } from '@web/lib/toast';
import { repairVideoPresentation, videoPresentationQuery } from '@web/spaces/canvas/video-presentation/video-presentation-query';
import { presentedBinding, presentedPreparation, presentedResponse, seedUsablePresentation } from '@web/test-utils/video-presentation';

const projectId = 'input-state-project'; const spaceId = 'input-state-space'; const nodeId = '10000000-0000-4000-8000-000000000001';
const sourceURL = 'https://assets.example.test/canonical.webm';
const inputURL = 'https://assets.example.test/second.webm';
const mediaInfo = { width: 160, height: 240, duration: 4, mimeType: 'video/webm' };
// The selected version's grid at 25 fps.
const grid = { fps: { numerator: 25, denominator: 1 }, frameCount: 100 };
const ready: VideoToolPresentation = { grid, status: 'ready', sourceURL, sourceEpoch: 1, seekEpoch: 1, presentedTime: 0, panelState: 'usable' };

/**
 * Mounts the transitions panel with a picked input whose presentation read is the one given.
 * @param input - The picked input's presentation read, or 'usable' for a usable one.
 * @returns Nothing.
 */
function mount(input: VideoPresentationResponse | 'usable'): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (input === 'usable') seedUsablePresentation(client, projectId, inputURL);
  else client.setQueryData(videoPresentationQuery({ projectId, canonicalURL: inputURL, active: true }).queryKey, input);
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  addNode(projectId, spaceId, { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, name: 'Source', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
  const initial = createVideoToolDraft('video.transitions', { nodeId, canonicalURL: sourceURL, mediaInfo });
  const second = { inputId: '60000000-0000-4000-8000-000000000002', url: inputURL, mediaInfo: { ...mediaInfo, duration: 3 } };
  commitVideoToolDraft(doc, nodeId, 'video.transitions', { ...initial, inputs: [...initial.inputs, second], params: { clips: [...initial.params.clips, { clipId: '50000000-0000-4000-8000-000000000002', inputId: second.inputId, in: 0, out: 3, transition: { kind: 'cut', duration: 0 } }] } });
  canvasSessions.of(spaceId).getState().openMiniTool(nodeId, 'video.transitions', { sourceContent: sourceURL, params: {} });
  const node: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, ...mediaInfo } };
  render(<QueryClientProvider client={client}><TooltipProvider><CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlowProvider><VideoToolPanelContainer nodeId={nodeId} toolId='video.transitions' node={node} nodes={[node]} presentation={ready} onRunVideo={vi.fn().mockResolvedValue({ kind: 'done', result: {} })} /></ReactFlowProvider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
}

const binding = presentedBinding(inputURL);

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { destroyDoc(docName.canvasSpace(projectId, spaceId)); canvasSessions.of(spaceId).getState().closeActivePanel(); vi.restoreAllMocks(); });

describe('the transitions panel shows its worst input (frames-split §7.12)', () => {
  it('shows an unsupported input as unsupported and keeps Run unavailable', () => {
    mount(presentedResponse(binding, { preparation: presentedPreparation('too_long') }));
    expect(screen.getByText(t('canvas.miniTool.videoUI.ledgerUnsupported'))).toBeInTheDocument();
    expect(screen.getByTestId('mini-tool-run')).toBeDisabled();
  });

  it('shows a retryable input with a Retry that repairs that input', async () => {
    mount(presentedResponse(binding, { preparation: presentedPreparation('expired') }));
    // A temporarily failed candidate names its preparation failure (§7.12 step 2), not a media error of the shown resource.
    expect(screen.getByText(t('canvas.miniTool.videoUI.preparationFailed'))).toBeInTheDocument();
    expect(screen.getByTestId('mini-tool-run')).toBeDisabled();
    act(() => screen.getByRole('button', { name: t('canvas.miniTool.videoUI.retryPreview') }).click());
    await waitFor(() => expect(repairVideoPresentation).toHaveBeenCalledOnce());
    expect(vi.mocked(repairVideoPresentation).mock.calls[0]![0]).toMatchObject({ projectId, canonicalURL: inputURL });
    await waitFor(() => expect(screen.getByRole('button', { name: t('canvas.miniTool.videoUI.retryPreview') })).toHaveAttribute('aria-busy', 'true'));
  });

  // The repair request reports its own refusal (`repairVideoPresentation`); the Retry around it adds no second toast.
  it('shows exactly one toast when the input repair is refused', async () => {
    vi.mocked(repairVideoPresentation).mockImplementationOnce(async () => { toast.error('Refused'); throw new Error('Refused'); });
    mount(presentedResponse(binding, { preparation: presentedPreparation('expired') }));
    act(() => screen.getByRole('button', { name: t('canvas.miniTool.videoUI.retryPreview') }).click());
    await waitFor(() => expect(screen.getByRole('button', { name: t('canvas.miniTool.videoUI.retryPreview') })).not.toHaveAttribute('aria-busy', 'true'));
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Refused');
  });

  it('shows an input still being prepared as waiting', () => {
    mount(presentedResponse(binding, { preparation: presentedPreparation(null) }));
    expect(screen.getByText(t('canvas.miniTool.videoUI.preparingVideo'))).toBeInTheDocument();
    expect(screen.getByTestId('mini-tool-run')).toBeDisabled();
  });

  it('runs once every input is usable', () => {
    mount('usable');
    expect(screen.queryByText(t('canvas.miniTool.videoUI.loadingFrames'))).toBeNull();
    expect(screen.getByTestId('mini-tool-run')).not.toBeDisabled();
  });
});
