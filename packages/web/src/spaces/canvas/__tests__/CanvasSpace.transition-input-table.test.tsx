// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §97 (D10-3, D13-1; canvas design §4 转场行, frames-split §7.17): each transition clip's frame rate
 * comes from that clip's own selected compact table, which comes from the binding of the node the input's `sourceNodeId`
 * names. Today `CanvasSpace` resolves the presentation and compact table of the panel host only and
 * `useCanvasVideoBindings` publishes the host only, so the picked input's node never reaches the panel.
 *
 * Level: `CanvasSpace`, where the per-node presentation reads and compact-table reads are made and handed through
 * `useCanvasVideoBindings` → `MiniToolPanelContainer` → `VideoToolPanelContainer` → `VideoTimelineDialog`. Only the
 * video node's browser rendering boundary and the Dialog (captured, not drawn) are replaced; the bindings hook, the
 * presentation and table queries and the panels stay real. The Dialog prop `inputTables` (input id → compact table)
 * is the shape the coordinator fixed.
 */

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizeModelCatalog, type VideoPresentationResponse } from '@breatic/shared';
import type { VideoPresentationTable, VideoToolDraftById } from '@breatic/shared/mini-tools';
import { CanvasSpace } from '../CanvasSpace';
import { useCanvasActions } from '../canvas-actions';
import { addNode, readNodes, useCanvasSpace } from '@web/data/yjs/canvas-space';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { SpaceConnectionContext } from '@web/data/yjs/space-connection';
import { modelsApi } from '@web/data/api/models';
import { commitVideoToolDraft, readVideoToolDraft } from '@web/data/yjs/video-tool-drafts';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { canvasSessions } from '@web/stores/canvas-session';
import { useCanvasStore } from '@web/stores/canvas';
import { resetRunOnceForTests } from '@web/stores/task-actions-in-flight';
import { useCurrentUserStore } from '@web/stores/current-user';
import { createVideoToolDraft } from '../mini-tool/video/video-tool-edit';
import { videoPresentationQuery } from '../video-presentation/video-presentation-query';
import { PRESENTED, presentedBinding, presentedBundle, presentedResponse, readyLedger } from '@web/test-utils/video-presentation';

const dialog = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock('@web/data/yjs/canvas-space', async (original) => ({ ...(await original<Record<string, unknown>>()), useCanvasSpace: vi.fn() }));
vi.mock('@web/spaces/canvas/_shared/NodePanelMount', () => ({ NodePanelMount: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
// The Dialog is captured: what reaches it is the question, not how it draws.
vi.mock('@web/spaces/canvas/mini-tool/video/VideoTimelineDialog', () => ({
  VideoTimelineDialog: (props: Record<string, unknown>): null => { dialog.props = props; return null; },
}));
// Each video node's browser rendering boundary reports its own ready binding, as the real node does.
vi.mock('@web/spaces/canvas/nodes/VideoNode', () => ({
  VideoNode: function RendererBoundary({ id, data }: { id: string; data: { content: string } }): React.JSX.Element {
    const notify = useCanvasActions().onVideoBinding;
    React.useEffect(() => {
      const element = document.createElement('video');
      const sourceKey = JSON.stringify([data.content, PRESENTED.fingerprint, PRESENTED.versionId]);
      const binding = { sourceKey, sourceEpoch: 1, element, surface: element, container: document.createElement('div'), original: { width: 400, height: 200, duration: 4 }, getSeekEpoch: () => 0, getPresentedFrame: () => ({ sourceKey, sourceEpoch: 1, seekEpoch: 0, mediaTime: 0, surface: element }), seek: vi.fn(), play: async () => undefined, pause: () => undefined };
      notify?.(id, data.content, { binding, status: 'ready', error: null, overlayTarget: null, sourceBinding: presentedBinding(data.content, { width: 400, height: 200, duration: 4, mimeType: 'video/webm' }) });
      return () => notify?.(id, data.content, { binding: null, status: 'detached', error: null, overlayTarget: null });
    }, [notify, id, data.content]);
    return <div data-testid={`renderer-${id}`} />;
  },
}));

const PROJECT = '30000000-0000-4000-8000-000000000001';
const SPACE = '30000000-0000-4000-8000-000000000002';
const HOST = '30000000-0000-4000-8000-000000000003';
const PICKED = '30000000-0000-4000-8000-000000000004';
const HOST_URL = 'https://assets.example.test/host.webm';
const PICKED_URL = 'https://assets.example.test/picked.webm';
// The host's selected table runs at 30000/1001 fps and the picked node's at 25 fps, so neither stands in for the other.
const TABLES: Readonly<Record<string, VideoPresentationTable>> = {
  [HOST_URL]: { schemaVersion: 1, timescale: 30000, runs: [{ start: 0, count: 4, step: 1001, duration: 1001 }] },
  [PICKED_URL]: { schemaVersion: 1, timescale: 25, runs: [{ start: 0, count: 4, step: 1, duration: 1 }] },
};
const PICKED_INPUT = '60000000-0000-4000-8000-000000000002';
let client: QueryClient;
const bytes = new Map<string, Uint8Array>();
const digests = new Map<string, string>();
const fetchMock = vi.fn<typeof fetch>();

/**
 * The compact object a source's ledger receipt points at, bound to the selected bundle's tool input.
 * @param url - The source URL.
 * @returns Its bytes.
 */
function tableBytes(url: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ sourceFingerprint: PRESENTED.fingerprint, toolInputId: PRESENTED.toolInputId, planSha256: PRESENTED.planSha256, presentation: TABLES[url] }));
}

