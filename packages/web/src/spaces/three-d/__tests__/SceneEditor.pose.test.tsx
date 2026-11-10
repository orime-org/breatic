// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { IMPORT_LIMITS } from '@web/spaces/three-d/__tests__/scene-import-fixtures';

import * as React from 'react';
import * as Y from 'yjs';
import { Unlock } from 'lucide-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { t, SCENE_FORMAT_VERSION, type SceneObject } from '@breatic/shared';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { applySceneCommand, readSceneDocument } from '@web/data/yjs/scene-document';
import { SceneSession } from '@web/data/yjs/scene-session';
import SceneEditor from '@web/spaces/three-d/SceneEditor';
import { useUIStore } from '@web/stores/ui';
import type { SceneViewportProps } from '@web/spaces/three-d/viewport/scene-viewport-props';

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
const SECOND = '22222222-2222-4222-8222-222222222222';
const JOINT = 'h:leftUpperArm';
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
 * Two figures, the first selected, its humanoid skeleton reported by the viewport.
 * @returns The document and its session.
 */
async function setup(): Promise<{ doc: Y.Doc; session: SceneSession }> {
  const doc = new Y.Doc(); doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
  const objects: SceneObject[] = [ID, SECOND].map((id, index) => ({ id, name: index ? 'Second' : 'Figure', model: { kind: 'builtin', id: 'figure' },
    position: [index * 2, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false }));
  applySceneCommand(doc, { type: 'create', objects }, Symbol('fixture'), true);
  const session = new SceneSession(doc);
  session.setEnvironment(EDITABLE);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); owners.push({ doc, session, client });
  render(<QueryClientProvider client={client}><TooltipProvider><div data-space-outlet='scene'><Bound session={session} /></div></TooltipProvider></QueryClientProvider>);
  await screen.findByTestId('scene-native-boundary');
  act(() => session.select(ID, false));
  await screen.findByTestId('scene-right-panel');
  act(() => { viewport().onSkeletonState(ID, 'humanoid'); viewport().onSkeletonState(SECOND, 'humanoid'); });
  return { doc, session };
}

/** Turn joint mode on from the inspector and pick a joint in the viewport. */
async function enterJointMode(): Promise<void> {
  fireEvent.click(await screen.findByTestId('scene-pose-joint-mode'));
  expect(viewport().jointMode).toBe(true);
  act(() => viewport().onJointSelect(JOINT));
  expect(viewport().selectedJoint).toBe(JOINT);
}

/** Joint mode is off and no joint is selected. */
function expectJointModeOff(): void {
  expect(viewport().jointMode).toBe(false);
  expect(viewport().selectedJoint).toBeNull();
}

beforeEach(() => { vi.spyOn(document, 'hasFocus').mockReturnValue(true); viewportInputs.mockClear(); });
afterEach(() => { cleanup(); for (const owner of owners.splice(0)) { owner.session.destroy(); owner.doc.destroy(); owner.client.clear(); } useUIStore.getState().setActiveOverlayId(null); vi.restoreAllMocks(); });

describe('editor-owned pose state (inner#1692)', () => {
  it('shows the pose section only once the viewport reports the selected model\'s skeleton', async () => {
    const doc = new Y.Doc(); doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
    applySceneCommand(doc, { type: 'create', objects: [{ id: ID, name: 'Figure', model: { kind: 'builtin', id: 'figure' },
      position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false }] }, Symbol('fixture'), true);
    const session = new SceneSession(doc); session.setEnvironment(EDITABLE);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); owners.push({ doc, session, client });
    render(<QueryClientProvider client={client}><TooltipProvider><div data-space-outlet='scene'><Bound session={session} /></div></TooltipProvider></QueryClientProvider>);
    await screen.findByTestId('scene-native-boundary');
    expectJointModeOff();
    act(() => session.select(ID, false));
    expect(await screen.findByTestId('scene-properties-panel')).toBeVisible();
    expect(screen.queryByTestId('scene-pose-section')).toBeNull();
    act(() => viewport().onSkeletonState(ID, 'none'));
    expect(await screen.findByTestId('scene-pose-no-skeleton')).toHaveTextContent(t('spaces.threeD.pose.noSkeleton'));
    act(() => viewport().onSkeletonState(ID, 'humanoid'));
    expect(await screen.findByTestId('scene-pose-preset-sit')).toBeVisible();
    expect(screen.queryByTestId('scene-pose-no-skeleton')).toBeNull();
  });

  it('shows no transform tool as current while joint mode is on, and the current tool again once it is off', async () => {
    await setup();
    const move = (): HTMLElement => within(screen.getByTestId('scene-object-menu')).getByRole('button', { name: t('spaces.threeD.move') });
    expect(move().className).toContain('bg-foreground');
    await enterJointMode();
    for (const name of ['move', 'rotate', 'scale'] as const) {
      expect(within(screen.getByTestId('scene-object-menu')).getByRole('button', { name: t(`spaces.threeD.${name}`) }).className).not.toContain('bg-foreground');
    }
    fireEvent.click(screen.getByTestId('scene-pose-joint-mode'));
    expect(move().className).toContain('bg-foreground');
  });

  it('passes joint mode and the selected joint to the viewport, and clears the joint when the switch turns off', async () => {
    await setup();
    expectJointModeOff();
    await enterJointMode();
    expect(screen.getByTestId('scene-pose-joint-mode')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByTestId('scene-pose-joint-mode'));
    expectJointModeOff();
    expect(screen.getByTestId('scene-pose-joint-mode')).toHaveAttribute('aria-checked', 'false');
  });
});

