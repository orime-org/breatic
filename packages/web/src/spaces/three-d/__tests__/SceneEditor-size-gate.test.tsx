// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * Space size cap, second design (inner#1790), web test spec SC-07 in the real
 * editor: a size refusal (`full`, `over_ceiling`, `resyncing`) shows the
 * shared size sentence once from the session, never the generic
 * command-failed error; a refused field keeps its draft marked as failed; a
 * refused creation leaves no pending focus behind; a non-size refusal
 * (locked) still shows the generic error.
 */

import * as React from 'react';
import * as Y from 'yjs';
import { Unlock } from 'lucide-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { t, SCENE_FORMAT_VERSION, type SceneObject } from '@breatic/shared';
import type * as SceneApiModule from '@web/data/api/scene';

const { viewportInputs } = vi.hoisted(() => ({ viewportInputs: vi.fn() }));

vi.mock('@web/lib/toast', () => ({
  toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
  muteToasts: vi.fn(),
  _unmuteToastsForTests: vi.fn(),
}));
vi.mock('@web/data/api/scene', async (importOriginal) => ({
  ...(await importOriginal<typeof SceneApiModule>()),
  listSpaceTasks: vi.fn(async () => ({ serverNow: new Date().toISOString(), tasks: [] })),
  getSceneControls: vi.fn(async () => ({ scaleSensitivity: 1, import: IMPORT_LIMITS, progressPublishMs: 1000 })),
  resolveSceneAsset: vi.fn(async () => ({ url: 'https://example.invalid/model.glb', mimeType: 'model/gltf-binary', sizeBytes: 100 })),
}));
vi.mock('@web/spaces/three-d/viewport/SceneViewport', () => ({
  default: (props: SceneViewportProps): React.JSX.Element => { viewportInputs(props); return <div data-testid='scene-viewport-boundary' />; },
}));
vi.mock('@web/lib/scene-view-storage', () => ({
  readSceneView: vi.fn(() => null),
  writeSceneView: vi.fn(() => true),
}));

