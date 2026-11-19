// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §69 U04 (frames-split design §5.5 and §10.12 `VideoToolPanelContainer.tsx` row): extracting frames
 * is platform funded, so the Extract frames panel's bottom line says `canvas.miniTool.panel.free` ("Free") rather than
 * an empty string or a quoted cost, and stays so when a cost text is around.
 */

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/spaces/canvas/_shared/NodePanelMount', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  NodePanelMount: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { t } from '@breatic/shared';
import { VideoToolPanelContainer, type VideoToolCostText } from '../video/VideoToolPanelContainer';
import { createVideoToolDraft } from '../video/video-tool-edit';
import { CanvasContext } from '../../canvas-context';
import { addNode, type CanvasNodeView } from '@web/data/yjs/canvas-space';
import { commitVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { canvasSessions } from '@web/stores/canvas-session';
import { TooltipProvider } from '@web/components/ui/tooltip';

const projectId = 'free-project'; const spaceId = 'free-space'; const nodeId = '10000000-0000-4000-8000-000000000002';
const sourceURL = 'https://assets.example.test/frames.mp4';
const mediaInfo = { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' };

/**
 * Mounts the Extract frames panel on a committed draft.
 * @param costs - Cost text the canvas would pass, when any.
 * @returns The footer's cost text.
 */
function footerText(costs?: VideoToolCostText): string {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  addNode(projectId, spaceId, { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, name: 'Source', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
  commitVideoToolDraft(doc, nodeId, 'video.extract-frames', createVideoToolDraft('video.extract-frames', { nodeId, canonicalURL: sourceURL, mediaInfo }));
  canvasSessions.of(spaceId).getState().openMiniTool(nodeId, 'video.extract-frames', { sourceContent: sourceURL, params: {} });
  const node: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, ...mediaInfo } };
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider><CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlowProvider><VideoToolPanelContainer nodeId={nodeId} toolId='video.extract-frames' node={node} nodes={[node]} costs={costs} /></ReactFlowProvider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
  return screen.getByTestId('mini-tool-credit').textContent ?? '';
}

afterEach(() => { destroyDoc(docName.canvasSpace(projectId, spaceId)); canvasSessions.of(spaceId).getState().closeActivePanel(); vi.restoreAllMocks(); });

describe('U04 the Extract frames panel bottom says Free (§5.5)', () => {
  it('U04: the footer reads the panel Free copy with no cost text around', () => {
    expect(footerText()).toBe(t('canvas.miniTool.panel.free'));
  });

  it('U04: the footer reads Free even when a cost text is passed', () => {
    expect(footerText({ execution: '3' })).toBe(t('canvas.miniTool.panel.free'));
  });
});
