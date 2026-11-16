// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { SCENE_FORMAT_VERSION } from '@breatic/shared';

import { SceneSession } from '@web/data/yjs/scene-session';

const NAME = 'project-p1/3d-s1';
const owned: Array<{ doc: Y.Doc; session: SceneSession; awareness: Awareness }> = [];
const VIEW = { position: [1, 2, 3] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 45 };

/**
 * A visible, focused, connected session over a fresh scene with a real awareness.
 * @returns The session and its awareness.
 */
function setup(): { session: SceneSession; awareness: Awareness } {
  const doc = new Y.Doc();
  doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
  const awareness = new Awareness(doc);
  const session = new SceneSession(doc, NAME);
  session.setEnvironment({ readOnly: false, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness });
  session.setVisible(true);
  session.setFocused(true);
  owned.push({ doc, session, awareness });
  return { session, awareness };
}

/**
 * Read the published 3D camera.
 * @param awareness - The awareness.
 * @returns The field, or null.
 */
function camera3d(awareness: Awareness): Record<string, unknown> | null {
  const state = awareness.getLocalState() as { camera3d?: Record<string, unknown> | null } | null;
  return state?.camera3d ?? null;
}

afterEach(() => {
  for (const { doc, session, awareness } of owned.splice(0)) {
    session.destroy();
    awareness.destroy();
    doc.destroy();
  }
});

describe('SceneSession camera3d', () => {
  it('publishes the camera with wall-clock time', async () => {
    const { session, awareness } = setup();
    const before = Date.now();
    session.setCamera(VIEW);
    await vi.waitFor(() => expect(camera3d(awareness)).toMatchObject(VIEW));
    expect(camera3d(awareness)?.at as number).toBeGreaterThanOrEqual(before);
  });

  it('keeps the camera when the window loses focus', async () => {
    const { session, awareness } = setup();
    session.setCamera(VIEW);
    await vi.waitFor(() => expect(camera3d(awareness)).not.toBeNull());
    session.setFocused(false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(camera3d(awareness)).toMatchObject(VIEW);
  });

  it('withdraws the camera at once when the view is hidden or the session ends', async () => {
    const { session, awareness } = setup();
    session.setCamera(VIEW);
    await vi.waitFor(() => expect(camera3d(awareness)).not.toBeNull());
    session.setVisible(false);
    expect(camera3d(awareness)).toBeNull();
    session.setVisible(true);
    await vi.waitFor(() => expect(camera3d(awareness)).not.toBeNull());
    session.destroy();
    expect(camera3d(awareness)).toBeNull();
  });
});