import { toast } from '@web/lib/toast';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { clearAllDocSizes } from '@web/data/yjs/doc-size';
import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import { readSceneDocument } from '@web/data/yjs/scene-document';
import { evictSceneSession, getSceneSession, type SceneSession } from '@web/data/yjs/scene-session';
import SceneEditor from '@web/spaces/three-d/SceneEditor';
import { IMPORT_LIMITS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';
import type { SceneViewportProps } from '@web/spaces/three-d/viewport/scene-viewport-props';
import { P_NORMAL, SIZE_COPY_EN, enterSize, pushSize, type SizeCode } from '@web/data/yjs/__tests__/helpers/size-v2-harness';

const NAME = docName.threeDSpace('project', 'scene');
const O1 = '11111111-1111-4111-8111-111111111111';
const O2 = '22222222-2222-4222-8222-222222222222';
const NEW_ID = '33333333-3333-4333-8333-333333333333';
const CONNECTION = { status: 'connected', synced: true } as const;
const PEERS = [] as const;
const clients: QueryClient[] = [];

/** Treat the test's keyboard as owned by this active Space. */
function ownsKeyboard(): boolean { return true; }

/**
 * Subscribe the real editor to its real session as the production host does.
 * @param props - The session.
 * @param props.session - Scene session bound to the registered document.
 * @returns The editor.
 */
function BoundEditor({ session }: { session: SceneSession }): React.JSX.Element {
  const snapshot = React.useSyncExternalStore(session.subscribe, session.getSnapshot);
  const readObjects = React.useCallback((): readonly SceneObject[] => readSceneDocument(session.doc).objects, [session]);
  return <SceneEditor projectId='project' spaceId='scene' userId='alice'
    session={session} snapshot={snapshot} connection={CONNECTION} namedPeers={PEERS}
    readObjects={readObjects} ownsKeyboard={ownsKeyboard} UnlockIcon={Unlock} />;
}

/**
 * Writes one object record the way a collaborator's update lands.
 * @param doc - Scene document.
 * @param object - The object.
 * @throws {Error} When the transaction fails.
 */
function remoteObject(doc: Y.Doc, object: SceneObject): void {
  const { id, ...values } = object;
  doc.transact(() => {
    doc.getMap<unknown>('objects').set(id, new Y.Map<unknown>(Object.entries(values)));
  }, 'remote-peer');
}

/**
 * An object record.
 * @param id - Object id.
 * @param name - Its name.
 * @param locked - Whether it is locked.
 * @returns The object.
 */
function sceneObject(id: string, name: string, locked: boolean): SceneObject {
  return { id, name, model: { kind: 'builtin', id: 'figure' }, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked };
}

/**
 * The focus revision the viewport was last rendered with.
 * @returns The revision.
 */
function lastFocusRevision(): number {
  return (viewportInputs.mock.calls.at(-1)![0] as SceneViewportProps).focusRevision;
}

beforeEach(() => {
  viewportInputs.mockClear();
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  evictSceneSession(NAME);
  for (const client of clients.splice(0)) client.clear();
  clearAllDocSizes();
  _resetForTests();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

/**
 * Mounts the editor on a 3D Space holding o1 and the locked o2, written by a peer, with o1 selected.
 * @returns The document and session.
 */
async function mounted(): Promise<{ doc: Y.Doc; session: SceneSession }> {
  const doc = getDoc(NAME);
  doc.transact(() => { doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION); }, 'remote-peer');
  remoteObject(doc, sceneObject(O1, 'Figure', false));
  remoteObject(doc, sceneObject(O2, 'Locked figure', true));
  const session = getSceneSession(doc, NAME);
  session.setEnvironment({ readOnly: false, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness: null });
  session.select(O1, false);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><TooltipProvider><BoundEditor session={session} /></TooltipProvider></QueryClientProvider>);
  await screen.findByTestId('scene-viewport-boundary');
  return { doc, session };
}

describe('SC-07 a full 3D Space reports each refusal once and leaves no stale state', () => {
  it('SC-07 warns once per refusal with the add sentence, keeps a failed field draft and drops the pending focus of a refused creation', async () => {
    const { doc, session } = await mounted();
    act(() => { enterSize(NAME, 'F'); });
    const user = userEvent.setup();

    // Rename in the right panel.
    const input = await screen.findByLabelText(t('spaces.threeD.name'));
    await user.click(input);
    fireEvent.change(input, { target: { value: 'Renamed' } });
    await user.keyboard('{Enter}');
    expect(readSceneDocument(doc).objects.find((object) => object.id === O1)?.name).toBe('Figure');
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.warning).mock.calls[0][0]).toBe(SIZE_COPY_EN.T_ADD);
    expect(toast.error).not.toHaveBeenCalled();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveValue('Renamed');

    // Create from the creation menu.
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(NEW_ID);
    const focusBefore = lastFocusRevision();
    await user.click(within(screen.getByTestId('scene-left-menu')).getByRole('button', { name: t('spaces.threeD.add') }));
    await user.click(await screen.findByRole('menuitem', { name: t('spaces.threeD.addFigure') }));
    expect(readSceneDocument(doc).objects.map((object) => object.id).sort()).toEqual([O1, O2]);
    expect(toast.warning).toHaveBeenCalledTimes(2);
    expect(vi.mocked(toast.warning).mock.calls[1][0]).toBe(SIZE_COPY_EN.T_ADD);
    expect(toast.error).not.toHaveBeenCalled();

    // The Space recovers and a peer writes an object with the refused id; its
    // model becoming ready must not move the camera to it.
    act(() => { pushSize(NAME, P_NORMAL); });
    act(() => { remoteObject(doc, sceneObject(NEW_ID, 'Peer figure', false)); });
    const latest = viewportInputs.mock.calls.at(-1)![0] as SceneViewportProps;
    act(() => { latest.onModelStateChange!(NEW_ID, 'ready'); });
    expect(lastFocusRevision()).toBe(focusBefore);

    // Only a size refusal skips the generic error: a locked refusal still shows it.
    act(() => { session.select(O2, false); });
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Delete', code: 'Delete', repeat: false });
      fireEvent.keyUp(window, { key: 'Delete', code: 'Delete' });
    });
    expect(readSceneDocument(doc).objects.map((object) => object.id).sort()).toEqual([O1, O2, NEW_ID]);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast.error).mock.calls[0][0]).toBe(t('spaces.threeD.commandFailed'));
    expect(toast.warning).toHaveBeenCalledTimes(2);
  });

  it.each<[SizeCode, string | null]>([['O', SIZE_COPY_EN.T_OVER], ['Z', null]])(
    'SC-07 at %s a refused rename shows only the size sentence, never the generic error',
    async (code, sentence) => {
      const { doc } = await mounted();
      act(() => { enterSize(NAME, code); });
      vi.mocked(toast.warning).mockClear();
      const user = userEvent.setup();
      const input = await screen.findByLabelText(t('spaces.threeD.name'));
      await user.click(input);
      fireEvent.change(input, { target: { value: 'Renamed' } });
      await user.keyboard('{Enter}');
      expect(readSceneDocument(doc).objects.find((object) => object.id === O1)?.name).toBe('Figure');
      expect(vi.mocked(toast.warning).mock.calls.map(([message]) => message)).toEqual(sentence === null ? [] : [sentence]);
      expect(toast.error).not.toHaveBeenCalled();
      expect(input).toHaveAttribute('aria-invalid', 'true');
    },
  );
});
