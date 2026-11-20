// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import type * as React from 'react';
import type * as CanvasModule from '@web/data/yjs/canvas-space';
import type * as StartModule from '@web/spaces/canvas/mini-tool/start-planned-video-run';
import type * as BindingModule from '@web/spaces/canvas/video-presentation/use-canvas-video-bindings';
import type * as MountModule from '@web/spaces/canvas/_shared/NodePanelMount';
import type * as VideoNodeModule from '@web/spaces/canvas/nodes/VideoNode';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizeModelCatalog, type VideoPresentationSourceBinding } from '@breatic/shared';
import type { VideoToolPresentation } from '@web/spaces/canvas/mini-tool/video/VideoToolPanelContainer';
import { CanvasSpace } from '@web/spaces/canvas/CanvasSpace';
import { CanvasContext } from '@web/spaces/canvas/canvas-context';
import { VideoToolPanelContainer } from '@web/spaces/canvas/mini-tool/video/VideoToolPanelContainer';
import { useCanvasVideoBindings } from '@web/spaces/canvas/video-presentation/use-canvas-video-bindings';
import { startPlannedVideoRun } from '@web/spaces/canvas/mini-tool/start-planned-video-run';
import { addNode, nodeDataMap, readNodes, useCanvasSpace } from '@web/data/yjs/canvas-space';
import { commitVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { SpaceConnectionContext } from '@web/data/yjs/space-connection';
import { modelsApi } from '@web/data/api/models';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { miniToolAnalysesApi } from '@web/data/api/mini-tool-analyses';
import { canvasSessions } from '@web/stores/canvas-session';
import { useCanvasStore } from '@web/stores/canvas';
import { useCurrentUserStore } from '@web/stores/current-user';
import type { VideoToolDraftById, VideoPlanGrid } from '@breatic/shared/mini-tools';

vi.mock('@web/data/yjs/canvas-space', async (original) => ({ ...(await original<typeof CanvasModule>()), useCanvasSpace: vi.fn() }));
vi.mock('@web/spaces/canvas/mini-tool/start-planned-video-run', async (original) => ({ ...(await original<typeof StartModule>()), startPlannedVideoRun: vi.fn() }));
vi.mock('@web/spaces/canvas/video-presentation/use-canvas-video-bindings', async (original) => ({ ...(await original<typeof BindingModule>()), useCanvasVideoBindings: vi.fn() }));
// Only placement and decoding are outside this wiring test. The actual Canvas,
// MiniToolPanelContainer, VideoToolPanelContainer and Run button remain real.
vi.mock('@web/spaces/canvas/_shared/NodePanelMount', async (original) => ({ ...(await original<typeof MountModule>()), NodePanelMount: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@web/spaces/canvas/nodes/VideoNode', async (original) => ({ ...(await original<typeof VideoNodeModule>()), VideoNode: () => <div data-testid='video-renderer-boundary' /> }));

const PROJECT = '30000000-0000-4000-8000-000000000001';
const SPACE = '30000000-0000-4000-8000-000000000002';
const SOURCE = '30000000-0000-4000-8000-000000000003';
const URL = 'https://assets.example.test/canonical.webm';
// The selected version's grid: 7 frames at 25 fps, 0.28 s.
const GRID: VideoPlanGrid = { fps: { numerator: 25, denominator: 1 }, frameCount: 7 };
const DRAFT: VideoToolDraftById['video.remove-bg'] = { version: 1, draftId: '30000000-0000-4000-8000-000000000004', revision: '30000000-0000-4000-8000-000000000005', source: { nodeId: SOURCE, canonicalURL: URL, mediaInfo: { width: 400, height: 200, duration: 0.28, mimeType: 'video/webm' } }, inputs: [], params: {} };
const SOURCE_BINDING: VideoPresentationSourceBinding = { assetId: '30000000-0000-4000-8000-000000000007', contentHash: 'a'.repeat(64), canonicalURL: URL, kind: 'video', mediaInfo: DRAFT.source.mediaInfo };
const clients: QueryClient[] = [];

// §96 (design §10.8 request row, §7.12): the panel facts carry the selected bundle's presentationRef, which the run request
// sends as presentation_ref (fixture migrated, 4.4.5); without one the panel cannot run.
const PRESENTATION_REF = { source: { toolInputId: 'd'.repeat(64), planSha256: 'f'.repeat(64) } };

/** Supplies explicit presentation facts without running a browser decoder; a null presentationRef omits the field. @throws {never} Never. */
function presentation(grid: VideoPlanGrid | null, sourceURL = URL, status: VideoToolPresentation['status'] = 'ready',
  presentationRef: VideoToolPresentation['presentationRef'] | null = PRESENTATION_REF): BindingModule.CanvasVideoBindings {
  const element = document.createElement('video');
  const binding = { sourceKey: 'registered-source', sourceEpoch: 1, element, surface: element, container: document.createElement('div'), original: DRAFT.source.mediaInfo, getSeekEpoch: () => 0, getPresentedFrame: () => null, seek: vi.fn(), play: vi.fn().mockResolvedValue(undefined), pause: vi.fn() };
  const facts: BindingModule.CanvasVideoBindings = {
    bindings: new Map([[SOURCE, { binding, status, error: null, overlayTarget: null, sourceBinding: SOURCE_BINDING }]]),
    presentations: new Map([[SOURCE, { status, grid, presentedTime: null, sourceURL, sourceEpoch: 1, seekEpoch: 0, ...(presentationRef === null || presentationRef === undefined ? {} : { presentationRef }) }]]),
    onVideoBinding: vi.fn(), onVideoFrame: vi.fn(),
  };
  vi.mocked(useCanvasVideoBindings).mockReturnValue(facts);
  return facts;
}

/** Mounts the real Canvas and its real video panel using existing context owners. @throws {Error} When rendering fails. */
function mount(readOnly = false): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><TooltipProvider><SpaceConnectionContext.Provider value={{ provider: null, synced: true, hasEverSynced: true, status: 'connected', writeAccess: 'granted', authFailedReason: null }}><CanvasSpace projectId={PROJECT} spaceId={SPACE} readOnly={readOnly} myRole={readOnly ? 'viewer' : 'editor'} /></SpaceConnectionContext.Provider></TooltipProvider></QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  useCanvasStore.getState().reset();
  canvasSessions.of(SPACE).getState().closeActivePanel();
  useCurrentUserStore.getState().setUser({ id: 'author', name: 'Author', email: 'author@example.test', personalStudio: null, membershipTier: 'base' });
  vi.spyOn(modelsApi, 'list').mockResolvedValue(sanitizeModelCatalog({}));
  vi.spyOn(miniToolAnalysesApi, 'start');
  const doc = getDoc(docName.canvasSpace(PROJECT, SPACE));
  addNode(PROJECT, SPACE, { id: SOURCE, type: 'video', position: { x: 30, y: 40 }, data: { content: URL, name: 'ORIGINAL', mediaWidth: 400, mediaHeight: 200, duration: 0.28, mimeType: 'video/webm', locked: false, createdBy: 'author', createdAt: 0, attachments: [] } });
  commitVideoToolDraft(doc, SOURCE, 'video.remove-bg', structuredClone(DRAFT));
  vi.mocked(useCanvasSpace).mockReturnValue({ nodes: readNodes(doc), edges: [], undo: vi.fn(), redo: vi.fn(), canUndo: false, canRedo: false, getLastWriteWasLocal: () => true, deletedByPeer: () => false });
  vi.mocked(startPlannedVideoRun).mockResolvedValue({ kind: 'done', result: { task_id: '30000000-0000-4000-8000-000000000006', status: 'pending' } });
  presentation(GRID);
  act(() => canvasSessions.of(SPACE).getState().openMiniTool(SOURCE, 'video.remove-bg', { sourceContent: URL, params: {} }));
});
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()); canvasSessions.of(SPACE).getState().closeActivePanel(); destroyDoc(docName.canvasSpace(PROJECT, SPACE)); vi.restoreAllMocks(); });