describe('Escape order with joint mode (inner#1692)', () => {
  it.each(['canvas', 'switch'] as const)('leaves joint mode first from the %s, keeping the panel and selection, then closes the panel, then clears the selection', async (from) => {
    const { session } = await setup();
    await enterJointMode();
    const target = from === 'canvas' ? screen.getByTestId('scene-native-boundary') : screen.getByTestId('scene-pose-joint-mode');
    act(() => target.focus());
    fireEvent.keyDown(target, { key: 'Escape' });
    expectJointModeOff();
    expect(screen.getByTestId('scene-right-panel')).toBeVisible();
    expect(session.getSnapshot().selectedIds).toEqual([ID]);
    const canvas = screen.getByTestId('scene-native-boundary'); act(() => canvas.focus());
    fireEvent.keyDown(canvas, { key: 'Escape' });
    expect(screen.queryByTestId('scene-right-panel')).toBeNull();
    expect(session.getSnapshot().selectedIds).toEqual([ID]);
    fireEvent.keyDown(canvas, { key: 'Escape' });
    expect(session.getSnapshot().selectedIds).toEqual([]);
  });

  it('cancels an active joint drag first and stays in joint mode without writing', async () => {
    const { doc, session } = await setup();
    await enterJointMode();
    act(() => { session.beginGesture(); session.previewGesture([{ id: ID, pose: { [JOINT]: [0, 0, 0.3826834, 0.9238795] } }]); });
    expect(session.getSnapshot().gestureActive).toBe(true);
    const canvas = screen.getByTestId('scene-native-boundary'); act(() => canvas.focus());
    fireEvent.keyDown(canvas, { key: 'Escape' });
    expect(session.getSnapshot().gestureActive).toBe(false);
    expect(viewport().jointMode).toBe(true);
    expect(viewport().selectedJoint).toBe(JOINT);
    expect(screen.getByTestId('scene-right-panel')).toBeVisible();
    expect(session.getSnapshot().selectedIds).toEqual([ID]);
    expect(readSceneDocument(doc).objects.find((object) => object.id === ID)?.pose ?? {}).toEqual({});
    fireEvent.keyDown(canvas, { key: 'Escape' });
    expectJointModeOff();
    expect(screen.getByTestId('scene-right-panel')).toBeVisible();
  });
});

describe('leaving joint mode (inner#1692)', () => {
  it.each([
    { button: 'move', mode: 'translate' },
    { button: 'rotate', mode: 'rotate' },
    { button: 'scale', mode: 'scale' },
  ] as const)('leaves joint mode when the toolbar\'s $button tool is chosen', async ({ button, mode }) => {
    await setup();
    await enterJointMode();
    fireEvent.click(screen.getByRole('button', { name: t(`spaces.threeD.${button}`) }));
    expectJointModeOff();
    expect(viewport().mode).toBe(mode);
  });

  it.each([
    { change: 'another object is selected', apply: ({ session }: { doc: Y.Doc; session: SceneSession }): void => { session.select(SECOND, false); } },
    { change: 'the selection is cleared', apply: ({ session }: { doc: Y.Doc; session: SceneSession }): void => { session.select(null, false); } },
    { change: 'this user locks the object', apply: ({ session }: { doc: Y.Doc; session: SceneSession }): void => { session.execute({ type: 'lock', ids: [ID], locked: true }); } },
    { change: 'a collaborator locks the object', apply: ({ doc }: { doc: Y.Doc; session: SceneSession }): void => { applySceneCommand(doc, { type: 'lock', ids: [ID], locked: true }, Symbol('peer'), true); } },
    { change: 'the member becomes read-only', apply: ({ session }: { doc: Y.Doc; session: SceneSession }): void => { session.setEnvironment({ ...EDITABLE, readOnly: true }); } },
  ])('leaves joint mode when $change', async ({ apply }) => {
    const owner = await setup();
    await enterJointMode();
    act(() => apply(owner));
    expectJointModeOff();
  });

  it('leaves joint mode when the right panel switches away from properties', async () => {
    await setup();
    await enterJointMode();
    fireEvent.click(screen.getByTestId('scene-objects-trigger'));
    expect(await screen.findByTestId('scene-objects-panel')).toBeVisible();
    expectJointModeOff();
  });

  it('does not re-enter joint mode on its own after the selection comes back', async () => {
    const { session } = await setup();
    await enterJointMode();
    act(() => session.select(SECOND, false));
    act(() => session.select(ID, false));
    expectJointModeOff();
    expect(await screen.findByTestId('scene-pose-joint-mode')).toHaveAttribute('aria-checked', 'false');
  });
});
