// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { SCENE_FORMAT_VERSION } from '@breatic/shared';

import {
  applySceneCommand, createSceneHistory, planSceneCommand, readSceneDocument, type SceneCommand,
} from '@web/data/yjs/scene-document';

type Quaternion = [number, number, number, number];
type Vector = [number, number, number];

const ID = '11111111-1111-4111-8111-111111111111';
const COPY = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const Q_IDENTITY: Quaternion = [0, 0, 0, 1];
const Q_Y90: Quaternion = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
const Q_X180: Quaternion = [1, 0, 0, 0];
const Q_Z180: Quaternion = [0, 0, 1, 0];
const Q_HALF: Quaternion = [0.5, 0.5, 0.5, 0.5];
const HIPS: Vector = [0, -0.4, 0];
const BASE = {
  id: ID, name: 'Figure', model: { kind: 'builtin' as const, id: 'figure' as const },
  position: [0, 0, 0] as Vector, rotation: [0, 0, 0, 1] as Quaternion,
  scale: [1, 1, 1] as Vector, locked: false,
};
const POSED = { ...BASE, pose: { 'h:leftUpperArm': Q_Y90, 'n:Tail_1': Q_X180, 't:hips': HIPS } };
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

/** Every stored key of one record that starts with the pose prefix, sorted. */
function poseKeys(doc: Y.Doc, id = ID): string[] {
  return [...record(doc, id).keys()].filter((key) => key.startsWith('pose.')).sort();
}

/** The projected pose of one object, or undefined when it has none. */
function poseOf(doc: Y.Doc, id = ID): unknown {
  return readSceneDocument(doc).objects.find((object) => object.id === id)?.pose;
}

/** A pose command for the main object. */
function pose(set: Record<string, number[]>, replace = false): SceneCommand {
  return { type: 'pose', id: ID, set, replace };
}

afterEach(() => {
  for (const doc of documents.splice(0)) doc.destroy();
});

