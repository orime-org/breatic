// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import * as React from 'react';
import * as Y from 'yjs';
import { Unlock } from 'lucide-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { t, type SceneObject } from '@breatic/shared';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { applySceneCommand, readSceneDocument } from '@web/data/yjs/scene-document';
import { SceneSession } from '@web/data/yjs/scene-session';
import SceneEditor from '@web/spaces/three-d/SceneEditor';
import { useUIStore } from '@web/stores/ui';

vi.mock('@web/data/api/scene', () => ({
  getSceneControls: vi.fn(async () => ({ scaleSensitivity: 1 })),
  resolveSceneAsset: vi.fn(async () => ({ url: 'https://example.invalid/model.glb', mimeType: 'model/gltf-binary' })),
}));
vi.mock('@web/spaces/three-d/viewport/SceneViewport', () => ({
  default: (): React.JSX.Element => <canvas tabIndex={0} data-testid='scene-native-boundary' />,
}));
vi.mock('@web/lib/scene-view-storage', () => ({ readSceneView: () => null, writeSceneView: () => true }));
const ID = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const owners: Array<{ doc: Y.Doc; session: SceneSession; client: QueryClient }> = [];
function Bound({ session }: { session: SceneSession }): React.JSX.Element {
  const snapshot = React.useSyncExternalStore(session.subscribe, session.getSnapshot);
  return <SceneEditor projectId='project' spaceId='scene' userId='alice' session={session} snapshot={snapshot}
    connection={{ status: 'connected', synced: true }} namedPeers={[]}
    readObjects={() => readSceneDocument(session.doc).objects} ownsKeyboard={() => true} UnlockIcon={Unlock} />;
}
function setup(): { session: SceneSession; doc: Y.Doc; page: ReturnType<typeof render>; client: QueryClient } {
  const doc = new Y.Doc(); doc.getMap('scene').set('formatVersion', 1);
  const objects: SceneObject[] = [ID, SECOND].map((id, index) => ({ id, name: index ? 'Box' : 'Figure', model: { kind: 'builtin', id: 'box' }, position: [index, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false, exists: true }));
  applySceneCommand(doc, { type: 'create', objects }, Symbol('fixture'), true);
  const session = new SceneSession(doc);
  session.setEnvironment({ readOnly: false, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness: null });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); owners.push({ doc, session, client });
  const page = render(tree(session, client)); return { session, doc, page, client };
}
function tree(session: SceneSession, client: QueryClient, mode: 'visible' | 'hidden' = 'visible'): React.JSX.Element {
  return <QueryClientProvider client={client}><TooltipProvider><React.Activity mode={mode}><Bound session={session} /></React.Activity></TooltipProvider></QueryClientProvider>;
}
// jsdom clears its focused element before dispatching blur, unlike the browser.
beforeEach(() => { vi.spyOn(document, 'hasFocus').mockReturnValue(true); });
afterEach(() => { cleanup(); for (const owner of owners.splice(0)) { owner.session.destroy(); owner.doc.destroy(); owner.client.clear(); } useUIStore.getState().setActiveOverlayId(null); vi.restoreAllMocks(); });

