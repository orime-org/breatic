// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * inner#1306 test plan §97 D26-1 (canvas design §4 去背景、对口型 rows: the footer shows the run's estimate; execution design
 * §9.3): the video model tools' footer shows the server's quote, never a price the panel works out itself. Mounted as
 * `CanvasSpace` mounts it (`MiniToolPanelContainer`, no `videoCosts`), the panel posts the planned request the Run would send
 * for the current draft (`buildPlannedVideoRequest` shape) to `POST /mini-tools/quote`, which answers `{ credits }`, and the
 * footer shows exactly `formatCreditAmount(credits)`; until the answer arrives it shows no number.
 *
 * The catalog prices every model as a decoy: a footer computed in the browser would show a different number. Earlier this
 * file asserted the client-side estimate of the configured model (`useCreditText` mocked to name the entry); D26-1 replaced
 * that contract with the server quote (4.4.5).
 */

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { act, render, screen, waitFor } from '@testing-library/react';
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

import type { ModelCatalog, ModelEntry } from '@breatic/shared';
import { fingerprintMiniToolAnalysisInput, miniToolPlannedRequestSchema, projectMiniToolAnalysisInput, type MiniToolAnalysisRecord, type VideoToolDraft, type VideoToolDraftById, type VideoToolId } from '@breatic/shared/mini-tools';
import { MiniToolPanelContainer } from '../MiniToolPanelContainer';
import type { VideoToolPresentation } from '../video/VideoToolPanelContainer';
import { createVideoToolDraft } from '../video/video-tool-edit';
import { CanvasContext } from '../../canvas-context';
import { modelCatalogQuery } from '@web/spaces/canvas/generate/model-catalog-query';
import { canvasApi } from '@web/data/api/canvas';
import { miniToolAnalysesApi } from '@web/data/api/mini-tool-analyses';
import { addNode, readNodes, type CanvasNodeView } from '@web/data/yjs/canvas-space';
import { commitVideoToolAnalysisRef, commitVideoToolDraft, readVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { canvasSessions } from '@web/stores/canvas-session';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { formatCreditAmount } from '@web/lib/format-credit-amount';

const projectId = '01000000-0000-4000-8000-000000000011'; const spaceId = '02000000-0000-4000-8000-000000000011';
const nodeId = '10000000-0000-4000-8000-000000000001';
const sourceURL = 'https://assets.example.test/canonical.mp4';
const mediaInfo = { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' };
const source = { nodeId, canonicalURL: sourceURL, mediaInfo };
const analysisRunId = '80000000-0000-4000-8000-000000000001';
const audioId = '40000000-0000-4000-8000-000000000009';
const frameTable = { schemaVersion: 1 as const, timescale: 100, runs: [{ start: 0, count: 125, step: 4, duration: 4 }] };
const PRESENTATION_REF = { source: { toolInputId: 'd'.repeat(64), planSha256: 'f'.repeat(64) } };
const presentation: VideoToolPresentation = { frameTable, status: 'ready', sourceURL, sourceEpoch: 1, seekEpoch: 1, presentedTime: 0, presentationRef: PRESENTATION_REF };
// The server's answers; nothing the catalog prices comes to these.
const QUOTES: Readonly<Record<'video.remove-bg' | 'video.lip-sync', number>> = { 'video.remove-bg': 73.25, 'video.lip-sync': 137.5 };

/**
 * A video model as the catalog serves it, priced so a footer computed in the browser shows a number of its own.
 * @param name - The catalog name.
 * @returns The entry.
 */
function model(name: string): ModelEntry {
  return { name, display_name: name, modality: 'video', mode: 'edit', description: '', guide: '', tier: 'internal', generation_time: 600, takes_prompt: false, providers: [],
    params: { video: { fill: 'tool', default: null }, audio: { fill: 'tool', default: null } },
    pricing: { base_price: 400_000, formula: '{"total_price": get_duration(video) * base_price}', discount_rate: 100 } } as unknown as ModelEntry;
}
const CATALOG = { image: [], video: [model('bria-fibo-video-background-remover'), model('sync-lipsync-3'), model('remove-bg-configured'), model('lipsync-configured-a')], audio: [], tts: [], three_d: [], total: 4, credit_multiplier: 1 } as unknown as ModelCatalog;

/** `GET /canvas/limits` as the server answers it with this deployment's video configuration. */
const LIMITS = {
  referencePoolCap: 10, nodeHistoryPageSize: 20, understandMaxBytes: 20_971_520, understandLongMediaMaxBytes: 2_147_483_648,
  waveformMaxSeconds: 600, waveformMaxBytes: 200_000_000, waveformPeaksRetryMs: 5000, waveformPeaksRetryMaxMs: 600_000,
  removeBackgroundModel: 'remove-bg-configured',
  lipSync: { models: [{ name: 'lipsync-configured-a', minDurationSeconds: 1, maxDurationSeconds: 300 }], tracking: { minDurationSeconds: 0.5, maxDurationSeconds: 600 }, maxPeople: 2, maxDialogues: 8 },
};

/**
 * A complete draft of the tool: remove-bg as created; lip-sync with one row bound to an identified person and a 3 s audio,
 * whose people analysis is served and recorded on the node.
 * @param toolId - The tool.
 * @returns The committed draft.
 */
async function seed(toolId: 'video.remove-bg' | 'video.lip-sync'): Promise<VideoToolDraft> {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  addNode(projectId, spaceId, { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, name: 'Source', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
  if (toolId === 'video.remove-bg') {
    const draft = createVideoToolDraft('video.remove-bg', source);
    commitVideoToolDraft(doc, nodeId, toolId, draft);
    return draft;
  }
  const initial = createVideoToolDraft('video.lip-sync', source);
  const draft: VideoToolDraftById['video.lip-sync'] = { ...initial,
    inputs: [{ inputId: audioId, url: 'https://assets.example.test/voice.m4a', mediaInfo: { duration: 3, mimeType: 'audio/mp4' } }],
    params: { ...initial.params, dialogues: [{ ...initial.params.dialogues[0]!, personId: 'person-a', analysisRunId, audioInputId: audioId, startTime: 0 }] } };
  commitVideoToolDraft(doc, nodeId, toolId, draft);
  const analysisInput = projectMiniToolAnalysisInput({ kind: 'people', source, params: draft.params, profile: { id: 'people', version: '1', weightsHash: null, params: {} } });
  const inputFingerprint = await fingerprintMiniToolAnalysisInput(analysisInput);
  const identity = { schemaVersion: 1 as const, draftId: draft.draftId, revision: draft.revision, analysisRunId, acceptedAt: '2026-11-06T00:00:00.000001Z',
    binding: { assetId: '70000000-0000-4000-8000-000000000001', contentHash: 'a'.repeat(64), canonicalURL: sourceURL, kind: 'video' as const, mediaInfo }, analysisInput, inputFingerprint };
  const record: MiniToolAnalysisRecord = { ...identity, kind: 'people', status: 'completed', artifactUnavailable: false, error: null, usage: [],
    result: { ...identity, kind: 'people', anchor: { frameIndex: 0, pts: 0 }, people: [{ personId: 'person-a', faceBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, artifactRefs: [] }] } };
  vi.spyOn(miniToolAnalysesApi, 'get').mockResolvedValue(record);
  commitVideoToolAnalysisRef(doc, nodeId, { version: 1, toolId: 'video.lip-sync', kind: 'people', draftId: draft.draftId, analysisRunId, inputFingerprint });
  return draft;
}

/**
 * Mounts the canvas's mini-tool panel container as `CanvasSpace` does, on an open video tool with a complete draft.
 * @param toolId - The video tool.
 * @returns Nothing.
 */
async function mount(toolId: 'video.remove-bg' | 'video.lip-sync'): Promise<void> {
  await seed(toolId);
  canvasSessions.of(spaceId).getState().openMiniTool(nodeId, toolId, { sourceContent: sourceURL, params: {} });
  const node: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, ...mediaInfo } };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(modelCatalogQuery().queryKey, CATALOG);
  render(<QueryClientProvider client={client}><TooltipProvider><CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlowProvider><MiniToolPanelContainer nodes={[node]} getLastWriteWasLocal={() => false} onRun={vi.fn()} onRunVideo={vi.fn()} videoPresentation={new Map([[nodeId, presentation]])} /></ReactFlowProvider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
}

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

describe('video model tools show the server quote of the current draft in their footer (§97 D26-1; canvas design §4)', () => {
  it.each(['video.remove-bg', 'video.lip-sync'] as const)('%s shows exactly the quoted credits for the planned request of its draft', async (toolId) => {
    http.post.mockImplementation(async (path: string, body: { tool: VideoToolId }): Promise<unknown> => {
      if (path !== '/mini-tools/quote') throw new Error(`Unexpected POST ${path}`);
      return { credits: QUOTES[body.tool as 'video.remove-bg' | 'video.lip-sync'] };
    });
    await mount(toolId);
    await waitFor(() => expect(footer()).toBe(formatCreditAmount(QUOTES[toolId])));
    const body = quoteBodies().at(-1)!;
    expect(miniToolPlannedRequestSchema.safeParse(body).success).toBe(true);
    const reading = readVideoToolDraft(getDoc(docName.canvasSpace(projectId, spaceId)), nodeId, toolId);
    expect(body).toMatchObject({ tool: toolId, project_id: projectId, space_id: spaceId, presentation_ref: PRESENTATION_REF, draft: reading.state === 'supported' ? reading.draft : null });
    const outputs = body.outputs as { outputIndex: number; nodeId: string; recipe: unknown }[];
    expect(outputs).toEqual([{ outputIndex: 0, nodeId: expect.any(String) as string, recipe: { kind: toolId === 'video.remove-bg' ? 'remove-bg' : 'lip-sync' } }]);
    expect(outputs[0]!.nodeId).not.toBe(nodeId);
    // A quote puts nothing on the canvas.
    expect(readNodes(getDoc(docName.canvasSpace(projectId, spaceId))).map((node) => node.id)).toEqual([nodeId]);
  });

  it.each(['video.remove-bg', 'video.lip-sync'] as const)('%s shows no number while the quote has not answered', async (toolId) => {
    http.post.mockImplementation(() => new Promise<never>(() => undefined));
    await mount(toolId);
    await waitFor(() => expect(quoteBodies()).toHaveLength(1));
    // Give any number the panel could compute on its own (the catalog prices every model) the time to appear.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(footer()).not.toMatch(/\d/);
  });
});
