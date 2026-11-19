// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VideoToolPanelContainer } from '../video/VideoToolPanelContainer';
import { createVideoToolDraft } from '../video/video-tool-edit';
import { CanvasContext } from '../../canvas-context';
import { addNode, type CanvasNodeView } from '@web/data/yjs/canvas-space';
import { commitVideoToolDraft, readVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { canvasSessions } from '@web/stores/canvas-session';
import { TooltipProvider } from '@web/components/ui/tooltip';
import type { MediaSurfaceBinding } from '../../video-presentation/types';

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
let target: HTMLElement | null = null;
afterEach(() => { target?.remove(); target = null; destroyDoc(docName.canvasSpace(projectId, spaceId)); canvasSessions.of(spaceId).getState().closeActivePanel(); vi.restoreAllMocks(); });

describe('parameter-owned overlay in the actual canonical node display', () => {
  it('portals the real region gesture into the provided display and commits the same persisted draft once', () => {
    const doc = getDoc(docName.canvasSpace(projectId, spaceId));
    addNode(projectId, spaceId, { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, name: 'Source', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
    const source = { nodeId, canonicalURL: sourceURL, mediaInfo: { width: 160, height: 240, duration: 10, mimeType: 'video/webm' } };
    const draft = createVideoToolDraft('video.erase', source);
    commitVideoToolDraft(doc, nodeId, 'video.erase', draft);
    canvasSessions.of(spaceId).getState().openMiniTool(nodeId, 'video.erase', { sourceContent: sourceURL, params: {} });
    target = document.createElement('div'); document.body.append(target);
    const element = document.createElement('video'); const surface = document.createElement('canvas');
    const frame = { sourceKey: 'canonical-key', sourceEpoch: 1, seekEpoch: 3, mediaTime: 0.417, surface };
    const binding: MediaSurfaceBinding = { sourceKey: frame.sourceKey, sourceEpoch: 1, element, surface, container: target, original: source.mediaInfo, getSeekEpoch: () => 3, getPresentedFrame: () => frame, seek: vi.fn(), play: vi.fn().mockResolvedValue(undefined), pause: vi.fn() };
    const node: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, ...source.mediaInfo } };
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider><CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlowProvider><VideoToolPanelContainer nodeId={nodeId} toolId='video.erase' node={node} nodes={[node]} overlayTarget={target} binding={binding} /></ReactFlowProvider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
    const overlay = screen.getByTestId('video-tool-node-overlay');
    expect(target.contains(overlay)).toBe(true);
    expect(screen.getByTestId('mini-tool-panel').contains(overlay)).toBe(false);
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 160, height: 240 } as DOMRect);
    const gesture = screen.getByTestId('video-tool-region-gesture');
    fireEvent.pointerDown(gesture, { pointerId: 1, button: 0, clientX: 16, clientY: 48 });
    fireEvent.pointerMove(gesture, { pointerId: 1, clientX: 96, clientY: 192 });
    expect(readVideoToolDraft(doc, nodeId, 'video.erase')).toEqual({ state: 'supported', draft });
    act(() => fireEvent.pointerUp(gesture, { pointerId: 1 }));
    const reading = readVideoToolDraft(doc, nodeId, 'video.erase');
    expect(reading.state).toBe('supported');
    if (reading.state !== 'supported' || !('region' in reading.draft.params)) throw new Error('Expected supported erase draft');
    expect(reading.draft.draftId).toBe(draft.draftId);
    expect(reading.draft.params.region.box).toEqual({ x: 0.1, y: 0.2, width: 0.5, height: 0.6000000000000001 });
  });
});


describe('Run with a trusted frame table and an unknown presented frame', () => {
  // §97: the interval mode is removed (frames-split §10.6), so only the three kept modes are gated (4.4.5).
  it.each(['current', 'first', 'last'] as const)('gates %s by its actual frame dependency without inventing a Current time', (mode) => {
    const doc = getDoc(docName.canvasSpace(projectId, spaceId));
    addNode(projectId, spaceId, { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, name: 'Source', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
    const source = { nodeId, canonicalURL: sourceURL, mediaInfo: { width: 160, height: 240, duration: 0.28, mimeType: 'video/webm' } };
    const initial = createVideoToolDraft('video.extract-frames', source);
    const draft = { ...initial, params: { mode, currentTime: 0.13 } } as typeof initial;
    commitVideoToolDraft(doc, nodeId, 'video.extract-frames', draft);
    canvasSessions.of(spaceId).getState().openMiniTool(nodeId, 'video.extract-frames', { sourceContent: sourceURL, params: {} });
    const node: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, ...source.mediaInfo } };
    const frameTable = { schemaVersion: 1 as const, timescale: 100, runs: [{ start: 0, count: 1, step: 4, duration: 4 }, { start: 4, count: 3, step: 8, duration: 8 }] };
    const onRun = vi.fn().mockResolvedValue(undefined);
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider><CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlowProvider><VideoToolPanelContainer nodeId={nodeId} toolId='video.extract-frames' node={node} nodes={[node]} onRunVideo={onRun} presentation={{ frameTable, status: 'ready', sourceURL, sourceEpoch: 1, seekEpoch: 3, presentedTime: null }} /></ReactFlowProvider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
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