/**
 * A ready presentation read for one source whose ledger receipt points at its compact table.
 * @param url - The source URL.
 * @returns The response.
 */
function sourceResponse(url: string): VideoPresentationResponse {
  const bundle = presentedBundle(url, { display: { width: 400, height: 200, duration: { numerator: '4', denominator: '1' } } });
  const ready = readyLedger(bundle, 4);
  const content = bytes.get(url)!;
  const receipt = ready.state === 'ready' ? { ...ready.receipt, table: { ...ready.receipt.table, url: `${url}.table.json`, size: content.length, sha256: digests.get(url)! } } : null;
  return presentedResponse(presentedBinding(url, { width: 400, height: 200, duration: 4, mimeType: 'video/webm' }), { presentation: bundle, ledger: { state: 'ready', receipt, failure: null } as VideoPresentationResponse['ledger'], sourceLedgerReadLimits: { maxBytes: 16777216 } });
}

/**
 * Adds a video node with this content.
 * @param id - The node id.
 * @param url - Its content.
 * @param x - Its horizontal position.
 * @returns Nothing.
 */
function videoNode(id: string, url: string, x: number): void {
  addNode(PROJECT, SPACE, { id, type: 'video', position: { x, y: 40 }, data: { content: url, name: id === HOST ? 'HOST' : 'PICKED', mediaWidth: 400, mediaHeight: 200, duration: 4, mimeType: 'video/webm', locked: false, createdBy: 'author', createdAt: 0, attachments: [] } });
}

