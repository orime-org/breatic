// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Reading the geometry remote gestures are showing nodes at (#2010, design
 * §5.4). Every cell of the reader's transition table is a case here: a remote
 * entering a gesture, updating it, ending it, and being evicted, plus two
 * remotes reaching for the same node.
 */

import { describe, expect, it } from 'vitest';

import type { GestureGeometry, GestureTable } from '@web/spaces/canvas/gesture-table';
import {
  collectRemoteGesture,
  readGestureField,
  sameGestureTable,
} from '@web/spaces/canvas/gesture-table';

/**
 * Build an awareness state carrying a gesture.
 * @param gesture - The gesture field's value.
 * @returns The state record.
 */
function stateWith(gesture: unknown): Record<string, unknown> {
  return { user: { id: 'alice', name: 'Alice' }, gesture };
}

/**
 * Build the states map awareness hands over.
 * @param entries - Client id to state.
 * @returns The map.
 */
function states(
  ...entries: Array<[number, Record<string, unknown>]>
): ReadonlyMap<number, Record<string, unknown>> {
  return new Map(entries);
}

/**
 * Build a table from plain entries.
 * @param entries - Node id to geometry.
 * @returns The table.
 */
function table(...entries: Array<[string, GestureGeometry]>): GestureTable {
  return new Map(entries);
}

describe('collectRemoteGesture', () => {
  it('collects one remote gesture', () => {
    const collected = collectRemoteGesture(
      states([2, stateWith({ n1: { x: 10, y: 20 } })]),
      1,
    );
    expect(collected.get('n1')).toEqual({ x: 10, y: 20 });
  });

  it('merges the batches of two remotes', () => {
    const collected = collectRemoteGesture(
      states(
        [2, stateWith({ n1: { x: 10, y: 20 } })],
        [3, stateWith({ n2: { x: 30, y: 40 } })],
      ),
      1,
    );
    expect(collected.size).toBe(2);
    expect(collected.get('n1')).toEqual({ x: 10, y: 20 });
    expect(collected.get('n2')).toEqual({ x: 30, y: 40 });
  });

  it('leaves this client out of the table', () => {
    const collected = collectRemoteGesture(
      states([1, stateWith({ mine: { x: 1, y: 2 } })]),
      1,
    );
    expect(collected.size).toBe(0);
  });

  it('carries the size a resized Group publishes', () => {
    const collected = collectRemoteGesture(
      states([2, stateWith({ g1: { x: 0, y: 0, width: 400, height: 300 } })]),
      1,
    );
    expect(collected.get('g1')).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  });

  it('drops a remote whose gesture ended', () => {
    const collected = collectRemoteGesture(states([2, stateWith(null)]), 1);
    expect(collected.size).toBe(0);
  });

  it('drops a remote that is no longer in the states at all', () => {
    const collected = collectRemoteGesture(states(), 1);
    expect(collected.size).toBe(0);
  });

  it('keeps only the other nodes when one remote of two ends', () => {
    const collected = collectRemoteGesture(
      states([2, stateWith(null)], [3, stateWith({ n2: { x: 30, y: 40 } })]),
      1,
    );
    expect(collected.size).toBe(1);
    expect(collected.get('n2')).toEqual({ x: 30, y: 40 });
  });

  it('lets the later entry win when two remotes move the same node', () => {
    const collected = collectRemoteGesture(
      states(
        [2, stateWith({ n1: { x: 10, y: 20 } })],
        [3, stateWith({ n1: { x: 99, y: 99 } })],
      ),
      1,
    );
    expect(collected.get('n1')).toEqual({ x: 99, y: 99 });
  });

  it('ignores a state with no gesture field', () => {
    const collected = collectRemoteGesture(
      states([2, { user: { id: 'alice', name: 'Alice' } }]),
      1,
    );
    expect(collected.size).toBe(0);
  });

  it('ignores a malformed gesture field', () => {
    const collected = collectRemoteGesture(
      states(
        [2, stateWith('not a table')],
        [3, stateWith({ n1: { x: 'ten', y: 20 } })],
        [4, stateWith({ n2: { x: 10 } })],
        [5, stateWith({ n3: null })],
      ),
      1,
    );
    expect(collected.size).toBe(0);
  });

  it('keeps the sound entries of a batch that has one malformed member', () => {
    const collected = collectRemoteGesture(
      states([2, stateWith({ n1: { x: 10, y: 20 }, n2: { x: 'ten', y: 20 } })]),
      1,
    );
    expect(collected.size).toBe(1);
    expect(collected.get('n1')).toEqual({ x: 10, y: 20 });
  });

  it('drops a size that is not a number', () => {
    const collected = collectRemoteGesture(
      states([2, stateWith({ g1: { x: 0, y: 0, width: 'wide', height: 300 } })]),
      1,
    );
    expect(collected.size).toBe(0);
  });
});

describe('readGestureField', () => {
  it('reads a sound table', () => {
    const read = readGestureField({ n1: { x: 1, y: 2 } });
    expect(read?.get('n1')).toEqual({ x: 1, y: 2 });
  });

  it('reports null for a field that is absent', () => {
    expect(readGestureField(undefined)).toBeNull();
    expect(readGestureField(null)).toBeNull();
  });

  it('reports null for a field of the wrong shape', () => {
    expect(readGestureField('not a table')).toBeNull();
    expect(readGestureField(42)).toBeNull();
  });
});

describe('sameGestureTable', () => {
  it('holds two tables with the same geometry to be the same', () => {
    expect(
      sameGestureTable(table(['n1', { x: 1, y: 2 }]), table(['n1', { x: 1, y: 2 }])),
    ).toBe(true);
  });

  it('separates two tables whose geometry differs', () => {
    expect(
      sameGestureTable(table(['n1', { x: 1, y: 2 }]), table(['n1', { x: 1, y: 3 }])),
    ).toBe(false);
  });

  it('separates two tables of different size', () => {
    expect(
      sameGestureTable(
        table(['n1', { x: 1, y: 2 }]),
        table(['n1', { x: 1, y: 2 }], ['n2', { x: 3, y: 4 }]),
      ),
    ).toBe(false);
  });

  it('separates two tables that name different nodes', () => {
    expect(
      sameGestureTable(table(['n1', { x: 1, y: 2 }]), table(['n2', { x: 1, y: 2 }])),
    ).toBe(false);
  });

  it('separates a Group whose size changed while its position held still', () => {
    expect(
      sameGestureTable(
        table(['g1', { x: 0, y: 0, width: 400, height: 300 }]),
        table(['g1', { x: 0, y: 0, width: 401, height: 300 }]),
      ),
    ).toBe(false);
  });

  it('holds two empty tables to be the same', () => {
    expect(sameGestureTable(table(), table())).toBe(true);
  });
});
