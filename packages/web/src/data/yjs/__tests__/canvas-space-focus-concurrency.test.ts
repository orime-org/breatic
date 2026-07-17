// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Focus crops cross-client concurrency (#1782, design adversary
 * 2026-07-17): `focusImages` is a Y.Array CRDT sequence, NOT a whole-array
 * LWW register — crops appended / removed concurrently by different
 * clients must ALL survive the merge (the ratified soft-cap model assumes
 * concurrent adds coexist as overshoot; a LWW register silently vanished
 * the loser's crop with its asset already uploaded and its ledger row
 * already reported).
 *
 * Each scenario replays a true two-client offline divergence through the
 * REAL public write API: capture a baseline update, let client A write on
 * top of it, reset the doc registry, rebuild client B from the same
 * baseline (a fresh Y.Doc = a different clientID), let B write the
 * concurrent edit, then merge both updates in BOTH orders and assert the
 * replicas converge with every effect intact.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as Y from 'yjs';
import type { CanvasNodeFields, FocusImage } from '@breatic/shared';

import { docName, getDoc, _resetForTests } from '@web/data/yjs/manager';
import {
  addNode,
  addNodeFocusImage,
  removeNodeFocusImage,
} from '@web/data/yjs/canvas-space';

const PID = 'p1';
const SID = 's1';

const crop = (id: string): FocusImage => ({
  id,
  url: `https://cdn/${id}.png`,
  name: `Crop ${id}`,
  width: 100,
  height: 100,
});

/**
 * Builds the minimal generative-node fixture the writes target.
 * @returns A complete CanvasNodeFields object for node `gen`.
 */
function genNode(): CanvasNodeFields {
  return {
    id: 'gen',
    type: 'image',
    position: { x: 0, y: 0 },
    data: {
      name: 'G',
      createdAt: 1000,
      createdBy: 'u1',
      locked: false,
      operationLocks: [],
      state: 'idle',
      attachments: [],
    },
  };
}

/**
 * Returns the live registry doc for the test project/space.
 * @returns The cached canvas-space Y.Doc.
 */
function doc(): Y.Doc {
  return getDoc(docName.canvasSpace(PID, SID));
}

/**
 * Snapshots the registry doc as a Yjs update.
 * @returns The full-state update.
 */
function stateOf(): Uint8Array {
  return Y.encodeStateAsUpdate(doc());
}

/**
 * Resets the registry to a fresh doc (a new clientID) seeded from a
 * captured update — the "second client" of the replay.
 * @param update - The baseline state to replay, if any.
 */
function resetTo(update: Uint8Array | null): void {
  _resetForTests();
  if (update) Y.applyUpdate(doc(), update);
}

/**
 * Reads node `gen`'s focusImages as plain JSON (either encoding).
 * @returns The plain-JSON focusImages value.
 */
function focusJson(): unknown {
  const data = (doc().getMap('nodesMap').get('gen') as Y.Map<unknown>).get(
    'data',
  ) as Y.Map<unknown>;
  const raw = data.get('focusImages');
  return raw instanceof Y.Array ? raw.toJSON() : raw;
}

/**
 * Runs `writeA` and `writeB` as two clients diverging OFFLINE from the
 * current registry state, merges both updates in both orders, asserts the
 * replicas converge, and returns the converged focusImages JSON.
 * @param writeA - Client A's write (runs through the public API).
 * @param writeB - Client B's concurrent write (same API, fresh clientID).
 * @returns The converged focusImages value.
 */
function concurrently(writeA: () => void, writeB: () => void): unknown {
  const baseline = stateOf();
  writeA();
  const afterA = stateOf();
  resetTo(baseline);
  writeB();
  const afterB = stateOf();
  resetTo(afterA);
  Y.applyUpdate(doc(), afterB);
  const ab = focusJson();
  resetTo(afterB);
  Y.applyUpdate(doc(), afterA);
  const ba = focusJson();
  expect(ba).toEqual(ab);
  return ab;
}

describe('focusImages cross-client concurrency (design adversary 2026-07-17)', () => {
  beforeEach(() => {
    _resetForTests();
    addNode(PID, SID, genNode());
  });

  it('concurrent FIRST crops on a cropless node both survive (container born with the node)', () => {
    // The eager-seeded container is the fix's linchpin: created lazily by
    // whichever client appends first, two concurrent first-croppers would
    // each create their OWN container and map-level LWW would vanish one
    // WITH its crop.
    const merged = concurrently(
      () => expect(addNodeFocusImage(PID, SID, 'gen', crop('a'))).toBe('added'),
      () => expect(addNodeFocusImage(PID, SID, 'gen', crop('b'))).toBe('added'),
    ) as unknown[];
    expect(merged).toHaveLength(2);
    expect(merged).toEqual(expect.arrayContaining([crop('a'), crop('b')]));
  });

  it('concurrent appends on an already-cropped node keep both new crops', () => {
    addNodeFocusImage(PID, SID, 'gen', crop('base'));
    const merged = concurrently(
      () => addNodeFocusImage(PID, SID, 'gen', crop('a')),
      () => addNodeFocusImage(PID, SID, 'gen', crop('b')),
    ) as unknown[];
    expect(merged).toHaveLength(3);
    expect(merged[0]).toEqual(crop('base'));
    expect(merged).toEqual(
      expect.arrayContaining([crop('base'), crop('a'), crop('b')]),
    );
  });

  it('a removal and an append merge with BOTH effects intact', () => {
    addNodeFocusImage(PID, SID, 'gen', crop('a'));
    addNodeFocusImage(PID, SID, 'gen', crop('b'));
    const merged = concurrently(
      () => expect(removeNodeFocusImage(PID, SID, 'gen', 'a')).toBe(true),
      () => addNodeFocusImage(PID, SID, 'gen', crop('c')),
    ) as unknown[];
    expect(merged).toEqual([crop('b'), crop('c')]);
  });

  it('concurrent removals of DIFFERENT crops both land', () => {
    addNodeFocusImage(PID, SID, 'gen', crop('a'));
    addNodeFocusImage(PID, SID, 'gen', crop('b'));
    addNodeFocusImage(PID, SID, 'gen', crop('keep'));
    const merged = concurrently(
      () => expect(removeNodeFocusImage(PID, SID, 'gen', 'a')).toBe(true),
      () => expect(removeNodeFocusImage(PID, SID, 'gen', 'b')).toBe(true),
    ) as unknown[];
    expect(merged).toEqual([crop('keep')]);
  });
});
