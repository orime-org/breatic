// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * A scene keeps imported models and part pictures as addresses (inner#2171 design §3.2). The format version stays 2:
 * an object still holding an asset id reads as an invalid object, and the rest of the scene opens and edits as before.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';
import { SCENE_FORMAT_VERSION } from '@breatic/shared';

import { readSceneDocument } from '@web/data/yjs/scene-document';

const ASSET = '22222222-2222-4222-8222-222222222222';
const BASE = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false };
const NEW_MODEL = { kind: 'asset', url: 'https://cdn.example/assets/figure.glb', mimeType: 'model/gltf-binary', sizeBytes: 2048 };

type Kind = 'builtin' | 'newModel' | 'oldModel' | 'oldPicture' | 'newPicture';

/**
 * A ready scene with one object per entry.
 * @param kinds - What each object holds.
 * @returns The document and each object's id.
 */
function scene(kinds: readonly Kind[]): { doc: Y.Doc; ids: string[] } {
  const doc = new Y.Doc();
  doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
  const objects = doc.getMap('objects');
  const ids = kinds.map((kind, index) => {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const record = new Y.Map<unknown>();
    objects.set(id, record);
    const fields: Record<string, unknown> = { ...BASE, name: kind };
    if (kind === 'builtin') fields.model = { kind: 'builtin', id: 'box' };
    if (kind === 'newModel' || kind === 'newPicture') fields.model = NEW_MODEL;
    if (kind === 'oldModel') fields.model = { kind: 'asset', assetId: ASSET };
    if (kind === 'oldPicture') { fields.model = NEW_MODEL; fields['look.0.map'] = ASSET; }
    if (kind === 'newPicture') fields['look.0.map'] = 'https://cdn.example/assets/wood.png';
    for (const [key, value] of Object.entries(fields)) record.set(key, value);
    return id;
  });
  return { doc, ids };
}

describe('scene media stored as addresses (inner#2171)', () => {
  it('opens a model and a part picture stored by address', () => {
    const { doc, ids } = scene(['newModel', 'newPicture']);
    const read = readSceneDocument(doc);
    expect(read.status).toBe('ready');
    expect(read.objects.map((object) => object.id).sort()).toEqual([...ids].sort());
    expect(read.invalidObjects).toEqual([]);
  });

  it('isolates objects still holding an asset id and opens the rest', () => {
    const { doc, ids } = scene(['oldModel', 'oldPicture', 'builtin', 'newModel']);
    const before = Y.encodeStateAsUpdate(doc);
    const read = readSceneDocument(doc);
    expect(read.status).toBe('ready');
    expect(read.objects.map((object) => object.id).sort()).toEqual([ids[2], ids[3]].sort());
    expect(read.invalidObjects.map((object) => object.id).sort()).toEqual([ids[0], ids[1]].sort());
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('opens a version 2 scene that holds only built-in shapes, or nothing', () => {
    expect(readSceneDocument(scene(['builtin']).doc)).toMatchObject({ status: 'ready', invalidObjects: [] });
    expect(readSceneDocument(scene([]).doc)).toMatchObject({ status: 'ready', objects: [], invalidObjects: [] });
  });

  it('splits any mix of old and new objects exactly by format', () => {
    const kinds = fc.array(fc.constantFrom<Kind>('builtin', 'newModel', 'oldModel', 'oldPicture', 'newPicture'), { maxLength: 8 });
    fc.assert(fc.property(kinds, (mix) => {
      const { doc, ids } = scene(mix);
      const read = readSceneDocument(doc);
      const old = ids.filter((_, index) => mix[index] === 'oldModel' || mix[index] === 'oldPicture').sort();
      expect(read.status).toBe('ready');
      expect(read.invalidObjects.map((object) => object.id).sort()).toEqual(old);
      expect(read.objects.map((object) => object.id).sort()).toEqual(ids.filter((id) => !old.includes(id)).sort());
    }), { numRuns: 100 });
  });
});