beforeEach(async () => {
  vi.clearAllMocks(); dialog.props = null; useCanvasStore.getState().reset(); canvasSessions.of(SPACE).getState().closeActivePanel();
  useCurrentUserStore.getState().setUser({ id: 'author', name: 'Author', email: 'author@example.test', personalStudio: null, membershipTier: 'base' });
  vi.spyOn(modelsApi, 'list').mockResolvedValue(sanitizeModelCatalog({}));
  for (const url of [HOST_URL, PICKED_URL]) {
    const content = tableBytes(url);
    bytes.set(url, content);
    const digest = await crypto.subtle.digest('SHA-256', content);
    digests.set(url, Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''));
  }
  const doc = getDoc(docName.canvasSpace(PROJECT, SPACE));
  videoNode(HOST, HOST_URL, 30); videoNode(PICKED, PICKED_URL, 600);
  // The two-clip timeline: the host's video first, the picked node's video second (canvas design §4 转场).
  const initial = createVideoToolDraft('video.transitions', { nodeId: HOST, canonicalURL: HOST_URL, mediaInfo: { width: 400, height: 200, duration: 4, mimeType: 'video/webm' } });
  const draft: VideoToolDraftById['video.transitions'] = { ...initial,
    inputs: [...initial.inputs, { inputId: PICKED_INPUT, url: PICKED_URL, mediaInfo: { width: 400, height: 200, duration: 4, mimeType: 'video/webm' }, sourceNodeId: PICKED }],
    params: { clips: [...initial.params.clips, { clipId: '50000000-0000-4000-8000-000000000002', inputId: PICKED_INPUT, in: 0, out: 3, transition: { kind: 'cut', duration: 0 } }] } };
  commitVideoToolDraft(doc, HOST, 'video.transitions', draft);
  vi.mocked(useCanvasSpace).mockReturnValue({ nodes: readNodes(doc), edges: [], undo: vi.fn(), redo: vi.fn(), canUndo: false, canRedo: false, getLastWriteWasLocal: () => true, deletedByPeer: () => false });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const url of [HOST_URL, PICKED_URL]) client.setQueryData(videoPresentationQuery({ projectId: PROJECT, canonicalURL: url, active: true }).queryKey, sourceResponse(url));
  fetchMock.mockReset().mockImplementation(async (input) => {
    const url = String(input).replace(/\.table\.json$/, '');
    const content = bytes.get(url);
    return content === undefined ? new Response(null, { status: 404 }) : new Response(content, { headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); resetRunOnceForTests(); client.clear(); canvasSessions.of(SPACE).getState().closeActivePanel(); destroyDoc(docName.canvasSpace(PROJECT, SPACE)); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/**
 * Mounts the real Canvas with the transitions panel open on the host.
 * @returns Nothing.
 */
function mount(): void {
  act(() => canvasSessions.of(SPACE).getState().openMiniTool(HOST, 'video.transitions', { sourceContent: HOST_URL, params: {} }));
  render(<QueryClientProvider client={client}><TooltipProvider><SpaceConnectionContext.Provider value={{ provider: null, synced: true, hasEverSynced: true, status: 'connected', writeAccess: 'granted', authFailedReason: null }}><CanvasSpace projectId={PROJECT} spaceId={SPACE} readOnly={false} myRole='editor' /></SpaceConnectionContext.Provider></TooltipProvider></QueryClientProvider>);
}

/**
 * The table the Dialog was handed for one input, if any.
 * @param inputId - The input.
 * @returns The table.
 */
function dialogTable(inputId: string): unknown {
  const tables = dialog.props?.inputTables;
  return tables instanceof Map ? tables.get(inputId) : undefined;
}

describe('each transition clip table reaches the Dialog from its own node binding (§97 D10-3; Canvas → bindings → panel)', () => {
  it('hands the Dialog the picked input node\'s selected compact table for the second clip', async () => {
    mount();
    // The picked node's binding exists and its table is read; the question is whether it reaches the panel.
    await waitFor(() => expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain(`${PICKED_URL}.table.json`));
    await waitFor(() => expect(dialogTable(PICKED_INPUT)).toEqual(TABLES[PICKED_URL]));
  });

  it('hands the Dialog the host node\'s selected compact table for the first clip', async () => {
    mount();
    await waitFor(() => expect(dialog.props).not.toBeNull());
    const hostInput = (dialog.props!.draft as VideoToolDraftById['video.transitions']).params.clips[0].inputId;
    await waitFor(() => expect(dialogTable(hostInput)).toEqual(TABLES[HOST_URL]));
  });
});

describe('a node picked through the transitions input slot reaches the Dialog at once (§97 D10-3; Canvas → bindings → panel)', () => {
  it('reads the newly picked node\'s compact table and hands it to the Dialog under the new input', async () => {
    // The panel starts on the host's video alone, before anything is picked.
    const doc = getDoc(docName.canvasSpace(PROJECT, SPACE));
    commitVideoToolDraft(doc, HOST, 'video.transitions', createVideoToolDraft('video.transitions', { nodeId: HOST, canonicalURL: HOST_URL, mediaInfo: { width: 400, height: 200, duration: 4, mimeType: 'video/webm' } }));
    mount();
    await waitFor(() => expect(dialog.props).not.toBeNull());
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain(`${PICKED_URL}.table.json`);
    // The real pick: the transitions input slot opens a pick, then a click on the picked video node fills it.
    act(() => canvasSessions.of(SPACE).getState().startMiniToolSlotPick(HOST, 'timeline'));
    const picked = document.querySelector(`.react-flow__node[data-id="${PICKED}"]`);
    expect(picked).not.toBeNull();
    act(() => { picked!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    let inputId: string | undefined;
    await waitFor(() => {
      const reading = readVideoToolDraft(doc, HOST, 'video.transitions');
      inputId = reading.state === 'supported' ? reading.draft.inputs.find((input) => input.sourceNodeId === PICKED)?.inputId : undefined;
      expect(inputId).toBeDefined();
    });
    await waitFor(() => expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain(`${PICKED_URL}.table.json`));
    await waitFor(() => expect(dialogTable(inputId!)).toEqual(TABLES[PICKED_URL]));
  });
});

