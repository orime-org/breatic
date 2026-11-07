// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { IMPORT_LIMITS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';

import * as React from 'react';
import * as Y from 'yjs';
import { Unlock } from 'lucide-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { t, SCENE_FORMAT_VERSION } from '@breatic/shared';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { readSceneDocument } from '@web/data/yjs/scene-document';
import { SceneSession } from '@web/data/yjs/scene-session';
import SceneEditor from '@web/spaces/three-d/SceneEditor';
import { useUIStore } from '@web/stores/ui';

const h = vi.hoisted(() => ({ started: null as ((taskId: string) => void) | null }));

vi.mock('@web/data/api/scene', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/scene')>()),
  listSpaceTasks: vi.fn(async () => ({ serverNow: new Date().toISOString(), tasks: [{ id: 'task-1', label: 'Lamp', status: 'running',
    startedByUserId: 'alice', startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 7_200_000).toISOString(), errorMessage: null, assetId: null }] })),
  getSceneControls: vi.fn(async () => ({ scaleSensitivity: 1, import: IMPORT_LIMITS, progressPublishMs: 1000 })),
}));
vi.mock('@web/spaces/three-d/viewport/SceneViewport', () => ({
  default: (): React.JSX.Element => <canvas tabIndex={0} data-testid='scene-native-boundary' />,
}));
vi.mock('@web/lib/scene-view-storage', () => ({ readSceneView: () => null, writeSceneView: () => true }));
vi.mock('@web/spaces/three-d/SceneModelImportHost', () => ({
  default: function ImportHostStandIn({ onStarted }: { onStarted?: (taskId: string) => void }): null {
    h.started = onStarted ?? null;
    return null;
  },
}));

const RIGHT_PANEL = 'scene:scene:right';
const owners: Array<{ doc: Y.Doc; session: SceneSession; client: QueryClient }> = [];

/**
 * The editor bound to its session as the production host binds it.
 * @param root0 - The session.
 * @param root0.session - The live scene session.
 * @returns The editor.
 */
function Bound({ session }: { session: SceneSession }): React.JSX.Element {
  const snapshot = React.useSyncExternalStore(session.subscribe, session.getSnapshot);
  return <SceneEditor projectId='project' spaceId='scene' userId='alice' session={session} snapshot={snapshot}
    connection={{ status: 'connected', synced: true }} namedPeers={[]}
    readObjects={() => readSceneDocument(session.doc).objects} ownsKeyboard={() => true} UnlockIcon={Unlock} />;
}

/**
 * The editor inside the tab's Activity boundary.
 * @param session - The session.
 * @param client - The query client.
 * @param mode - Whether the Space tab is on screen.
 * @returns The tree.
 */
function tree(session: SceneSession, client: QueryClient, mode: 'visible' | 'hidden' = 'visible'): React.JSX.Element {
  return <QueryClientProvider client={client}><TooltipProvider><React.Activity mode={mode}>
    <div data-space-outlet='scene'><Bound session={session} /></div>
  </React.Activity></TooltipProvider></QueryClientProvider>;
}

/**
 * Render an editable empty scene and wait for its import host.
 * @returns The rerender handle and its parts.
 */
async function setup(): Promise<{ session: SceneSession; client: QueryClient; page: ReturnType<typeof render> }> {
  const doc = new Y.Doc();
  doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
  const session = new SceneSession(doc, 'project-p1/3d-s1');
  session.setEnvironment({ readOnly: false, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness: null });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  owners.push({ doc, session, client });
  const page = render(tree(session, client));
  await screen.findByTestId('scene-native-boundary');
  await waitFor(() => expect(h.started).not.toBeNull());
  return { session, client, page };
}

beforeEach(() => { vi.spyOn(document, 'hasFocus').mockReturnValue(true); });
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) { owner.session.destroy(); owner.doc.destroy(); owner.client.clear(); }
  useUIStore.getState().setActiveOverlayId(null);
  h.started = null;
  vi.restoreAllMocks();
});

describe('handing a started upload to the task list (inner#1690)', () => {
  it('shows the new row once; reopening the task list later leaves it where the user left it', async () => {
    await setup();
    act(() => h.started?.('task-1'));
    const row = await screen.findByTestId('scene-task-task-1');
    await waitFor(() => expect(row).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: t('spaces.threeD.closePanel') }));
    await waitFor(() => expect(screen.queryByTestId('scene-tasks-panel')).toBeNull());
    fireEvent.click(screen.getByTestId('scene-tasks-trigger'));
    const again = await screen.findByTestId('scene-task-task-1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(again).not.toHaveFocus();
  });

  it('leaves the overlay on screen alone while its Space is hidden, then opens the task list once shown', async () => {
    const { session, client, page } = await setup();
    page.rerender(tree(session, client, 'hidden'));
    act(() => useUIStore.getState().setActiveOverlayId('other-space-menu'));
    act(() => h.started?.('task-1'));
    expect(useUIStore.getState().activeOverlayId).toBe('other-space-menu');

    page.rerender(tree(session, client, 'visible'));
    await waitFor(() => expect(useUIStore.getState().activeOverlayId).toBe(RIGHT_PANEL));
    expect(await screen.findByTestId('scene-task-task-1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: t('spaces.threeD.closePanel') }));
    await waitFor(() => expect(useUIStore.getState().activeOverlayId).toBeNull());
    page.rerender(tree(session, client, 'hidden'));
    page.rerender(tree(session, client, 'visible'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(useUIStore.getState().activeOverlayId).toBeNull();
  });
});
