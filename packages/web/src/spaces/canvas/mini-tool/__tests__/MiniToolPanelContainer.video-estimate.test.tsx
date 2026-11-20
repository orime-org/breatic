// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §97 D26-1 (canvas design §4 外扩、擦除、对口型、去背景 rows: the footer shows the run's estimate;
 * execution design §9.3, §10.4, §10.5): the video model tools' footer shows the server's quote, never a price the panel works out itself. Mounted as
 * `CanvasSpace` mounts it (`MiniToolPanelContainer`, no `videoCosts`), the panel posts the planned request the Run would send
 * for the current draft (`buildPlannedVideoRequest` shape) to `POST /mini-tools/quote`, which answers `{ credits }`, and the
 * footer shows exactly `formatCreditAmount(credits)`; until the answer arrives it shows no number.
 *
 * The catalog prices every model as a decoy: a footer computed in the browser would show a different number. Earlier this
 * file asserted the client-side estimate of the configured model (`useCreditText` mocked to name the entry); D26-1 replaced
 * that contract with the server quote (4.4.5).
 *
 * An erase names the one tracking made for its current selection (shared `miniToolPlannedRequestSchema` takes exactly one
 * tracked_mask ref): with an older tracking of another selection also recorded on the node, the quote and the Run both
 * name only the current one.
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
// The selected version's grid: 125 frames at 25 fps (5 s).
const grid = { fps: { numerator: 25, denominator: 1 }, frameCount: 125 };
const PRESENTATION_REF = { source: { toolInputId: 'd'.repeat(64), planSha256: 'f'.repeat(64) } };
const presentation: VideoToolPresentation = { grid, status: 'ready', sourceURL, sourceEpoch: 1, seekEpoch: 1, presentedTime: 0, presentationRef: PRESENTATION_REF };
// The server's answers; nothing the catalog prices comes to these.
type QuotedTool = 'video.remove-bg' | 'video.lip-sync' | 'video.erase' | 'video.expand';
const QUOTES: Readonly<Record<QuotedTool, number>> = { 'video.remove-bg': 73.25, 'video.lip-sync': 137.5, 'video.erase': 41.5, 'video.expand': 88.75 };
const RECIPES: Readonly<Record<QuotedTool, string>> = { 'video.remove-bg': 'remove-bg', 'video.lip-sync': 'lip-sync', 'video.erase': 'erase', 'video.expand': 'expand' };
const staleRunId = '80000000-0000-4000-8000-000000000002';

/**
 * A video model as the catalog serves it, priced so a footer computed in the browser shows a number of its own.
 * @param name - The catalog name.
 * @returns The entry.
 */
