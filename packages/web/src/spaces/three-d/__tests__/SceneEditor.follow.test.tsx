// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { IMPORT_LIMITS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';

import * as React from 'react';
import * as Y from 'yjs';
import { Unlock } from 'lucide-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { t, SCENE_FORMAT_VERSION, type SceneObject } from '@breatic/shared';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { applySceneCommand, readSceneDocument } from '@web/data/yjs/scene-document';
import { SceneSession } from '@web/data/yjs/scene-session';
import SceneEditor from '@web/spaces/three-d/SceneEditor';
import { SCENE_CAMERA_FOV } from '@web/spaces/three-d/viewport/scene-viewport-props';
import type { SceneViewportProps } from '@web/spaces/three-d/viewport/scene-viewport-props';
import { useFollowStore } from '@web/stores/follow';
import { useUIStore } from '@web/stores/ui';

const NAME = 'project-p1/3d-s1';
const { viewportInputs } = vi.hoisted(() => ({ viewportInputs: vi.fn() }));

vi.mock('@web/data/api/scene', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/scene')>()),
  listSpaceTasks: vi.fn(async () => ({ serverNow: new Date().toISOString(), tasks: [] })),
  getSceneControls: vi.fn(async () => ({ scaleSensitivity: 1, import: IMPORT_LIMITS })),
  resolveSceneAsset: vi.fn(async () => ({ url: 'https://example.invalid/model.glb', mimeType: 'model/gltf-binary', sizeBytes: 100 })),
}));
vi.mock('@web/spaces/three-d/viewport/SceneViewport', () => ({
  default: (props: SceneViewportProps): React.JSX.Element => { viewportInputs(props); return <canvas tabIndex={0} data-testid='scene-native-boundary' />; },
}));
vi.mock('@web/lib/scene-view-storage', () => ({ readSceneView: () => null, writeSceneView: () => true }));
vi.mock('@web/data/api/models', async () => {
  const { sanitizeModelCatalog } = await import('@breatic/shared');
  const { RAW_CATALOG } = await import('@web/spaces/three-d/__tests__/scene-generate-fixtures');
  return { modelsApi: { list: async () => sanitizeModelCatalog(RAW_CATALOG) } };
});

const ID = '11111111-1111-4111-8111-111111111111';
const EDITABLE = { readOnly: false, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness: null } as const;
const owners: Array<{ doc: Y.Doc; session: SceneSession; client: QueryClient }> = [];

/** Subscribe the real editor to its real session as the production host does. */
function Bound({ session }: { session: SceneSession }): React.JSX.Element {
  const snapshot = React.useSyncExternalStore(session.subscribe, session.getSnapshot);
  const readObjects = React.useCallback((): readonly SceneObject[] => readSceneDocument(session.doc).objects, [session]);
  return <SceneEditor projectId='project' spaceId='scene' userId='alice' session={session} snapshot={snapshot}
    connection={{ status: 'connected', synced: true }} namedPeers={[]}
    readObjects={readObjects} ownsKeyboard={() => true} UnlockIcon={Unlock} />;
}

/** The props the editor last handed the viewport. */
function viewport(): SceneViewportProps {
  const props = viewportInputs.mock.lastCall?.[0] as SceneViewportProps | undefined;
  if (!props) throw new Error('The viewport has not rendered');
  return props;
}

/**
 * One figure in an editable scene, rendered.
 * @returns The session.
 */
async function setup(): Promise<SceneSession> {
  const doc = new Y.Doc(); doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
  applySceneCommand(doc, { type: 'create', objects: [{ id: ID, name: 'Figure', model: { kind: 'builtin', id: 'figure' },
    position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false }] }, Symbol('fixture'), true, NAME);
  const session = new SceneSession(doc, NAME); session.setEnvironment(EDITABLE);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); owners.push({ doc, session, client });
  render(<QueryClientProvider client={client}><TooltipProvider><div data-space-outlet='scene'><Bound session={session} /></div></TooltipProvider></QueryClientProvider>);
  await screen.findByTestId('scene-native-boundary');
  return session;
}

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  viewportInputs.mockClear();
  useFollowStore.getState().reset();
  useFollowStore.getState().start('leader', 'Leader');
});
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) { owner.session.destroy(); owner.doc.destroy(); owner.client.clear(); }
  useUIStore.getState().setActiveOverlayId(null);
  vi.restoreAllMocks();
});

describe('SceneEditor, following a member', () => {
  it('publishes the personal camera with the field of view', async () => {
    const session = await setup();
    const setCamera = vi.spyOn(session, 'setCamera');
    act(() => viewport().onViewChange({ position: [1, 2, 3], target: [0, 0, 0] }));
    expect(setCamera).toHaveBeenLastCalledWith({ position: [1, 2, 3], target: [0, 0, 0], fov: SCENE_CAMERA_FOV });
  });

  it('stops following when the user moves the camera in the viewport or the overview', async () => {
    await setup();
    act(() => viewport().onUserCameraMove?.());
    expect(useFollowStore.getState().stopped?.reason).toBe('viewport');
  });

  it('stops following when the user frames with F', async () => {
    const session = await setup();
    act(() => session.select(ID, false));
    fireEvent.keyDown(screen.getByTestId('scene-native-boundary'), { key: 'f' });
    expect(useFollowStore.getState().stopped?.reason).toBe('viewport');
  });

  it('stops following when the user frames with the toolbar button', async () => {
    const session = await setup();
    act(() => session.select(ID, false));
    fireEvent.click(await screen.findByRole('button', { name: t('spaces.threeD.focus') }));
    expect(useFollowStore.getState().stopped?.reason).toBe('viewport');
  });

  it('keeps following when the user only selects an object', async () => {
    await setup();
    act(() => viewport().onSelect(ID, false));
    expect(useFollowStore.getState().targetUserId).toBe('leader');
  });
});
