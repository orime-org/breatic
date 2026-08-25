// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * The read side's one entry point for who holds what.
 *
 * A real `Awareness` pair is used rather than a double: what is being checked
 * is which of the protocol's own notifications reach React and which are
 * damped, and a hand-written stand-in would fire whatever this test expected.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from 'y-protocols/awareness';
import * as Y from 'yjs';

import { useCanvasOccupants } from '@web/spaces/canvas/use-canvas-occupants';

const open: Array<{ doc: Y.Doc; awareness: Awareness }> = [];

/**
 * Build a real awareness over a throwaway document.
 * @returns The awareness, torn down after the test.
 */
function makeAwareness(): Awareness {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  open.push({ doc, awareness });
  return awareness;
}

/**
 * Pipe one awareness' updates into another, the way the socket does.
 * @param from - The awareness whose changes travel.
 * @param to - The awareness that receives them.
 */
function pipe(from: Awareness, to: Awareness): void {
  from.on('update', (changes: { added: number[]; updated: number[]; removed: number[] }) => {
    const touched = [...changes.added, ...changes.updated, ...changes.removed];
    applyAwarenessUpdate(to, encodeAwarenessUpdate(from, touched), 'remote');
  });
}

/**
 * Build the local awareness plus a peer already piped into it.
 * @returns The local awareness and one remote peer.
 */
function pair(): { local: Awareness; remote: Awareness } {
  const local = makeAwareness();
  const remote = makeAwareness();
  pipe(remote, local);
  remote.setLocalStateField('user', { id: 'alice' });
  return { local, remote };
}

afterEach(() => {
  for (const { doc, awareness } of open.splice(0)) {
    awareness.destroy();
    doc.destroy();
  }
});

describe('useCanvasOccupants', () => {
  it('starts empty and stays empty without an awareness', () => {
    const { result } = renderHook(() => useCanvasOccupants(null));

    expect(result.current.size).toBe(0);
  });

  it('reads the holding a peer already published before it mounted', () => {
    const { local, remote } = pair();
    remote.setLocalStateField('activeNodeIds', ['n1']);

    const { result } = renderHook(() => useCanvasOccupants(local));

    expect(result.current.get('n1')).toEqual(['alice']);
  });

  it('follows a peer taking and releasing a node', () => {
    const { local, remote } = pair();
    const { result } = renderHook(() => useCanvasOccupants(local));

    act(() => remote.setLocalStateField('activeNodeIds', ['n1']));
    expect(result.current.get('n1')).toEqual(['alice']);

    act(() => remote.setLocalStateField('activeNodeIds', null));
    expect(result.current.size).toBe(0);
  });

  it('keeps the table identical when only a pointer moved', () => {
    // This is the whole point of the read-side split: the writer republishes
    // the entire state at up to 30fps while a pointer moves, and none of those
    // notifications may reach the node renderer.
    const { local, remote } = pair();
    remote.setLocalStateField('activeNodeIds', ['n1']);

    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useCanvasOccupants(local);
    });
    const first = result.current;
    const before = renders;

    act(() => {
      for (let i = 0; i < 10; i += 1) {
        remote.setLocalStateField('pointer', { x: i, y: i });
      }
    });

    expect(result.current).toBe(first);
    expect(renders).toBe(before);
  });

  it('leaves this client out of its own view', () => {
    const { local } = pair();
    local.setLocalStateField('user', { id: 'me' });
    local.setLocalStateField('activeNodeIds', ['mine']);

    const { result } = renderHook(() => useCanvasOccupants(local));

    expect(result.current.size).toBe(0);
  });

  it('drops the peer when it leaves', () => {
    const { local, remote } = pair();
    remote.setLocalStateField('activeNodeIds', ['n1']);
    const { result } = renderHook(() => useCanvasOccupants(local));

    act(() => remote.setLocalState(null));

    expect(result.current.size).toBe(0);
  });

  it('stops listening once unmounted', () => {
    const { local, remote } = pair();
    const { unmount } = renderHook(() => useCanvasOccupants(local));
    unmount();

    // Asserting on the last rendered value would prove nothing — React stops
    // rendering an unmounted hook either way. What has to be seen is the
    // listener no longer running, so watch the call it would make.
    const reads = vi.spyOn(local, 'getStates');
    act(() => remote.setLocalStateField('activeNodeIds', ['n1']));

    expect(reads).not.toHaveBeenCalled();
  });
});
