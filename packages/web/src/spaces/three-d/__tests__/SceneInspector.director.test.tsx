// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from 'react';
import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { t, SCENE_FORMAT_VERSION, type SceneObject } from '@breatic/shared';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { applySceneCommand, readSceneDocument } from '@web/data/yjs/scene-document';
import { SceneSession } from '@web/data/yjs/scene-session';
import { SceneInspector } from '@web/spaces/three-d/SceneInspector';
import { SceneDirectorFields } from '@web/spaces/three-d/SceneDirectorFields';
import { SceneField } from '@web/spaces/three-d/SceneField';

const NAME = 'project-p1/3d-s1';
const ID = '00000000-0000-4000-8000-000000000001';
const POSE = { position: [0, 1, 4], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false };
const owners: Array<{ doc: Y.Doc; session: SceneSession }> = [];

afterEach(() => { cleanup(); for (const owner of owners.splice(0)) { owner.session.destroy(); owner.doc.destroy(); } });

/**
 * The real inspector on one selected record.
 * @param record - A camera or light.
 */
function show(record: Record<string, unknown>): void {
  const doc = new Y.Doc(); doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
  if (!applySceneCommand(doc, { type: 'create', objects: [{ id: ID, ...POSE, ...record } as unknown as SceneObject] }, Symbol('fixture'), true, NAME, { maxLights: 16 }).ok) {
    throw new Error('fixture create refused');
  }
  const session = new SceneSession(doc, NAME);
  session.setEnvironment({ readOnly: false, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness: null });
  session.select(ID, false);
  owners.push({ doc, session });
  render(<TooltipProvider><SceneInspector DirectorFields={SceneDirectorFields} spaceId='scene' session={session} snapshot={session.getSnapshot()} namedPeers={[]} Field={SceneField}
    fieldDrafts={new Map()} onFieldDraftChange={() => undefined} readObjects={() => readSceneDocument(doc).objects}
    skeletonStates={new Map()} jointMode={false} onJointModeChange={() => undefined} /></TooltipProvider>);
}

const legends = (): string[] => screen.queryAllByRole('group').map((group) => group.querySelector('legend')?.textContent ?? '');

describe('properties of a camera or a light (inner#1694 design 3.2)', () => {
  it('shows a camera\'s position, rotation, lens and frame, without scale', () => {
    show({ name: 'Camera 1', model: { kind: 'camera' }, number: 1, focalLength: 50, frame: '16:9' });
    expect(legends()).toEqual([t('spaces.threeD.position'), t('spaces.threeD.rotation')]);
    expect(screen.getByText(t('spaces.threeD.focalLength'))).toBeInTheDocument();
    expect(screen.getByText(t('spaces.threeD.frame'))).toBeInTheDocument();
  });

  it('shows a point light\'s position and light fields, without rotation or scale', () => {
    show({ name: 'Light 1', model: { kind: 'light', type: 'point' }, number: 1, color: '#ffffff', intensity: 40, castShadow: true });
    expect(legends()).toEqual([t('spaces.threeD.position')]);
    expect(screen.getByText(t('spaces.threeD.intensity'))).toBeInTheDocument();
    expect(screen.queryByText(t('spaces.threeD.angle'))).toBeNull();
  });

  it('shows a spotlight\'s angle', () => {
    show({ name: 'Spotlight 1', model: { kind: 'light', type: 'spot' }, number: 1, color: '#ffffff', intensity: 40, castShadow: true, angle: 30 });
    expect(legends()).toEqual([t('spaces.threeD.position'), t('spaces.threeD.rotation')]);
    expect(screen.getByText(t('spaces.threeD.angle'))).toBeInTheDocument();
  });
});
