// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { SCENE_FORMAT_VERSION } from '@breatic/shared';

import {
  applySceneCommand, createSceneHistory, planSceneCommand, readSceneDocument, type SceneCommand,
} from '@web/data/yjs/scene-document';

const NAME = 'project-p1/3d-s1';

type Vector = [number, number, number];
type Quaternion = [number, number, number, number];

const ID = '11111111-1111-4111-8111-111111111111';
const COPY = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const CAMERA_ID = '44444444-4444-4444-8444-444444444444';
const LIGHT_ID = '55555555-5555-4555-8555-555555555555';
const IMAGE = '66666666-6666-4666-8666-666666666666';
const BASE = {
  id: ID, name: 'Figure', model: { kind: 'builtin' as const, id: 'figure' as const },
  position: [0, 0, 0] as Vector, rotation: [0, 0, 0, 1] as Quaternion,
  scale: [1, 1, 1] as Vector, locked: false,
};
const LOOKED = { ...BASE, look: { 0: { color: '#112233', roughness: 0.4 }, 2: { map: IMAGE, mapRepeat: [2, 2] as [number, number] } } };
const CAMERA = {
  ...BASE, id: CAMERA_ID, name: 'Camera 1', model: { kind: 'camera' as const }, number: 1, focalLength: 35, frame: '16:9' as const,
};
const LIGHT = {
  ...BASE, id: LIGHT_ID, name: 'Light 1', model: { kind: 'light' as const, type: 'point' as const }, number: 1,
  color: '#ffffff', intensity: 10, castShadow: true,
};
const documents: Y.Doc[] = [];

/** Creates an isolated scene in the current format. */
function sceneDoc(): Y.Doc {
  const doc = new Y.Doc();
  documents.push(doc);
  doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
  doc.getMap('objects');
  return doc;
}

/** Restores an independent replica of a scene. */
function replica(source: Y.Doc): Y.Doc {
  const doc = new Y.Doc();
  documents.push(doc);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
  return doc;
}

/** Exchanges both replicas' updates so they converge. */
function merge(left: Y.Doc, right: Y.Doc): void {
  const leftUpdate = Y.encodeStateAsUpdate(left);
  const rightUpdate = Y.encodeStateAsUpdate(right);
  Y.applyUpdate(left, rightUpdate);
  Y.applyUpdate(right, leftUpdate);
}

/** The raw shared record of one object. */
function record(doc: Y.Doc, id = ID): Y.Map<unknown> {
  return doc.getMap('objects').get(id) as Y.Map<unknown>;
}

/** Every stored key of one record that starts with the look prefix, sorted. */
function lookKeys(doc: Y.Doc, id = ID): string[] {
  return [...record(doc, id).keys()].filter((key) => key.startsWith('look.')).sort();
}

/** The projected look of one object, or undefined when it has none. */
function lookOf(doc: Y.Doc, id = ID): unknown {
  return (readSceneDocument(doc).objects.find((object) => object.id === id) as { look?: unknown } | undefined)?.look;
}

/** A look command for one part of the main object. */
function look(part: string | null, set: Record<string, unknown>, id = ID): SceneCommand {
  return { type: 'look', id, part, set } as unknown as SceneCommand;
}

afterEach(() => {
  for (const doc of documents.splice(0)) doc.destroy();
});

