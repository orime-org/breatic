// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * inner#1306 test plan §97 D26-1: a planned video tool's footer shows the server's quote, never a price the panel works out
 * itself. Mounted as `CanvasSpace` mounts it (`MiniToolPanelContainer`, no `videoCosts`), the panel posts the planned request
 * the Run would send for the current draft to `POST /mini-tools/quote`, which answers `{ credits }`, and the footer shows
 * exactly `formatCreditAmount(credits)`.
 */

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const http = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@web/data/api/request', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  apiGet: http.get,
  apiPost: http.post,
}));
vi.mock('@web/spaces/canvas/_shared/NodePanelMount', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  NodePanelMount: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { miniToolPlannedRequestSchema } from '@breatic/shared/mini-tools';
import { MiniToolPanelContainer } from '../MiniToolPanelContainer';
import type { VideoToolPresentation } from '../video/VideoToolPanelContainer';
import { createVideoToolDraft } from '../video/video-tool-edit';
import { CanvasContext } from '../../canvas-context';
import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';
import { canvasApi } from '@web/data/api/canvas';
import { addNode, type CanvasNodeView } from '@web/data/yjs/canvas-space';
import { commitVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { canvasSessions } from '@web/stores/canvas-session';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { formatCreditAmount } from '@web/lib/format-credit-amount';

const projectId = '01000000-0000-4000-8000-000000000011'; const spaceId = '02000000-0000-4000-8000-000000000011';
const nodeId = '10000000-0000-4000-8000-000000000001';
const sourceURL = 'https://assets.example.test/canonical.mp4';
const mediaInfo = { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' };
const source = { nodeId, canonicalURL: sourceURL, mediaInfo };
// The selected version's grid: 125 frames at 25 fps (5 s).
const grid = { fps: { numerator: 25, denominator: 1 }, frameCount: 125 };
const PRESENTATION_REF = { source: { toolInputId: 'd'.repeat(64), planSha256: 'f'.repeat(64) } };
const presentation: VideoToolPresentation = { grid, status: 'ready', sourceURL, sourceEpoch: 1, seekEpoch: 1, presentedTime: 0, presentationRef: PRESENTATION_REF };
const CATALOG = { image: [], video: [], audio: [], tts: [], three_d: [], total: 0, credit_multiplier: 1 };

/** `GET /canvas/limits` as the server answers it with this deployment's video configuration. */
const LIMITS = {
  referencePoolCap: 10, nodeHistoryPageSize: 20, understandMaxBytes: 20_971_520, understandLongMediaMaxBytes: 2_147_483_648,
  waveformMaxSeconds: 600, waveformMaxBytes: 200_000_000, quoteDebounceMs: 0,
};

/**
 * The quote requests posted so far.
 * @returns Their bodies.
 */
function quoteBodies(): Record<string, unknown>[] {
  return http.post.mock.calls.filter(([path]) => path === '/mini-tools/quote').map(([, body]) => body as Record<string, unknown>);
}

/**
 * The footer's text.
 * @returns The text.
 */
function footer(): string {
  return screen.getByTestId('mini-tool-credit').textContent ?? '';
}

beforeEach(() => {
  vi.clearAllMocks();
  canvasApi.resetLimitsCache();
  http.get.mockImplementation(async (path: string): Promise<unknown> => {
    if (path === '/canvas/limits') return structuredClone(LIMITS);
    throw new Error(`Unexpected GET ${path}`);
  });
});
afterEach(() => { destroyDoc(docName.canvasSpace(projectId, spaceId)); canvasSessions.of(spaceId).getState().closeActivePanel(); canvasApi.resetLimitsCache(); vi.restoreAllMocks(); });

// Frames-split design §10.8 计费 row: split is charged for its container work, so its footer shows the server's quote of
// the planned request, never "Free"; a split names one output node per planned segment, so its quote names as many.
// Extract-frames is free and shows Free (frames-split §10, test plan §69 U04, extract-frames-free.test.tsx); split is quoted.
describe('split shows the server quote, not "Free" (frames-split §10.8)', () => {
  const FRAMES_QUOTES = { 'video.split': 6.5 } as const;
  it.each(['video.split'] as const)('%s shows exactly the quoted credits for the planned request of its draft', async (toolId) => {
    http.post.mockImplementation(async (path: string): Promise<unknown> => {
      if (path !== '/mini-tools/quote') throw new Error(`Unexpected POST ${path}`);
      return { credits: FRAMES_QUOTES[toolId] };
    });
    const doc = getDoc(docName.canvasSpace(projectId, spaceId));
    addNode(projectId, spaceId, { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, name: 'Source', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
    const initial = createVideoToolDraft(toolId, source, PRESENTATION_REF);
    commitVideoToolDraft(doc, nodeId, toolId, { ...initial, params: { ...initial.params, cuts: [50] } });
    canvasSessions.of(spaceId).getState().openMiniTool(nodeId, toolId, { sourceContent: sourceURL, params: {} });
    const node: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, ...mediaInfo } };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(modelCatalogQuery().queryKey, CATALOG);
    render(<QueryClientProvider client={client}><TooltipProvider><CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlowProvider><MiniToolPanelContainer nodes={[node]} getLastWriteWasLocal={() => false} onRun={vi.fn()} onRunVideo={vi.fn()} videoPresentation={new Map([[nodeId, presentation]])} /></ReactFlowProvider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
    await waitFor(() => expect(footer()).toBe(formatCreditAmount(FRAMES_QUOTES[toolId])));
    const body = quoteBodies().at(-1)!;
    expect(miniToolPlannedRequestSchema.safeParse(body).success).toBe(true);
    const outputs = body.outputs as { nodeId: string }[];
    expect(outputs).toHaveLength(2);
    expect(new Set(outputs.map((output) => output.nodeId)).size).toBe(outputs.length);
  });
});

