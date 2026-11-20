// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 the source player's camera menu reaches the canvas (tools design §4 camera menu; canvas design §27): a pick opens
 * Extract frames on that node, as the Tools submenu does, in the chosen mode.
 */

import type * as React from 'react';
import type * as CanvasModule from '@web/data/yjs/canvas-space';
import type * as StartModule from '@web/spaces/canvas/mini-tool/start-planned-video-run';
import type * as BindingModule from '@web/spaces/canvas/video-presentation/use-canvas-video-bindings';
import type * as MountModule from '@web/spaces/canvas/_shared/NodePanelMount';
import type * as VideoNodeModule from '@web/spaces/canvas/nodes/VideoNode';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizeModelCatalog, type VideoPresentationSourceBinding } from '@breatic/shared';
import type { VideoToolPresentation } from '@web/spaces/canvas/mini-tool/video/VideoToolPanelContainer';
import { CanvasSpace } from '@web/spaces/canvas/CanvasSpace';
import { useCanvasVideoBindings } from '@web/spaces/canvas/video-presentation/use-canvas-video-bindings';
import { startPlannedVideoRun } from '@web/spaces/canvas/mini-tool/start-planned-video-run';
import { addNode, readNodes, useCanvasSpace } from '@web/data/yjs/canvas-space';
import { commitVideoToolDraft, readVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
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
// The video node's player is replaced by a probe that presses its camera-menu pick through the real Canvas actions.
vi.mock('@web/spaces/canvas/nodes/VideoNode', async (original) => {
  const { useCanvasActions } = await import('@web/spaces/canvas/canvas-actions');
  return { ...(await original<typeof VideoNodeModule>()), VideoNode: () => {
    const actions = useCanvasActions();
    return actions.openFrameTool === undefined ? <div data-testid='no-camera' /> : <button type='button' data-testid='camera-last' onClick={() => actions.openFrameTool?.('30000000-0000-4000-8000-000000000003', 'last')} />;
  } };
});

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

describe('the camera menu opens Extract frames (tools design §4)', () => {
  it('opens Extract frames on the node in the chosen mode', () => {
    act(() => canvasSessions.of(SPACE).getState().closeActivePanel());
    mount();
    fireEvent.click(screen.getByTestId('camera-last'));
    const session = canvasSessions.of(SPACE).getState();
    expect(session.panelHostId).toBe(SOURCE);
    expect(session.miniTool?.toolId).toBe('video.extract-frames');
    const held = readVideoToolDraft(getDoc(docName.canvasSpace(PROJECT, SPACE)), SOURCE, 'video.extract-frames');
    expect(held.state === 'supported' && (held.draft as VideoToolDraftById['video.extract-frames']).params.mode).toBe('last');
  });

  it('offers no camera menu to a viewer', () => {
    mount(true);
    expect(screen.getByTestId('no-camera')).toBeInTheDocument();
  });
});
