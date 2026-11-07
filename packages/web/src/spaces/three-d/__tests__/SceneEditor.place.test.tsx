// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { IMPORT_LIMITS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';

import * as React from 'react';
import * as Y from 'yjs';
import { Unlock } from 'lucide-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { t, SCENE_FORMAT_VERSION, type SceneObject } from '@breatic/shared';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { readSceneDocument } from '@web/data/yjs/scene-document';
import { SceneSession } from '@web/data/yjs/scene-session';
import SceneEditor from '@web/spaces/three-d/SceneEditor';
import type * as ToastModule from '@web/lib/toast';
import type { SceneViewportProps } from '@web/spaces/three-d/viewport/scene-viewport-props';
import { ModelImportError } from '@web/spaces/three-d/model-import-errors';
import { importErrorKey } from '@web/spaces/three-d/model-import-error-text';
import { ApiException } from '@web/data/api/types';

const h = vi.hoisted(() => ({
  reportError: vi.fn(),
  release: vi.fn(),
  latest: { props: null as SceneViewportProps | null },
  bounds: null as Promise<{ center: [number, number, number]; min: [number, number, number] }> | null,
  tasks: [] as unknown[],
}));

vi.mock('@web/data/api/scene', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web/data/api/scene')>()),
  listSpaceTasks: vi.fn(async () => ({ serverNow: new Date().toISOString(), tasks: h.tasks })),
  getSceneControls: vi.fn(async () => ({ scaleSensitivity: 1, import: IMPORT_LIMITS, progressPublishMs: 1000 })),
  resolveSceneAsset: vi.fn(async () => ({ url: 'https://example.invalid/model.glb', mimeType: 'model/gltf-binary', sizeBytes: 100 })),
}));
vi.mock('@web/spaces/three-d/viewport/SceneViewport', () => ({
  default: function ViewportStandIn(props: SceneViewportProps): React.JSX.Element {
    h.latest.props = props;
    React.useEffect(() => {
      props.onResources?.(() => ({ bounds: h.bounds ?? Promise.resolve({ center: [1, 0, 2], min: [0, -0.5, 0] }), release: h.release }));
      return (): void => props.onResources?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the stand-in hands its holder up once, as the runtime does
    }, []);
    return <div data-testid='scene-viewport-boundary' />;
  },
}));
vi.mock('@web/lib/scene-view-storage', () => ({
  readSceneView: vi.fn(() => ({ position: [5, 4, 7], target: [3, 0, 4] })),
  writeSceneView: vi.fn(() => true),
}));
vi.mock('@web/lib/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof ToastModule>();
  return { ...actual, toast: { ...actual.toast, error: h.reportError } };
});

const CONNECTION = { status: 'connected', synced: true } as const;
const PEERS = [] as const;
const ASSET = '55555555-5555-4555-8555-555555555555';

/** Treat keyboard targets as owned by this active Space. */
function ownsKeyboard(): boolean { return true; }

/**
 * Subscribe the real editor to its real session as the production host does.
 * @param root0 - The session.
 * @param root0.session - The live scene session.
 * @returns The editor.
 */
function BoundEditor({ session }: { session: SceneSession }): React.JSX.Element {
  const snapshot = React.useSyncExternalStore(session.subscribe, session.getSnapshot);
  const readObjects = React.useCallback((): readonly SceneObject[] => readSceneDocument(session.doc).objects, [session]);
  return <SceneEditor projectId='project' spaceId='scene' userId='alice'
    session={session} snapshot={snapshot} connection={CONNECTION} namedPeers={PEERS}
    readObjects={readObjects} ownsKeyboard={ownsKeyboard} UnlockIcon={Unlock} />;
}

const owners: { doc: Y.Doc; session: SceneSession }[] = [];

/**
 * Render an empty editable scene with one finished model on its task list.
 * @param label - The finished row's model name.
 * @returns The session.
 */
async function placeable(label = 'Barn lamp'): Promise<SceneSession> {
  h.tasks = [{ id: 'task-1', label, status: 'done', startedByUserId: 'alice', startedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 7_200_000).toISOString(), errorMessage: null, assetId: ASSET }];
  const doc = new Y.Doc();
  doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
  const session = new SceneSession(doc);
  session.setEnvironment({ readOnly: false, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness: null });
  owners.push({ doc, session });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><TooltipProvider><BoundEditor session={session} /></TooltipProvider></QueryClientProvider>);
  await screen.findByTestId('scene-viewport-boundary');
  fireEvent.click(screen.getByTestId('scene-tasks-trigger'));
  await screen.findByTestId('scene-task-task-1');
  return session;
}

