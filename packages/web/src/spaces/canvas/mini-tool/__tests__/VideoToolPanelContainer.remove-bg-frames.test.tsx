// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 remove background and extract frames in the panel container: remove background waits for the frame table like
 * every model tool (frames-split §10.6 panel hookup), its newest ready result opens in a preview dialog (canvas design §4
 * remove-background row; demo open-alpha-result), the frame modes stay usable while only Run waits, and a camera-menu pick
 * reaches the extract-frames draft (tools design §4 camera menu).
 */

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/spaces/canvas/_shared/NodePanelMount', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  NodePanelMount: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@web/spaces/canvas/video-presentation/use-resolved-video-presentation', () => ({
  useResolvedVideoPresentation: () => ({ query: {}, source: null, failure: null }),
}));

import type { VideoToolDraftById, VideoToolId } from '@breatic/shared/mini-tools';
import { VideoToolPanelContainer, type VideoToolPresentation } from '../video/VideoToolPanelContainer';
import { createVideoToolDraft } from '../video/video-tool-edit';
import { CanvasContext } from '../../canvas-context';
import { addEdge, addNode, nodeDataMap, readNodes, type CanvasNodeView } from '@web/data/yjs/canvas-space';
import { commitVideoToolDraft, readVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { canvasSessions } from '@web/stores/canvas-session';
import { TooltipProvider } from '@web/components/ui/tooltip';
import type { MediaSurfaceBinding } from '@web/spaces/canvas/video-presentation/types';

const projectId = 'rb-project'; const spaceId = 'rb-space'; const nodeId = '10000000-0000-4000-8000-000000000001';
const resultId = '10000000-0000-4000-8000-000000000002'; const olderId = '10000000-0000-4000-8000-000000000003';
const failedId = '10000000-0000-4000-8000-000000000004';
const sourceURL = 'https://assets.example.test/canonical.mp4'; const resultURL = 'https://assets.example.test/alpha.webm';
const mediaInfo = { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' };
// The selected version's grid: 10 frames at 2 fps (5 s).
const GRID = { fps: { numerator: 2, denominator: 1 }, frameCount: 10 };

/**
 * Presentation facts of a source in the given state.
 * @param ready - Whether the selected version is usable.
 * @returns The facts.
 */
function facts(ready: boolean): VideoToolPresentation {
  return ready ? { status: 'ready', grid: GRID, presentedTime: 1, sourceURL, sourceEpoch: 1, seekEpoch: 0, panelState: 'usable', presentationRef: { source: { toolInputId: 'd'.repeat(64), planSha256: 'f'.repeat(64) } } }
    : { status: 'ready', grid: null, presentedTime: 1, sourceURL, sourceEpoch: 1, seekEpoch: 0, panelState: 'waiting-presentation' };
}

/** Puts the source video node on the canvas once. */
function seedSource(): void {
  if (nodeDataMap(getDoc(docName.canvasSpace(projectId, spaceId)), nodeId) !== null) return;
  addNode(projectId, spaceId, { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, name: 'Source', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
}

/**
 * Mounts one video tool's panel on a committed draft.
 * @param toolId - The tool.
 * @param presentation - The source's presentation facts.
 * @param params - The session params the panel opens with.
 * @param binding - The source player's transport, when the test drives it.
 */
function mount(toolId: VideoToolId, presentation: VideoToolPresentation, params: Record<string, unknown> = {}, binding?: MediaSurfaceBinding): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  seedSource();
  commitVideoToolDraft(doc, nodeId, toolId, createVideoToolDraft(toolId, { nodeId, canonicalURL: sourceURL, mediaInfo }));
  canvasSessions.of(spaceId).getState().openMiniTool(nodeId, toolId, { sourceContent: sourceURL, params });
  // The panel reads the source's size from its view, as the canvas hands it over.
  const node: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, ...mediaInfo } };
  const nodes = [node, ...readNodes(doc).filter((candidate) => candidate.id !== nodeId)];
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider><CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlowProvider><VideoToolPanelContainer nodeId={nodeId} toolId={toolId} node={node} nodes={nodes} presentation={presentation} binding={binding} onRunVideo={vi.fn().mockResolvedValue(undefined)} /></ReactFlowProvider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
}

/**
 * Puts a remove-background output node of the source on the canvas.
 * @param id - The output node.
 * @param content - Its result, empty while pending.
 * @param createdAt - When its edge was drawn.
 */
function output(id: string, content: string, createdAt: number): void {
  seedSource();
  addNode(projectId, spaceId, { id, type: 'video', position: { x: 400, y: 0 }, data: { content, name: `BG-${createdAt}`, locked: false, createdAt, createdBy: 'test', attachments: [] } });
  addEdge(projectId, spaceId, { id: `${nodeId}->${id}`, source: nodeId, target: id, toolId: 'video.remove-bg', createdAt });
}

afterEach(() => { destroyDoc(docName.canvasSpace(projectId, spaceId)); canvasSessions.of(spaceId).getState().closeActivePanel(); vi.restoreAllMocks(); });

describe('remove background waits for the selected version (frames-split §7.12)', () => {
  it('keeps Run unavailable and shows the preparing line while the selected version is not usable', () => {
    mount('video.remove-bg', facts(false));
    expect(screen.getByTestId('mini-tool-run')).toBeDisabled();
    expect(screen.getByText('Preparing video…')).toBeInTheDocument();
  });

  it('runs once the selected version is usable', () => {
    mount('video.remove-bg', facts(true));
    expect(screen.getByTestId('mini-tool-run')).not.toBeDisabled();
  });
});

describe('the newest remove-background result (canvas design §4 remove-background row)', () => {
  it('offers Results ready for a ready newest result and opens it in a preview dialog', () => {
    output(olderId, 'https://assets.example.test/old.webm', 1);
    output(resultId, resultURL, 2);
    mount('video.remove-bg', facts(true));
    fireEvent.click(screen.getByRole('button', { name: /Results ready/ }));
    const dialog = screen.getByTestId('video-result-preview');
    expect(dialog.textContent).toContain('BG-2');
    expect(dialog.querySelector('[data-testid="media-player"]')).not.toBeNull();
    expect(dialog.querySelector('[data-testid="play-toggle"]')).not.toBeNull();
    expect(dialog.querySelector('[data-testid="seek"]')).not.toBeNull();
  });

  it('still offers the older ready result while the newest run is pending', () => {
    output(olderId, 'https://assets.example.test/old.webm', 1);
    output(resultId, '', 2);
    mount('video.remove-bg', facts(true));
    fireEvent.click(screen.getByRole('button', { name: /Results ready/ }));
    expect(screen.getByTestId('video-result-preview').textContent).toContain('BG-1');
  });

  it('still offers the older ready result when the newest run failed and its node never got a result', () => {
    output(olderId, 'https://assets.example.test/old.webm', 1);
    output(resultId, '', 2);
    output(failedId, '', 3);
    mount('video.remove-bg', facts(true));
    fireEvent.click(screen.getByRole('button', { name: /Results ready/ }));
    expect(screen.getByTestId('video-result-preview').textContent).toContain('BG-1');
  });

  it('offers nothing while no result is ready', () => {
    output(resultId, '', 2);
    mount('video.remove-bg', facts(true));
    expect(screen.queryByRole('button', { name: /Results ready/ })).toBeNull();
  });
});

describe('extract frames while the selected version waits', () => {
  it('keeps the mode buttons usable while only Run waits', () => {
    mount('video.extract-frames', facts(false));
    expect(screen.getByTestId('mini-tool-run')).toBeDisabled();
    const last = screen.getByTestId('video-frame-mode-last');
    expect(last).not.toBeDisabled();
    fireEvent.click(last);
    const held = readVideoToolDraft(getDoc(docName.canvasSpace(projectId, spaceId)), nodeId, 'video.extract-frames');
    expect(held.state === 'supported' && (held.draft as VideoToolDraftById['video.extract-frames']).params.mode).toBe('last');
  });

  it('applies the mode a camera-menu pick asks for, once', () => {
    mount('video.extract-frames', facts(true), { frameMode: 'first' });
    const held = readVideoToolDraft(getDoc(docName.canvasSpace(projectId, spaceId)), nodeId, 'video.extract-frames');
    expect(held.state === 'supported' && (held.draft as VideoToolDraftById['video.extract-frames']).params.mode).toBe('first');
    expect(canvasSessions.of(spaceId).getState().miniTool?.params.frameMode).toBeUndefined();
    act(() => canvasSessions.of(spaceId).getState().setMiniToolParam('frameMode', 'current'));
    const again = readVideoToolDraft(getDoc(docName.canvasSpace(projectId, spaceId)), nodeId, 'video.extract-frames');
    // The presented mediaTime 1 s is grid frame 2 at 2 fps (frames-split §4.3).
    expect(again.state === 'supported' && (again.draft as VideoToolDraftById['video.extract-frames']).params).toMatchObject({ mode: 'current', frameIndex: 2 });
  });
});

describe('the playback strip follows the source while it plays (FM5)', () => {
  it('moves the head from the live presented frame without the panel re-rendering', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => frames.push(callback)));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const element = document.createElement('video');
    let paused = true;
    Object.defineProperty(element, 'paused', { configurable: true, get: () => paused });
    let mediaTime = 1;
    const getPresentedFrame = (): ReturnType<MediaSurfaceBinding['getPresentedFrame']> => ({ sourceKey: 'source', sourceEpoch: 1, seekEpoch: 0, mediaTime, surface: element });
    const binding = { sourceKey: 'source', sourceEpoch: 1, element, surface: element, container: document.createElement('div'), original: { width: 960, height: 540, duration: 5 },
      getSeekEpoch: () => 0, getPresentedFrame, seek: vi.fn(), play: vi.fn(), pause: vi.fn() } satisfies MediaSurfaceBinding;
    mount('video.remove-bg', { ...facts(true), getPresentedFrame }, {}, binding);
    expect(screen.getByTestId('video-playback-head').style.left).toBe('20%');
    paused = false;
    fireEvent(element, new Event('play'));
    mediaTime = 2.5;
    act(() => { for (const callback of frames.splice(0)) callback(0); });
    expect(screen.getByTestId('video-playback-head').style.left).toBe('50%');
  });
});