describe('actual Canvas planned remove-bg callback wire', () => {
  it('F01/F05 forwards the real panel press to planned execution with its complete persisted draft and source capabilities', () => {
    mount();
    const button = screen.getByTestId('mini-tool-run');
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(startPlannedVideoRun).toHaveBeenCalledOnce();
    expect(startPlannedVideoRun).toHaveBeenCalledWith(expect.objectContaining({ projectId: PROJECT, spaceId: SPACE, userId: 'author', toolId: 'video.remove-bg', draft: DRAFT, analyses: [], presentationRef: PRESENTATION_REF, source: expect.objectContaining({ id: SOURCE, name: 'ORIGINAL', position: { x: 30, y: 40 }, groupOrigin: null }), sourceExists: expect.any(Function), canWrite: expect.any(Function), stillOpen: expect.any(Function), onBuilt: expect.any(Function) }));
    expect(nodeDataMap(getDoc(docName.canvasSpace(PROJECT, SPACE)), SOURCE)?.get('content')).toBe(URL);
    expect(miniToolAnalysesApi.start).not.toHaveBeenCalled();
  });

  // Frames-split §10.6 panel hookup: remove background waits for the selected version's grid like the other model tools.
  it('keeps remove-bg from running while no grid is usable, and runs it without sampling or analysis once it is', () => {
    presentation(null);
    mount();
    expect(screen.getByTestId('mini-tool-run')).toBeDisabled();
    fireEvent.click(screen.getByTestId('mini-tool-run'));
    expect(startPlannedVideoRun).not.toHaveBeenCalled();
    cleanup();
    presentation(GRID);
    mount();
    fireEvent.click(screen.getByTestId('mini-tool-run'));
    expect(startPlannedVideoRun).toHaveBeenCalledWith(expect.objectContaining({ toolId: 'video.remove-bg', draft: DRAFT, analyses: [] }));
    expect(miniToolAnalysesApi.start).not.toHaveBeenCalled();
  });

  it('F15 a source without a presentationRef cannot run: the press forwards nothing (§96; design §10.8, §7.12)', () => {
    const facts = presentation(GRID, URL, 'ready', null);
    expect(facts.presentations.get(SOURCE)).not.toHaveProperty('presentationRef');
    mount();
    fireEvent.click(screen.getByTestId('mini-tool-run'));
    expect(startPlannedVideoRun).not.toHaveBeenCalled();
  });

  it('F02 keeps a viewer unable to start the real planned callback', () => {
    mount(true);
    expect(screen.getByTestId('mini-tool-run')).toBeDisabled();
    fireEvent.click(screen.getByTestId('mini-tool-run'));
    expect(startPlannedVideoRun).not.toHaveBeenCalled();
  });

  it('F02 rereads an own-lock written after rendering before forwarding a press', () => {
    mount();
    const button = screen.getByTestId('mini-tool-run');
    expect(button).not.toBeDisabled();
    act(() => nodeDataMap(getDoc(docName.canvasSpace(PROJECT, SPACE)), SOURCE)?.set('locked', true));
    fireEvent.click(button);
    expect(startPlannedVideoRun).not.toHaveBeenCalled();
  });

  it('F02 does not forward a source whose runtime belongs to another canonical URL', () => {
    presentation(GRID, 'https://assets.example.test/another.webm');
    mount();
    expect(screen.getByTestId('mini-tool-run')).toBeDisabled();
    fireEvent.click(screen.getByTestId('mini-tool-run'));
    expect(startPlannedVideoRun).not.toHaveBeenCalled();
  });

  it.each(['loading', 'failed', 'absent'] as const)('G03 retains the source-not-ready gate when presentation is %s', (status) => {
    if (status === 'absent') vi.mocked(useCanvasVideoBindings).mockReturnValue({ bindings: new Map(), presentations: new Map(), onVideoBinding: vi.fn(), onVideoFrame: vi.fn() });
    else presentation(null, URL, status);
    mount();
    expect(screen.getByTestId('mini-tool-run')).toBeDisabled();
    fireEvent.click(screen.getByTestId('mini-tool-run'));
    expect(startPlannedVideoRun).not.toHaveBeenCalled();
    expect(miniToolAnalysesApi.start).not.toHaveBeenCalled();
  });

  it('G01/G02 executes the real Container with an explicit callback once the grid is usable', () => {
    const facts = presentation(GRID);
    const nodes = readNodes(getDoc(docName.canvasSpace(PROJECT, SPACE)));
    const node = nodes.find((candidate) => candidate.id === SOURCE);
    if (node === undefined) throw new Error('Expected the attached source node');
    const callback = vi.fn().mockResolvedValue(undefined);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    render(<QueryClientProvider client={client}><TooltipProvider><CanvasContext.Provider value={{ projectId: PROJECT, spaceId: SPACE, readOnly: false, myRole: 'editor', caretProvider: null }}><ReactFlowProvider>
      <VideoToolPanelContainer nodeId={SOURCE} toolId='video.remove-bg' node={node} nodes={nodes} presentation={facts.presentations.get(SOURCE)} binding={facts.bindings.get(SOURCE)?.binding} sourceBinding={SOURCE_BINDING} onRunVideo={callback} />
    </ReactFlowProvider></CanvasContext.Provider></TooltipProvider></QueryClientProvider>);
    expect(screen.getByTestId('mini-tool-run')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('mini-tool-run'));
    expect(callback).toHaveBeenCalledExactlyOnceWith(SOURCE, 'video.remove-bg', DRAFT, []);
    expect(miniToolAnalysesApi.start).not.toHaveBeenCalled();
  });
});
