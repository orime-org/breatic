// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Look commands from two members with their own undo and redo, interleaved and merged
 * (inner#1693 design 10): both replicas converge, every record is valid or reported invalid,
 * a member's undo and redo leave the keys the other member wrote as they are, and a reset part
 * carries no look key.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { SCENE_FORMAT_VERSION, SCENE_LOOK_FIELDS } from '@breatic/shared';

import { applySceneCommand, createSceneHistory, readSceneDocument, type SceneCommand } from '@web/data/yjs/scene-document';

const NAME = 'project-p1/3d-s1';
const ID = '11111111-1111-4111-8111-111111111111';
const IMAGE = 'https://cdn.example/assets/wood.png';
const BASE = {
  id: ID, name: 'Figure', model: { kind: 'builtin' as const, id: 'figure' as const },
  position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number], locked: false,
};

type Step =
  | { side: 0 | 1; kind: 'look'; part: string | null; set: Record<string, unknown> }
  | { side: 0 | 1; kind: 'resetPart'; part: string }
  | { side: 0 | 1; kind: 'undo' | 'redo' | 'sync' };

const part = fc.constantFrom('0', '1', '2', 'd');
const unit = fc.oneof(fc.double({ min: 0, max: 1, noNaN: true }), fc.constant(null));
const colour = fc.constantFrom('#000000', '#ffffff', '#3b6fd8', null);
/** A value for each look field; null deletes it. */
const VALUES: Record<string, fc.Arbitrary<unknown>> = {
  color: colour, roughness: unit, metalness: unit, opacity: unit, transmission: unit, emissive: colour,
  emissiveIntensity: fc.oneof(fc.double({ min: 0, max: 10, noNaN: true }), fc.constant(null)),
  map: fc.constantFrom(IMAGE, 'none', null), mapRepeat: fc.constantFrom([1, 1], [2, 3], null),
  mapOffset: fc.constantFrom([0, 0], [0.5, -1], null), mapRotation: fc.oneof(fc.integer({ min: -180, max: 180 }), fc.constant(null)),
};
const fields = fc.record(Object.fromEntries(SCENE_LOOK_FIELDS.map((name) => [name, VALUES[name]!])), { requiredKeys: [] })
  .filter((set) => Object.keys(set).length > 0);
const side = fc.constantFrom(0 as const, 1 as const);
// Weighted toward writes, syncs and undos, so a member undoing after the other member's write reached them is common.
const step: fc.Arbitrary<Step> = fc.oneof(
  { arbitrary: fc.record({ side, kind: fc.constant('look' as const), part, set: fields }), weight: 4 },
  { arbitrary: fc.record({ side, kind: fc.constant('look' as const), part: fc.constant(null), set: fc.constant({}) }), weight: 1 },
  { arbitrary: fc.record({ side, kind: fc.constant('resetPart' as const), part }), weight: 1 },
  { arbitrary: fc.record({ side, kind: fc.constant('sync' as const) }), weight: 3 },
  { arbitrary: fc.record({ side, kind: fc.constantFrom('undo' as const, 'redo' as const) }), weight: 3 },
);

