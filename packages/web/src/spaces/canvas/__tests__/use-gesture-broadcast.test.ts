// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Driving the gesture field from the canvas's drag and resize callbacks
 * (#2010, design §5.3 and §5.6).
 *
 * The publisher is a stand-in here on purpose: what is being checked is the
 * order the three steps of a release happen in and what each one is handed,
 * and both are this module's own doing. That the field survives the awareness
 * protocol is checked against a real `Awareness` in the publisher's own spec.
 */

import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';

import type { GeometryNode } from '@web/spaces/canvas/local-gesture';
import type { GestureBatch, GesturePublisher } from '@web/spaces/canvas/use-publish-presence';
import { useGestureBroadcast } from '@web/spaces/canvas/use-gesture-broadcast';

/** One thing the broadcast did, in the order it did it. */
type Step =
  | { kind: 'publish'; batch: GestureBatch }
  | { kind: 'publishNow'; batch: GestureBatch }
  | { kind: 'clear' }
  | { kind: 'document' };

/**
 * A publisher that writes down what it was asked to do.
 * @param log - The timeline to append to.
 * @returns The stand-in publisher.
 */
function recorder(log: Step[]): GesturePublisher {
  return {
    publishGesture: (batch) => log.push({ kind: 'publish', batch }),
    publishGestureNow: (batch) => log.push({ kind: 'publishNow', batch }),
    clearGesture: () => log.push({ kind: 'clear' }),
  };
}

/**
 * Mount the broadcast over a buffer the test can move.
 * @param buffer - The render buffer, mutated in place to simulate a drag.
 * @returns The broadcast and the timeline it writes to.
 */
function mount(buffer: { current: GeometryNode[] }): {
  broadcast: ReturnType<typeof useGestureBroadcast>;
  activeIds: { current: ReadonlySet<string> };
  log: Step[];
} {
  const log: Step[] = [];
  const activeIds: { current: ReadonlySet<string> } = { current: new Set() };
  const { result } = renderHook(() =>
    useGestureBroadcast(recorder(log), buffer, activeIds),
  );
  return { broadcast: result.current, activeIds, log };
}

/**
 * Build a top-level node.
 * @param id - Its id.
 * @param x - Its x.
 * @param y - Its y.
 * @returns The node.
 */
function loose(id: string, x: number, y: number): GeometryNode {
  return { id, position: { x, y } };
}

describe('useGestureBroadcast, a drag', () => {
  it('publishes where the batch starts', () => {
    const buffer = { current: [loose('n1', 10, 20), loose('n2', 30, 40)] };
    const { broadcast, log } = mount(buffer);

    broadcast.begin('n1', ['n1'], null);

    expect(log).toEqual([{ kind: 'publish', batch: { n1: { x: 10, y: 20 } } }]);
  });

  it('publishes the whole batch again as it moves', () => {
    const buffer = { current: [loose('n1', 10, 20)] };
    const { broadcast, log } = mount(buffer);
    broadcast.begin('n1', ['n1'], null);

    buffer.current = [loose('n1', 11, 21)];
    broadcast.update();

    expect(log[1]).toEqual({ kind: 'publish', batch: { n1: { x: 11, y: 21 } } });
  });

  it('holds the nodes it is moving for the merge stage', () => {
    const buffer = {
      current: [
        { id: 'g1', position: { x: 0, y: 0 }, width: 400, height: 300 },
        { id: 'm1', parentId: 'g1', position: { x: 10, y: 10 } },
      ] as GeometryNode[],
    };
    const { broadcast, activeIds } = mount(buffer);

    broadcast.begin('g1', ['g1'], null);

    expect([...activeIds.current].sort()).toEqual(['g1', 'm1']);
    expect(broadcast.anchorId()).toBe('g1');
  });

  it('holds nothing before a gesture and after one', () => {
    const buffer = { current: [loose('n1', 10, 20)] };
    const { broadcast, activeIds } = mount(buffer);
    expect(activeIds.current.size).toBe(0);
    expect(broadcast.anchorId()).toBeNull();

    broadcast.begin('n1', ['n1'], null);
    broadcast.end(() => undefined);

    expect(activeIds.current.size).toBe(0);
    expect(broadcast.anchorId()).toBeNull();
  });
});

describe('useGestureBroadcast, the release', () => {
  it('publishes the final value, writes the document, then takes the field down', () => {
    // The order is what lets the far side hold one coordinate across the whole
    // handover: the final value is on the wire before the document write that
    // follows it, and the field only comes down once the document carries the
    // same geometry (design §5.6, invariant 8).
    const buffer = { current: [loose('n1', 10, 20)] };
    const { broadcast, log } = mount(buffer);
    broadcast.begin('n1', ['n1'], null);
    log.length = 0;

    buffer.current = [loose('n1', 99, 99)];
    broadcast.end(() => log.push({ kind: 'document' }));

    expect(log).toEqual([
      { kind: 'publishNow', batch: { n1: { x: 99, y: 99 } } },
      { kind: 'document' },
      { kind: 'clear' },
    ]);
  });

  it('reads the final geometry off the buffer, not off the last frame published', () => {
    const buffer = { current: [loose('n1', 10, 20)] };
    const { broadcast, log } = mount(buffer);
    broadcast.begin('n1', ['n1'], null);

    // The limiter can have parked the last stretch of a fast gesture, so the
    // release has to look at where the node actually ended up.
    buffer.current = [loose('n1', 500, 600)];
    broadcast.end(() => undefined);

    expect(log[1]).toEqual({ kind: 'publishNow', batch: { n1: { x: 500, y: 600 } } });
  });

  it('takes the field down even when the document write throws', () => {
    const buffer = { current: [loose('n1', 10, 20)] };
    const { broadcast, activeIds, log } = mount(buffer);
    broadcast.begin('n1', ['n1'], null);
    log.length = 0;

    expect(() =>
      broadcast.end(() => {
        throw new Error('write failed');
      }),
    ).toThrow('write failed');

    // A gesture field left standing would freeze this client's nodes on every
    // other screen until the tab closes.
    expect(log.map((step) => step.kind)).toEqual(['publishNow', 'clear']);
    expect(activeIds.current.size).toBe(0);
  });
});

describe('useGestureBroadcast, a resize', () => {
  it('publishes the Group size along with its members positions', () => {
    const buffer = {
      current: [
        { id: 'g1', position: { x: 100, y: 200 }, width: 400, height: 300 },
        { id: 'm1', parentId: 'g1', position: { x: 10, y: 20 } },
      ] as GeometryNode[],
    };
    const { broadcast, log } = mount(buffer);

    broadcast.begin('g1', ['g1'], 'g1');

    expect(log[0]).toEqual({
      kind: 'publish',
      batch: {
        g1: { x: 100, y: 200, width: 400, height: 300 },
        m1: { x: 110, y: 220 },
      },
    });
  });

  it('keeps publishing the size as the Group is dragged out', () => {
    const buffer = {
      current: [{ id: 'g1', position: { x: 0, y: 0 }, width: 400, height: 300 }] as GeometryNode[],
    };
    const { broadcast, log } = mount(buffer);
    broadcast.begin('g1', ['g1'], 'g1');

    buffer.current = [{ id: 'g1', position: { x: 0, y: 0 }, width: 800, height: 300 }];
    broadcast.update();

    expect(log[1]).toEqual({
      kind: 'publish',
      batch: { g1: { x: 0, y: 0, width: 800, height: 300 } },
    });
  });

  it('still carries the size at the release, without being told again', () => {
    const buffer = {
      current: [{ id: 'g1', position: { x: 0, y: 0 }, width: 400, height: 300 }] as GeometryNode[],
    };
    const { broadcast, log } = mount(buffer);
    broadcast.begin('g1', ['g1'], 'g1');
    log.length = 0;

    buffer.current = [{ id: 'g1', position: { x: 0, y: 0 }, width: 900, height: 700 }];
    broadcast.end(() => undefined);

    expect(log[0]).toEqual({
      kind: 'publishNow',
      batch: { g1: { x: 0, y: 0, width: 900, height: 700 } },
    });
  });
});

describe('useGestureBroadcast, a gesture cut short', () => {
  it('drops the whole batch with no final value', () => {
    // xyflow aborts the entire drag when the grabbed node leaves the lookup and
    // fires no stop for any node in the batch, so the batch has to go as one.
    const buffer = { current: [loose('n1', 10, 20), loose('n2', 30, 40)] };
    const { broadcast, activeIds, log } = mount(buffer);
    broadcast.begin('n1', ['n1', 'n2'], null);
    log.length = 0;

    broadcast.abandon();

    expect(log).toEqual([{ kind: 'clear' }]);
    expect(activeIds.current.size).toBe(0);
  });

  it('names the node the pointer grabbed, so the caller knows which one ends it', () => {
    // xyflow aborts a drag when THIS node leaves its lookup and then fires no
    // stop for any node in the batch; deleting any other node of the batch
    // leaves the drag running. The caller needs the anchor to tell them apart.
    const buffer = { current: [loose('n1', 10, 20), loose('n2', 30, 40)] };
    const { broadcast } = mount(buffer);

    broadcast.begin('n1', ['n1', 'n2'], null);

    expect(broadcast.anchorId()).toBe('n1');
    broadcast.abandon();
    expect(broadcast.anchorId()).toBeNull();
  });

  it('says nothing when there was no gesture to drop', () => {
    const buffer = { current: [loose('n1', 10, 20)] };
    const { broadcast, log } = mount(buffer);

    broadcast.abandon();

    expect(log).toEqual([]);
  });
});
