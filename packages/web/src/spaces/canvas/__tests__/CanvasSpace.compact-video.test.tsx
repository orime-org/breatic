// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizeModelCatalog, t, type VideoPresentationResponse } from '@breatic/shared';
import type * as CanvasModule from '@web/data/yjs/canvas-space';
import type * as StartModule from '@web/spaces/canvas/mini-tool/start-planned-video-run';
import type { VideoToolId } from '@breatic/shared/mini-tools';
import { CanvasSpace } from '../CanvasSpace';
import { useCanvasActions } from '../canvas-actions';
import { addNode, readNodes, useCanvasSpace } from '@web/data/yjs/canvas-space';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { SpaceConnectionContext } from '@web/data/yjs/space-connection';
import { modelsApi } from '@web/data/api/models';
import { miniToolAnalysesApi } from '@web/data/api/mini-tool-analyses';
import { commitVideoToolDraft, readVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import * as request from '@web/data/api/request';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { canvasSessions } from '@web/stores/canvas-session';
import { useCanvasStore } from '@web/stores/canvas';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import { useCurrentUserStore } from '@web/stores/current-user';
import { videoPresentationQuery } from '../video-presentation/video-presentation-query';
import { PRESENTED, presentedBinding, presentedBundle, presentedResponse, readyLedger } from '@web/test-utils/video-presentation';

const PRESENTATION_REF = { source: { toolInputId: PRESENTED.toolInputId, planSha256: PRESENTED.planSha256 } };

// §96 (design §3.3 runtimeSourceKey = JSON([canonicalURL, sourceFingerprint, versionId]), §7.12 step 3): the page stub
// reports the version it shows in its runtime source key; a test may show another version and report again.
const page = vi.hoisted(() => ({ shown: 'e'.repeat(64), renotify: null as (() => void) | null }));
vi.mock('@web/data/yjs/canvas-space', async (original) => ({ ...(await original<typeof CanvasModule>()), useCanvasSpace: vi.fn() }));
vi.mock('@web/spaces/canvas/mini-tool/start-planned-video-run', async (original) => ({ ...(await original<typeof StartModule>()), startPlannedVideoRun: vi.fn() }));
vi.mock('@web/spaces/canvas/_shared/NodePanelMount', () => ({ NodePanelMount: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
// Only the node's browser rendering boundary is replaced. CanvasSpace,
// useCanvasVideoBindings, sourceLedgerQuery, all panels and Buttons remain real.
vi.mock('@web/spaces/canvas/nodes/VideoNode', () => ({
  VideoNode: function RendererBoundary({ data }: { data: { content: string } }): React.JSX.Element {
    const actions = useCanvasActions();
    const notify = actions.onVideoBinding;
    React.useEffect(() => {
      const send = (): void => {
        const element = document.createElement('video');
        const binding = { sourceKey: JSON.stringify([data.content, HASH, page.shown]), sourceEpoch: 1, element, surface: element, container: document.createElement('div'), original: { width: 400, height: 200, duration: 4 }, getSeekEpoch: () => 0, getPresentedFrame: () => ({ sourceKey: JSON.stringify([data.content, HASH, page.shown]), sourceEpoch: 1, seekEpoch: 0, mediaTime: 2.62, surface: element }), seek: vi.fn(), play: async () => undefined, pause: () => undefined };
        notify?.(SOURCE, data.content, { binding, status: 'ready', error: null, overlayTarget: null, sourceBinding: sourceResponse().sourceBinding });
      };
      send();
      page.renotify = send;
      return () => notify?.(SOURCE, data.content, { binding: null, status: 'detached', error: null, overlayTarget: null });
    }, [notify, data.content]);
    return <div data-testid='renderer-boundary' />;
  },
}));

const PROJECT = '30000000-0000-4000-8000-000000000001';
const SPACE = '30000000-0000-4000-8000-000000000002';
const SOURCE = '30000000-0000-4000-8000-000000000003';
const URL = 'https://assets.example.test/source.webm';
const HASH = 'a'.repeat(64);
const table = { schemaVersion: 1, timescale: 1000, runs: [{ start: 2000, count: 4, step: 250, duration: 250 }] };
// §95: the compact object is the four fields around the S1 table, bound to the selected bundle's toolInputId (4.4.5).
const tableBytes = new TextEncoder().encode(JSON.stringify({ sourceFingerprint: 'a'.repeat(64), toolInputId: PRESENTED.toolInputId, planSha256: PRESENTED.planSha256, presentation: table }));
const tableURL = `${URL}.table.json`;
const attempt = { jobId: 'ledger-job', deadlineAt: 1900000000000 };
let sha256 = '';
let client: QueryClient;
const fetchMock = vi.fn<typeof fetch>();

/** Supplies immutable, bound v2 source facts. @throws {never} Never. */
function sourceResponse(ledger?: unknown): VideoPresentationResponse {
  // §95: the read carries the selected bundle and its ledger (fixtures migrated from `state: 'native'` and `sourceLedger`, 4.4.5).
  const bundle = presentedBundle(URL, { sourceFingerprint: HASH, display: { width: 400, height: 200, duration: { numerator: '4', denominator: '1' } } });
  const ready = readyLedger(bundle, 4);
  const receipt = ready.state === 'ready' ? { ...ready.receipt, attempt, table: { ...ready.receipt.table, url: tableURL, size: tableBytes.length, sha256 } } : null;
  return presentedResponse(presentedBinding(URL, { width: 400, height: 200, duration: 4, mimeType: 'video/webm' }, HASH),
    { presentation: bundle, ledger: (ledger ?? { state: 'ready', receipt, failure: null }) as VideoPresentationResponse['ledger'], sourceLedgerReadLimits: { maxBytes: 16777216 } });
}
/** Publishes a new authoritative response in the actual account query cache. @throws {never} Never. */
function publish(response: VideoPresentationResponse): void {
  client.setQueryData(videoPresentationQuery({ projectId: PROJECT, canonicalURL: URL, active: true }).queryKey, response);
}
/** Mounts the real Canvas and opens the real chosen video tool. @throws {Error} When the Canvas cannot render. */
function mount(toolId: VideoToolId = 'video.split'): void {
  act(() => canvasSessions.of(SPACE).getState().openMiniTool(SOURCE, toolId, { sourceContent: URL, params: {} }));
  render(<QueryClientProvider client={client}><TooltipProvider><SpaceConnectionContext.Provider value={{ provider: null, synced: true, hasEverSynced: true, status: 'connected', writeAccess: 'granted', authFailedReason: null }}><CanvasSpace projectId={PROJECT} spaceId={SPACE} readOnly={false} myRole='editor' /></SpaceConnectionContext.Provider></TooltipProvider></QueryClientProvider>);
}
/** A transient or content failure of this exact source. @throws {never} Never. */
function failure(errorCode: string): VideoPresentationResponse {
  return sourceResponse({ state: 'failed', receipt: null, failure: errorCode });
}

beforeEach(async () => {
  page.shown = PRESENTED.versionId; page.renotify = null;
  vi.clearAllMocks(); useCanvasStore.getState().reset(); canvasSessions.of(SPACE).getState().closeActivePanel();
  useCurrentUserStore.getState().setUser({ id: 'author', name: 'Author', email: 'author@example.test', personalStudio: null, membershipTier: 'base' });
  vi.spyOn(modelsApi, 'list').mockResolvedValue(sanitizeModelCatalog({}));
  vi.spyOn(miniToolAnalysesApi, 'start').mockImplementation(() => new Promise(() => undefined));
  const doc = getDoc(docName.canvasSpace(PROJECT, SPACE));
  addNode(PROJECT, SPACE, { id: SOURCE, type: 'video', position: { x: 30, y: 40 }, data: { content: URL, name: 'SOURCE', mediaWidth: 400, mediaHeight: 200, duration: 4, mimeType: 'video/webm', locked: false, createdBy: 'author', createdAt: 0, attachments: [] } });
  vi.mocked(useCanvasSpace).mockReturnValue({ nodes: readNodes(doc), edges: [], undo: vi.fn(), redo: vi.fn(), canUndo: false, canRedo: false, getLastWriteWasLocal: () => true, deletedByPeer: () => false });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const digest = await crypto.subtle.digest('SHA-256', tableBytes);
  sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  publish(sourceResponse()); fetchMock.mockReset().mockImplementation(async () => new Response(tableBytes, { headers: { 'content-type': 'application/json' } })); vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); resetRunOnceForTests(); client.clear(); canvasSessions.of(SPACE).getState().closeActivePanel(); destroyDoc(docName.canvasSpace(PROJECT, SPACE)); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('S4 actual Canvas → bindings → tools compact table wire', () => {
  it('C01 enables split only after the compact table is validated through the real Canvas wire', async () => {
    mount(); await waitFor(() => expect(screen.getByTestId('mini-tool-run')).not.toBeDisabled());
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(fetchMock.mock.calls[0]?.[0]).toBe(tableURL);
    // Nonzero origin belongs to the table, not the nullable registry duration.
    expect(screen.getByText(/1.*(?:segment|clip)/i)).toBeInTheDocument();
  });
  it.each(['video.extract-frames', 'video.split', 'video.expand', 'video.erase', 'video.lip-sync', 'video.transitions'] as const)('C02 %s waits for a pending table', async (tool) => {
    mount(); await waitFor(() => expect(screen.getByTestId('mini-tool-run')).not.toBeDisabled());
    act(() => {
      publish(sourceResponse({ state: 'pending', receipt: null, failure: null }));
      canvasSessions.of(SPACE).getState().openMiniTool(SOURCE, tool, { sourceContent: URL, params: {} });
    });
    await waitFor(() => expect(screen.getByTestId('mini-tool-run')).toBeDisabled());
    expect(screen.getAllByText('Reading video frames…')[0]).toBeInTheDocument();
  });
  // Frames-split §10.6 panel hookup: remove background and the other model tools wait for the frame table too.
  it('C03 remove-background waits for a pending table like the other tools', async () => {
    publish(sourceResponse({ state: 'pending', receipt: null, failure: null })); mount('video.remove-bg');
    await waitFor(() => expect(screen.getByTestId('mini-tool-run')).toBeDisabled());
    expect(screen.getAllByText('Reading video frames…')[0]).toBeInTheDocument();
  });
  it.each(['expired', 'source_ledger_invalid'])('C04 %s shows real retry; Button remains loading through authoritative refresh', async (code) => {
    publish(failure(code));
    let finish!: (value: unknown) => void;
    const post = vi.spyOn(request, 'apiPost').mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    let finishRead!: (value: unknown) => void;
    const get = vi.spyOn(request, 'apiGet').mockImplementation(() => new Promise((resolve) => { finishRead = resolve; }));
    mount(); const retry = await screen.findByRole('button', { name: /retry/i }); fireEvent.click(retry);
    await waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(post.mock.calls[0]?.[0]).toBe(`/projects/${PROJECT}/assets/video-presentation/repair`);
    expect(post.mock.calls[0]?.[1]).toEqual({ canonicalURL: URL, sourceFingerprint: HASH });
    fireEvent.click(retry);
    expect(post).toHaveBeenCalledOnce();
    expect(retry).toHaveAttribute('aria-busy', 'true');
    expect(retry).toHaveAttribute('aria-disabled', 'true');
    await act(async () => finish(sourceResponse({ state: 'pending', receipt: null, failure: null })));
    expect(screen.getByTestId('mini-tool-run')).toBeDisabled();
    expect(retry).toHaveAttribute('aria-busy', 'true');
    expect(retry).toHaveAttribute('aria-disabled', 'true');
    expect(get).toHaveBeenCalled();
    await act(async () => finishRead(sourceResponse()));
    await waitFor(() => expect(screen.getByTestId('mini-tool-run')).not.toBeDisabled());
  });
  it('C05 content failure shows its reason without a retry (after valid-source control)', async () => {
    mount(); await waitFor(() => expect(screen.getByTestId('mini-tool-run')).not.toBeDisabled());
    act(() => publish(failure('no_presented_frames')));
    await waitFor(() => expect(screen.getByTestId('mini-tool-run')).toBeDisabled());
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    expect(screen.getByText(/unsupported|no.*frames/i)).toBeInTheDocument();
  });
  it('C07 cut stepping and split planning use the exact table supplied through Canvas', async () => {
    mount(); await waitFor(() => expect(screen.getByTestId('mini-tool-run')).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /at cursor/i }));
    fireEvent.keyDown(screen.getByTestId('video-cut-handle-0'), { key: 'ArrowRight' });
    const reading = readVideoToolDraft(getDoc(docName.canvasSpace(PROJECT, SPACE)), SOURCE, 'video.split');
    expect(reading.state).toBe('supported');
    if (reading.state !== 'supported') throw new Error('Expected the persisted split draft');
    expect(reading.draft.params).toEqual({ cuts: [2.75] });
    expect(screen.getByTestId('video-cut-count')).toHaveTextContent('1 cut point · 2 segments');
  });
  it('C08 the lip-sync anchor is the current compact-table frame, not registry FPS', async () => {
    const start = vi.spyOn(miniToolAnalysesApi, 'start').mockImplementation(() => new Promise(() => undefined));
    mount('video.lip-sync');
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    // §95 D9-4 (design §7.11 analysis admission): every analysis request names the selected bundle's tool input.
    expect(start.mock.calls[0]?.[0]).toMatchObject({ kind: 'people', params: { anchor: { frameIndex: 2, pts: 2.5 } }, presentationRef: PRESENTATION_REF });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(tableURL);
  });
  // §96 (design §7.12 step 3, §7.8, §3.3): while the page still shows the earlier version the panel waits for the
  // presentation, even with the new version's table ready; it moves on only once the page reports the new version.
  it('C12 the panel waits while the page shows another version, and becomes usable once the page shows the selected one', async () => {
    page.shown = 'b'.repeat(64);
    mount();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(screen.getByTestId('mini-tool-run')).toBeDisabled();
    page.shown = PRESENTED.versionId;
    act(() => page.renotify?.());
    await waitFor(() => expect(screen.getByTestId('mini-tool-run')).not.toBeDisabled());
  });
  it('C10 scene detection requests the analysis against the selected bundle\'s tool input (§95 D9-4)', async () => {
    const start = vi.spyOn(miniToolAnalysesApi, 'start').mockImplementation(() => new Promise(() => undefined));
    mount('video.split');
    const detect = await screen.findByTestId('video-detect-scenes');
    await waitFor(() => expect(detect).not.toBeDisabled());
    fireEvent.click(detect);
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(start.mock.calls[0]?.[0]).toMatchObject({ kind: 'scene_cuts', presentationRef: PRESENTATION_REF });
  });
  it('C11 object tracking requests the analysis against the selected bundle\'s tool input (§95 D9-4)', async () => {
    const start = vi.spyOn(miniToolAnalysesApi, 'start').mockImplementation(() => new Promise(() => undefined));
    mount('video.erase');
    const doc = getDoc(docName.canvasSpace(PROJECT, SPACE));
    await waitFor(() => expect(readVideoToolDraft(doc, SOURCE, 'video.erase').state).toBe('supported'));
    const held = readVideoToolDraft(doc, SOURCE, 'video.erase');
    if (held.state !== 'supported') throw new Error('Expected the persisted erase draft');
    act(() => { commitVideoToolDraft(doc, SOURCE, 'video.erase', { ...held.draft, params: { ...held.draft.params, region: { box: null, points: [{ x: 0.5, y: 0.5, label: 'positive' }] } } }); });
    const track = await screen.findByRole('button', { name: t('canvas.miniTool.videoUI.trackObject') });
    await waitFor(() => expect(track).not.toBeDisabled());
    fireEvent.click(track);
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(start.mock.calls[0]?.[0]).toMatchObject({ kind: 'tracked_mask', presentationRef: PRESENTATION_REF });
  });
  it('C09 compact read validation errors offer retry without exposing the previous table', async () => {
    mount(); await waitFor(() => expect(screen.getByTestId('mini-tool-run')).not.toBeDisabled());
    const next = sourceResponse();
    if (next.ledger?.state !== 'ready') throw new Error('Expected a ready fixture');
    next.ledger.receipt.table.sha256 = 'd'.repeat(64);
    act(() => publish(next));
    await waitFor(() => expect(screen.getByTestId('mini-tool-run')).toBeDisabled());
    expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
  it('C06 accepted retry completes even after the panel closes', async () => {
    publish(failure('expired')); let finish!: (value: unknown) => void;
    const post = vi.spyOn(request, 'apiPost').mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    vi.spyOn(request, 'apiGet').mockResolvedValue(sourceResponse());
    mount(); fireEvent.click(await screen.findByRole('button', { name: /retry/i }));
    await waitFor(() => expect(post).toHaveBeenCalledOnce());
    act(() => canvasSessions.of(SPACE).getState().closeActivePanel());
    expect(screen.queryByTestId('mini-tool-run')).not.toBeInTheDocument();
    await act(async () => finish(sourceResponse()));
    expect(post.mock.calls[0]?.[2]).not.toMatchObject({ signal: expect.any(AbortSignal) });
    await waitFor(() => expect(client.getQueryData(videoPresentationQuery({ projectId: PROJECT, canonicalURL: URL, active: true }).queryKey)).toMatchObject({ ledger: { state: 'ready' } }));
  });
});