/** The object's look keys on a replica, with their values. */
function lookKeys(doc: Y.Doc): string {
  const record = doc.getMap('objects').get(ID) as Y.Map<unknown>;
  return JSON.stringify([...record.entries()].filter(([key]) => key.startsWith('look.')).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The look keys of the object on a replica that the other replica wrote last, with their values.
 * @param doc - The replica.
 * @returns Key to value, for keys whose current write came from another client.
 */
function othersKeys(doc: Y.Doc): Map<string, unknown> {
  const record = doc.getMap('objects').get(ID) as Y.Map<unknown> | undefined;
  const found = new Map<string, unknown>();
  if (!record) return found;
  // Yjs keeps the item that set each key; its client is the replica that wrote it.
  const items = (record as unknown as { _map: Map<string, { id: { client: number }; deleted: boolean }> })._map;
  for (const [key, item] of items) {
    if (key.startsWith('look.') && !item.deleted && item.id.client !== doc.clientID) found.set(key, JSON.stringify(record.get(key)));
  }
  return found;
}

/** Exchanges both replicas' updates so they converge. */
function merge(left: Y.Doc, right: Y.Doc): void {
  const leftUpdate = Y.encodeStateAsUpdate(left);
  const rightUpdate = Y.encodeStateAsUpdate(right);
  Y.applyUpdate(left, rightUpdate);
  Y.applyUpdate(right, leftUpdate);
}

describe('look commands under concurrent editing (property)', () => {
  it('converges, keeps every record valid or reported, undoes only its own writes and leaves a reset part without keys', () => {
    fc.assert(fc.property(fc.array(step, { minLength: 10, maxLength: 40 }), (steps) => {
      const docs = [new Y.Doc(), new Y.Doc()] as const;
      docs[0].getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
      applySceneCommand(docs[0], { type: 'create', objects: [BASE] }, Symbol(), true, NAME);
      Y.applyUpdate(docs[1], Y.encodeStateAsUpdate(docs[0]));
      const origins = [Symbol('left'), Symbol('right')] as const;
      const histories = [createSceneHistory(docs[0], origins[0]), createSceneHistory(docs[1], origins[1])] as const;
      try {
        for (const current of steps) {
          const doc = docs[current.side];
          if (current.kind === 'resetPart') {
            // The panel's "reset this part" sets every stored field of the part to null in one command.
            const record = doc.getMap('objects').get(ID) as Y.Map<unknown>;
            const prefix = `look.${current.part}.`;
            const set = Object.fromEntries([...record.keys()].filter((key) => key.startsWith(prefix)).map((key) => [key.slice(prefix.length), null]));
            if (Object.keys(set).length > 0) {
              const result = applySceneCommand(doc, { type: 'look', id: ID, part: current.part, set } as unknown as SceneCommand, origins[current.side], true, NAME);
              expect(result.ok).toBe(true);
            }
            expect([...record.keys()].some((key) => key.startsWith(prefix))).toBe(false);
          } else if (current.kind === 'look') {
            const command = { type: 'look', id: ID, part: current.part, set: current.set } as unknown as SceneCommand;
            const before = lookKeys(doc);
            const result = applySceneCommand(doc, command, origins[current.side], true, NAME);
            expect(result.ok, JSON.stringify(current)).toBe(true);
            // Undo takes back exactly this write, and redo puts it back.
            const after = lookKeys(doc);
            if (after !== before) {
              histories[current.side].undo();
              expect(lookKeys(doc), 'undo restores the look before the write').toBe(before);
              histories[current.side].redo();
              expect(lookKeys(doc), 'redo puts the write back').toBe(after);
            }
            if (current.part !== null && Object.values(current.set).every((value) => value === null)) {
              const record = doc.getMap('objects').get(ID) as Y.Map<unknown>;
              for (const key of Object.keys(current.set)) expect(record.has(`look.${current.part}.${key}`)).toBe(false);
            }
            if (current.part === null) {
              const record = doc.getMap('objects').get(ID) as Y.Map<unknown>;
              expect([...record.keys()].some((key) => key.startsWith('look.'))).toBe(false);
            }
          } else if (current.kind === 'undo' || current.kind === 'redo') {
            const others = othersKeys(doc);
            if (current.kind === 'undo') histories[current.side].undo();
            else histories[current.side].redo();
            const record = doc.getMap('objects').get(ID) as Y.Map<unknown>;
            for (const [key, value] of others) expect(JSON.stringify(record.get(key)), `${current.kind} touched ${key}`).toBe(value);
          } else merge(docs[0], docs[1]);
          for (const replica of docs) {
            const scene = readSceneDocument(replica);
            expect(scene.invalidObjects).toEqual([]);
            expect(scene.objects).toHaveLength(1);
          }
        }
        merge(docs[0], docs[1]);
        expect(readSceneDocument(docs[0]).objects).toEqual(readSceneDocument(docs[1]).objects);
        expect(readSceneDocument(docs[0]).invalidObjects).toEqual([]);
      } finally {
        histories.forEach((history) => history.destroy());
        docs.forEach((doc) => doc.destroy());
      }
    }), { numRuns: 200 });
  });
});