describe('scene pose storage (inner#1692 section 2.1)', () => {
  it('projects flat pose keys into one pose object and leaves other fields untouched', () => {
    const doc = sceneDoc();
    applySceneCommand(doc, { type: 'create', objects: [BASE] }, Symbol(), true);
    doc.transact(() => {
      record(doc).set('pose.h:leftUpperArm', Q_Y90);
      record(doc).set('pose.n:Tail_1', Q_X180);
      record(doc).set('pose.t:hips', HIPS);
    });
    const scene = readSceneDocument(doc);
    expect(scene.invalidObjects).toEqual([]);
    expect(scene.objects).toEqual([POSED]);
  });

  it('projects an object without pose keys with no pose property at all', () => {
    const doc = sceneDoc();
    applySceneCommand(doc, { type: 'create', objects: [BASE] }, Symbol(), true);
    const [object] = readSceneDocument(doc).objects;
    expect(object).toEqual(BASE);
    expect(object).not.toHaveProperty('pose');
  });

  it.each([
    ['a rotation that is not normalized', 'pose.h:leftUpperArm', [1, 1, 1, 1]],
    ['a rotation with three components', 'pose.n:Tail_1', [0, 0, 1]],
    ['a hips translation with four components', 'pose.t:hips', [0, 0, 0, 1]],
    ['a non-finite component', 'pose.h:leftUpperArm', [0, 0, Number.NaN, 1]],
    ['a key outside the h:, n: and t:hips forms', 'pose.x:leftUpperArm', [0, 0, 0, 1]],
  ])('isolates a record holding %s as invalid while other objects stay readable', (_label, key, value) => {
    const doc = sceneDoc();
    applySceneCommand(doc, { type: 'create', objects: [BASE, { ...BASE, id: OTHER }] }, Symbol(), true);
    record(doc).set(key, value);
    const scene = readSceneDocument(doc);
    expect(scene.objects).toEqual([{ ...BASE, id: OTHER }]);
    expect(scene.invalidObjects.map((object) => object.id)).toEqual([ID]);
  });

  it('creates a posed object as one flat key per bone with plain values and no nested pose entry', () => {
    const doc = sceneDoc();
    expect(applySceneCommand(doc, { type: 'create', objects: [POSED] }, Symbol(), true)).toEqual({ ok: true, ids: [ID] });
    const stored = record(doc);
    expect(stored.has('pose')).toBe(false);
    expect(poseKeys(doc)).toEqual(['pose.h:leftUpperArm', 'pose.n:Tail_1', 'pose.t:hips']);
    for (const key of stored.keys()) expect(stored.get(key)).not.toBeInstanceOf(Y.AbstractType);
    const { id: _id, pose: _pose, ...values } = POSED;
    expect(stored.toJSON()).toEqual({ ...values,
      'pose.h:leftUpperArm': Q_Y90, 'pose.n:Tail_1': Q_X180, 'pose.t:hips': HIPS });
    expect(readSceneDocument(doc).objects).toEqual([POSED]);
  });

  it('creates an object with an empty pose without writing any pose key', () => {
    const doc = sceneDoc();
    expect(applySceneCommand(doc, { type: 'create', objects: [{ ...BASE, pose: {} }] }, Symbol(), true).ok).toBe(true);
    expect([...record(doc).keys()].filter((key) => key === 'pose' || key.startsWith('pose.'))).toEqual([]);
    expect(readSceneDocument(doc).objects[0]).not.toHaveProperty('pose');
  });

  it('refuses to create an object whose pose holds an invalid value without writing', () => {
    const doc = sceneDoc();
    const before = Y.encodeStateAsUpdate(doc);
    const bad = { ...BASE, pose: { 'h:leftUpperArm': [2, 0, 0, 0] as Quaternion } };
    expect(applySceneCommand(doc, { type: 'create', objects: [bad] }, Symbol(), true)).toEqual({ ok: false, reason: 'invalid' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('duplicates the pose as flat keys and keeps the copy independent of the original', () => {
    const doc = sceneDoc(); const origin = Symbol();
    applySceneCommand(doc, { type: 'create', objects: [POSED] }, origin, true);
    expect(applySceneCommand(doc, { type: 'duplicate', copies: [{ sourceId: ID, id: COPY }] }, origin, true))
      .toEqual({ ok: true, ids: [COPY] });
    expect(record(doc, COPY).has('pose')).toBe(false);
    expect(poseKeys(doc, COPY)).toEqual(['pose.h:leftUpperArm', 'pose.n:Tail_1', 'pose.t:hips']);
    expect(poseOf(doc, COPY)).toEqual(POSED.pose);
    const copyPose: SceneCommand = { type: 'pose', id: COPY, set: { 'h:leftUpperArm': Q_Z180, 'n:Tail_1': Q_X180 }, replace: true };
    expect(applySceneCommand(doc, copyPose, origin, true)).toEqual({ ok: true, ids: [COPY] });
    expect(poseOf(doc, COPY)).toEqual({ 'h:leftUpperArm': Q_Z180, 'n:Tail_1': Q_X180 });
    expect(poseOf(doc, ID)).toEqual(POSED.pose);
  });

  it('never writes pose keys through a patch command', () => {
    const doc = sceneDoc();
    applySceneCommand(doc, { type: 'create', objects: [POSED] }, Symbol(), true);
    const patch = { type: 'patch', patches: [{ id: ID, pose: { 'h:leftUpperArm': Q_Z180, 'h:spine': Q_HALF } }] } as unknown as SceneCommand;
    applySceneCommand(doc, patch, Symbol(), true);
    expect(record(doc).has('pose')).toBe(false);
    expect(poseOf(doc)).toEqual(POSED.pose);
  });
});

describe('pose command (inner#1692 section 2.3)', () => {
  it('sets new keys, overwrites changed keys and, replacing, clears the rest in one transaction and one undo item', () => {
    const doc = sceneDoc(); const origin = Symbol(); const history = createSceneHistory(doc, origin);
    applySceneCommand(doc, { type: 'create', objects: [POSED] }, Symbol(), true);
    const origins: unknown[] = [];
    doc.on('afterTransaction', (transaction) => origins.push(transaction.origin));
    expect(applySceneCommand(doc, pose({ 'h:leftUpperArm': Q_Z180, 'h:spine': Q_HALF, 't:hips': HIPS }, true), origin, true))
      .toEqual({ ok: true, ids: [ID] });
    expect(origins).toEqual([origin]);
    expect(poseOf(doc)).toEqual({ 'h:leftUpperArm': Q_Z180, 'h:spine': Q_HALF, 't:hips': HIPS });
    expect(poseKeys(doc)).toEqual(['pose.h:leftUpperArm', 'pose.h:spine', 'pose.t:hips']);
    expect(history.undoStack).toHaveLength(1);
    history.undo();
    expect(poseOf(doc)).toEqual(POSED.pose);
    history.redo();
    expect(poseOf(doc)).toEqual({ 'h:leftUpperArm': Q_Z180, 'h:spine': Q_HALF, 't:hips': HIPS });
    history.destroy();
  });

  it('clears every pose key when replacing with an empty pose and removes the pose projection', () => {
    const doc = sceneDoc(); const origin = Symbol(); const history = createSceneHistory(doc, origin);
    applySceneCommand(doc, { type: 'create', objects: [POSED] }, Symbol(), true);
    expect(applySceneCommand(doc, pose({}, true), origin, true)).toEqual({ ok: true, ids: [ID] });
    expect(poseKeys(doc)).toEqual([]);
    expect(readSceneDocument(doc).objects).toEqual([BASE]);
    expect(readSceneDocument(doc).objects[0]).not.toHaveProperty('pose');
    expect(history.undoStack).toHaveLength(1);
    history.undo();
    expect(poseOf(doc)).toEqual(POSED.pose);
    history.destroy();
  });

  it('applies a preset as a replace, keeping the set keys and removing every other key', () => {
    const doc = sceneDoc(); const origin = Symbol(); const history = createSceneHistory(doc, origin);
    applySceneCommand(doc, { type: 'create', objects: [POSED] }, Symbol(), true);
    const preset = { 'h:leftUpperArm': Q_Y90, 'h:rightUpperArm': Q_HALF, 't:hips': [0, -0.5, 0] };
    expect(applySceneCommand(doc, pose(preset, true), origin, true)).toEqual({ ok: true, ids: [ID] });
    expect(poseOf(doc)).toEqual(preset);
    expect(history.undoStack).toHaveLength(1);
    history.undo();
    expect(poseOf(doc)).toEqual(POSED.pose);
    history.destroy();
  });

  it('keeps every key it does not set when not replacing', () => {
    const doc = sceneDoc();
    applySceneCommand(doc, { type: 'create', objects: [POSED] }, Symbol(), true);
    expect(applySceneCommand(doc, pose({ 'h:leftUpperArm': Q_Z180 }), Symbol(), true).ok).toBe(true);
    expect(poseOf(doc)).toEqual({ ...POSED.pose, 'h:leftUpperArm': Q_Z180 });
  });

  it('writes only the keys whose value changes', () => {
    const doc = sceneDoc();
    applySceneCommand(doc, { type: 'create', objects: [POSED] }, Symbol(), true);
    const changed: string[] = [];
    record(doc).observe((event) => changed.push(...event.keysChanged));
    expect(applySceneCommand(doc, pose({ 'h:leftUpperArm': [...Q_Y90], 'n:Tail_1': Q_Z180, 'h:spine': Q_HALF }), Symbol(), true).ok).toBe(true);
    expect(changed.sort()).toEqual(['pose.h:spine', 'pose.n:Tail_1']);
  });

  it.each([
    ['sets only current values', pose({ 'h:leftUpperArm': Q_Y90, 't:hips': HIPS })],
    ['replaces with the same pose', pose(POSED.pose as Record<string, number[]>, true)],
    ['is empty', pose({})],
  ])('creates no transaction and no undo item for a command that %s', (_label, command) => {
    const doc = sceneDoc(); const origin = Symbol(); const history = createSceneHistory(doc, origin);
    applySceneCommand(doc, { type: 'create', objects: [POSED] }, Symbol(), true);
    const before = Y.encodeStateAsUpdate(doc);
    let transactions = 0;
    doc.on('afterTransaction', () => { transactions += 1; });
    expect(applySceneCommand(doc, command, origin, true)).toEqual({ ok: true, ids: [ID] });
    expect(transactions).toBe(0);
    expect(history.undoStack).toHaveLength(0);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    history.destroy();
  });

  it('creates no transaction for clear all on an object without a pose', () => {
    const doc = sceneDoc(); const origin = Symbol(); const history = createSceneHistory(doc, origin);
    applySceneCommand(doc, { type: 'create', objects: [BASE] }, Symbol(), true);
    let transactions = 0;
    doc.on('afterTransaction', () => { transactions += 1; });
    expect(applySceneCommand(doc, pose({}, true), origin, true)).toEqual({ ok: true, ids: [ID] });
    expect(transactions).toBe(0);
    expect(history.undoStack).toHaveLength(0);
    history.destroy();
  });

  it('applying the same preset twice leaves the pose unchanged and adds no second undo item', () => {
    const doc = sceneDoc(); const origin = Symbol(); const history = createSceneHistory(doc, origin);
    applySceneCommand(doc, { type: 'create', objects: [POSED] }, Symbol(), true);
    const preset = { 'h:leftUpperArm': Q_HALF, 'h:leftLowerArm': Q_Y90 };
    applySceneCommand(doc, pose(preset, true), origin, true);
    const after = Y.encodeStateAsUpdate(doc);
    applySceneCommand(doc, pose(preset, true), origin, true);
    expect(poseOf(doc)).toEqual(preset);
    expect(history.undoStack).toHaveLength(1);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(after);
    history.destroy();
  });

  it('plans without writing', () => {
    const doc = sceneDoc();
    applySceneCommand(doc, { type: 'create', objects: [POSED] }, Symbol(), true);
    const before = Y.encodeStateAsUpdate(doc);
    expect(planSceneCommand(doc, pose({ 'h:spine': Q_HALF }, true), true).ok).toBe(true);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('refuses a read-only caller', () => {
    const doc = sceneDoc();
    applySceneCommand(doc, { type: 'create', objects: [POSED] }, Symbol(), true);
    const before = Y.encodeStateAsUpdate(doc);
    expect(applySceneCommand(doc, pose({ 'h:spine': Q_HALF }), Symbol(), false)).toEqual({ ok: false, reason: 'readOnly' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('refuses a scene in an unsupported format', () => {
    const doc = sceneDoc();
    applySceneCommand(doc, { type: 'create', objects: [POSED] }, Symbol(), true);
    doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION + 1);
    const before = Y.encodeStateAsUpdate(doc);
    expect(applySceneCommand(doc, pose({ 'h:spine': Q_HALF }), Symbol(), true)).toEqual({ ok: false, reason: 'unsupported' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it('refuses a missing object and an invalid record', () => {
    const doc = sceneDoc();
    applySceneCommand(doc, { type: 'create', objects: [POSED] }, Symbol(), true);
    doc.getMap('objects').set(OTHER, new Y.Map<unknown>([['model', { kind: 'unknown' }]]));
    const before = Y.encodeStateAsUpdate(doc);
    expect(applySceneCommand(doc, { type: 'pose', id: COPY, set: { 'h:spine': Q_HALF }, replace: false }, Symbol(), true))
      .toEqual({ ok: false, reason: 'missing' });
    expect(applySceneCommand(doc, { type: 'pose', id: OTHER, set: { 'h:spine': Q_HALF }, replace: false }, Symbol(), true))
      .toEqual({ ok: false, reason: 'invalid' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it.each([
    ['a set', pose({ 'h:spine': Q_HALF })],
    ['a replace', pose({}, true)],
  ])('refuses %s on a locked object', (_label, command) => {
    const doc = sceneDoc();
    applySceneCommand(doc, { type: 'create', objects: [POSED] }, Symbol(), true);
    // A record cannot be created locked, so it is locked by its own command.
    applySceneCommand(doc, { type: 'lock', ids: [ID], locked: true }, Symbol(), true);
    const before = Y.encodeStateAsUpdate(doc);
    expect(applySceneCommand(doc, command, Symbol(), true)).toEqual({ ok: false, reason: 'locked' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });

  it.each([
    ['a rotation that is not normalized', { 'h:spine': [1, 1, 1, 1] }],
    ['a rotation with three components', { 'n:Tail_1': [0, 0, 1] }],
    ['a hips translation with four components', { 't:hips': [0, 0, 0, 1] }],
    ['a non-finite component', { 'h:spine': [0, 0, Number.POSITIVE_INFINITY, 1] }],
    ['a translation key other than hips', { 't:spine': [0, 1, 0] }],
    ['a key with an unknown form', { 'x:spine': Q_HALF }],
    ['a key that repeats the storage prefix', { 'pose.h:spine': Q_HALF }],
    ['a key longer than 128 characters', { [`n:${'a'.repeat(200)}`]: Q_HALF }],
    ['more than 256 keys', Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`n:Bone_${index}`, Q_HALF]))],
  ])('refuses %s and writes nothing, even beside a valid entry', (_label, set) => {
    const doc = sceneDoc();
    applySceneCommand(doc, { type: 'create', objects: [POSED] }, Symbol(), true);
    const before = Y.encodeStateAsUpdate(doc);
    expect(applySceneCommand(doc, pose({ 'h:leftUpperArm': Q_Z180, ...set }, true), Symbol(), true))
      .toEqual({ ok: false, reason: 'invalid' });
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
});

describe('pose collaboration with real Yjs replicas (inner#1692 acceptance 10 and 12)', () => {
  it('keeps both members\' first writes to different bones of an unposed object', () => {
    const alice = sceneDoc();
    applySceneCommand(alice, { type: 'create', objects: [BASE] }, Symbol(), true);
    const bob = replica(alice);
    expect(applySceneCommand(alice, pose({ 'h:leftUpperArm': Q_Y90 }), Symbol(), true).ok).toBe(true);
    expect(applySceneCommand(bob, pose({ 'h:rightUpperArm': Q_HALF }), Symbol(), true).ok).toBe(true);
    merge(alice, bob);
    const expected = { 'h:leftUpperArm': Q_Y90, 'h:rightUpperArm': Q_HALF };
    expect(poseOf(alice)).toEqual(expected);
    expect(poseOf(bob)).toEqual(expected);
  });

  it('keeps concurrent writes to different bones of a posed object on both replicas', () => {
    const alice = sceneDoc();
    applySceneCommand(alice, { type: 'create', objects: [POSED] }, Symbol(), true);
    const bob = replica(alice);
    applySceneCommand(alice, pose({ 'h:leftUpperArm': Q_Z180 }), Symbol(), true);
    applySceneCommand(bob, pose({ 'n:Tail_1': Q_HALF }), Symbol(), true);
    merge(alice, bob);
    const expected = { 'h:leftUpperArm': Q_Z180, 'n:Tail_1': Q_HALF, 't:hips': HIPS };
    expect(poseOf(alice)).toEqual(expected);
    expect(poseOf(bob)).toEqual(expected);
  });

  it('never removes a key another member wrote when undoing my pose command', () => {
    const alice = sceneDoc(); const origin = Symbol(); const history = createSceneHistory(alice, origin);
    applySceneCommand(alice, { type: 'create', objects: [BASE] }, Symbol(), true);
    const bob = replica(alice);
    applySceneCommand(alice, pose({ 'h:leftUpperArm': Q_Y90 }), origin, true);
    merge(alice, bob);
    applySceneCommand(bob, pose({ 'h:rightUpperArm': Q_HALF }), Symbol(), true);
    merge(alice, bob);
    history.undo();
    merge(alice, bob);
    expect(poseOf(alice)).toEqual({ 'h:rightUpperArm': Q_HALF });
    expect(poseOf(bob)).toEqual({ 'h:rightUpperArm': Q_HALF });
    history.destroy();
  });

  it('keeps a key another member wrote after my preset when I undo the preset', () => {
    const alice = sceneDoc(); const origin = Symbol(); const history = createSceneHistory(alice, origin);
    applySceneCommand(alice, { type: 'create', objects: [POSED] }, Symbol(), true);
    const bob = replica(alice);
    applySceneCommand(alice, pose({ 'h:leftUpperArm': Q_HALF, 'h:leftLowerArm': Q_Y90 }, true), origin, true);
    merge(alice, bob);
    applySceneCommand(bob, pose({ 'h:spine': Q_Z180 }), Symbol(), true);
    merge(alice, bob);
    history.undo();
    merge(alice, bob);
    const expected = { ...POSED.pose, 'h:spine': Q_Z180 };
    expect(poseOf(alice)).toEqual(expected);
    expect(poseOf(bob)).toEqual(expected);
    history.destroy();
  });

  it('keeps a bone another member wrote concurrently with my clear all', () => {
    const alice = sceneDoc();
    applySceneCommand(alice, { type: 'create', objects: [POSED] }, Symbol(), true);
    const bob = replica(alice);
    applySceneCommand(alice, pose({}, true), Symbol(), true);
    applySceneCommand(bob, pose({ 'h:spine': Q_Z180 }), Symbol(), true);
    merge(alice, bob);
    expect(poseOf(alice)).toEqual({ 'h:spine': Q_Z180 });
    expect(poseOf(bob)).toEqual({ 'h:spine': Q_Z180 });
  });

  it('restores my previous value on undo unless the other member wrote that bone afterwards', () => {
    const alice = sceneDoc(); const origin = Symbol(); const history = createSceneHistory(alice, origin);
    applySceneCommand(alice, { type: 'create', objects: [POSED] }, Symbol(), true);
    const bob = replica(alice);
    applySceneCommand(alice, pose({ 'h:leftUpperArm': Q_Z180, 'n:Tail_1': Q_HALF }), origin, true);
    merge(alice, bob);
    applySceneCommand(bob, pose({ 'n:Tail_1': Q_IDENTITY }), Symbol(), true);
    merge(alice, bob);
    history.undo();
    merge(alice, bob);
    const expected = { 'h:leftUpperArm': Q_Y90, 'n:Tail_1': Q_IDENTITY, 't:hips': HIPS };
    expect(poseOf(alice)).toEqual(expected);
    expect(poseOf(bob)).toEqual(expected);
    history.destroy();
  });
});
