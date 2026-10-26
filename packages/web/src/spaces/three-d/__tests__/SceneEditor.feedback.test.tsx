// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import * as Y from 'yjs';
import { Unlock } from 'lucide-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { t, type SceneObject } from '@breatic/shared';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { applySceneCommand, readSceneDocument } from '@web/data/yjs/scene-document';
import { SceneSession } from '@web/data/yjs/scene-session';
import SceneEditor from '@web/spaces/three-d/SceneEditor';
import type * as ToastModule from '@web/lib/toast';

const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }));

vi.mock('@web/data/api/scene', () => ({
  getSceneControls: vi.fn(async () => ({ scaleSensitivity: 1 })),
  resolveSceneAsset: vi.fn(async () => ({ url: 'https://example.invalid/model.glb', mimeType: 'model/gltf-binary' })),
}));
vi.mock('@web/spaces/three-d/viewport/SceneViewport', () => ({
  default: (): React.JSX.Element => <div data-testid='scene-viewport-boundary' />,
}));
vi.mock('@web/lib/scene-view-storage', () => ({
  readSceneView: vi.fn(() => null),
  writeSceneView: vi.fn(() => true),
}));
vi.mock('@web/lib/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof ToastModule>();
  return { ...actual, toast: { ...actual.toast, error: reportError } };
});

const ID = '11111111-1111-4111-8111-111111111111';
const OBJECT: SceneObject = {
  id: ID, name: 'Figure', model: { kind: 'builtin', id: 'figure' },
  position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false, exists: true,
};
const CONNECTION = { status: 'connected', synced: true } as const;
const PEERS = [] as const;
const owners: Array<{ doc: Y.Doc; session: SceneSession; client: QueryClient }> = [];

/** Treat the test's explicit Delete key as owned by this active Space. */
function ownsKeyboard(): boolean { return true; }

/** Subscribe the real editor to its real session as the production host does. */
function BoundEditor({ session }: { session: SceneSession }): React.JSX.Element {
  const snapshot = React.useSyncExternalStore(session.subscribe, session.getSnapshot);
  const readObjects = React.useCallback((): readonly SceneObject[] => readSceneDocument(session.doc).objects, [session]);
  return <SceneEditor projectId='project' spaceId='scene' userId='alice'
    session={session} snapshot={snapshot} connection={CONNECTION} namedPeers={PEERS}
    readObjects={readObjects} ownsKeyboard={ownsKeyboard} UnlockIcon={Unlock} />;
}

/**
 * Seed shared locked content before constructing this user's personal history.
 * @throws {Error} When the real command layer cannot create the locked fixture.
 */
function fixture(): { doc: Y.Doc; session: SceneSession; client: QueryClient } {
  const doc = new Y.Doc();
  doc.getMap('scene').set('formatVersion', 1);
  const created = applySceneCommand(doc, { type: 'create', objects: [OBJECT] }, Symbol('shared-create'), true);
  const locked = applySceneCommand(doc, { type: 'lock', ids: [ID], locked: true }, Symbol('shared-lock'), true);
  if (!created.ok || !locked.ok) throw new Error('The scene feedback fixture must contain one locked object');
  const session = new SceneSession(doc);
  session.setEnvironment({ readOnly: false, connected: true, hasEverSynced: true,
    writeAccess: 'granted', refused: false, awareness: null });
  session.select(ID, false);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const owner = { doc, session, client };
  owners.push(owner);
  return owner;
}

/** Keep the same editor instance while Activity suspends and resumes its effects. */
function editorTree(session: SceneSession, client: QueryClient, mode: 'visible' | 'hidden'): React.JSX.Element {
  return <QueryClientProvider client={client}>
    <TooltipProvider><React.Activity mode={mode}><BoundEditor session={session} /></React.Activity></TooltipProvider>
  </QueryClientProvider>;
}

/** Send a complete independent keyboard press through the editor's real window handler. */
async function pressDelete(): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(window, { key: 'Delete', code: 'Delete', repeat: false });
    fireEvent.keyUp(window, { key: 'Delete', code: 'Delete' });
  });
}

beforeEach(() => { reportError.mockClear(); });
afterEach(() => {
  cleanup();
  for (const { session, doc, client } of owners.splice(0)) {
    session.destroy();
    doc.destroy();
    client.clear();
  }
});

describe('scene command failure feedback (inner#1724)', () => {
  it('reports each independent failed Delete even when both refusals have the same cause', async () => {
    const { doc, session, client } = fixture();
    render(editorTree(session, client, 'visible'));
    await screen.findByTestId('scene-viewport-boundary');
    await pressDelete();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenNthCalledWith(1, t('spaces.threeD.commandFailed'));
    await pressDelete();
    expect(reportError).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenNthCalledWith(2, t('spaces.threeD.commandFailed'));
    expect(readSceneDocument(doc).objects).toEqual([{ ...OBJECT, locked: true }]);
  });

  it('does not report an old command failure again when Activity shows the Space', async () => {
    const { doc, session, client } = fixture();
    const page = render(editorTree(session, client, 'visible'));
    await screen.findByTestId('scene-viewport-boundary');
    await pressDelete();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(t('spaces.threeD.commandFailed'));
    await act(async () => { page.rerender(editorTree(session, client, 'hidden')); });
    expect(reportError).toHaveBeenCalledTimes(1);
    await act(async () => { page.rerender(editorTree(session, client, 'visible')); });
    await screen.findByTestId('scene-viewport-boundary');
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(readSceneDocument(doc).objects).toEqual([{ ...OBJECT, locked: true }]);
  });
});
