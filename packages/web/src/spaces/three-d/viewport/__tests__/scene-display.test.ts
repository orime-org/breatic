// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { SceneObject } from '@breatic/shared';
import { displayedObjects, previewedObjectIds } from '@web/spaces/three-d/viewport/scene-display';
import type { SceneRemotePeer } from '@web/spaces/three-d/viewport/scene-viewport-props';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const QUARTER_TURN: [number, number, number, number] = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
const ARM_UP = { 'h:leftUpperArm': [0, 0, 0.3826834, 0.9238795] } as const;

/** One committed figure. */
function object(id: string, extra: Partial<SceneObject> = {}): SceneObject {
  return { id, name: id === A ? 'Alice figure' : 'Bob figure', model: { kind: 'builtin', id: 'figure' },
    position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], locked: false, ...extra };
}

/** A collaborator whose gesture carries the given values. */
function peer(clientId: number, gesture: readonly SceneObject[] | null, selectedIds: readonly string[] = gesture?.map((item) => item.id) ?? []): SceneRemotePeer {
  return { clientId, userId: `user-${clientId}`, color: '#ff0000', selectedIds, gesture };
}

/** The four fields a peer's gesture shows on the real instance. */
function shown(item: SceneObject | undefined): Pick<SceneObject, 'position' | 'rotation' | 'scale' | 'pose'> | undefined {
  return item && { position: item.position, rotation: item.rotation, scale: item.scale, pose: item.pose };
}

const NONE = new Set<string>();

describe('values the viewport shows for collaborators\' gestures (inner#1692)', () => {
  it('shows document values when no collaborator is dragging', () => {
    const objects = [object(A), object(B)];
    expect(displayedObjects(objects, NONE, [])).toEqual(objects);
    expect(displayedObjects(objects, NONE, [peer(7, null, [A])])).toEqual(objects);
  });

  it.each([
    { gesture: 'move', change: { position: [3, 0, -2] as [number, number, number] } },
    { gesture: 'rotate', change: { rotation: QUARTER_TURN } },
    { gesture: 'scale', change: { scale: [2, 2, 2] as [number, number, number] } },
    { gesture: 'joint drag', change: { pose: ARM_UP } },
  ])('shows a collaborator\'s $gesture on the dragged object only', ({ change }) => {
    const objects = [object(A), object(B)];
    const result = displayedObjects(objects, NONE, [peer(7, [object(A, change)])]);
    expect(result.map((item) => item.id)).toEqual([A, B]);
    expect(shown(result[0])).toEqual(shown(object(A, change)));
    // Identity and attributes stay the document's.
    expect(result[0]).toMatchObject({ id: A, name: 'Alice figure', model: { kind: 'builtin', id: 'figure' }, locked: false });
    expect(result[1]).toEqual(objects[1]);
  });

  it('shows the document value again once the collaborator\'s gesture is withdrawn', () => {
    const objects = [object(A)];
    expect(shown(displayedObjects(objects, NONE, [peer(7, [object(A, { position: [5, 0, 0], pose: ARM_UP })])])[0])).toEqual(
      { position: [5, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], pose: ARM_UP });
    expect(displayedObjects(objects, NONE, [peer(7, null, [A])])).toEqual(objects);
    expect(displayedObjects(objects, NONE, [])).toEqual(objects);
  });

  it('keeps showing the gesture when the document changes during it, and the new document value after it', () => {
    const gesture = [object(A, { position: [5, 0, 0], pose: ARM_UP })];
    const changed = [object(A, { position: [-1, 0, 4], pose: { 'h:head': [0, 0.3826834, 0, 0.9238795] } })];
    expect(shown(displayedObjects(changed, NONE, [peer(7, gesture)])[0])).toEqual(shown(gesture[0]));
    expect(displayedObjects(changed, NONE, [peer(7, null)])).toEqual(changed);
  });

  it('keeps this user\'s own gesture over a collaborator\'s on the same object', () => {
    const local = [object(A, { position: [1, 1, 1] }), object(B)];
    const result = displayedObjects(local, new Set([A]), [peer(7, [object(A, { position: [9, 9, 9] }), object(B, { position: [4, 0, 0] })])]);
    expect(result[0]).toEqual(local[0]);
    expect(result[1].position).toEqual([4, 0, 0]);
  });

  it('never shows a collaborator\'s gesture on a locked object', () => {
    const objects = [object(A, { locked: true }), object(B)];
    expect(displayedObjects(objects, NONE, [peer(7, [object(A, { position: [9, 0, 0], pose: ARM_UP })])])).toEqual(objects);
  });

  it('lets the last collaborator in peer order win when two drag the same object', () => {
    const objects = [object(A)];
    const result = displayedObjects(objects, NONE, [peer(3, [object(A, { position: [1, 0, 0] })]), peer(9, [object(A, { position: [2, 0, 0] })])]);
    expect(result[0].position).toEqual([2, 0, 0]);
  });

  it('ignores a gesture for an object the document no longer has', () => {
    const objects = [object(B)];
    expect(displayedObjects(objects, NONE, [peer(7, [object(A, { position: [9, 0, 0] })])])).toEqual(objects);
  });

  it('only ever shows the document value or a collaborator\'s gesture value for that object, in document order', () => {
    const vector = fc.tuple(fc.integer({ min: -9, max: 9 }), fc.integer({ min: -9, max: 9 }), fc.integer({ min: -9, max: 9 }));
    const ids = [A, B];
    fc.assert(fc.property(
      fc.array(fc.record({ id: fc.constantFrom(...ids), position: vector, locked: fc.boolean() }), { maxLength: 2 }).map((items) =>
        [...new Map(items.map((item) => [item.id, item])).values()].map((item) => object(item.id, { position: item.position, locked: item.locked }))),
      fc.subarray(ids),
      fc.array(fc.option(fc.array(fc.record({ id: fc.constantFrom(...ids), position: vector }), { maxLength: 2 }), { nil: null }), { maxLength: 3 }),
      (objects, localIds, gestures) => {
        const local = new Set(localIds);
        // A gesture names each object once.
        const peers = gestures.map((gesture, index) => peer(index + 1, gesture
          ? [...new Map(gesture.map((item) => [item.id, object(item.id, { position: item.position })])).values()] : null));
        const result = displayedObjects(objects, local, peers);
        expect(result.map((item) => item.id)).toEqual(objects.map((item) => item.id));
        result.forEach((item, index) => {
          const record = objects[index];
          const candidates = peers.flatMap((entry) => entry.gesture?.filter((value) => value.id === record.id) ?? []);
          const last = candidates.at(-1);
          if (local.has(record.id) || record.locked || !last) expect(item).toEqual(record);
          else expect(shown(item)).toEqual(shown(last));
        });
      },
    ));
  });
});

describe('objects drawn from a drag still in progress (inner#1692)', () => {
  it('holds this page\'s own drag and every collaborator\'s, and nothing once both end', () => {
    expect([...previewedObjectIds(NONE, [])]).toEqual([]);
    expect([...previewedObjectIds(NONE, [peer(7, null, [A])])]).toEqual([]);
    expect(new Set(previewedObjectIds(new Set([A]), [peer(7, [object(B, { pose: ARM_UP })])]))).toEqual(new Set([A, B]));
  });
});
