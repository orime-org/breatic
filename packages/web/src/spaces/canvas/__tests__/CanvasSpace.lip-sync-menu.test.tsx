// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * inner#1306 test plan §97 (canvas design §4 对口型 row: "列表为空时对口型菜单项不可用"): when `GET /canvas/limits` answers
 * `lipSync: null` (the deployment configures no lip-sync), a video node's Tools submenu does not offer lip-sync. The menu's
 * existing convention for a tool that cannot run here is to leave it off the list (`servedMiniToolsFor` drops a model tool
 * whose model the catalog does not serve, `CanvasSpace` `menuTools`), so this test follows it and asserts the entry is absent.
 * The control case (`lipSync` configured) keeps the entry, so the absence is not an artefact of the fixture.
 *
 * Level: `CanvasSpace`, where `menuTools` is built and handed to `NodeContextMenu`. Only the request layer's
 * `/canvas/limits` read is answered here (every other read goes to the real `apiGet`), and the video node's browser
 * rendering boundary is replaced.
 */

import type * as React from 'react';
import type * as CanvasModule from '@web/data/yjs/canvas-space';
import type * as VideoNodeModule from '@web/spaces/canvas/nodes/VideoNode';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizeModelCatalog } from '@breatic/shared';

const limits = vi.hoisted(() => ({ lipSync: null as unknown, asked: 0 }));
vi.mock('@web/data/api/request', async (importOriginal) => {
  const actual = await importOriginal<{ apiGet:(path: string, ...rest: unknown[]) => Promise<unknown> }>();
  return {
    ...actual,
    apiGet: async (path: string, ...rest: unknown[]): Promise<unknown> => {
      if (path !== '/canvas/limits') return actual.apiGet(path, ...rest);
      limits.asked += 1;
      return {
        referencePoolCap: 10, nodeHistoryPageSize: 20, understandMaxBytes: 20_971_520, understandLongMediaMaxBytes: 2_147_483_648,
        waveformMaxSeconds: 600, waveformMaxBytes: 200_000_000, waveformPeaksRetryMs: 5000, waveformPeaksRetryMaxMs: 600_000,
        removeBackgroundModel: 'remove-bg-configured', lipSync: structuredClone(limits.lipSync),
      };
    },
  };
});
vi.mock('@web/data/yjs/canvas-space', async (original) => ({ ...(await original<typeof CanvasModule>()), useCanvasSpace: vi.fn() }));
vi.mock('@web/spaces/canvas/nodes/VideoNode', async (original) => ({ ...(await original<typeof VideoNodeModule>()), VideoNode: () => <div data-testid='video-renderer-boundary' /> }));

import { CanvasSpace } from '@web/spaces/canvas/CanvasSpace';
import { addNode, readNodes, useCanvasSpace } from '@web/data/yjs/canvas-space';
import { docName, getDoc, destroyDoc } from '@web/data/yjs/manager';
import { SpaceConnectionContext } from '@web/data/yjs/space-connection';
import { canvasApi } from '@web/data/api/canvas';
import { modelsApi } from '@web/data/api/models';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { canvasSessions } from '@web/stores/canvas-session';
import { useCanvasStore } from '@web/stores/canvas';
import { useCurrentUserStore } from '@web/stores/current-user';

const PROJECT = '31000000-0000-4000-8000-000000000001';
const SPACE = '31000000-0000-4000-8000-000000000002';
const SOURCE = '31000000-0000-4000-8000-000000000003';
const URL = 'https://assets.example.test/canonical.webm';
const CONFIGURED = {
  models: [{ name: 'lipsync-configured-a', minDurationSeconds: 1, maxDurationSeconds: 300 }],
  tracking: { minDurationSeconds: 0.5, maxDurationSeconds: 600 }, maxPeople: 2, maxDialogues: 8,
};
let client: QueryClient;

/**
 * Mounts the real Canvas, waits until it has asked for the limits, right-clicks the video node and opens Tools.
 * @returns The tool entries' test ids, in order.
 */
async function toolsOffered(): Promise<string[]> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><TooltipProvider><SpaceConnectionContext.Provider value={{ provider: null, synced: true, hasEverSynced: true, status: 'connected', writeAccess: 'granted', authFailedReason: null }}><CanvasSpace projectId={PROJECT} spaceId={SPACE} readOnly={false} myRole='editor' /></SpaceConnectionContext.Provider></TooltipProvider></QueryClientProvider>);
  await waitFor(() => expect(limits.asked).toBeGreaterThan(0));
  // Let the answer settle into whatever reads it before the menu opens.
  await act(async () => { await canvasApi.fetchLimits(); });
  act(() => {
    document.querySelector(`.react-flow__node[data-id="${SOURCE}"]`)?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  });
  fireEvent.keyDown(screen.getByTestId('node-menu-tools'), { key: 'ArrowRight' });
  return screen.getAllByTestId(/^node-menu-tool-/).map((item) => item.dataset.testid ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  limits.asked = 0;
  canvasApi.resetLimitsCache();
  useCanvasStore.getState().reset();
  canvasSessions.of(SPACE).getState().closeActivePanel();
  useCurrentUserStore.getState().setUser({ id: 'author', name: 'Author', email: 'author@example.test', personalStudio: null, membershipTier: 'base' });
  vi.spyOn(modelsApi, 'list').mockResolvedValue(sanitizeModelCatalog({}));
  const doc = getDoc(docName.canvasSpace(PROJECT, SPACE));
  addNode(PROJECT, SPACE, { id: SOURCE, type: 'video', position: { x: 30, y: 40 }, data: { content: URL, name: 'ORIGINAL', mediaWidth: 400, mediaHeight: 200, duration: 4, mimeType: 'video/webm', locked: false, createdBy: 'author', createdAt: 0, attachments: [] } });
  vi.mocked(useCanvasSpace).mockReturnValue({ nodes: readNodes(doc), edges: [], undo: vi.fn(), redo: vi.fn(), canUndo: false, canRedo: false, getLastWriteWasLocal: () => true, deletedByPeer: () => false });
});
afterEach(() => { cleanup(); client.clear(); canvasSessions.of(SPACE).getState().closeActivePanel(); destroyDoc(docName.canvasSpace(PROJECT, SPACE)); canvasApi.resetLimitsCache(); vi.restoreAllMocks(); });

describe('the video node Tools menu follows the lip-sync configuration (§97; canvas design §4 对口型)', () => {
  it('offers lip-sync when the limits configure it (control)', async () => {
    limits.lipSync = CONFIGURED;
    expect(await toolsOffered()).toContain('node-menu-tool-video.lip-sync');
  });

  it('leaves lip-sync off the Tools menu when the limits say lip-sync is not configured', async () => {
    limits.lipSync = null;
    const offered = await toolsOffered();
    expect(offered).toContain('node-menu-tool-video.remove-bg');
    expect(offered).not.toContain('node-menu-tool-video.lip-sync');
  });
});
