// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * Publishing which nodes this client holds.
 *
 * A real `Awareness` is used rather than a double: what is being checked is
 * that the field survives a round trip through the protocol's own clock and
 * de-duplication, which a hand-written stand-in would answer from whatever
 * this test expected instead.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { usePublishActiveNodes } from '@web/spaces/canvas/use-publish-active-nodes';
import type { ActiveNodeSources } from '@web/spaces/canvas/active-node-ids';

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
 * Read back what this client currently publishes.
 * @param awareness - The awareness to read.
 * @returns The published ids, or null when the field is empty or absent.
 */
function published(awareness: Awareness): readonly string[] | null {
  const state = awareness.getLocalState() as { activeNodeIds?: string[] | null } | null;
  return state?.activeNodeIds ?? null;
}

/**
 * Wait for the animation frame the publisher batches into, plus one more so a
 * frame scheduled from within the first one has also run.
 * @returns A promise resolved after two frames.
 */
function twoFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

const NOTHING: ActiveNodeSources = {
  selectedIds: [],
  pickSession: null,
  focusTargetId: null,
};

afterEach(() => {
  for (const { doc, awareness } of open.splice(0)) {
    awareness.destroy();
    doc.destroy();
  }
});

describe('usePublishActiveNodes', () => {
  it('publishes the holding it is mounted with', async () => {
    const awareness = makeAwareness();
    renderHook(() =>
      usePublishActiveNodes({
        awareness,
        sources: { ...NOTHING, selectedIds: ['a'] },
        connected: true,
      }),
    );

    await twoFrames();

    expect(published(awareness)).toEqual(['a']);
  });

  it('follows the sources when they change', async () => {
    const awareness = makeAwareness();
    const rendered = renderHook(
      (sources: ActiveNodeSources) =>
        usePublishActiveNodes({ awareness, sources, connected: true }),
      { initialProps: { ...NOTHING, selectedIds: ['a'] } },
    );
    await twoFrames();

    rendered.rerender({ ...NOTHING, selectedIds: ['b', 'c'] });
    await twoFrames();

    expect(published(awareness)).toEqual(['b', 'c']);
  });

  it('leaves the field null while nothing is held', async () => {
    const awareness = makeAwareness();
    renderHook(() =>
      usePublishActiveNodes({ awareness, sources: NOTHING, connected: true }),
    );

    await twoFrames();

    expect(published(awareness)).toBeNull();
  });

  it('does not republish a holding that has not changed', async () => {
    const awareness = makeAwareness();
    const rendered = renderHook(
      (sources: ActiveNodeSources) =>
        usePublishActiveNodes({ awareness, sources, connected: true }),
      { initialProps: { ...NOTHING, selectedIds: ['a'] } },
    );
    await twoFrames();

    let writes = 0;
    awareness.on('update', () => {
      writes += 1;
    });
    // A fresh array with the same content, the way the mirror hands one over
    // on any unrelated document change.
    rendered.rerender({ ...NOTHING, selectedIds: ['a'] });
    await twoFrames();

    expect(writes).toBe(0);
  });

  it('republishes after the state is wiped from the outside', async () => {
    const awareness = makeAwareness();
    const rendered = renderHook(
      (sources: ActiveNodeSources) =>
        usePublishActiveNodes({ awareness, sources, connected: true }),
      { initialProps: { ...NOTHING, selectedIds: ['a'] } },
    );
    await twoFrames();

    // What the bfcache teardown does: the whole local state goes, and the
    // sources have not moved, so nothing in React reports a change.
    awareness.setLocalState({});
    expect(published(awareness)).toBeNull();

    rendered.rerender({ ...NOTHING, selectedIds: ['a'] });
    await twoFrames();

    expect(published(awareness)).toEqual(['a']);
  });

  it('collapses several changes within one frame into a single write', async () => {
    const awareness = makeAwareness();
    const rendered = renderHook(
      (sources: ActiveNodeSources) =>
        usePublishActiveNodes({ awareness, sources, connected: true }),
      { initialProps: { ...NOTHING, selectedIds: ['a'] } },
    );
    await twoFrames();

    let writes = 0;
    awareness.on('update', () => {
      writes += 1;
    });
    // What a rubber-band drag does: every pointer move flips one more node's
    // `selected`, and each one arrives as its own render.
    rendered.rerender({ ...NOTHING, selectedIds: ['a', 'b'] });
    rendered.rerender({ ...NOTHING, selectedIds: ['a', 'b', 'c'] });
    rendered.rerender({ ...NOTHING, selectedIds: ['a', 'b', 'c', 'd'] });
    await twoFrames();

    expect(writes).toBe(1);
    expect(published(awareness)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('clears the field when it unmounts', async () => {
    const awareness = makeAwareness();
    const rendered = renderHook(() =>
      usePublishActiveNodes({
        awareness,
        sources: { ...NOTHING, selectedIds: ['a'] },
        connected: true,
      }),
    );
    await twoFrames();
    expect(published(awareness)).toEqual(['a']);

    rendered.unmount();

    expect(published(awareness)).toBeNull();
  });

  it('republishes on reconnect, even though nothing local changed', async () => {
    const awareness = makeAwareness();
    const rendered = renderHook(
      (connected: boolean) =>
        usePublishActiveNodes({
          awareness,
          sources: { ...NOTHING, selectedIds: ['a'] },
          connected,
        }),
      { initialProps: true },
    );
    await twoFrames();

    let writes = 0;
    awareness.on('update', () => {
      writes += 1;
    });
    rendered.rerender(false);
    await twoFrames();
    rendered.rerender(true);
    await twoFrames();

    // The server drops an update whose clock it has already seen, and closing
    // the socket moves neither side's clock. Reconnecting therefore has to
    // push a fresh one or the peers never get this holding back.
    expect(writes).toBeGreaterThan(0);
    expect(published(awareness)).toEqual(['a']);
  });

  it('republishes when the page comes back from the bfcache', async () => {
    const awareness = makeAwareness();
    renderHook(() =>
      usePublishActiveNodes({
        awareness,
        sources: { ...NOTHING, selectedIds: ['a'] },
        connected: true,
      }),
    );
    await twoFrames();

    // The provider drops the local state on `pagehide` and puts back an empty
    // one on restore, while the sources sat frozen across the whole round trip.
    awareness.setLocalState({});
    const restored = new Event('pageshow');
    Object.defineProperty(restored, 'persisted', { value: true });
    window.dispatchEvent(restored);
    await twoFrames();

    expect(published(awareness)).toEqual(['a']);
  });

  it('writes nothing when there is no awareness yet', async () => {
    const rendered = renderHook(() =>
      usePublishActiveNodes({
        awareness: null,
        sources: { ...NOTHING, selectedIds: ['a'] },
        connected: true,
      }),
    );

    await twoFrames();

    expect(() => rendered.unmount()).not.toThrow();
  });
});
