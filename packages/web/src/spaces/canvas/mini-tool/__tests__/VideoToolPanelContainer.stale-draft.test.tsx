// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 frames-split §7.13 Dv stale and Rebind (presentation states demo scene 5, decisions D8 and D9): a saved draft
 * set on another version of the source, or saved before drafts held a presentationRef, keeps its values but neither plans
 * nor runs; the panel says the video was updated and offers Apply to this video, which binds the draft to the selected
 * version unless a value lies outside it, and then says so and stays stale.
 *
 * Fixture: a 5 s 960x540 source; the selected version's grid is 25 fps, 125 frames.
 */

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/lib/toast', () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock('@web/spaces/canvas/_shared/NodePanelMount', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  NodePanelMount: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { t } from '@breatic/shared';
import type { MiniToolPresentationRef, VideoToolDraftById, VideoToolId } from '@breatic/shared/mini-tools';
import { VideoToolPanelContainer, type VideoToolPresentation } from '../video/VideoToolPanelContainer';
import { createVideoToolDraft } from '../video/video-tool-edit';
import { CanvasContext } from '../../canvas-context';
import { addNode, type CanvasNodeView } from '@web/data/yjs/canvas-space';
import { commitVideoToolDraft, readVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { canvasSessions } from '@web/stores/canvas-session';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { toast } from '@web/lib/toast';

const projectId = 'stale-project'; const spaceId = 'stale-space'; const nodeId = '10000000-0000-4000-8000-000000000001';
const sourceURL = 'https://assets.example.test/canonical.mp4';
const mediaInfo = { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' };
const source = { nodeId, canonicalURL: sourceURL, mediaInfo };
const grid = { fps: { numerator: 25, denominator: 1 }, frameCount: 125 };
// The version the draft was set on, and the one selected now: a new plan of the same source.
const earlier: MiniToolPresentationRef = { source: { toolInputId: 'a'.repeat(64), planSha256: 'b'.repeat(64) } };
const selected: MiniToolPresentationRef = { source: { toolInputId: 'c'.repeat(64), planSha256: 'd'.repeat(64) } };

/**
 * Mounts a tool panel over a saved draft.
 * @param toolId - The tool.
 * @param params - The saved parameters.
 * @param presentationRef - The ref the draft was saved with; none for a draft saved before refs were stored.
 * @param onRunVideo - The execution entry.
 * @returns The saved draft.
 */
function mount<K extends VideoToolId>(toolId: K, params: VideoToolDraftById[K]['params'], presentationRef: MiniToolPresentationRef | undefined, onRunVideo: () => Promise<unknown> = vi.fn()): VideoToolDraftById[K] {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  addNode(projectId, spaceId, { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, name: 'Source', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
  const draft = { ...createVideoToolDraft(toolId, source, presentationRef), params };
  commitVideoToolDraft(doc, nodeId, toolId, draft);
  canvasSessions.of(spaceId).getState().openMiniTool(nodeId, toolId, { sourceContent: sourceURL, params: {} });
  const presentation = { grid, status: 'ready', sourceURL, sourceEpoch: 1, seekEpoch: 1, presentedTime: 0, presentationRef: selected } as VideoToolPresentation;
  const node: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, ...mediaInfo } };
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider><CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlowProvider><VideoToolPanelContainer nodeId={nodeId} toolId={toolId} node={node} presentation={presentation} onRunVideo={onRunVideo} costs={{ execution: '1' }} maxOutputs={50} /></ReactFlowProvider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
  return draft;
}

/**
 * The stored draft as the selected version reads it.
 * @param toolId - The tool.
 * @returns The reading.
 */
function stored(toolId: VideoToolId): ReturnType<typeof readVideoToolDraft> {
  return readVideoToolDraft(getDoc(docName.canvasSpace(projectId, spaceId)), nodeId, toolId, selected);
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { destroyDoc(docName.canvasSpace(projectId, spaceId)); canvasSessions.of(spaceId).getState().closeActivePanel(); vi.restoreAllMocks(); });

describe('a stale video tool draft (frames-split §7.13 Dv stale)', () => {
  it('says the video was updated, keeps the saved cuts and neither detects nor runs', () => {
    const onRunVideo = vi.fn();
    const draft = mount('video.split', { cuts: [25, 75] }, earlier, onRunVideo);
    expect(screen.getByTestId('video-tool-stale')).toHaveTextContent(t('canvas.miniTool.videoUI.videoUpdated'));
    expect(screen.getByRole('button', { name: t('canvas.miniTool.videoUI.applyToVideo') })).toBeEnabled();
    expect(screen.getByTestId('video-detect-scenes')).toBeDisabled();
    const run = screen.getByTestId('mini-tool-run');
    expect(run).toBeDisabled();
    act(() => run.click());
    expect(onRunVideo).not.toHaveBeenCalled();
    expect(stored('video.split')).toEqual({ state: 'stale', draft });
  });

  it('reads a draft saved before drafts held a presentationRef as stale', () => {
    mount('video.split', { cuts: [25] }, undefined);
    expect(screen.getByTestId('video-tool-stale')).toBeInTheDocument();
    expect(screen.getByTestId('mini-tool-run')).toBeDisabled();
  });

  it('shows no notice for a draft set on the selected version', () => {
    mount('video.split', { cuts: [25] }, selected);
    expect(screen.queryByTestId('video-tool-stale')).toBeNull();
    expect(screen.getByTestId('mini-tool-run')).toBeEnabled();
  });

  it('rebinds the draft to the selected version as a new draft with the same values', () => {
    const draft = mount('video.split', { cuts: [25, 75] }, earlier);
    fireEvent.click(screen.getByRole('button', { name: t('canvas.miniTool.videoUI.applyToVideo') }));
    const reading = stored('video.split');
    expect(reading).toMatchObject({ state: 'supported', draft: { params: { cuts: [25, 75] }, presentationRef: selected } });
    if (reading.state !== 'supported') throw new Error('Expected a current draft');
    expect(reading.draft.draftId).not.toBe(draft.draftId);
    expect(screen.queryByTestId('video-tool-stale')).toBeNull();
    expect(screen.getByTestId('mini-tool-run')).toBeEnabled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  // Demo decision D9: a value outside the updated video is neither cut nor dropped; the user adjusts it first.
  it('keeps a draft with a cut outside the selected grid stale, marks the cut once Apply finds it and says to adjust it, without throwing', () => {
    const draft = mount('video.split', { cuts: [25, 130] }, earlier);
    const outside = screen.getByTestId('video-cut-outside-0');
    const marker = screen.getByTestId('video-cut-outside-marker-0');
    // Shown unmarked until the press finds it, its strip marker at the end in the selected colour (demo rebind).
    expect(outside).toHaveAttribute('aria-invalid', 'false');
    expect(outside).toHaveValue('5.2');
    expect(marker).toHaveClass('border-status-selected');
    expect(marker).not.toHaveClass('border-status-error');
    fireEvent.click(screen.getByRole('button', { name: t('canvas.miniTool.videoUI.applyToVideo') }));
    expect(toast.warning).toHaveBeenCalledExactlyOnceWith(t('canvas.miniTool.videoUI.settingsOutOfRange'));
    expect(stored('video.split')).toEqual({ state: 'stale', draft });
    expect(screen.getByTestId('video-cut-outside-0')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('video-cut-outside-marker-0')).toHaveClass('border-status-error');
    fireEvent.click(screen.getByTestId('video-cut-outside-remove-0'));
    expect(stored('video.split')).toMatchObject({ state: 'stale', draft: { params: { cuts: [25] } } });
    fireEvent.click(screen.getByRole('button', { name: t('canvas.miniTool.videoUI.applyToVideo') }));
    expect(stored('video.split')).toMatchObject({ state: 'supported', draft: { params: { cuts: [25] }, presentationRef: selected } });
  });

  it('keeps a cut outside the grid when another cut is edited', () => {
    mount('video.split', { cuts: [25, 130] }, earlier);
    // The first remove button is the row of the cut inside the grid.
    fireEvent.click(screen.getAllByRole('button', { name: t('canvas.miniTool.videoUI.removeCut') })[0]!);
    expect(stored('video.split')).toMatchObject({ state: 'stale', draft: { params: { cuts: [130] } } });
  });

  it('clears the mark Apply put on a cut outside the grid once the cuts are edited, keeping that cut', () => {
    mount('video.split', { cuts: [25, 130] }, earlier);
    fireEvent.click(screen.getByRole('button', { name: t('canvas.miniTool.videoUI.applyToVideo') }));
    expect(screen.getByTestId('video-cut-outside-0')).toHaveAttribute('aria-invalid', 'true');
    fireEvent.click(screen.getAllByRole('button', { name: t('canvas.miniTool.videoUI.removeCut') })[0]!);
    expect(stored('video.split')).toMatchObject({ state: 'stale', draft: { params: { cuts: [130] } } });
    expect(screen.getByTestId('video-cut-outside-0')).toHaveAttribute('aria-invalid', 'false');
    expect(screen.getByTestId('video-cut-outside-marker-0')).toHaveClass('border-status-selected');
    expect(screen.getByTestId('mini-tool-run')).toBeDisabled();
  });

  it('still marks a time typed into a cut row outside the grid that is not a number', () => {
    mount('video.split', { cuts: [130] }, earlier);
    const outside = screen.getByTestId('video-cut-outside-0');
    fireEvent.change(outside, { target: { value: 'x' } });
    expect(outside).toHaveAttribute('aria-invalid', 'true');
  });

  it('moves a cut outside the grid inside it once a valid time is typed and the field is left', () => {
    mount('video.split', { cuts: [130] }, earlier);
    const outside = screen.getByTestId('video-cut-outside-0');
    fireEvent.change(outside, { target: { value: '4' } });
    expect(stored('video.split')).toMatchObject({ draft: { params: { cuts: [130] } } });
    fireEvent.blur(outside);
    expect(stored('video.split')).toMatchObject({ state: 'stale', draft: { params: { cuts: [100] } } });
  });

  it('renders a current draft whose cut lies beyond the grid without planning it', () => {
    mount('video.split', { cuts: [25, 400] }, selected);
    expect(screen.getByTestId('video-cut-outside-0')).toBeInTheDocument();
    expect(screen.getByTestId('mini-tool-run')).toBeDisabled();
  });

  it('rebinds an extract-frames draft set on another version', () => {
    mount('video.extract-frames', { mode: 'first', frameIndex: 0 }, earlier);
    expect(screen.getByTestId('video-tool-stale')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: t('canvas.miniTool.videoUI.applyToVideo') }));
    expect(stored('video.extract-frames')).toMatchObject({ state: 'supported', draft: { params: { mode: 'first' }, presentationRef: selected } });
  });
});

describe('a new video tool draft (frames-split §7.13 Dv absent × Open)', () => {
  it('binds the draft the panel opens with to the selected version', () => {
    const doc = getDoc(docName.canvasSpace(projectId, spaceId));
    addNode(projectId, spaceId, { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, name: 'Source', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
    canvasSessions.of(spaceId).getState().openMiniTool(nodeId, 'video.split', { sourceContent: sourceURL, params: {} });
    const presentation = { grid, status: 'ready', sourceURL, sourceEpoch: 1, seekEpoch: 1, presentedTime: 0, presentationRef: selected } as VideoToolPresentation;
    const node: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, ...mediaInfo } };
    render(<QueryClientProvider client={new QueryClient()}><TooltipProvider><CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlowProvider><VideoToolPanelContainer nodeId={nodeId} toolId='video.split' node={node} presentation={presentation} onRunVideo={vi.fn()} maxOutputs={50} /></ReactFlowProvider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
    expect(readVideoToolDraft(doc, nodeId, 'video.split', selected)).toMatchObject({ state: 'supported', draft: { presentationRef: selected } });
  });

  it('stores no draft and takes no edit while no version is selected', () => {
    const doc = getDoc(docName.canvasSpace(projectId, spaceId));
    addNode(projectId, spaceId, { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, name: 'Source', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
    canvasSessions.of(spaceId).getState().openMiniTool(nodeId, 'video.extract-frames', { sourceContent: sourceURL, params: {} });
    const presentation = { grid: null, status: 'loading', sourceURL, sourceEpoch: 1, seekEpoch: 1, presentedTime: null, panelState: 'waiting-presentation' } as VideoToolPresentation;
    const node: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, ...mediaInfo } };
    render(<QueryClientProvider client={new QueryClient()}><TooltipProvider><CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlowProvider><VideoToolPanelContainer nodeId={nodeId} toolId='video.extract-frames' node={node} presentation={presentation} onRunVideo={vi.fn()} maxOutputs={50} /></ReactFlowProvider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
    expect(screen.getByTestId('video-frame-mode-first')).toBeDisabled();
    expect(readVideoToolDraft(doc, nodeId, 'video.extract-frames')).toEqual({ state: 'absent' });
  });
});
