// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Demo main.tsx guard-message and canvas design §4 (read-only, locked or offline): while the Space is read-only, the node is locked or the
 * collaboration connection is lost, the panel says why in red, and offline nothing that writes or starts work can be pressed.
 */

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider, ViewportPortal } from '@xyflow/react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { commitVideoToolDraft, readVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { SpaceConnectionContext } from '@web/data/yjs/space-connection';
import type { SocketState } from '@web/data/yjs/use-socket';
import { canvasSessions } from '@web/stores/canvas-session';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { modelsApi } from '@web/data/api';
import { createVideoToolDraft } from '../video/video-tool-edit';
import { CanvasVideoExpandBridge } from '../../video-presentation/CanvasVideoExpandBridge';
import { cropCanvas, installLayout } from '../../crop/__tests__/crop-harness';

const projectId = 'guard-project'; const spaceId = 'guard-space'; const nodeId = '10000000-0000-4000-8000-000000000001';
const sourceURL = 'https://assets.example.test/canonical.mp4';
const mediaInfo = { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' };
// The selected version's grid at 25 fps.
const grid = { fps: { numerator: 25, denominator: 1 }, frameCount: 125 };
const name = docName.canvasSpace(projectId, spaceId);
const VNODE = '10000000-0000-4000-8000-000000000002';

/**
 * A connection in the given state.
 * @param status - The connection status.
 * @returns The socket state.
 */
function connection(status: SocketState['status']): SocketState {
  return { provider: null, synced: status === 'connected', hasEverSynced: true, status, writeAccess: 'unknown', authFailedReason: null };
}

/**
 * Mounts a tool panel on a video node.
 * @param toolId - The tool.
 * @param over - The Space's read-only state, the node lock and the connection.
 * @param over.readOnly - Whether the Space is read-only.
 * @param over.locked - Whether the node is locked.
 * @param over.status - The connection status.
 */
function open(toolId: VideoToolId, over: { readOnly?: boolean; locked?: boolean; status?: SocketState['status'] } = {}): void {
  addNode(projectId, spaceId, { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, name: 'Source', locked: over.locked === true, createdAt: 0, createdBy: 'test', attachments: [] } });
  canvasSessions.of(spaceId).getState().openMiniTool(nodeId, toolId, { sourceContent: sourceURL, params: {} });
  const presentation = { grid, status: 'ready', sourceURL, sourceEpoch: 1, seekEpoch: 1, presentedTime: 0,
    presentationRef: { source: { toolInputId: 'd'.repeat(64), planSha256: 'f'.repeat(64) } } } as VideoToolPresentation;
  const node: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, locked: over.locked === true, ...mediaInfo } };
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider><SpaceConnectionContext.Provider value={connection(over.status ?? 'connected')}><CanvasContext.Provider value={{ projectId, spaceId, readOnly: over.readOnly === true, myRole: over.readOnly === true ? 'viewer' : 'editor', caretProvider: null }}><ReactFlowProvider><VideoToolPanelContainer nodeId={nodeId} toolId={toolId} node={node} nodes={[node]} presentation={presentation} onRunVideo={vi.fn()} costs={{ execution: '1' }} /></ReactFlowProvider></CanvasContext.Provider></SpaceConnectionContext.Provider></TooltipProvider></QueryClientProvider>);
}

afterEach(() => { destroyDoc(name); canvasSessions.of(spaceId).getState().closeActivePanel(); vi.restoreAllMocks(); });

describe('a video tool panel that cannot write says why', () => {
  it('says Viewer mode in a read-only Space', () => {
    open('video.remove-bg', { readOnly: true });
    expect(screen.getByTestId('video-tool-guard')).toHaveTextContent(t('canvas.miniTool.videoUI.viewerMode'));
    expect(screen.getByTestId('video-tool-guard')).toHaveClass('text-status-error-foreground');
  });

  it('says the node is locked', () => {
    open('video.remove-bg', { locked: true });
    expect(screen.getByTestId('video-tool-guard')).toHaveTextContent(t('canvas.gate.locked'));
  });

  it('says the connection is unavailable and blocks Run and slot picks while offline', () => {
    open('video.transitions', { status: 'disconnected' });
    expect(screen.getByTestId('video-tool-guard')).toHaveTextContent(t('canvas.miniTool.videoUI.connectionUnavailable'));
    expect(screen.getByTestId('mini-tool-run')).toBeDisabled();
    fireEvent.click(screen.getByTestId('video-timeline-input'));
    expect(canvasSessions.of(spaceId).getState().pickSession).toBeNull();
  });

  it('blocks scene detection while offline', () => {
    open('video.split', { status: 'authFailed' });
    expect(screen.getByTestId('video-detect-scenes')).toBeDisabled();
  });

  it('shows no guard while connected and writable', () => {
    open('video.remove-bg');
    expect(screen.queryByTestId('video-tool-guard')).toBeNull();
  });
});

describe('the expansion frame while offline', () => {
  beforeEach(() => { installLayout(); canvasSessions.clear(); vi.spyOn(modelsApi, 'list').mockReturnValue(new Promise(() => {})); });

  /**
   * Drags nothing on one handle of a video expansion frame and reports whether the draft was written.
   * @param status - The connection status.
   * @returns Whether the draft's revision changed.
   */
  function pressHandle(status: SocketState['status']): boolean {
    const url = 'https://assets.example.test/canonical.webm';
    addNode(projectId, spaceId, { id: VNODE, type: 'video', position: { x: 0, y: 0 }, data: { content: url, name: 'Source', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
    commitVideoToolDraft(getDoc(name), VNODE, 'video.expand', createVideoToolDraft('video.expand', { nodeId: VNODE, canonicalURL: url, mediaInfo: { ...mediaInfo, mimeType: 'video/webm' } }), false);
    const before = readVideoToolDraft(getDoc(name), VNODE, 'video.expand');
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SpaceConnectionContext.Provider value={connection(status)}><CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'editor', caretProvider: null }}>{cropCanvas([{ id: VNODE, kind: 'video', src: url }], <ViewportPortal><CanvasVideoExpandBridge nodeId={VNODE} canonicalURL={url} locked={false} snapshot={undefined} onNodeContextMenu={vi.fn()} /></ViewportPortal>)}</CanvasContext.Provider></SpaceConnectionContext.Provider></QueryClientProvider>);
    screen.getByTestId('media-element').setAttribute('data-canonical-video-display', url);
    act(() => {
      const session = canvasSessions.of(spaceId).getState();
      session.openMiniTool(VNODE, 'video.expand', { sourceContent: url, params: {} });
      session.setMiniToolSourceSize({ width: 1600, height: 1000 });
      session.setExpand({ frame: { x: -0.5, y: -0.5, width: 2, height: 2 }, ratio: 'free' });
    });
    const handle = screen.getByTestId('mini-tool-expand-handle-se');
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(handle, { button: 0, pointerId: 1 });
    const after = readVideoToolDraft(getDoc(name), VNODE, 'video.expand');
    return before.state === 'supported' && after.state === 'supported' && before.draft.revision !== after.draft.revision;
  }

  it('commits a handle press while connected', () => {
    expect(pressHandle('connected')).toBe(true);
  });

  it('commits no frame edit while offline', () => {
    expect(pressHandle('disconnected')).toBe(false);
  });
});
