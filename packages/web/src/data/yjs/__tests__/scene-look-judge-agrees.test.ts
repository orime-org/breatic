// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * Collab writes an uploaded part picture when the shared `judgeSceneLookPicture` allows it, and the editor writes a
 * picture through `planSceneCommand` (inner#1693 design 6.3). For the same scene they must agree on who may receive a
 * picture: a write collab makes is one the editor would make, and the limits and refusals are the same.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { SCENE_FORMAT_VERSION, SCENE_LOOK_MAX_PARTS, judgeSceneLookPicture } from '@breatic/shared';

import { planSceneCommand, readSceneDocument } from '@web/data/yjs/scene-document';

const NAME = 'project-p1/3d-s1';
const ID = '11111111-1111-4111-8111-111111111111';
const PICTURE = '77777777-7777-4777-8777-777777777777';
const START = '88888888-8888-4888-8888-888888888888';
const OTHER = '99999999-9999-4999-8999-999999999999';

/**
 * A scene holding one object built from the drawn values.
 * @param input - The drawn record.
 * @param input.kind - The model kind.
 * @param input.locked - Whether the object is locked.
 * @param input.others - How many other parts already have a look.
 * @param input.now - The target part's picture now, or undefined for none.
 * @returns The document.
 */
function scene(input: { kind: 'builtin' | 'asset' | 'camera'; locked: boolean; others: number; now: string | undefined }): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap('scene').set('formatVersion', SCENE_FORMAT_VERSION);
  const record = new Y.Map<unknown>();
  doc.getMap('objects').set(ID, record);
  if (input.kind === 'camera') {
    record.set('model', { kind: 'camera' });
    record.set('number', 1);
  } else {
    record.set('model', input.kind === 'builtin' ? { kind: 'builtin', id: 'figure' } : { kind: 'asset', assetId: OTHER });
    for (let at = 0; at < input.others; at += 1) record.set(`look.${at + 10}.color`, '#ff0000');
    if (input.now !== undefined) record.set('look.3.map', input.now);
  }
  if (input.locked) record.set('locked', true);
  return doc;
}

describe('judgeSceneLookPicture agrees with the editor\'s write plan', () => {
  it('writes, refuses for the part limit and refuses an unwritable object exactly where the editor does', () => {
    fc.assert(fc.property(
      fc.constantFrom('builtin' as const, 'asset' as const, 'camera' as const),
      fc.boolean(),
      fc.oneof(fc.integer({ min: 0, max: 3 }), fc.integer({ min: SCENE_LOOK_MAX_PARTS - 2, max: SCENE_LOOK_MAX_PARTS + 1 })),
      fc.constantFrom(undefined, START, OTHER, 'none'),
      fc.constantFrom(null, START),
      (kind, locked, others, now, startMap) => {
        const doc = scene({ kind, locked, others, now });
        const object = readSceneDocument(doc).objects.find((item) => item.id === ID);
        const judged = judgeSceneLookPicture({ object, part: '3', startMap, picture: PICTURE });
        const plan = planSceneCommand(doc, NAME, { type: 'look', id: ID, part: '3', set: { map: PICTURE } }, true);
        const refusal = plan.ok ? null : plan.reason;
        if (judged === 'write') expect(refusal).toBeNull();
        if (judged === 'partLimit') expect(refusal).toBe('lookPartLimit');
        if (judged === 'objectGone') expect(['locked', 'invalid', 'missing']).toContain(refusal);
        if (refusal === 'lookPartLimit') expect(judged).toBe('partLimit');
        if (refusal === 'locked' || refusal === 'invalid' || refusal === 'missing') expect(judged).toBe('objectGone');
      },
    ), { numRuns: 300 });
  });
});