function model(name: string): ModelEntry {
  return { name, display_name: name, modality: 'video', mode: 'edit', description: '', guide: '', tier: 'internal', generation_time: 600, takes_prompt: false,
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
  erase: { minSeconds: 1, maxSeconds: 5, maxGridFps: 30 }, quoteDebounceMs: 0,
  expand: { maxDurationSeconds: 180, maxTargetSide: 4096 },
};

/**
 * A complete draft of the tool: remove-bg as created; lip-sync with one row bound to an identified person and a 3 s audio,
 * whose people analysis is served and recorded on the node; erase with a 3 s range tracked twice, an older tracking of
 * another box and the one of its current box, both served and recorded; expand widened to half the width again.
 * @param toolId - The tool.
 * @param tracking - The erase tracking seeded: billed credits, or none at all.
 * @param tracking.billed - What the current tracking was charged.
 * @param tracking.none - Seeds no tracking.
 * @returns The committed draft.
 */
async function seed(toolId: QuotedTool, tracking: { billed?: number; none?: boolean } = {}): Promise<VideoToolDraft> {
  const doc = getDoc(docName.canvasSpace(projectId, spaceId));
  addNode(projectId, spaceId, { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { content: sourceURL, name: 'Source', locked: false, createdAt: 0, createdBy: 'test', attachments: [] } });
  if (toolId === 'video.remove-bg') {
    const draft = createVideoToolDraft('video.remove-bg', source);
    commitVideoToolDraft(doc, nodeId, toolId, draft);
    return draft;
  }
  if (toolId === 'video.expand') {
    const initial = createVideoToolDraft('video.expand', source);
    const draft: VideoToolDraftById['video.expand'] = { ...initial, params: { ...initial.params, frame: { x: -0.25, y: 0, width: 1.5, height: 1 } } };
    commitVideoToolDraft(doc, nodeId, toolId, draft);
    return draft;
  }
  if (toolId === 'video.erase') {
    const initial = createVideoToolDraft('video.erase', source);
    const box = { x: 0.3, y: 0.2, width: 0.3, height: 0.6 };
    // The range is grid frames: the first 3 s of the 25 fps grid.
    const draft: VideoToolDraftById['video.erase'] = { ...initial, params: { ...initial.params, range: { start: 0, end: 75 }, region: { box, points: [] } } };
    commitVideoToolDraft(doc, nodeId, toolId, draft);
    if (tracking.none === true) return draft;
    const profile = { id: 'sam3', version: '1', weightsHash: null, params: {} };
    const tracked = async (runId: string, region: typeof draft.params.region, acceptedAt: string): Promise<MiniToolAnalysisRecord> => {
      const analysisInput = projectMiniToolAnalysisInput({ kind: 'tracked_mask', source, params: { ...draft.params, region }, profile });
      const inputFingerprint = await fingerprintMiniToolAnalysisInput(analysisInput);
      const identity = { schemaVersion: 1 as const, draftId: draft.draftId, revision: draft.revision, analysisRunId: runId, acceptedAt,
        binding: { assetId: '70000000-0000-4000-8000-000000000001', contentHash: 'a'.repeat(64), canonicalURL: sourceURL, kind: 'video' as const, mediaInfo }, analysisInput, inputFingerprint };
      commitVideoToolAnalysisRef(doc, nodeId, { version: 1, toolId: 'video.erase', kind: 'tracked_mask', draftId: draft.draftId, analysisRunId: runId, inputFingerprint });
      return { ...identity, kind: 'tracked_mask', status: 'completed', artifactUnavailable: false, error: null, usage: tracking.billed === undefined ? [] : [{ credits: tracking.billed }],
        result: { ...identity, kind: 'tracked_mask', width: 960, height: 540, frameCount: 75, fps: { numerator: 25, denominator: 1 }, anchor: draft.params.anchor,
          regionFingerprint: 'c'.repeat(64),
          artifactRefs: [{ role: 'rle', assetId: '70000000-0000-4000-8000-000000000002', canonicalURL: 'https://assets.example.test/track.rle', contentHash: 'b'.repeat(64),
            kind: 'document', mimeType: 'text/plain', size: 10, frameMetadata: null }] } };
    };
    const records = [await tracked(staleRunId, { box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, points: [] }, '2026-11-06T00:00:00.000001Z'),
      await tracked(analysisRunId, draft.params.region, '2026-11-06T00:01:00.000001Z')];
    vi.spyOn(miniToolAnalysesApi, 'get').mockImplementation(async (runId) => records.find((record) => record.analysisRunId === runId)!);
    return draft;
  }
  const initial = createVideoToolDraft('video.lip-sync', source);
  const draft: VideoToolDraftById['video.lip-sync'] = { ...initial,
    inputs: [{ inputId: audioId, url: 'https://assets.example.test/voice.m4a', mediaInfo: { duration: 3, mimeType: 'audio/mp4' } }],
    params: { ...initial.params, dialogues: [{ ...initial.params.dialogues[0], personId: 'person-a', analysisRunId, audioInputId: audioId, startTime: 0 }] } };
  commitVideoToolDraft(doc, nodeId, toolId, draft);
  const analysisInput = projectMiniToolAnalysisInput({ kind: 'people', source, params: draft.params, profile: { id: 'people', version: '1', weightsHash: null, params: {} } });
  const inputFingerprint = await fingerprintMiniToolAnalysisInput(analysisInput);
  const identity = { schemaVersion: 1 as const, draftId: draft.draftId, revision: draft.revision, analysisRunId, acceptedAt: '2026-11-06T00:00:00.000001Z',
    binding: { assetId: '70000000-0000-4000-8000-000000000001', contentHash: 'a'.repeat(64), canonicalURL: sourceURL, kind: 'video' as const, mediaInfo }, analysisInput, inputFingerprint };
  const record: MiniToolAnalysisRecord = { ...identity, kind: 'people', status: 'completed', artifactUnavailable: false, error: null, usage: [],
    result: { ...identity, kind: 'people', anchor: { frameIndex: 0 }, people: [{ personId: 'person-a', faceBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, artifactRefs: [] }] } };
  vi.spyOn(miniToolAnalysesApi, 'get').mockResolvedValue(record);
  commitVideoToolAnalysisRef(doc, nodeId, { version: 1, toolId: 'video.lip-sync', kind: 'people', draftId: draft.draftId, analysisRunId, inputFingerprint });
  return draft;
}

/**
 * Mounts the canvas's mini-tool panel container as `CanvasSpace` does, on an open video tool with a complete draft.
 * @param toolId - The video tool.
 * @param onRunVideo - The execution entry.
 * @param tracking - The erase tracking seeded: billed credits, or none at all.
 * @returns Nothing.
 */
async function mount(toolId: QuotedTool, onRunVideo: (...args: unknown[]) => Promise<unknown> = vi.fn(), tracking: { billed?: number; none?: boolean } = {}): Promise<void> {
  await seed(toolId, tracking);
  canvasSessions.of(spaceId).getState().openMiniTool(nodeId, toolId, { sourceContent: sourceURL, params: {} });
  const node: CanvasNodeView = { id: nodeId, type: 'video', position: { x: 0, y: 0 }, data: { handling: false, content: sourceURL, ...mediaInfo } };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(modelCatalogQuery().queryKey, CATALOG);
  render(<QueryClientProvider client={client}><TooltipProvider><CanvasContext.Provider value={{ projectId, spaceId, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlowProvider><MiniToolPanelContainer nodes={[node]} getLastWriteWasLocal={() => false} onRun={vi.fn()} onRunVideo={onRunVideo} videoPresentation={new Map([[nodeId, presentation]])} /></ReactFlowProvider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
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
  it.each(['video.remove-bg', 'video.lip-sync', 'video.erase', 'video.expand'] as const)('%s shows exactly the quoted credits for the planned request of its draft', async (toolId) => {
    http.post.mockImplementation(async (path: string, body: { tool: VideoToolId }): Promise<unknown> => {
      if (path !== '/mini-tools/quote') throw new Error(`Unexpected POST ${path}`);
      return { credits: QUOTES[body.tool as QuotedTool] };
    });
    await mount(toolId);
    await waitFor(() => expect(footer()).toBe(formatCreditAmount(QUOTES[toolId])));
    const body = quoteBodies().at(-1)!;
    expect(miniToolPlannedRequestSchema.safeParse(body).success).toBe(true);
    const reading = readVideoToolDraft(getDoc(docName.canvasSpace(projectId, spaceId)), nodeId, toolId);
    expect(body).toMatchObject({ tool: toolId, project_id: projectId, space_id: spaceId, presentation_ref: PRESENTATION_REF, draft: reading.state === 'supported' ? reading.draft : null });
    const outputs = body.outputs as { outputIndex: number; nodeId: string; recipe: unknown }[];
    expect(outputs).toEqual([{ outputIndex: 0, nodeId: expect.any(String) as string, recipe: { kind: RECIPES[toolId] } }]);
    expect(outputs[0].nodeId).not.toBe(nodeId);
    // A quote puts nothing on the canvas.
    expect(readNodes(getDoc(docName.canvasSpace(projectId, spaceId))).map((node) => node.id)).toEqual([nodeId]);
  });

  it('an erase quotes and runs on the tracking of its current selection only', async () => {
    http.post.mockImplementation(async (path: string): Promise<unknown> => {
      if (path !== '/mini-tools/quote') throw new Error(`Unexpected POST ${path}`);
      return { credits: QUOTES['video.erase'] };
    });
    const onRunVideo = vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined);
    await mount('video.erase', onRunVideo);
    await waitFor(() => expect(footer()).toBe(formatCreditAmount(QUOTES['video.erase'])));
    const refs = (quoteBodies().at(-1)!.analysis_refs as { analysisRunId: string }[]).map((reference) => reference.analysisRunId);
    expect(refs).toEqual([analysisRunId]);
    await act(async () => { screen.getByTestId('mini-tool-run').click(); });
    await waitFor(() => expect(onRunVideo).toHaveBeenCalledTimes(1));
    const plan = onRunVideo.mock.calls[0].at(4) as { analysisRefs: { analysisRunId: string }[]; outputNodeIds: string[] };
    expect(plan.analysisRefs.map((reference) => reference.analysisRunId)).toEqual([analysisRunId]);
    expect(plan.outputNodeIds).toEqual([(quoteBodies().at(-1)!.outputs as { nodeId: string }[])[0].nodeId]);
  });

  it.each(['video.remove-bg', 'video.lip-sync', 'video.erase', 'video.expand'] as const)('%s shows no number while the quote has not answered', async (toolId) => {
    http.post.mockImplementation(() => new Promise<never>(() => undefined));
    await mount(toolId);
    await waitFor(() => expect(quoteBodies()).toHaveLength(1));
    // Give any number the panel could compute on its own (the catalog prices every model) the time to appear.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(footer()).not.toMatch(/\d/);
  });
});

// Frames-split design §10.8 计费 row: extract-frames and split are charged for their container work like the other planned
// tools, so their footer shows the server's quote of the planned request, never "Free". A split names one output node per
// planned segment, so its quote names as many.
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
    const initial = createVideoToolDraft(toolId, source);
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

// Canvas design §4 erase row: beside "Track selection" the server's quote of the tracking the press would start, and once that
// tracking is billed, what it used in the same place (`POST /mini-tools/analyses/quote`; the record's `usage`).
describe('the erase tracking cost beside "Track selection" (canvas design §4 erase row)', () => {
  it('shows the quoted tracking credits for the request the press would send, before any tracking', async () => {
    http.post.mockImplementation(async (path: string): Promise<unknown> => {
      if (path === '/mini-tools/analyses/quote') return { credits: 8.5 };
      if (path === '/mini-tools/quote') return { credits: QUOTES['video.erase'] };
      throw new Error(`Unexpected POST ${path}`);
    });
    await mount('video.erase', vi.fn(), { none: true });
    await waitFor(() => expect(screen.getByText(`Est. ${formatCreditAmount(8.5)}`)).toBeTruthy());
    const body = http.post.mock.calls.find(([path]) => path === '/mini-tools/analyses/quote')![1] as Record<string, unknown>;
    expect(body).toMatchObject({ kind: 'tracked_mask', projectId, spaceId, hostNodeId: nodeId, presentationRef: PRESENTATION_REF,
      params: { range: { start: 0, end: 75 }, anchor: { frameIndex: 0 }, region: { box: { x: 0.3, y: 0.2, width: 0.3, height: 0.6 }, points: [] }, trackingPrompt: '' } });
  });

  it('shows what the current tracking used once it is billed, in place of the estimate', async () => {
    http.post.mockImplementation(async (path: string): Promise<unknown> => {
      if (path === '/mini-tools/analyses/quote') return { credits: 8.5 };
      if (path === '/mini-tools/quote') return { credits: QUOTES['video.erase'] };
      throw new Error(`Unexpected POST ${path}`);
    });
    await mount('video.erase', vi.fn(), { billed: 6.25 });
    await waitFor(() => expect(screen.getByText(`Used ${formatCreditAmount(6.25)}`)).toBeTruthy());
    expect(screen.queryByText(/^Est\. /)).toBeNull();
  });
});
