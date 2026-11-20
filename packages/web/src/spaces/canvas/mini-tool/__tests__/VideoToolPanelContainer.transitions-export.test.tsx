// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §97 (canvas design §10 editor row, `export` column; §4 transitions row; demo 2026-10-23-1306-video-tools
 * `timeline-editor.tsx` footer): the Dialog's Export and the panel's Run read one derived availability. While Run is
 * unavailable Export is `aria-disabled` and a click explains with a toast and leaves the Dialog open; an accepted export
 * returns to the panel (the Dialog closes); a refused export keeps the Dialog open and shows the server's reason as a toast.
 */

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock('@web/spaces/canvas/_shared/NodePanelMount', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  NodePanelMount: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
// The track editor and the GL preview are not under test; jsdom cannot draw either.
vi.mock('@xzdarcy/react-timeline-editor', async () => ({ Timeline: (await import('react')).forwardRef(() => null) }));
vi.mock('@web/spaces/canvas/mini-tool/video/VideoTimelinePreview', () => ({ VideoTimelinePreview: () => null }));

import { VideoToolPanelContainer, type VideoToolPresentation } from '../video/VideoToolPanelContainer';
import { createVideoToolDraft } from '../video/video-tool-edit';
import { CanvasContext } from '../../canvas-context';
import { addNode, type CanvasNodeView } from '@web/data/yjs/canvas-space';
import { commitVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { ApiException } from '@web/data/api/types';
import { canvasSessions } from '@web/stores/canvas-session';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { toast } from '@web/lib/toast';
import { presentedDisplay, seedUsablePresentation } from '@web/test-utils/video-presentation';

const projectId = 'export-project'; const spaceId = 'export-space'; const nodeId = '10000000-0000-4000-8000-000000000001';
const sourceURL = 'https://assets.example.test/canonical.webm';
const mediaInfo = { width: 160, height: 240, duration: 4, mimeType: 'video/webm' };
// The selected version's grid at 25 fps.
const grid = { fps: { numerator: 25, denominator: 1 }, frameCount: 100 };
const ready: VideoToolPresentation = { grid, status: 'ready', sourceURL, sourceEpoch: 1, seekEpoch: 1, presentedTime: 0 };

/**
 * A cache in which the picked input's presentation is usable, which Run needs as much as the current video's (frames-split
 * §7.12 last paragraph).
 * @returns The cache.
 */
function usableInputClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  seedUsablePresentation(client, projectId, 'https://assets.example.test/second.webm');
  return client;
}

/**
 * Mounts the transitions panel on a committed draft and opens the timeline Dialog.
 * @param presentation - The node's presentation facts; undefined leaves Run unavailable.
 * @param onRunVideo - The execution entry the panel and Export share.
 * @param client - The query cache holding the inputs' presentations.
 * @param firstOut - The current video clip's out point, when the test trims it.
 * @returns The open Dialog.
 */
function openDialog(presentation: VideoToolPresentation | undefined, onRunVideo: () => Promise<unknown>, client = usableInputClient(), firstOut?: number): HTMLElement {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  addNode(projectId, spaceId, { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, name: 'Source', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
  // The two-clip timeline the design fixes: the current video first, the picked input video second.
  const initial = createVideoToolDraft('video.transitions', { nodeId, canonicalURL: sourceURL, mediaInfo });
  const second = { inputId: '60000000-0000-4000-8000-000000000002', url: 'https://assets.example.test/second.webm', mediaInfo: { ...mediaInfo, duration: 3 } };
  commitVideoToolDraft(doc, nodeId, 'video.transitions', { ...initial, inputs: [...initial.inputs, second], params: { clips: [...initial.params.clips.map((clip) => (firstOut === undefined ? clip : { ...clip, out: firstOut })), { clipId: '50000000-0000-4000-8000-000000000002', inputId: second.inputId, in: 0, out: 3, transition: { kind: 'cut', duration: 0 } }] } });
  canvasSessions.of(spaceId).getState().openMiniTool(nodeId, 'video.transitions', { sourceContent: sourceURL, params: {} });
  const node: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, ...mediaInfo } };
  render(<QueryClientProvider client={client}><TooltipProvider><CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlowProvider><VideoToolPanelContainer nodeId={nodeId} toolId='video.transitions' node={node} nodes={[node]} presentation={presentation} onRunVideo={onRunVideo} /></ReactFlowProvider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
  act(() => screen.getByRole('button', { name: 'Edit timeline' }).click());
  return screen.getByTestId('video-timeline-dialog');
}

/**
 * Every message the panel showed as an error or warning toast.
 * @returns The messages.
 */
function toastMessages(): unknown[] {
  return [...vi.mocked(toast.error).mock.calls, ...vi.mocked(toast.warning).mock.calls].map((call) => call[0]);
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { destroyDoc(docName.canvasSpace(projectId, spaceId)); canvasSessions.of(spaceId).getState().closeActivePanel(); vi.restoreAllMocks(); });

describe('Export shares the panel Run availability (§97; canvas design §10 editor × export)', () => {
  it('is aria-disabled while Run is unavailable, explains with a toast and keeps the Dialog open', () => {
    const onRunVideo = vi.fn().mockResolvedValue({ kind: 'done', result: {} });
    const dialog = openDialog(undefined, onRunVideo);
    expect(screen.getByTestId('mini-tool-run')).toBeDisabled();
    const exportButton = within(dialog).getByRole('button', { name: 'Export' });
    expect(exportButton).toHaveAttribute('aria-disabled', 'true');
    expect(exportButton).not.toBeDisabled();
    act(() => exportButton.click());
    expect(toast.warning).toHaveBeenCalledOnce();
    expect(onRunVideo).not.toHaveBeenCalled();
    expect(screen.getByTestId('video-timeline-dialog')).toBeInTheDocument();
  });

  it('closes the Dialog once the export is accepted', async () => {
    const onRunVideo = vi.fn().mockResolvedValue({ kind: 'done', result: {} });
    const dialog = openDialog(ready, onRunVideo);
    act(() => within(dialog).getByRole('button', { name: 'Export' }).click());
    expect(onRunVideo).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByTestId('video-timeline-dialog')).toBeNull());
  });

  it('keeps the Dialog open and shows the server reason as a toast when the export is refused', async () => {
    const refusal = new ApiException({ status: 409, message: 'The clips changed. Check the timeline and export again.', fromServer: true });
    const onRunVideo = vi.fn().mockResolvedValue({ kind: 'failed', error: refusal });
    const dialog = openDialog(ready, onRunVideo);
    act(() => within(dialog).getByRole('button', { name: 'Export' }).click());
    expect(onRunVideo).toHaveBeenCalledOnce();
    await waitFor(() => expect(toastMessages()).toContain(refusal.message));
    expect(screen.getByTestId('video-timeline-dialog')).toBeInTheDocument();
  });
  it('refuses an export with a clip shorter than one output frame before anything is sent, and says so', () => {
    const onRunVideo = vi.fn().mockResolvedValue({ kind: 'done', result: {} });
    // 0.01 s is a quarter of a 25 fps frame, which the output grid rounds to no frame.
    const dialog = openDialog(ready, onRunVideo, usableInputClient(), 0.01);
    act(() => within(dialog).getByRole('button', { name: 'Export' }).click());
    expect(toastMessages()).toContain('A clip is shorter than one frame');
    expect(onRunVideo).not.toHaveBeenCalled();
    expect(screen.getByTestId('video-timeline-dialog')).toBeInTheDocument();
  });

  it('exports with each clip input\'s own selected version, read from that input\'s presentation', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const SECOND_URL = 'https://assets.example.test/second.webm';
    const refs: Record<string, { toolInputId: string; planSha256: string }> = { [sourceURL]: { toolInputId: '1'.repeat(64), planSha256: '2'.repeat(64) }, [SECOND_URL]: { toolInputId: '3'.repeat(64), planSha256: '4'.repeat(64) } };
    for (const [url, ref] of Object.entries(refs)) seedUsablePresentation(client, projectId, url, ref);
    const onRunVideo = vi.fn().mockResolvedValue({ kind: 'done', result: {} });
    const dialog = openDialog({ ...ready, presentationRef: { source: refs[sourceURL]! } }, onRunVideo, client);
    act(() => within(dialog).getByRole('button', { name: 'Export' }).click());
    await waitFor(() => expect(onRunVideo).toHaveBeenCalledOnce());
    const draft = onRunVideo.mock.calls[0]![2] as { inputs: { inputId: string; url: string }[] };
    const plan = onRunVideo.mock.calls[0]![4] as { presentationRef: Record<string, unknown> } | undefined;
    expect(plan?.presentationRef).toEqual(Object.fromEntries(draft.inputs.map((input) => [input.inputId, refs[input.url]])));
  });
});

describe('the Dialog composition row reads the first clip\'s selected display size (canvas design §4 transitions row; demo timeline-editor.tsx)', () => {
  it('states the size the current video\'s presentation displays, not its registered size', () => {
    const client = usableInputClient();
    seedUsablePresentation(client, projectId, sourceURL, { display: presentedDisplay(320, 480, 100) });
    const dialog = openDialog(ready, vi.fn(), client);
    expect(within(dialog).getByText(/^320 × 480 · 25 fps · /)).toBeInTheDocument();
  });
});
