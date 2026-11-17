// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Look commands from two members with their own undo and redo, interleaved and merged
 * (inner#1693 design 10): both replicas converge, every record is valid or reported invalid,
 * and a reset part carries no look key.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { SCENE_FORMAT_VERSION } from '@breatic/shared';

import { applySceneCommand, createSceneHistory, readSceneDocument, type SceneCommand } from '@web/data/yjs/scene-document';

const NAME = 'project-p1/3d-s1';
const ID = '11111111-1111-4111-8111-111111111111';
const IMAGE = '66666666-6666-4666-8666-666666666666';
const BASE = {
  id: ID, name: 'Figure', model: { kind: 'builtin' as const, id: 'figure' as const },
  position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number], locked: false,
};

type Step =
  | { side: 0 | 1; kind: 'look'; part: string | null; set: Record<string, unknown> }
  | { side: 0 | 1; kind: 'undo' | 'redo' | 'sync' };

const part = fc.constantFrom('0', '1', '2', 'd');
const field = fc.oneof(
  fc.record({ color: fc.constantFrom('#000000', '#ffffff', '#3b6fd8', null) }),
  fc.record({ roughness: fc.oneof(fc.double({ min: 0, max: 1, noNaN: true }), fc.constant(null)) }),
  fc.record({ map: fc.constantFrom(IMAGE, 'none', null) }),
  fc.record({ mapRepeat: fc.constantFrom([1, 1], [2, 3], null) }),
);
const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ side: fc.constantFrom(0 as const, 1 as const), kind: fc.constant('look' as const), part, set: field }),
  fc.record({ side: fc.constantFrom(0 as const, 1 as const), kind: fc.constant('look' as const), part: fc.constant(null), set: fc.constant({}) }),
  fc.record({ side: fc.constantFrom(0 as const, 1 as const), kind: fc.constantFrom('undo' as const, 'redo' as const, 'sync' as const) }),
);

/** Exchanges both replicas' updates so they converge. */
function merge(left: Y.Doc, right: Y.Doc): void {
  const leftUpdate = Y.encodeStateAsUpdate(left);
  const rightUpdate = Y.encodeStateAsUpdate(right);
  Y.applyUpdate(left, rightUpdate);
  Y.applyUpdate(right, leftUpdate);
}

describe('look commands under concurrent editing (property)', () => {
  it('converges, keeps every record valid or reported, and leaves a reset part without keys', () => {
    fc.assert(fc.property(fc.array(step, { maxLength: 30 }), (steps) => {
      const docs = [new Y.Doc(), new Y.Doc()] as const;
      docs[0].getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
      applySceneCommand(docs[0], { type: 'create', objects: [BASE] }, Symbol(), true, NAME);
      Y.applyUpdate(docs[1], Y.encodeStateAsUpdate(docs[0]));
      const origins = [Symbol('left'), Symbol('right')] as const;
      const histories = [createSceneHistory(docs[0], origins[0]), createSceneHistory(docs[1], origins[1])] as const;
      try {
        for (const current of steps) {
          const doc = docs[current.side];
          if (current.kind === 'look') {
            const command = { type: 'look', id: ID, part: current.part, set: current.set } as unknown as SceneCommand;
            const result = applySceneCommand(doc, command, origins[current.side], true, NAME);
            expect(result.ok, JSON.stringify(current)).toBe(true);
            if (current.part !== null && Object.values(current.set).every((value) => value === null)) {
              const record = doc.getMap('objects').get(ID) as Y.Map<unknown>;
              for (const key of Object.keys(current.set)) expect(record.has(`look.${current.part}.${key}`)).toBe(false);
            }
            if (current.part === null) {
              const record = doc.getMap('objects').get(ID) as Y.Map<unknown>;
              expect([...record.keys()].some((key) => key.startsWith('look.'))).toBe(false);
            }
          } else if (current.kind === 'undo') histories[current.side].undo();
          else if (current.kind === 'redo') histories[current.side].redo();
          else merge(docs[0], docs[1]);
          for (const replica of docs) {
            const scene = readSceneDocument(replica);
            expect(scene.objects.length + scene.invalidObjects.length).toBe(1);
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
