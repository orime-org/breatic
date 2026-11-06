// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import * as Y from 'yjs';
import { Unlock } from 'lucide-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SCENE_FORMAT_VERSION, t, type SceneObject } from '@breatic/shared';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { readSceneDocument } from '@web/data/yjs/scene-document';
import { SceneSession } from '@web/data/yjs/scene-session';
import SceneEditor from '@web/spaces/three-d/SceneEditor';
import type * as ToastModule from '@web/lib/toast';

const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }));

vi.mock('@web/data/api/scene', () => ({
  getSceneControls: vi.fn(async () => ({ scaleSensitivity: 1 })),
  resolveSceneAsset: vi.fn(async () => ({ url: 'https://example.invalid/model.glb', mimeType: 'model/gltf-binary' })),
}));
vi.mock('@web/lib/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof ToastModule>();
  return { ...actual, toast: { ...actual.toast, error: reportError } };
});
vi.mock('@web/spaces/three-d/viewport/SceneViewport', () => ({
  default: (): React.JSX.Element => <div data-testid='scene-viewport-boundary' />,
}));

const CONNECTION = { status: 'connected', synced: true } as const;
const PEERS = [] as const;
const sessions: SceneSession[] = [];

/** Treat keyboard input as owned by this Space. */
function ownsKeyboard(): boolean { return true; }

/** Subscribe the real editor to its real session as the production host does. */
function BoundEditor({ session }: { session: SceneSession }): React.JSX.Element {
  const snapshot = React.useSyncExternalStore(session.subscribe, session.getSnapshot);
  const readObjects = React.useCallback((): readonly SceneObject[] => readSceneDocument(session.doc).objects, [session]);
  return <SceneEditor projectId='project' spaceId='scene' userId='alice'
    session={session} snapshot={snapshot} connection={CONNECTION} namedPeers={PEERS}
    readObjects={readObjects} ownsKeyboard={ownsKeyboard} UnlockIcon={Unlock} />;
}

/** Render the editor over a scene document stamped with the given format version. */
function renderVersion(version: number): void {
  const doc = new Y.Doc();
  doc.getMap('scene').set('formatVersion', version);
  const session = new SceneSession(doc);
  session.setEnvironment({ readOnly: false, connected: true, hasEverSynced: true,
    writeAccess: 'granted', refused: false, awareness: null });
  sessions.push(session);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><TooltipProvider><BoundEditor session={session} /></TooltipProvider></QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  reportError.mockClear();
  for (const session of sessions.splice(0)) { session.destroy(); session.doc.destroy(); }
});

describe('SceneEditor unsupported format states', () => {
  it('shows the older-format sentence without a reload button', () => {
    renderVersion(SCENE_FORMAT_VERSION - 1);
    expect(screen.getByText(t('spaces.threeD.unsupportedOld'))).toBeTruthy();
    expect(screen.queryByText(t('spaces.threeD.unsupported'))).toBeNull();
    expect(screen.queryByRole('button', { name: t('spaces.threeD.reload') })).toBeNull();
  });

  it('shows only the older-format sentence, without the creation rail, viewport toolbar or minimap', () => {
    renderVersion(SCENE_FORMAT_VERSION - 1);
    expect(screen.getByText(t('spaces.threeD.unsupportedOld'))).toBeTruthy();
    expect(screen.queryByTestId('scene-left-menu')).toBeNull();
    expect(screen.queryByTestId('scene-viewport-toolbar')).toBeNull();
    expect(screen.queryByTestId('scene-map')).toBeNull();
  });

  it('keeps the creation rail and viewport toolbar for a newer format', () => {
    renderVersion(SCENE_FORMAT_VERSION + 1);
    expect(screen.getByTestId('scene-left-menu')).toBeTruthy();
    expect(screen.getByTestId('scene-viewport-toolbar')).toBeTruthy();
  });

  it('shows the newer-format sentence with a reload button', () => {
    renderVersion(SCENE_FORMAT_VERSION + 1);
    expect(screen.getByText(t('spaces.threeD.unsupported'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('spaces.threeD.reload') })).toBeTruthy();
  });

  it.each([
    { label: 'older', offset: -1 },
    { label: 'newer', offset: 1 },
  ])('ignores editing shortcuts in an $label format without an error toast', ({ offset }) => {
    renderVersion(SCENE_FORMAT_VERSION + offset);
    for (const init of [{ key: 'Backspace' }, { key: 'Delete' }, { key: 'd', metaKey: true }, { key: 'd', ctrlKey: true }]) {
      fireEvent.keyDown(window, init);
    }
    expect(reportError).not.toHaveBeenCalled();
  });
});
