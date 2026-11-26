// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Demo main.tsx guard-message and canvas design §4 (read-only, locked or offline): while the Space is read-only, the node is locked or the
 * collaboration connection is lost, the panel says why in red, and offline nothing that writes or starts work can be pressed.
 */

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { render, screen } from '@testing-library/react';
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
import { docName, destroyDoc } from '@web/data/yjs/manager';
import { SpaceConnectionContext } from '@web/data/yjs/space-connection';
import type { SocketState } from '@web/data/yjs/use-socket';
import { canvasSessions } from '@web/stores/canvas-session';
import { TooltipProvider } from '@web/components/ui/tooltip';

const projectId = 'guard-project'; const spaceId = 'guard-space'; const nodeId = '10000000-0000-4000-8000-000000000001';
const sourceURL = 'https://assets.example.test/canonical.mp4';
const mediaInfo = { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' };
// The selected version's grid at 25 fps.
const grid = { fps: { numerator: 25, denominator: 1 }, frameCount: 125 };
const name = docName.canvasSpace(projectId, spaceId);

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
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider><SpaceConnectionContext.Provider value={connection(over.status ?? 'connected')}><CanvasContext.Provider value={{ projectId, spaceId, readOnly: over.readOnly === true, myRole: over.readOnly === true ? 'viewer' : 'editor', caretProvider: null }}><ReactFlowProvider><VideoToolPanelContainer nodeId={nodeId} toolId={toolId} node={node} presentation={presentation} onRunVideo={vi.fn()} costs={{ execution: '1' }} /></ReactFlowProvider></CanvasContext.Provider></SpaceConnectionContext.Provider></TooltipProvider></QueryClientProvider>);
}

afterEach(() => { destroyDoc(name); canvasSessions.of(spaceId).getState().closeActivePanel(); vi.restoreAllMocks(); });

describe('a video tool panel that cannot write says why', () => {
  it('says Viewer mode in a read-only Space', () => {
    open('video.split', { readOnly: true });
    expect(screen.getByTestId('video-tool-guard')).toHaveTextContent(t('canvas.miniTool.videoUI.viewerMode'));
    expect(screen.getByTestId('video-tool-guard')).toHaveClass('text-status-error-foreground');
  });

  it('says the node is locked', () => {
    open('video.split', { locked: true });
    expect(screen.getByTestId('video-tool-guard')).toHaveTextContent(t('canvas.gate.locked'));
  });

  it('says the connection is unavailable and blocks Run while offline', () => {
    open('video.split', { status: 'disconnected' });
    expect(screen.getByTestId('video-tool-guard')).toHaveTextContent(t('canvas.miniTool.videoUI.connectionUnavailable'));
    expect(screen.getByTestId('mini-tool-run')).toBeDisabled();
  });

  it('blocks scene detection while offline', () => {
    open('video.split', { status: 'authFailed' });
    expect(screen.getByTestId('video-detect-scenes')).toBeDisabled();
  });

  it('shows no guard while connected and writable', () => {
    open('video.split');
    expect(screen.queryByTestId('video-tool-guard')).toBeNull();
  });
});