/**
 * Press the row's Place in scene.
 */
async function pressPlace(): Promise<void> {
  await act(async () => {
    fireEvent.click(within(screen.getByTestId('scene-task-task-1')).getByRole('button', { name: t('spaces.threeD.taskList.place') }));
  });
}

afterEach(() => {
  h.bounds = null;
  cleanup();
  for (const { session, doc } of owners.splice(0)) { session.destroy(); doc.destroy(); }
  vi.clearAllMocks();
});

describe('placing a finished model from the task list (inner#1690)', () => {
  it('puts it on the ground at the view centre under its name, selects it and keeps the task list open', async () => {
    const session = await placeable();
    await pressPlace();

    const objects = readSceneDocument(session.doc).objects;
    expect(objects).toEqual([{ id: expect.any(String), name: 'Barn lamp', model: { kind: 'asset', assetId: ASSET },
      position: [2, 0.5, 2], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false }]);
    expect(session.getSnapshot().selectedIds).toEqual([objects[0]!.id]);
    expect(screen.getByTestId('scene-tasks-panel')).toBeVisible();
    expect(h.release).not.toHaveBeenCalled();
  });

  it('lets the model go once the viewport holds the placed object', async () => {
    const session = await placeable();
    await pressPlace();
    const id = readSceneDocument(session.doc).objects[0]!.id;
    act(() => h.latest.props?.onModelStateChange?.(id, 'loading'));
    expect(h.release).not.toHaveBeenCalled();
    act(() => h.latest.props?.onModelStateChange?.(id, 'ready'));
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('lets the model go when the placed object is deleted before the viewport holds it', async () => {
    const session = await placeable();
    await pressPlace();
    act(() => { session.execute({ type: 'delete', ids: session.getSnapshot().selectedIds }); });
    await waitFor(() => expect(h.release).toHaveBeenCalledTimes(1));
  });

  it('lets the model go at once and says so when the scene refuses the object', async () => {
    const session = await placeable('   ');
    await pressPlace();
    expect(readSceneDocument(session.doc).objects).toEqual([]);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError).toHaveBeenCalledWith(t('spaces.threeD.commandFailed'));
  });

  it('ends quietly when the viewport lets the model go before it loads, even once a new viewport is in place', async () => {
    const pending = Promise.withResolvers<{ center: [number, number, number]; min: [number, number, number] }>();
    h.bounds = pending.promise;
    pending.promise.catch(() => undefined);
    const session = await placeable();
    await pressPlace();
    act(() => h.latest.props?.onResources?.(null));
    // The Space is shown again before the old load settles: a new viewport hands up its own holder.
    act(() => h.latest.props?.onResources?.(() => ({ bounds: new Promise(() => undefined), release: vi.fn() })));
    await act(async () => { pending.reject(new DOMException('Scene model holder released', 'AbortError')); await pending.promise.catch(() => undefined); });
    expect(readSceneDocument(session.doc).objects).toEqual([]);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it('ends quietly when the viewport goes while the model\'s address is being read', async () => {
    const pending = Promise.withResolvers<{ center: [number, number, number]; min: [number, number, number] }>();
    h.bounds = pending.promise;
    pending.promise.catch(() => undefined);
    const session = await placeable();
    await pressPlace();
    act(() => h.latest.props?.onResources?.(null));
    await act(async () => { pending.reject(new ApiException({ status: 0, message: 'canceled' })); await pending.promise.catch(() => undefined); });
    expect(readSceneDocument(session.doc).objects).toEqual([]);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it('says it could not place the model when the address cannot be read while the viewport stays', async () => {
    h.bounds = Promise.reject(new ApiException({ status: 503, message: 'unavailable' }));
    h.bounds.catch(() => undefined);
    const session = await placeable();
    await pressPlace();
    expect(readSceneDocument(session.doc).objects).toEqual([]);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.reportError).toHaveBeenCalledWith(t('spaces.threeD.taskList.placeFailed'));
  });

  it('says why the model could not be placed when its content is refused, and writes nothing', async () => {
    h.bounds = Promise.reject(new ModelImportError('budget', 'too large', { detail: '', budget: { limit: 'files', allowed: 1, actual: 2 } }));
    h.bounds.catch(() => undefined);
    const session = await placeable();
    await pressPlace();
    expect(readSceneDocument(session.doc).objects).toEqual([]);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.reportError).toHaveBeenCalledWith(`${t('spaces.threeD.taskList.placeFailed')} ${t(importErrorKey('budget'))}`);
  });

});
