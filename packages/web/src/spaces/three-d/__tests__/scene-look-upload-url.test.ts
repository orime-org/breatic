// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A part picture is settled by its address (inner#2171 design §4): the uploading row ends when collab says it wrote
 * the stored picture's address, and stays while a settlement names anything else.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { SCENE_FORMAT_VERSION } from '@breatic/shared';

import { applySceneCommand } from '@web/data/yjs/scene-document';
import { SceneSession } from '@web/data/yjs/scene-session';
import { createSceneLookUploads } from '@web/spaces/three-d/scene-look-uploads';

const NAME = 'project-p1/3d-s1';
const ID = '11111111-1111-4111-8111-111111111111';
const ASSET = '77777777-7777-4777-8777-777777777777';
const STORED_URL = 'https://assets.example.test/u.png';
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/**
 * A holder whose upload stores the picture at {@link STORED_URL}.
 * @returns It.
 */
function holder(): ReturnType<typeof createSceneLookUploads> {
  const doc = new Y.Doc();
  doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
  applySceneCommand(doc, { type: 'create', objects: [{ id: ID, name: 'Figure', model: { kind: 'builtin', id: 'figure' }, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false }] }, Symbol(), true, NAME);
  const awareness = new Awareness(doc);
  const session = new SceneSession(doc, NAME);
  session.setEnvironment({ readOnly: false, connected: true, hasEverSynced: true, writeAccess: 'granted', refused: false, awareness });
  cleanups.push(() => { session.destroy(); awareness.destroy(); doc.destroy(); });
  return createSceneLookUploads({
    upload: vi.fn(async () => ({ assetId: ASSET, fileUrl: STORED_URL, kind: 'image', width: 64, height: 64, coverUrl: null, durationSeconds: null, mimeType: 'image/png', sizeBytes: 10 })),
    notify: vi.fn(), register: vi.fn(), unregister: vi.fn(), invalidateImages: vi.fn(),
    readLocalSize: async () => ({ width: 64, height: 64, type: 'png' }),
    size: async () => ({ width: 64, height: 64, type: 'png' }),
    session: () => session,
  } as never);
}

/** Lets pending promises settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

/**
 * Upload a picture onto part 0 and wait for the bytes to be stored.
 * @param uploads - The holder.
 */
async function uploadOnto(uploads: ReturnType<typeof createSceneLookUploads>): Promise<void> {
  await uploads.start({
    projectId: 'p1', spaceId: 's1', name: NAME, objectId: ID, part: '0', file: new File(['x'], 'pattern.png', { type: 'image/png' }),
    ownBytes: 0, clampBytes: {}, limits: { maxTextureEdge: 8192, maxTextureBytes: 268_435_456, maxPictureHeaderBytes: 12_345_678 },
  } as never);
  await settle();
}

describe('part pictures settle by address (inner#2171)', () => {
  it('ends the uploading row when collab wrote the stored address', async () => {
    const uploads = holder();
    await uploadOnto(uploads);
    expect(uploads.get('s1', ID, '0')).toBeDefined();
    uploads.settled({ spaceId: 's1', objectId: ID, part: '0', picture: STORED_URL, outcome: 'written' });
    expect(uploads.get('s1', ID, '0')).toBeUndefined();
  });

  it('keeps the row while a settlement names the asset id', async () => {
    const uploads = holder();
    await uploadOnto(uploads);
    uploads.settled({ spaceId: 's1', objectId: ID, part: '0', picture: ASSET, outcome: 'written' });
    expect(uploads.get('s1', ID, '0')).toBeDefined();
  });
});
