// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as Y from 'yjs';

import { SCENE_FORMAT_VERSION } from '@breatic/shared';

import { applySceneCommand, createSceneHistory, readSceneDocument, type SceneCommand } from '../scene-document';

const NAME = 'project-p1/3d-s1';
const LIMITS = { maxLights: 16 };
const POSE = { position: [0, 1, 2] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number], locked: false };
const documents: Y.Doc[] = [];

afterEach(() => { documents.splice(0).forEach((doc) => doc.destroy()); });

/** An empty scene in the current format. */
function sceneDoc(): Y.Doc {
  const doc = new Y.Doc();
  documents.push(doc);
  doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
  doc.getMap('objects');
  return doc;
}

/** A UUID whose last digits are `n`, so tests can name records. */
function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** A camera record. */
function camera(n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: uuid(n), name: `Camera ${n}`, model: { kind: 'camera' }, ...POSE, number: n, focalLength: 35, frame: '16:9', ...extra };
}

/** A light record. */
function light(n: number, type: 'directional' | 'point' | 'spot' = 'point', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: uuid(1000 + n), name: `Light ${n}`, model: { kind: 'light', type }, ...POSE, number: n, color: '#ffffff', intensity: 1, castShadow: true, ...(type === 'spot' ? { angle: 30 } : {}), ...extra };
}

/** Apply a command with the director limits. */
function run(doc: Y.Doc, command: unknown, origin: symbol = Symbol('test'), limits = LIMITS): ReturnType<typeof applySceneCommand> {
  return applySceneCommand(doc, command as SceneCommand, origin, true, NAME, limits);
}

