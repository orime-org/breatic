// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §97 (canvas design §4 外扩、擦除、对口型、去背景 rows: the footer shows the run's estimate; production
 * `creditMode` in `mini-tool-view.ts` and the footer text in `MiniToolPanelContainer.tsx`): the four model tools state their
 * cost as an estimate, the way other model tools do: the quoted text when there is one, and nothing until it arrives,
 * never "Billed by usage", which belongs to container tools.
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

import { miniToolById, type VideoToolId } from '@breatic/shared/mini-tools';
import { VideoToolPanelContainer, type VideoToolCostText } from '../video/VideoToolPanelContainer';
import { createVideoToolDraft } from '../video/video-tool-edit';
import { creditMode } from '../mini-tool-view';
import { CanvasContext } from '../../canvas-context';
import { addNode, type CanvasNodeView } from '@web/data/yjs/canvas-space';
import { commitVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { canvasSessions } from '@web/stores/canvas-session';
import { TooltipProvider } from '@web/components/ui/tooltip';

const projectId = 'footer-project'; const spaceId = 'footer-space'; const nodeId = '10000000-0000-4000-8000-000000000001';
const sourceURL = 'https://assets.example.test/canonical.mp4';
const mediaInfo = { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' };
const MODEL_TOOLS = ['video.expand', 'video.erase', 'video.lip-sync', 'video.remove-bg'] as const satisfies readonly VideoToolId[];

/**
 * Mounts one video tool's panel on a committed draft.
 * @param toolId - The tool.
 * @param costs - The quoted cost text, when any.
 * @returns The footer's cost text.
 */
function footerText(toolId: VideoToolId, costs?: VideoToolCostText): string {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  addNode(projectId, spaceId, { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, name: 'Source', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
  commitVideoToolDraft(doc, nodeId, toolId, createVideoToolDraft(toolId, { nodeId, canonicalURL: sourceURL, mediaInfo }));
  canvasSessions.of(spaceId).getState().openMiniTool(nodeId, toolId, { sourceContent: sourceURL, params: {} });
  const node: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, ...mediaInfo } };
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider><CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlowProvider><VideoToolPanelContainer nodeId={nodeId} toolId={toolId} node={node} nodes={[node]} costs={costs} /></ReactFlowProvider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
  return screen.getByTestId('mini-tool-credit').textContent ?? '';
}

afterEach(() => { destroyDoc(docName.canvasSpace(projectId, spaceId)); canvasSessions.of(spaceId).getState().closeActivePanel(); vi.restoreAllMocks(); });

describe('model-tool footers show the estimate (§97; canvas design §4)', () => {
  it.each(MODEL_TOOLS)('%s is an estimate tool', (toolId) => {
    expect(creditMode(miniToolById(toolId)!)).toBe('estimate');
  });

  it.each(MODEL_TOOLS)('%s shows nothing, not "Billed by usage", before its estimate arrives', (toolId) => {
    expect(footerText(toolId)).toBe('');
  });

  it.each(MODEL_TOOLS)('%s shows the quoted estimate when there is one', (toolId) => {
    expect(footerText(toolId, { execution: '30' })).toBe('30');
  });
});