describe('scene look storage (inner#1693 design 4.1)', () => {
  it('projects flat look keys into one look object and leaves other fields untouched', () => {
    const doc = sceneDoc();
    applySceneCommand(doc, { type: 'create', objects: [BASE] }, Symbol(), true, NAME);
    doc.transact(() => {
      record(doc).set('look.0.color', '#112233');
      record(doc).set('look.d.map', 'none');
    });
    const object = readSceneDocument(doc).objects[0] as Record<string, unknown>;
    expect(object.look).toEqual({ 0: { color: '#112233' }, d: { map: 'none' } });
    expect(object.name).toBe('Figure');
    expect(Object.keys(object).some((key) => key.startsWith('look.'))).toBe(false);
  });

  it('projects an object without look keys with no look property at all', () => {
    const doc = sceneDoc();
    applySceneCommand(doc, { type: 'create', objects: [BASE] }, Symbol(), true, NAME);
    expect('look' in (readSceneDocument(doc).objects[0] as object)).toBe(false);
  });

  it('creates an object with a look as one flat key per part field', () => {
    const doc = sceneDoc();
    applySceneCommand(doc, { type: 'create', objects: [LOOKED] }, Symbol(), true, NAME);
    expect(lookKeys(doc)).toEqual(['look.0.color', 'look.0.roughness', 'look.2.map', 'look.2.mapRepeat']);
    expect(record(doc).has('look')).toBe(false);
    expect(lookOf(doc)).toEqual(LOOKED.look);
  });

  it.each(['look', 'pose'])('treats a record storing a whole %s under one key as invalid', (key) => {
    const doc = sceneDoc();
    applySceneCommand(doc, { type: 'create', objects: [BASE] }, Symbol(), true, NAME);
    record(doc).set(key, key === 'look' ? { 0: { color: '#ff0000' } } : {});
    const scene = readSceneDocument(doc);
    expect(scene.objects).toHaveLength(0);
    expect(scene.invalidObjects.map((object) => object.id)).toEqual([ID]);
  });

  it('treats a record carrying a malformed look key as invalid', () => {
    const doc = sceneDoc();
    applySceneCommand(doc, { type: 'create', objects: [BASE] }, Symbol(), true, NAME);
    record(doc).set('look.0.roughness', 3);
    const scene = readSceneDocument(doc);
    expect(scene.objects).toHaveLength(0);
    expect(scene.invalidObjects.map((object) => object.id)).toEqual([ID]);
  });

  it('duplicates the look as flat keys and keeps the copy independent of the original', () => {
    const doc = sceneDoc();
    applySceneCommand(doc, { type: 'create', objects: [LOOKED] }, Symbol(), true, NAME);
    applySceneCommand(doc, { type: 'duplicate', copies: [{ sourceId: ID, id: COPY }] }, Symbol(), true, NAME);
    expect(lookOf(doc, COPY)).toEqual(LOOKED.look);
    applySceneCommand(doc, look('0', { color: '#ffffff' }, COPY), Symbol(), true, NAME);
    expect(lookOf(doc, COPY)).toEqual({ ...LOOKED.look, 0: { ...LOOKED.look[0], color: '#ffffff' } });
    expect(lookOf(doc)).toEqual(LOOKED.look);
  });

  it('never writes look keys through a patch command', () => {
    const doc = sceneDoc();
    applySceneCommand(doc, { type: 'create', objects: [BASE] }, Symbol(), true, NAME);
    const before = Y.encodeStateAsUpdate(doc);
    const patch = { type: 'patch', patches: [{ id: ID, look: { 0: { color: '#ffffff' } } }] } as unknown as SceneCommand;
    expect(applySceneCommand(doc, patch, Symbol(), true, NAME)).toEqual({ ok: false, reason: 'invalid' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
});

describe('look command (inner#1693 design 4.2)', () => {
  it('writes the set fields of one part in one transaction and one undo item', () => {
    const doc = sceneDoc(); const origin = Symbol(); const history = createSceneHistory(doc, origin);
    applySceneCommand(doc, { type: 'create', objects: [LOOKED] }, Symbol(), true, NAME);
    const origins: unknown[] = [];
    doc.on('afterTransaction', (transaction) => origins.push(transaction.origin));
    expect(applySceneCommand(doc, look('0', { roughness: 0.9, metalness: 1 }), origin, true, NAME)).toEqual({ ok: true, ids: [ID] });
    expect(origins).toEqual([origin]);
    expect(lookOf(doc)).toEqual({ ...LOOKED.look, 0: { color: '#112233', roughness: 0.9, metalness: 1 } });
    expect(history.undoStack).toHaveLength(1);
    history.undo();
    expect(lookOf(doc)).toEqual(LOOKED.look);
    history.redo();
    expect(lookOf(doc)).toEqual({ ...LOOKED.look, 0: { color: '#112233', roughness: 0.9, metalness: 1 } });
    history.destroy();
  });

  it('deletes the fields set to null, and the part with them when none are left', () => {
    const doc = sceneDoc();
    applySceneCommand(doc, { type: 'create', objects: [LOOKED] }, Symbol(), true, NAME);
    applySceneCommand(doc, look('2', { map: null, mapRepeat: null, mapOffset: null, mapRotation: null }), Symbol(), true, NAME);
    expect(lookKeys(doc)).toEqual(['look.0.color', 'look.0.roughness']);
    expect(lookOf(doc)).toEqual({ 0: LOOKED.look[0] });
  });

  it('writes none as the map to turn off the model picture', () => {
    const doc = sceneDoc();
    applySceneCommand(doc, { type: 'create', objects: [BASE] }, Symbol(), true, NAME);
    applySceneCommand(doc, look('1', { map: 'none' }), Symbol(), true, NAME);
    expect(record(doc).get('look.1.map')).toBe('none');
  });

  it('resets every look key of the object with a null part', () => {
    const doc = sceneDoc(); const origin = Symbol(); const history = createSceneHistory(doc, origin);
    applySceneCommand(doc, { type: 'create', objects: [LOOKED] }, Symbol(), true, NAME);
    expect(applySceneCommand(doc, look(null, {}), origin, true, NAME)).toEqual({ ok: true, ids: [ID] });
    expect(lookKeys(doc)).toEqual([]);
    expect(lookOf(doc)).toBeUndefined();
    history.undo();
    expect(lookOf(doc)).toEqual(LOOKED.look);
    history.destroy();
  });

  it('writes only the fields whose value changes and no transaction when nothing changes', () => {
    const doc = sceneDoc(); const origin = Symbol(); const history = createSceneHistory(doc, origin);
    applySceneCommand(doc, { type: 'create', objects: [LOOKED] }, Symbol(), true, NAME);
    const origins: unknown[] = [];
    doc.on('afterTransaction', (transaction) => origins.push(transaction.origin));
    expect(applySceneCommand(doc, look('0', { color: '#112233', roughness: 0.4 }), origin, true, NAME)).toEqual({ ok: true, ids: [ID] });
    expect(applySceneCommand(doc, look('5', { color: null }), origin, true, NAME)).toEqual({ ok: true, ids: [ID] });
    expect(origins).toEqual([]);
    expect(history.undoStack).toHaveLength(0);
    history.destroy();
  });

  it('plans without writing', () => {
    const doc = sceneDoc();
    applySceneCommand(doc, { type: 'create', objects: [LOOKED] }, Symbol(), true, NAME);
    const before = Y.encodeStateAsUpdate(doc);
    expect(planSceneCommand(doc, NAME, look('0', { color: '#ffffff' }), true).ok).toBe(true);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('refuses a read-only caller', () => {
    const doc = sceneDoc();
    applySceneCommand(doc, { type: 'create', objects: [BASE] }, Symbol(), true, NAME);
    expect(applySceneCommand(doc, look('0', { color: '#ffffff' }), Symbol(), false, NAME)).toEqual({ ok: false, reason: 'readOnly' });
  });

  it('refuses a missing object, an invalid record and a locked object without writing', () => {
    const doc = sceneDoc();
    applySceneCommand(doc, { type: 'create', objects: [LOOKED] }, Symbol(), true, NAME);
    doc.getMap('objects').set(OTHER, new Y.Map<unknown>([['model', { kind: 'unknown' }]]));
    expect(applySceneCommand(doc, look('0', { color: '#ffffff' }, COPY), Symbol(), true, NAME)).toEqual({ ok: false, reason: 'missing' });
    expect(applySceneCommand(doc, look('0', { color: '#ffffff' }, OTHER), Symbol(), true, NAME)).toEqual({ ok: false, reason: 'invalid' });
    applySceneCommand(doc, { type: 'lock', ids: [ID], locked: true }, Symbol(), true, NAME);
    const before = Y.encodeStateAsUpdate(doc);
    expect(applySceneCommand(doc, look('0', { color: '#ffffff' }), Symbol(), true, NAME)).toEqual({ ok: false, reason: 'locked' });
    expect(applySceneCommand(doc, look(null, {}), Symbol(), true, NAME)).toEqual({ ok: false, reason: 'locked' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('refuses a look on a camera and on a light', () => {
    const doc = sceneDoc();
    applySceneCommand(doc, { type: 'create', objects: [CAMERA, LIGHT] }, Symbol(), true, NAME, { maxLights: 8 });
    const before = Y.encodeStateAsUpdate(doc);
    expect(applySceneCommand(doc, look('0', { color: '#ffffff' }, CAMERA_ID), Symbol(), true, NAME)).toEqual({ ok: false, reason: 'invalid' });
    expect(applySceneCommand(doc, look('0', { color: '#ffffff' }, LIGHT_ID), Symbol(), true, NAME)).toEqual({ ok: false, reason: 'invalid' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it.each([
    ['a part key over 9999', '10000', { color: '#ffffff' }],
    ['a letter part key other than d', 'e', { color: '#ffffff' }],
    ['an unknown field', '0', { gloss: 0.5 }],
    ['roughness above 1', '0', { roughness: 2 }],
    ['a map that is neither a uuid nor none', '0', { map: 'img.png' }],
    ['a tiling of 0', '0', { mapRepeat: [0, 1] }],
  ])('refuses %s and writes nothing, even beside a valid field', (_label, part, set) => {
    const doc = sceneDoc();
    applySceneCommand(doc, { type: 'create', objects: [LOOKED] }, Symbol(), true, NAME);
    const before = Y.encodeStateAsUpdate(doc);
    expect(applySceneCommand(doc, look(part, { color: '#000000', ...set }), Symbol(), true, NAME)).toEqual({ ok: false, reason: 'invalid' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('refuses a write that would carry the object past 256 parts', () => {
    const doc = sceneDoc();
    const full = { ...BASE, look: Object.fromEntries(Array.from({ length: 256 }, (_, index) => [String(index), { opacity: 0.5 }])) };
    applySceneCommand(doc, { type: 'create', objects: [full] }, Symbol(), true, NAME);
    expect(applySceneCommand(doc, look('300', { opacity: 0.5 }), Symbol(), true, NAME)).toEqual({ ok: false, reason: 'invalid' });
    expect(applySceneCommand(doc, look('3', { opacity: 0.2 }), Symbol(), true, NAME)).toEqual({ ok: true, ids: [ID] });
  });

  it('refuses to create an object carrying more than 256 parts', () => {
    const doc = sceneDoc();
    const over = { ...BASE, look: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [String(index), { opacity: 0.5 }])) };
    expect(applySceneCommand(doc, { type: 'create', objects: [over] }, Symbol(), true, NAME)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('keeps an object readable when two members each add a part at 255 and the merge passes 256', () => {
    const left = sceneDoc();
    const almost = { ...BASE, look: Object.fromEntries(Array.from({ length: 255 }, (_, index) => [String(index), { opacity: 0.5 }])) };
    applySceneCommand(left, { type: 'create', objects: [almost] }, Symbol(), true, NAME);
    const right = replica(left);
    expect(applySceneCommand(left, look('400', { opacity: 0.1 }), Symbol(), true, NAME).ok).toBe(true);
    expect(applySceneCommand(right, look('401', { opacity: 0.2 }), Symbol(), true, NAME).ok).toBe(true);
    merge(left, right);
    for (const replicaDoc of [left, right]) {
      const scene = readSceneDocument(replicaDoc);
      expect(scene.invalidObjects).toEqual([]);
      expect(Object.keys((scene.objects[0] as { look: object }).look)).toHaveLength(257);
    }
    // Parts it has can still change; a further part cannot be added.
    expect(applySceneCommand(left, look('400', { opacity: 0.3 }), Symbol(), true, NAME)).toEqual({ ok: true, ids: [ID] });
    expect(applySceneCommand(left, look('402', { opacity: 0.3 }), Symbol(), true, NAME)).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('look collaboration with real Yjs replicas (inner#1693 acceptance 6)', () => {
  it('keeps both members\' concurrent writes to different fields of one part', () => {
    const left = sceneDoc();
    applySceneCommand(left, { type: 'create', objects: [BASE] }, Symbol(), true, NAME);
    const right = replica(left);
    applySceneCommand(left, look('0', { color: '#ff0000' }), Symbol(), true, NAME);
    applySceneCommand(right, look('0', { roughness: 0.1 }), Symbol(), true, NAME);
    merge(left, right);
    expect(lookOf(left)).toEqual({ 0: { color: '#ff0000', roughness: 0.1 } });
    expect(lookOf(right)).toEqual(lookOf(left));
  });

  it('never removes a field another member wrote when undoing my look command', () => {
    const left = sceneDoc(); const origin = Symbol(); const history = createSceneHistory(left, origin);
    applySceneCommand(left, { type: 'create', objects: [BASE] }, Symbol(), true, NAME);
    const right = replica(left);
    applySceneCommand(left, look('0', { color: '#ff0000' }), origin, true, NAME);
    applySceneCommand(right, look('0', { metalness: 1 }), Symbol(), true, NAME);
    merge(left, right);
    history.undo();
    merge(left, right);
    expect(lookOf(left)).toEqual({ 0: { metalness: 1 } });
    expect(lookOf(right)).toEqual({ 0: { metalness: 1 } });
    history.destroy();
  });
});