describe('approved scene layout (inner#1724)', () => {
  it('keeps viewport actions conditional and orders the bottom-right controls', async () => {
    setup(); await screen.findByTestId('scene-native-boundary');
    expect(screen.queryByTestId('scene-object-menu')).toBeNull();
    expect(screen.queryByTestId('scene-right-panel')).toBeNull();
    expect(within(screen.getByTestId('scene-viewport-toolbar')).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      t('spaces.threeD.undo'), t('spaces.threeD.redo'), t('spaces.threeD.properties'), t('spaces.threeD.objects'), t('spaces.threeD.tasks'), t('spaces.threeD.minimap'),
    ]);
  });
  it.each([
    { state: 'unlocked object', ids: [ID], locked: [], action: 'lock', next: [true, false], second: [false, false] },
    { state: 'locked object', ids: [ID], locked: [ID], action: 'unlock', next: [false, false], second: [true, false] },
    { state: 'mixed selection', ids: [ID, SECOND], locked: [ID], action: 'lock', next: [true, true], second: [false, false] },
    { state: 'locked selection', ids: [ID, SECOND], locked: [ID, SECOND], action: 'unlock', next: [false, false], second: [true, true] },
  ] as const)('places the $state action before Close and applies it to the selection', async ({ ids, locked, action, next, second }) => {
    const { session, doc } = setup(); await screen.findByTestId('scene-native-boundary');
    act(() => {
      if (locked.length > 0) session.execute({ type: 'lock', ids: [...locked], locked: true });
      ids.forEach((id) => session.select(id, true));
    });
    const header = await screen.findByTestId('scene-panel-header');
    const button = within(header).getByRole('button', { name: t(`spaces.threeD.${action}`) });
    expect(within(header).getAllByRole('button')).toEqual([button, within(header).getByRole('button', { name: t('spaces.threeD.closePanel') })]);
    expect(button).toHaveAttribute('aria-pressed', String(action === 'unlock'));
    expect(within(await screen.findByTestId('scene-properties-panel')).queryByRole('button', { name: t(`spaces.threeD.${action}`) })).toBeNull();
    fireEvent.click(button);
    expect([ID, SECOND].map((id) => readSceneDocument(doc).objects.find((object) => object.id === id)?.locked)).toEqual(next);
    expect(session.getSnapshot().selectedIds).toEqual(ids);
    expect(screen.getByTestId('scene-right-panel')).toBeVisible();
    expect(button).toHaveAttribute('aria-pressed', String(action === 'lock'));
    fireEvent.click(button);
    expect([ID, SECOND].map((id) => readSceneDocument(doc).objects.find((object) => object.id === id)?.locked)).toEqual(second);
  });
  it('reserves the selection lock for properties and keeps it disabled for viewers', async () => {
    const { session } = setup(); await screen.findByTestId('scene-native-boundary');
    fireEvent.click(screen.getByTestId('scene-objects-trigger'));
    expect(screen.queryByTestId('scene-selection-lock')).toBeNull();
    act(() => session.select(ID, false));
    const lock = await screen.findByTestId('scene-selection-lock');
    act(() => session.setEnvironment({ readOnly: true, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness: null }));
    expect(lock).toBeDisabled();
    fireEvent.click(lock);
    expect(session.getSnapshot().objects.find((object) => object.id === ID)?.locked).toBe(false);
    fireEvent.click(screen.getByTestId('scene-tasks-trigger'));
    expect(screen.queryByTestId('scene-selection-lock')).toBeNull();
  });
  it.each(['properties', 'objects', 'tasks'] as const)('toggles the $0 panel from its entry and also closes from the header', async (panel) => {
    const { session } = setup(); await screen.findByTestId('scene-native-boundary');
    act(() => session.select(ID, false));
    await screen.findByTestId('scene-right-panel');
    fireEvent.click(screen.getByRole('button', { name: t('spaces.threeD.closePanel') }));
    const trigger = screen.getByTestId(`scene-${panel}-trigger`);
    fireEvent.click(trigger);
    expect(await screen.findByTestId(`scene-${panel}-panel`)).toBeVisible();
    fireEvent.click(trigger);
    expect(screen.queryByTestId('scene-right-panel')).toBeNull();
    fireEvent.click(trigger);
    expect(await screen.findByTestId(`scene-${panel}-panel`)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: t('spaces.threeD.closePanel') }));
    expect(screen.queryByTestId('scene-right-panel')).toBeNull();
    fireEvent.click(trigger);
    expect(await screen.findByTestId(`scene-${panel}-panel`)).toBeVisible();
  });
  it('opens properties for selection-set changes while model updates preserve the chosen panel', async () => {
    const { session } = setup(); await screen.findByTestId('scene-native-boundary');
    act(() => session.select(ID, false));
    expect(await screen.findByLabelText(t('spaces.threeD.name'))).toHaveValue('Figure');
    fireEvent.click(screen.getByTestId('scene-tasks-trigger'));
    expect(await screen.findByTestId('scene-tasks-panel')).toHaveTextContent(t('spaces.threeD.generationDev'));
    act(() => session.execute({ type: 'patch', patches: [{ id: ID, position: [4, 0, 0] }] }));
    expect(screen.getByTestId('scene-tasks-panel')).toHaveTextContent(t('spaces.threeD.generationDev'));
    act(() => session.select(SECOND, true));
    expect(await screen.findByText(t('spaces.threeD.selectedCount', { count: 2 }))).toBeVisible();
    expect(screen.getByTestId('scene-object-menu')).toBeVisible();
  });
  it('cancels a field draft before dismissing its panel and consumes panel Escape before scene selection', async () => {
    const { session, doc } = setup(); await screen.findByTestId('scene-native-boundary');
    act(() => session.select(ID, false));
    const input = await screen.findByLabelText(t('spaces.threeD.name'));
    fireEvent.focus(input); input.focus(); fireEvent.change(input, { target: { value: 'Uncommitted draft' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveValue('Figure');
    expect(screen.getByTestId('scene-right-panel')).toBeVisible();
    expect(readSceneDocument(doc).objects.find((object) => object.id === ID)?.name).toBe('Figure');
    const canvas = screen.getByTestId('scene-native-boundary'); canvas.focus();
    fireEvent.keyDown(canvas, { key: 'Escape' });
    expect(screen.queryByTestId('scene-right-panel')).toBeNull();
    expect(session.getSnapshot().selectedIds).toEqual([ID]);
    fireEvent.keyDown(canvas, { key: 'Escape' });
    expect(session.getSnapshot().selectedIds).toEqual([]);
  });
  it('shows the approved generation capability state with disabled fields', async () => {
    setup(); await screen.findByTestId('scene-native-boundary');
    fireEvent.click(screen.getByRole('button', { name: t('spaces.threeD.generate') }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(t('spaces.threeD.generationDev'));
    expect(within(dialog).getByLabelText(t('spaces.threeD.prompt'))).toBeDisabled();
    expect(within(dialog).getByLabelText(t('spaces.threeD.reference'))).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: t('spaces.threeD.submit') })).toBeDisabled();
  });
  it('keeps focus in the shared panel when an object row opens its properties', async () => {
    setup(); await screen.findByTestId('scene-native-boundary');
    fireEvent.click(screen.getByTestId('scene-objects-trigger'));
    const row = await screen.findByTestId(`scene-object-${ID}`); row.focus();
    fireEvent.click(row);
    expect(await screen.findByLabelText(t('spaces.threeD.name'))).toHaveValue('Figure');
    expect(screen.getByTestId('scene-right-panel')).toHaveFocus();
  });
  it.each([
    { action: 'selects the first object', initial: [], target: ID, shift: false, selected: [ID] },
    { action: 'opens the already selected object', initial: [ID], target: ID, shift: false, selected: [ID] },
    { action: 'adds a second selection', initial: [ID], target: SECOND, shift: true, selected: [ID, SECOND] },
    { action: 'removes one of two selections', initial: [ID, SECOND], target: ID, shift: true, selected: [SECOND] },
    { action: 'clears the last selection', initial: [ID], target: ID, shift: true, selected: [] },
  ])('routes the list to the resulting selection when it $action', async ({ initial, target, shift, selected }) => {
    const { session } = setup(); await screen.findByTestId('scene-native-boundary');
    act(() => initial.forEach((id) => session.select(id, true)));
    fireEvent.click(screen.getByTestId('scene-objects-trigger'));
    const row = await screen.findByTestId(`scene-object-${target}`); row.focus();
    fireEvent.click(row, { shiftKey: shift });
    expect(session.getSnapshot().selectedIds).toEqual(selected);
    if (selected.length === 0) {
      expect(screen.getByTestId('scene-objects-panel')).toBeVisible();
      expect(row).toHaveFocus();
      expect(screen.queryByTestId('scene-properties-panel')).toBeNull();
      expect(screen.queryByTestId('scene-object-menu')).toBeNull();
    } else {
      expect(screen.getByTestId('scene-properties-panel')).toBeVisible();
      expect(screen.getByTestId('scene-right-panel')).toHaveFocus();
      if (selected.length === 1) expect(screen.getByLabelText(t('spaces.threeD.name'))).toHaveValue(selected[0] === ID ? 'Figure' : 'Box');
      else expect(screen.getByText(t('spaces.threeD.selectedCount', { count: selected.length }))).toBeVisible();
    }
  });
  it.each([
    { key: 'Enter', isComposing: true, keyCode: 13 },
    { key: 'Escape', isComposing: true, keyCode: 27 },
    { key: 'Enter', isComposing: false, keyCode: 229 },
    { key: 'Escape', isComposing: false, keyCode: 229 },
  ])('leaves the field draft to the input method for $key (composing=$isComposing, code=$keyCode)', async (event) => {
    const { session, doc } = setup(); await screen.findByTestId('scene-native-boundary');
    act(() => session.select(ID, false));
    const input = await screen.findByLabelText(t('spaces.threeD.name')); input.focus();
    fireEvent.change(input, { target: { value: 'Composition draft' } });
    fireEvent.keyDown(input, event);
    expect(input).toHaveFocus();
    expect(input).toHaveValue('Composition draft');
    expect(readSceneDocument(doc).objects.find((object) => object.id === ID)?.name).toBe('Figure');
    expect(screen.getByTestId('scene-right-panel')).toBeVisible();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(readSceneDocument(doc).objects.find((object) => object.id === ID)?.name).toBe('Composition draft');
  });
  it('withdraws open portals when Activity hides the Space and preserves selection', async () => {
    const { session, page, client } = setup(); await screen.findByTestId('scene-native-boundary');
    act(() => session.select(ID, false)); await screen.findByTestId('scene-right-panel');
    await act(async () => page.rerender(tree(session, client, 'hidden')));
    expect(screen.getByTestId('scene-right-panel')).not.toBeVisible();
    expect(session.getSnapshot().selectedIds).toEqual([ID]);
    expect(useUIStore.getState().activeOverlayId).toBeNull();
  });
  it('retains viewer browsing and disables shared mutation controls', async () => {
    const { session } = setup(); await screen.findByTestId('scene-native-boundary');
    act(() => { session.setEnvironment({ readOnly: true, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness: null }); session.select(ID, false); });
    expect(await screen.findByLabelText(t('spaces.threeD.name'))).toBeDisabled();
    expect(screen.getByRole('button', { name: t('spaces.threeD.add') })).toBeDisabled();
    expect(screen.getByRole('button', { name: t('spaces.threeD.move') })).toBeDisabled();
    expect(screen.getByRole('button', { name: t('spaces.threeD.duplicate') })).toBeDisabled();
    expect(screen.getByRole('button', { name: t('spaces.threeD.focus') })).toBeEnabled();
    expect(screen.getByTestId('scene-objects-trigger')).toBeEnabled();
  });
  it('commits a numeric draft against the latest peer transform', async () => {
    const { session, doc } = setup(); await screen.findByTestId('scene-native-boundary');
    act(() => session.select(ID, false));
    const inspector = await screen.findByTestId('scene-properties-panel');
    const field = within(within(inspector).getByRole('group', { name: t('spaces.threeD.position') })).getByLabelText('X', { exact: true });
    field.focus(); fireEvent.change(field, { target: { value: '2.5' } });
    act(() => { applySceneCommand(doc, { type: 'patch', patches: [{ id: ID, position: [0, 7, 0] }] }, Symbol('peer'), true); });
    await act(async () => { fireEvent.blur(field); });
    expect(readSceneDocument(doc).objects.find((object) => object.id === ID)?.position).toEqual([2.5, 7, 0]);
  });

  it('cancels the active transform before dismissing properties and keeps peer changes', async () => {
    const { session, doc } = setup(); await screen.findByTestId('scene-native-boundary');
    act(() => session.select(ID, false)); await screen.findByTestId('scene-right-panel');
    act(() => { session.beginGesture(); session.previewGesture([{ id: ID, position: [9, 0, 0] }]); });
    act(() => { applySceneCommand(doc, { type: 'patch', patches: [{ id: ID, name: 'Peer name' }] }, Symbol('peer'), true); });
    const canvas = screen.getByTestId('scene-native-boundary'); canvas.focus();
    fireEvent.keyDown(canvas, { key: 'Escape' });
    expect(session.getSnapshot().gestureActive).toBe(false);
    expect(session.getSnapshot().selectedIds).toEqual([ID]);
    expect(screen.getByTestId('scene-right-panel')).toBeVisible();
    expect(readSceneDocument(doc).objects.find((object) => object.id === ID)).toMatchObject({ name: 'Peer name', position: [0, 0, 0] });
    expect(session.getSnapshot().objects.find((object) => object.id === ID)?.position).toEqual([0, 0, 0]);
  });

});
