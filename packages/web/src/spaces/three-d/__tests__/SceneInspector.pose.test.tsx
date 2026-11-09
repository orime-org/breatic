// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import * as React from 'react';
import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { t, SCENE_FORMAT_VERSION, type SceneObject } from '@breatic/shared';
import en from '@locales/en.json';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { applySceneCommand, readSceneDocument } from '@web/data/yjs/scene-document';
import { SceneSession } from '@web/data/yjs/scene-session';
import { SceneInspector } from '@web/spaces/three-d/SceneInspector';
import { SceneField, type SceneFieldDraft } from '@web/spaces/three-d/SceneField';
import { POSE_PRESETS } from '@web/spaces/three-d/viewport/pose-presets';

type SkeletonState = 'none' | 'humanoid' | 'other';
const ID = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const PRESETS = ['stand', 'sit', 'lie', 'walk', 'wave'] as const;
// A non-humanoid bone key the user posed earlier; presets and reset replace the whole pose.
const EARLIER_POSE = { 'n:Tail_01': [0, 0, 0.3826834, 0.9238795] } as const;
const owners: Array<{ doc: Y.Doc; session: SceneSession }> = [];

afterEach(() => { cleanup(); for (const owner of owners.splice(0)) { owner.session.destroy(); owner.doc.destroy(); } vi.restoreAllMocks(); });

/**
 * Subscribe the real inspector to a real document session with the editor-owned pose inputs.
 * @param root0 - Inputs supplied by the editor.
 * @param root0.session - The shared command and selection owner.
 * @param root0.skeletonStates - What the viewport reported for each loaded object.
 * @param root0.jointMode - Whether joint mode is on.
 * @param root0.onJointModeChange - Receives the switch's requested state.
 * @returns The inspector.
 */
function Bound({ session, skeletonStates, jointMode, onJointModeChange }: { session: SceneSession; skeletonStates: ReadonlyMap<string, SkeletonState>;
  jointMode: boolean; onJointModeChange: (next: boolean) => void; }): React.JSX.Element {
  const snapshot = React.useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [fieldDrafts, setFieldDrafts] = React.useState<ReadonlyMap<string, SceneFieldDraft>>(new Map());
  const onFieldDraftChange = React.useCallback((key: string, draft: SceneFieldDraft | undefined): void => {
    setFieldDrafts((previous) => { const next = new Map(previous); if (draft) next.set(key, draft); else next.delete(key); return next; });
  }, []);
  return <TooltipProvider><SceneInspector spaceId='scene' session={session} snapshot={snapshot} namedPeers={[]} Field={SceneField}
    fieldDrafts={fieldDrafts} onFieldDraftChange={onFieldDraftChange} readObjects={() => readSceneDocument(session.doc).objects}
    skeletonStates={skeletonStates} jointMode={jointMode} onJointModeChange={onJointModeChange} /></TooltipProvider>;
}

/**
 * Seed two figures, the first carrying an earlier pose, and select the first.
 * @param options - Fixture variations.
 * @param options.states - Skeleton state reported per object.
 * @param options.jointMode - Editor joint mode.
 * @param options.readOnly - Whether this member can only view.
 * @param options.locked - Whether the selected object is locked.
 * @returns The document, session and switch callback.
 */
