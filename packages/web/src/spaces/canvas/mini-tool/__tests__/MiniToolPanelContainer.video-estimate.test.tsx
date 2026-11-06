// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1306 test plan §97 (canvas design §4 去背景、对口型 rows: the footer shows the run's estimate): `MiniToolPanelContainer`
 * owns the estimate path the other model tools use (catalog entry, `useCreditText`, `creditMode`), and it is also where a
 * video tool's panel is mounted; `CanvasSpace` passes it no `videoCosts`. So the video model tools' footer must show what
 * that path produces for the tool's model: remove-bg prices `bria-fibo-video-background-remover` (config
 * `executions.video.remove-bg.model`), lip-sync the selected model, `sync-lipsync-3` by default (config
 * `executions.video.lip-sync.models`). `useCreditText` is mocked to name the entry it priced, so the footer text proves
 * which model reached it.
 */

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@web/spaces/canvas/_shared/NodePanelMount', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  NodePanelMount: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@web/spaces/canvas/generate/use-credit-estimate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useCreditText: vi.fn((model: { name: string } | undefined): string | undefined => (model === undefined ? undefined : `≈ ${model.name}`)),
}));

import type { ModelCatalog, ModelEntry } from '@breatic/shared';
import type { VideoToolId } from '@breatic/shared/mini-tools';
import { MiniToolPanelContainer } from '../MiniToolPanelContainer';
import { createVideoToolDraft } from '../video/video-tool-edit';
import { CanvasContext } from '../../canvas-context';
import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';
import { addNode, type CanvasNodeView } from '@web/data/yjs/canvas-space';
import { commitVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { canvasSessions } from '@web/stores/canvas-session';
import { TooltipProvider } from '@web/components/ui/tooltip';

const projectId = 'estimate-project'; const spaceId = 'estimate-space'; const nodeId = '10000000-0000-4000-8000-000000000001';
const sourceURL = 'https://assets.example.test/canonical.mp4';
const mediaInfo = { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' };

/**
 * A priced video model as the catalog serves it.
 * @param name - The catalog name.
 * @returns The entry.
 */
function model(name: string): ModelEntry {
  return { name, display_name: name, modality: 'video', mode: 'edit', description: '', guide: '', tier: 'internal', generation_time: 600, takes_prompt: false, params: {}, providers: [] };
}
const CATALOG = { image: [], video: [model('bria-fibo-video-background-remover'), model('sync-lipsync-3'), model('ltx-2.3-lipsync')], audio: [], tts: [], three_d: [], total: 3, credit_multiplier: 1 } as unknown as ModelCatalog;

/**
 * Mounts the canvas's mini-tool panel container, with no `videoCosts`, as `CanvasSpace` does, on an open video tool.
 * @param toolId - The video tool.
 * @returns Nothing.
 */
function mount(toolId: VideoToolId): void {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  addNode(projectId, spaceId, { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, name: 'Source', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
  commitVideoToolDraft(doc, nodeId, toolId, createVideoToolDraft(toolId, { nodeId, canonicalURL: sourceURL, mediaInfo }));
  canvasSessions.of(spaceId).getState().openMiniTool(nodeId, toolId, { sourceContent: sourceURL, params: {} });
  const node: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, ...mediaInfo } };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(modelCatalogQuery().queryKey, CATALOG);
  render(<QueryClientProvider client={client}><TooltipProvider><CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlowProvider><MiniToolPanelContainer nodes={[node]} getLastWriteWasLocal={() => false} onRun={vi.fn()} onRunVideo={vi.fn()} /></ReactFlowProvider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
}

afterEach(() => { destroyDoc(docName.canvasSpace(projectId, spaceId)); canvasSessions.of(spaceId).getState().closeActivePanel(); vi.restoreAllMocks(); });

describe('video model tools take their footer estimate from the panel container estimate path (§97; canvas design §4)', () => {
  it.each([
    ['video.remove-bg', 'bria-fibo-video-background-remover'],
    ['video.lip-sync', 'sync-lipsync-3'],
  ] as const)('%s shows the estimate priced for %s', async (toolId, name) => {
    mount(toolId);
    expect(screen.getByTestId('mini-tool-panel')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('mini-tool-credit')).toHaveTextContent(`≈ ${name}`));
  });
});
