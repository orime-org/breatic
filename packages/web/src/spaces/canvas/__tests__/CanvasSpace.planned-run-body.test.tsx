// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §97 D27-1 (D26-1 quote; canvas design §4 对口型 and 转场 rows): the quote and the Run send one body, made by
 * `buildPlannedVideoRequest`. The panel generates the output node id when it first quotes a draft and keeps it for the Run;
 * the node itself is created only on Run, by `preparePlannedVideoRun`. So, on the real Canvas:
 * - Run from the lip-sync panel, and Export from the transitions Dialog, reach `POST /mini-tools` (asserted at the request
 *   layer, `apiPost`) with a body equal to the last `POST /mini-tools/quote` body except `run_id`;
 * - exactly one output node is created, behind the tool's edge from the host, and its id is the id the quote named.
 *
 * Only the request layer, the video node's browser rendering boundary, the per-node presentation facts
 * (`useCanvasVideoBindings`) and, for transitions, the track editor and GL preview are replaced; `startPlannedVideoRun`,
 * `preparePlannedVideoRun`, the panels and the Dialog stay real. The lip-sync panel is opened while the node's presentation is
 * still loading and becomes ready afterwards, as a node opened right after load does, so the reopen re-detection defect
 * (covered in `MiniToolPanelContainer.lip-sync-limits.test.tsx`) does not stand in front of this question. For transitions the
 * presentation read of each clip input carries a ref, and the request's `presentation_ref` maps each clip input id to its
 * input's ref (D11-3).
 */

import type * as React from 'react';
import type * as CanvasModule from '@web/data/yjs/canvas-space';
import type * as BindingModule from '@web/spaces/canvas/video-presentation/use-canvas-video-bindings';
import type * as MountModule from '@web/spaces/canvas/_shared/NodePanelMount';
import type * as VideoNodeModule from '@web/spaces/canvas/nodes/VideoNode';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelCatalog } from '@breatic/shared';
import { fingerprintMiniToolAnalysisInput, miniToolPlannedRequestSchema, projectMiniToolAnalysisInput, type MiniToolAnalysisRecord, type VideoPlanGrid, type VideoToolDraftById } from '@breatic/shared/mini-tools';