function setup({ states = new Map<string, SkeletonState>([[ID, 'humanoid']]), jointMode = false, readOnly = false, locked = false }: {
  states?: ReadonlyMap<string, SkeletonState>; jointMode?: boolean; readOnly?: boolean; locked?: boolean;
} = {}): { doc: Y.Doc; session: SceneSession; onJointModeChange: ReturnType<typeof vi.fn> } {
  const doc = new Y.Doc(); doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
  const objects: SceneObject[] = [ID, SECOND].map((id, index) => ({ id, name: index ? 'Second' : 'Figure', model: { kind: 'builtin', id: 'figure' },
    position: [index, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false, ...(index === 0 && { pose: EARLIER_POSE }) }));
  if (!applySceneCommand(doc, { type: 'create', objects }, Symbol('fixture'), true).ok) throw new Error('fixture create refused');
  if (locked && !applySceneCommand(doc, { type: 'lock', ids: [ID], locked: true }, Symbol('fixture'), true).ok) throw new Error('fixture lock refused');
  const session = new SceneSession(doc);
  session.setEnvironment({ readOnly, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness: null });
  session.select(ID, false);
  owners.push({ doc, session });
  const onJointModeChange = vi.fn();
  render(<Bound session={session} skeletonStates={states} jointMode={jointMode} onJointModeChange={onJointModeChange} />);
  return { doc, session, onJointModeChange };
}

/** The committed pose of the selected object, with an absent pose read as the rest pose. */
function committedPose(doc: Y.Doc): Readonly<Record<string, readonly number[]>> {
  return readSceneDocument(doc).objects.find((object) => object.id === ID)?.pose ?? {};
}

describe('pose section locale keys (inner#1692)', () => {
  it.each(['title', 'stand', 'sit', 'lie', 'walk', 'wave', 'jointMode', 'reset', 'noSkeleton', 'humanoidOnly'] as const)('defines spaces.threeD.pose.%s in English', (key) => {
    const pose = (en as unknown as { spaces: { threeD: { pose?: Record<string, unknown> } } }).spaces.threeD.pose;
    expect(typeof pose?.[key]).toBe('string');
    expect(String(pose?.[key]).trim()).not.toBe('');
    expect(t(`spaces.threeD.pose.${key}`)).toBe(pose?.[key]);
  });
});

describe('pose section by skeleton state (inner#1692)', () => {
  it('is absent while the selected model has reported no state yet', () => {
    setup({ states: new Map() });
    expect(screen.getByTestId('scene-properties-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('scene-pose-section')).toBeNull();
  });

  it('says a model without a skeleton cannot be posed and offers no pose control', () => {
    setup({ states: new Map<string, SkeletonState>([[ID, 'none']]) });
    const section = screen.getByTestId('scene-pose-section');
    expect(section).toHaveTextContent(t('spaces.threeD.pose.title'));
    expect(within(section).getByTestId('scene-pose-no-skeleton')).toHaveTextContent(t('spaces.threeD.pose.noSkeleton'));
    expect(within(section).queryByTestId('scene-pose-joint-mode')).toBeNull();
    expect(within(section).queryByTestId('scene-pose-reset')).toBeNull();
    expect(within(section).queryByTestId('scene-pose-humanoid-only')).toBeNull();
    for (const name of PRESETS) expect(within(section).queryByTestId(`scene-pose-preset-${name}`)).toBeNull();
  });

  it('offers the five presets, joint mode and reset for a humanoid', () => {
    setup({ states: new Map<string, SkeletonState>([[ID, 'humanoid']]) });
    const section = screen.getByTestId('scene-pose-section');
    expect(section).toHaveTextContent(t('spaces.threeD.pose.title'));
    for (const name of PRESETS) expect(within(section).getByTestId(`scene-pose-preset-${name}`)).toHaveTextContent(t(`spaces.threeD.pose.${name}`));
    expect(within(section).getByTestId('scene-pose-joint-mode')).toHaveAttribute('role', 'switch');
    expect(section).toHaveTextContent(t('spaces.threeD.pose.jointMode'));
    expect(within(section).getByTestId('scene-pose-reset')).toHaveTextContent(t('spaces.threeD.pose.reset'));
    expect(within(section).queryByTestId('scene-pose-no-skeleton')).toBeNull();
    expect(within(section).queryByTestId('scene-pose-humanoid-only')).toBeNull();
  });

  it('says presets are humanoid-only for another skeleton and still offers joint mode and reset', () => {
    setup({ states: new Map<string, SkeletonState>([[ID, 'other']]) });
    const section = screen.getByTestId('scene-pose-section');
    expect(within(section).getByTestId('scene-pose-humanoid-only')).toHaveTextContent(t('spaces.threeD.pose.humanoidOnly'));
    for (const name of PRESETS) expect(within(section).queryByTestId(`scene-pose-preset-${name}`)).toBeNull();
    expect(within(section).getByTestId('scene-pose-joint-mode')).toHaveAttribute('role', 'switch');
    expect(within(section).getByTestId('scene-pose-reset')).toHaveTextContent(t('spaces.threeD.pose.reset'));
    expect(within(section).queryByTestId('scene-pose-no-skeleton')).toBeNull();
  });

  it('follows the state of the selected object, not another object\'s', () => {
    setup({ states: new Map<string, SkeletonState>([[ID, 'none'], [SECOND, 'humanoid']]) });
    expect(screen.getByTestId('scene-pose-no-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('scene-pose-preset-stand')).toBeNull();
  });

  it('is not shown for a multiple selection', () => {
    const { session } = setup({ states: new Map<string, SkeletonState>([[ID, 'humanoid'], [SECOND, 'humanoid']]) });
    act(() => session.select(SECOND, true));
    expect(screen.getByText(t('spaces.threeD.selectedCount', { count: 2 }))).toBeInTheDocument();
    expect(screen.queryByTestId('scene-pose-section')).toBeNull();
  });
});

describe('pose commands (inner#1692)', () => {
  it.each(PRESETS)('applies the %s preset as one pose command replacing the whole pose, undone in one step', (name) => {
    const { doc, session } = setup();
    const execute = vi.spyOn(session, 'execute');
    fireEvent.click(screen.getByTestId(`scene-pose-preset-${name}`));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ type: 'pose', id: ID, set: POSE_PRESETS[name], replace: true });
    expect(committedPose(doc)).toEqual(POSE_PRESETS[name]);
    // Position and rotation stay where they were.
    expect(readSceneDocument(doc).objects.find((object) => object.id === ID)).toMatchObject({ position: [0, 0, 0], rotation: [0, 0, 0, 1] });
    act(() => { session.historyStep('undo'); });
    expect(committedPose(doc)).toEqual(EARLIER_POSE);
  });

  it('resets to the rest pose with one pose command clearing every pose key', () => {
    const { doc, session } = setup();
    const execute = vi.spyOn(session, 'execute');
    fireEvent.click(screen.getByTestId('scene-pose-reset'));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ type: 'pose', id: ID, set: {}, replace: true });
    expect(committedPose(doc)).toEqual({});
  });

  it('resets a non-humanoid skeleton the same way', () => {
    const { doc, session } = setup({ states: new Map<string, SkeletonState>([[ID, 'other']]) });
    const execute = vi.spyOn(session, 'execute');
    fireEvent.click(screen.getByTestId('scene-pose-reset'));
    expect(execute).toHaveBeenCalledWith({ type: 'pose', id: ID, set: {}, replace: true });
    expect(committedPose(doc)).toEqual({});
  });

  it.each([false, true])('asks the editor for the opposite joint mode when the switch is pressed (on=%s)', (jointMode) => {
    const { onJointModeChange } = setup({ jointMode });
    const toggle = screen.getByTestId('scene-pose-joint-mode');
    expect(toggle).toHaveAttribute('aria-checked', String(jointMode));
    fireEvent.click(toggle);
    expect(onJointModeChange).toHaveBeenCalledTimes(1);
    expect(onJointModeChange).toHaveBeenCalledWith(!jointMode);
  });
});

describe('pose controls follow the transform fields\' disabled rule (inner#1692)', () => {
  it.each([
    { reason: 'read-only member', state: 'humanoid', readOnly: true, locked: false },
    { reason: 'locked object', state: 'humanoid', readOnly: false, locked: true },
    { reason: 'read-only member', state: 'other', readOnly: true, locked: false },
    { reason: 'locked object', state: 'other', readOnly: false, locked: true },
  ] as const)('disables every pose control of a $state skeleton for a $reason', ({ state, readOnly, locked }) => {
    const { doc, session, onJointModeChange } = setup({ states: new Map<string, SkeletonState>([[ID, state]]), readOnly, locked });
    const execute = vi.spyOn(session, 'execute');
    const buttons = [...(state === 'humanoid' ? PRESETS.map((name) => screen.getByTestId(`scene-pose-preset-${name}`)) : []),
      screen.getByTestId('scene-pose-reset'), screen.getByTestId('scene-pose-joint-mode')];
    for (const button of buttons) expect(button).toBeDisabled();
    for (const button of buttons) fireEvent.click(button);
    expect(execute).not.toHaveBeenCalled();
    expect(onJointModeChange).not.toHaveBeenCalled();
    expect(committedPose(doc)).toEqual(EARLIER_POSE);
    // The rule is the same one the transform fields use.
    expect(screen.getByLabelText(t('spaces.threeD.name'))).toBeDisabled();
  });

  it('enables every pose control for an editor on an unlocked object', () => {
    setup();
    for (const name of PRESETS) expect(screen.getByTestId(`scene-pose-preset-${name}`)).toBeEnabled();
    expect(screen.getByTestId('scene-pose-reset')).toBeEnabled();
    expect(screen.getByTestId('scene-pose-joint-mode')).toBeEnabled();
  });
});