describe('director records in the scene document (inner#1694 design 4)', () => {
  it('creates a camera and a light and reads them back with their fields', () => {
    const doc = sceneDoc();
    expect(run(doc, { type: 'create', objects: [camera(1), light(1, 'spot')] })).toEqual({ ok: true, ids: [uuid(1), uuid(1001)] });
    const objects = readSceneDocument(doc).objects as unknown as Record<string, unknown>[];
    expect(objects.find((object) => object.id === uuid(1))).toMatchObject({ number: 1, focalLength: 35, frame: '16:9' });
    expect(objects.find((object) => object.id === uuid(1001))).toMatchObject({ number: 1, intensity: 1, castShadow: true, angle: 30 });
  });

  it('patches camera lens and frame and light colour and intensity', () => {
    const doc = sceneDoc();
    run(doc, { type: 'create', objects: [camera(1), light(1)] });
    expect(run(doc, { type: 'patch', patches: [{ id: uuid(1), focalLength: 50, frame: '9:16' }] }).ok).toBe(true);
    expect(run(doc, { type: 'patch', patches: [{ id: uuid(1001), color: '#ff8800', intensity: 3 }] }).ok).toBe(true);
    const objects = readSceneDocument(doc).objects as unknown as Record<string, unknown>[];
    expect(objects.find((object) => object.id === uuid(1))).toMatchObject({ focalLength: 50, frame: '9:16' });
    expect(objects.find((object) => object.id === uuid(1001))).toMatchObject({ color: '#ff8800', intensity: 3 });
  });

  it.each([
    ['a light key on a camera', (doc: Y.Doc) => run(doc, { type: 'patch', patches: [{ id: uuid(1), intensity: 2 }] })],
    ['a camera key on a light', (doc: Y.Doc) => run(doc, { type: 'patch', patches: [{ id: uuid(1001), focalLength: 50 }] })],
    ['a scale on a camera', (doc: Y.Doc) => run(doc, { type: 'patch', patches: [{ id: uuid(1), scale: [2, 2, 2] }] })],
    ['a rotation on a point light', (doc: Y.Doc) => run(doc, { type: 'patch', patches: [{ id: uuid(1001), rotation: [0, 1, 0, 0] }] })],
    ['a pose on a camera', (doc: Y.Doc) => run(doc, { type: 'pose', id: uuid(1), set: { 't:hips': [0, 0, 0] }, replace: false })],
  ])('refuses %s as invalid', (_label, act) => {
    const doc = sceneDoc();
    run(doc, { type: 'create', objects: [camera(1), light(1)] });
    expect(act(doc)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('numbers duplicated cameras after the highest number, one after another', () => {
    const doc = sceneDoc();
    run(doc, { type: 'create', objects: [camera(1), camera(4)] });
    expect(run(doc, { type: 'duplicate', copies: [{ sourceId: uuid(1), id: uuid(7) }, { sourceId: uuid(4), id: uuid(8) }] }).ok).toBe(true);
    const numbers = (readSceneDocument(doc).objects as unknown as Record<string, unknown>[]).filter((object) => object.id === uuid(7) || object.id === uuid(8)).map((object) => object.number);
    expect(numbers.sort()).toEqual([5, 6]);
  });
});

describe('the light limit (design 3.6, 4.4)', () => {
  it('refuses only a command that adds a light past the limit', () => {
    const doc = sceneDoc();
    expect(run(doc, { type: 'create', objects: Array.from({ length: 16 }, (_, i) => light(i + 1)) }).ok).toBe(true);
    expect(run(doc, { type: 'create', objects: [light(17)] })).toEqual({ ok: false, reason: 'lightLimit' });
    expect(run(doc, { type: 'duplicate', copies: [{ sourceId: uuid(1001), id: uuid(1999) }] })).toEqual({ ok: false, reason: 'lightLimit' });
    expect(run(doc, { type: 'create', objects: [camera(1)] }).ok).toBe(true);
  });

  it('never refuses a command that adds no light, even when concurrent adds pushed the scene over the limit', () => {
    const a = sceneDoc();
    run(a, { type: 'create', objects: Array.from({ length: 16 }, (_, i) => light(i + 1)) });
    const b = sceneDoc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    run(a, { type: 'delete', ids: [uuid(1001)] });
    run(a, { type: 'create', objects: [light(40)] });
    run(b, { type: 'delete', ids: [uuid(1002)] });
    run(b, { type: 'create', objects: [light(41)] });
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(run(a, { type: 'patch', patches: [{ id: uuid(1003), intensity: 2 }] }).ok).toBe(true);
    expect(run(a, { type: 'create', objects: [camera(9)] }).ok).toBe(true);
  });
});

describe('ambient light in the scene root (design 4.3)', () => {
  it('reads the defaults when no key is stored and writes through the environment command', () => {
    const doc = sceneDoc();
    const read = (): unknown => (readSceneDocument(doc) as unknown as { environment: unknown }).environment;
    expect(read()).toEqual({ ambientColor: '#ffffff', ambientIntensity: 2.7 });
    expect(run(doc, { type: 'environment', set: { ambientColor: '#ffeecc', ambientIntensity: 1.5 } }).ok).toBe(true);
    expect(read()).toEqual({ ambientColor: '#ffeecc', ambientIntensity: 1.5 });
    expect(run(doc, { type: 'environment', set: { ambientIntensity: 11 } })).toEqual({ ok: false, reason: 'invalid' });
  });

  it('puts an ambient change in the personal undo history', () => {
    const doc = sceneDoc();
    const origin = Symbol('mine');
    const history = createSceneHistory(doc, origin);
    run(doc, { type: 'environment', set: { ambientIntensity: 1 } }, origin);
    history.undo();
    expect((readSceneDocument(doc) as unknown as { environment: { ambientIntensity: number } }).environment.ambientIntensity).toBe(2.7);
  });
});

describe('director commands on two replicas (design 10 property test)', () => {
  it('keeps every record valid or isolated, converges, and never accepts a light past the limit', () => {
    // A small limit lets random runs reach it.
    const small = { maxLights: 3 };
    const step = fc.oneof(
      fc.record({ side: fc.constantFrom(0, 1), kind: fc.constant('light' as const), n: fc.integer({ min: 1, max: 30 }) }),
      fc.record({ side: fc.constantFrom(0, 1), kind: fc.constant('camera' as const), n: fc.integer({ min: 1, max: 30 }) }),
      fc.record({ side: fc.constantFrom(0, 1), kind: fc.constant('delete' as const), n: fc.integer({ min: 1, max: 30 }) }),
      fc.record({ side: fc.constantFrom(0, 1), kind: fc.constant('undo' as const), n: fc.constant(0) }),
      fc.record({ side: fc.constantFrom(0, 1), kind: fc.constant('sync' as const), n: fc.constant(0) }),
    );
    fc.assert(fc.property(fc.array(step, { minLength: 30, maxLength: 60 }), (steps) => {
      const docs = [sceneDoc(), sceneDoc()];
      const origins = [Symbol('a'), Symbol('b')];
      const histories = docs.map((doc, i) => createSceneHistory(doc, origins[i]));
      for (const { side, kind, n } of steps) {
        const doc = docs[side];
        const lightsBefore = readSceneDocument(doc).objects.filter((object) => object.model.kind === ('light' as never)).length;
        if (kind === 'sync') { Y.applyUpdate(docs[1 - side], Y.encodeStateAsUpdate(doc)); continue; }
        if (kind === 'undo') { histories[side].undo(); continue; }
        if (kind === 'delete') { run(doc, { type: 'delete', ids: [uuid(1000 + n)] }, origins[side], small); continue; }
        const result = run(doc, { type: 'create', objects: [kind === 'light' ? light(n + side * 100) : camera(n + side * 100)] }, origins[side], small);
        if (kind === 'light' && result.ok) expect(lightsBefore + 1).toBeLessThanOrEqual(small.maxLights);
        if (kind === 'camera' && !result.ok) expect(result.reason).not.toBe('lightLimit');
      }
      Y.applyUpdate(docs[1], Y.encodeStateAsUpdate(docs[0]));
      Y.applyUpdate(docs[0], Y.encodeStateAsUpdate(docs[1]));
      const [a, b] = docs.map((doc) => readSceneDocument(doc));
      expect(a.invalidObjects).toEqual([]);
      expect(a.objects.map((object) => object.id).sort()).toEqual(b.objects.map((object) => object.id).sort());
    }), { numRuns: 60 });
  });
});