const http = vi.hoisted(() => ({ posts: [] as [string, Record<string, unknown>][], limits: null as unknown }));
vi.mock('@web/data/api/request', async (importOriginal) => {
  const actual = await importOriginal<{ apiGet:(path: string, ...rest: unknown[]) => Promise<unknown>; apiPost: (path: string, ...rest: unknown[]) => Promise<unknown> }>();
  return {
    ...actual,
    apiGet: async (path: string, ...rest: unknown[]): Promise<unknown> => path === '/canvas/limits' ? structuredClone(http.limits) : actual.apiGet(path, ...rest),
    apiPost: async (path: string, body: Record<string, unknown>, ...rest: unknown[]): Promise<unknown> => {
      if (path === '/mini-tools/quote') { http.posts.push([path, structuredClone(body)]); return { credits: 42 }; }
      if (path === '/mini-tools') { http.posts.push([path, structuredClone(body)]); return { task_id: body.run_id, status: 'pending' }; }
      return actual.apiPost(path, body, ...rest);
    },
  };
});
vi.mock('@web/data/yjs/canvas-space', async (original) => ({ ...(await original<typeof CanvasModule>()), useCanvasSpace: vi.fn() }));
vi.mock('@web/spaces/canvas/video-presentation/use-canvas-video-bindings', async (original) => ({ ...(await original<typeof BindingModule>()), useCanvasVideoBindings: vi.fn() }));
vi.mock('@web/spaces/canvas/_shared/NodePanelMount', async (original) => ({ ...(await original<typeof MountModule>()), NodePanelMount: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@web/spaces/canvas/nodes/VideoNode', async (original) => ({ ...(await original<typeof VideoNodeModule>()), VideoNode: () => <div data-testid='video-renderer-boundary' /> }));
// The track editor and the GL preview are not under test; jsdom cannot draw either.
vi.mock('@xzdarcy/react-timeline-editor', async () => ({ Timeline: (await import('react')).forwardRef(() => null) }));
vi.mock('@web/spaces/canvas/mini-tool/video/VideoTimelinePreview', () => ({ VideoTimelinePreview: () => null }));

import { CanvasSpace } from '@web/spaces/canvas/CanvasSpace';
import { useCanvasVideoBindings } from '@web/spaces/canvas/video-presentation/use-canvas-video-bindings';
import { addNode, readEdges, readNodes, useCanvasSpace } from '@web/data/yjs/canvas-space';
import { commitVideoToolAnalysisRef, commitVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { SpaceConnectionContext } from '@web/data/yjs/space-connection';
import { canvasApi } from '@web/data/api/canvas';
import { modelsApi } from '@web/data/api/models';
import { miniToolAnalysesApi } from '@web/data/api/mini-tool-analyses';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { canvasSessions } from '@web/stores/canvas-session';
import { useCanvasStore } from '@web/stores/canvas';
import { useCurrentUserStore } from '@web/stores/current-user';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import { createVideoToolDraft } from '@web/spaces/canvas/mini-tool/video/video-tool-edit';
import { seedUsablePresentation } from '@web/test-utils/video-presentation';

const PROJECT = '32000000-0000-4000-8000-000000000001';
const SPACE = '32000000-0000-4000-8000-000000000002';
const HOST = '32000000-0000-4000-8000-000000000003';
const PICKED_NODE = '32000000-0000-4000-8000-000000000004';
const HOST_URL = 'https://assets.example.test/host.mp4';
const PICKED_URL = 'https://assets.example.test/picked.mp4';
const AUDIO = '42000000-0000-4000-8000-000000000001';
const PICKED_INPUT = '42000000-0000-4000-8000-000000000002';
const RUN = '82000000-0000-4000-8000-000000000001';
const MEDIA = { width: 960, height: 540, duration: 5, mimeType: 'video/mp4' };
// The selected version's grid: 125 frames at 25 fps, 5 s.
const GRID: VideoPlanGrid = { fps: { numerator: 25, denominator: 1 }, frameCount: 125 };
const ref = (letter: string): { toolInputId: string; planSha256: string } => ({ toolInputId: letter.repeat(64), planSha256: 'f'.repeat(64) });
const CATALOG = { image: [], video: [{ name: 'lipsync-configured-a', display_name: 'Configured A', modality: 'video', mode: 'talking_head', description: '', guide: '', tier: 'optional', generation_time: 600, takes_prompt: false, params: {}, providers: [] }], audio: [], tts: [], three_d: [], total: 1, credit_multiplier: 1 } as unknown as ModelCatalog;
const clients: QueryClient[] = [];

/**
 * Publishes the presentation facts of these nodes, as the node owners do.
 * @param status - Their presentation status.
 * @param nodes - Each node with its content and its selected tool input.
 * @returns Nothing.
 */
function present(status: 'loading' | 'ready', nodes: readonly { id: string; url: string; letter: string }[]): void {
  const facts: BindingModule.CanvasVideoBindings = {
    bindings: new Map(nodes.map(({ id, url }) => {
      const element = document.createElement('video');
      const binding = { sourceKey: `registered-${id}`, sourceEpoch: 1, element, surface: element, container: document.createElement('div'), original: { width: MEDIA.width, height: MEDIA.height, duration: MEDIA.duration }, getSeekEpoch: () => 0, getPresentedFrame: () => null, seek: vi.fn(), play: vi.fn().mockResolvedValue(undefined), pause: vi.fn() };
      return [id, { binding, status: status === 'ready' ? 'ready' : 'loading', error: null, overlayTarget: null, sourceBinding: { assetId: '72000000-0000-4000-8000-000000000001', contentHash: 'a'.repeat(64), canonicalURL: url, kind: 'video', mediaInfo: MEDIA } }];
    })) as BindingModule.CanvasVideoBindings['bindings'],
    // The real hook publishes presentation facts for the panel host only (the first node); other inputs are read per input.
    presentations: new Map(nodes.slice(0, 1).map(({ id, url, letter }) => [id, { status, grid: status === 'ready' ? GRID : null, presentedTime: 0, sourceURL: url, sourceEpoch: 1, seekEpoch: 0, presentationRef: { source: ref(letter) } }])),
    onVideoBinding: vi.fn(), onVideoFrame: vi.fn(),
  };
  vi.mocked(useCanvasVideoBindings).mockReturnValue(facts);
}

/**
 * The real Canvas in its providers.
 * @returns The tree.
 */
function tree(): React.JSX.Element {
  const client = clients[0]!;
  return <QueryClientProvider client={client}><TooltipProvider><SpaceConnectionContext.Provider value={{ provider: null, synced: true, hasEverSynced: true, status: 'connected', writeAccess: 'granted', authFailedReason: null }}><CanvasSpace projectId={PROJECT} spaceId={SPACE} readOnly={false} myRole='editor' /></SpaceConnectionContext.Provider></TooltipProvider></QueryClientProvider>;
}

/**
 * Adds a video node with this content.
 * @param id - The node id.
 * @param url - Its content.
 * @param x - Its horizontal position.
 * @returns Nothing.
 */
function videoNode(id: string, url: string, x: number): void {
  addNode(PROJECT, SPACE, { id, type: 'video', position: { x, y: 40 }, data: { content: url, name: id === HOST ? 'HOST' : 'PICKED', mediaWidth: MEDIA.width, mediaHeight: MEDIA.height, duration: MEDIA.duration, mimeType: MEDIA.mimeType, locked: false, createdBy: 'author', createdAt: 0, attachments: [] } });
}

/**
 * Points the Canvas at the document's current nodes.
 * @returns Nothing.
 */
function syncNodes(): void {
  const doc = getDoc(docName.canvasSpace(PROJECT, SPACE));
  vi.mocked(useCanvasSpace).mockReturnValue({ nodes: readNodes(doc), edges: [], undo: vi.fn(), redo: vi.fn(), canUndo: false, canRedo: false, getLastWriteWasLocal: () => true, deletedByPeer: () => false });
}

/**
 * The posts the request layer received at this path, in order.
 * @param path - The path.
 * @returns Their bodies.
 */
function posted(path: string): Record<string, unknown>[] {
  return http.posts.filter(([at]) => at === path).map(([, body]) => body);
}

/**
 * Checks the run against the quote before it: the same body but `run_id`, and one new output node, behind the tool's edges
 * (a transitions result also from its picked node), carrying the quoted id.
 * @param tool - The tool.
 * @param before - The node ids before the press.
 * @returns Nothing.
 */
async function expectRunMatchesQuote(tool: 'video.lip-sync' | 'video.transitions', before: readonly string[]): Promise<void> {
  await waitFor(() => expect(posted('/mini-tools')).toHaveLength(1));
  const run = posted('/mini-tools')[0]!;
  const quote = posted('/mini-tools/quote').at(-1);
  expect(quote, 'a quote was requested before the run').toBeDefined();
  expect(miniToolPlannedRequestSchema.safeParse(run).success).toBe(true);
  expect(run.tool).toBe(tool);
  expect({ ...run, run_id: null }).toEqual({ ...quote, run_id: null });
  const outputId = (run.outputs as { nodeId: string }[])[0]!.nodeId;
  const doc = getDoc(docName.canvasSpace(PROJECT, SPACE));
  const added = readNodes(doc).map((node) => node.id).filter((id) => !before.includes(id));
  expect(added).toEqual([outputId]);
  // A transitions result is also linked from the picked input's node (canvas design §4 转场 row).
  const sources = tool === 'video.transitions' ? [HOST, PICKED_NODE] : [HOST];
  expect(readEdges(doc).filter((edge) => edge.target === outputId)).toEqual(sources.map((source) => expect.objectContaining({ source, toolId: tool })));
}

beforeEach(() => {
  vi.clearAllMocks();
  http.posts.length = 0;
  http.limits = {
    referencePoolCap: 10, nodeHistoryPageSize: 20, understandMaxBytes: 20_971_520, understandLongMediaMaxBytes: 2_147_483_648,
    waveformMaxSeconds: 600, waveformMaxBytes: 200_000_000, waveformPeaksRetryMs: 5000, waveformPeaksRetryMaxMs: 600_000,
    removeBackgroundModel: 'remove-bg-configured',
    lipSync: { models: [{ name: 'lipsync-configured-a', minDurationSeconds: 1, maxDurationSeconds: 300 }], tracking: { minDurationSeconds: 0.5, maxDurationSeconds: 600 }, maxPeople: 2, maxDialogues: 8 },
  };
  canvasApi.resetLimitsCache();
  useCanvasStore.getState().reset();
  canvasSessions.of(SPACE).getState().closeActivePanel();
  useCurrentUserStore.getState().setUser({ id: 'author', name: 'Author', email: 'author@example.test', personalStudio: null, membershipTier: 'base' });
  vi.spyOn(modelsApi, 'list').mockResolvedValue(CATALOG);
  clients.push(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
});
afterEach(() => { cleanup(); resetRunOnceForTests(); clients.splice(0).forEach((client) => client.clear()); canvasSessions.of(SPACE).getState().closeActivePanel(); destroyDoc(docName.canvasSpace(PROJECT, SPACE)); canvasApi.resetLimitsCache(); vi.restoreAllMocks(); });

describe('Run sends the quoted body and creates the quoted output node (§97 D27-1)', () => {
  it('from the lip-sync panel', async () => {
    const doc = getDoc(docName.canvasSpace(PROJECT, SPACE));
    videoNode(HOST, HOST_URL, 30);
    const source = { nodeId: HOST, canonicalURL: HOST_URL, mediaInfo: MEDIA };
    const initial = createVideoToolDraft('video.lip-sync', source);
    const draft: VideoToolDraftById['video.lip-sync'] = { ...initial,
      inputs: [{ inputId: AUDIO, url: 'https://assets.example.test/voice.m4a', mediaInfo: { duration: 3, mimeType: 'audio/mp4' } }],
      params: { ...initial.params, modelId: 'lipsync-configured-a', dialogues: [{ ...initial.params.dialogues[0]!, personId: 'person-a', analysisRunId: RUN, audioInputId: AUDIO, startTime: 0 }] } };
    commitVideoToolDraft(doc, HOST, 'video.lip-sync', draft);
    const profile = { id: 'people', version: '1', weightsHash: null, params: {} };
    const analysisInput = projectMiniToolAnalysisInput({ kind: 'people', source, params: draft.params, profile });
    const inputFingerprint = await fingerprintMiniToolAnalysisInput(analysisInput);
    const identity = { schemaVersion: 1 as const, draftId: draft.draftId, revision: draft.revision, analysisRunId: RUN, acceptedAt: '2026-11-06T00:00:00.000001Z',
      binding: { assetId: '72000000-0000-4000-8000-000000000001', contentHash: 'a'.repeat(64), canonicalURL: HOST_URL, kind: 'video' as const, mediaInfo: MEDIA }, analysisInput, inputFingerprint };
    const record: MiniToolAnalysisRecord = { ...identity, kind: 'people', status: 'completed', artifactUnavailable: false, error: null, usage: [],
      result: { ...identity, kind: 'people', anchor: { frameIndex: 0 }, people: [{ personId: 'person-a', faceBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, artifactRefs: [] }] } };
    vi.spyOn(miniToolAnalysesApi, 'get').mockResolvedValue(record);
    const started = vi.spyOn(miniToolAnalysesApi, 'start').mockImplementation(() => new Promise(() => undefined));
    commitVideoToolAnalysisRef(doc, HOST, { version: 1, toolId: 'video.lip-sync', kind: 'people', draftId: draft.draftId, analysisRunId: RUN, inputFingerprint });
    syncNodes();
    present('loading', [{ id: HOST, url: HOST_URL, letter: 'a' }]);
    act(() => canvasSessions.of(SPACE).getState().openMiniTool(HOST, 'video.lip-sync', { sourceContent: HOST_URL, params: {} }));
    const view = render(tree());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    present('ready', [{ id: HOST, url: HOST_URL, letter: 'a' }]);
    view.rerender(tree());
    await screen.findByText('Person 1');
    expect(started).not.toHaveBeenCalled();
    await waitFor(() => expect(posted('/mini-tools/quote').length).toBeGreaterThan(0));
    const before = readNodes(doc).map((node) => node.id);
    const run = screen.getByTestId('mini-tool-run');
    await waitFor(() => expect(run).not.toHaveAttribute('aria-disabled', 'true'));
    act(() => run.click());
    await expectRunMatchesQuote('video.lip-sync', before);
  });

  it('from the transitions Dialog', async () => {
    const doc = getDoc(docName.canvasSpace(PROJECT, SPACE));
    videoNode(HOST, HOST_URL, 30); videoNode(PICKED_NODE, PICKED_URL, 600);
    const initial = createVideoToolDraft('video.transitions', { nodeId: HOST, canonicalURL: HOST_URL, mediaInfo: MEDIA });
    const draft: VideoToolDraftById['video.transitions'] = { ...initial,
      inputs: [...initial.inputs, { inputId: PICKED_INPUT, url: PICKED_URL, mediaInfo: MEDIA, sourceNodeId: PICKED_NODE }],
      params: { clips: [...initial.params.clips, { clipId: '52000000-0000-4000-8000-000000000002', inputId: PICKED_INPUT, in: 0, out: 3, transition: { kind: 'cut', duration: 0 } }] } };
    commitVideoToolDraft(doc, HOST, 'video.transitions', draft);
    syncNodes();
    present('ready', [{ id: HOST, url: HOST_URL, letter: 'a' }, { id: PICKED_NODE, url: PICKED_URL, letter: 'b' }]);
    // Each clip input's selected version comes from that input's own presentation read, usable as Run needs it to be
    // (frames-split §7.12 last paragraph).
    for (const [url, letter] of [[HOST_URL, 'a'], [PICKED_URL, 'b']] as const) seedUsablePresentation(clients[0]!, PROJECT, url, ref(letter));
    act(() => canvasSessions.of(SPACE).getState().openMiniTool(HOST, 'video.transitions', { sourceContent: HOST_URL, params: {} }));
    render(tree());
    await waitFor(() => expect(posted('/mini-tools/quote').length).toBeGreaterThan(0));
    const quoted = posted('/mini-tools/quote').at(-1)!;
    const current = draft.inputs[0]!.inputId;
    expect(quoted.presentation_ref).toEqual({ [current]: ref('a'), [PICKED_INPUT]: ref('b') });
    act(() => screen.getByRole('button', { name: 'Edit timeline' }).click());
    const dialog = screen.getByTestId('video-timeline-dialog');
    const before = readNodes(doc).map((node) => node.id);
    const exported = within(dialog).getByRole('button', { name: 'Export' });
    await waitFor(() => expect(exported).not.toHaveAttribute('aria-disabled', 'true'));
    act(() => exported.click());
    await expectRunMatchesQuote('video.transitions', before);
  });
});
