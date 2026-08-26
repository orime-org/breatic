// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * Publishing what this client is doing: which nodes it holds and where its
 * pointer is.
 *
 * A real `Awareness` is used rather than a double: what is being checked is
 * that the fields survive a round trip through the protocol's own clock and
 * de-duplication, which a hand-written stand-in would answer from whatever
 * this test expected instead.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import type { ActiveNodeSources } from '@web/spaces/canvas/active-node-ids';
import { usePublishPresence } from '@web/spaces/canvas/use-publish-presence';

const open: Array<{ doc: Y.Doc; awareness: Awareness }> = [];
const mounted: HTMLElement[] = [];

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
 * Put a canvas container and a viewport in the document.
 * @returns The container pointer events go to, and the viewport that pans.
 */
function makeCanvas(): { container: HTMLElement; viewport: HTMLElement } {
  const container = document.createElement('div');
  const viewport = document.createElement('div');
  viewport.className = 'react-flow__viewport';
  container.appendChild(viewport);
  document.body.appendChild(container);
  mounted.push(container);
  return { container, viewport };
}

// The global stub in `vitest.setup.ts` never calls back, which is right for
// components that only need the constructor to exist. These specs drive the
// callback, so they swap in one that remembers what it observes.
const resizeCallbacks = new Map<Element,() => void>();

class TriggerableResizeObserver {
  private readonly targets: Element[] = [];

  constructor(private readonly callback: () => void) {}

  observe(target: Element): void {
    this.targets.push(target);
    resizeCallbacks.set(target, this.callback);
  }

  unobserve(target: Element): void {
    resizeCallbacks.delete(target);
  }

  disconnect(): void {
    for (const target of this.targets) resizeCallbacks.delete(target);
  }
}

/**
 * Report a size change on an element that something is observing.
 * @param target - The observed element.
 * @throws {Error} When nothing observes it, which would leave a silent no-op.
 */
function resizeContainer(target: Element): void {
  const callback = resizeCallbacks.get(target);
  if (!callback) throw new Error('nothing observes this element');
  callback();
}

/**
 * Read back what this client currently publishes.
 * @param awareness - The awareness to read.
 * @returns The two published fields.
 */
function published(awareness: Awareness): {
  activeNodeIds: readonly string[] | null;
  pointer: { x: number; y: number } | null;
} {
  const state = awareness.getLocalState() as {
    activeNodeIds?: string[] | null;
    pointer?: { x: number; y: number } | null;
  } | null;
  return { activeNodeIds: state?.activeNodeIds ?? null, pointer: state?.pointer ?? null };
}

/**
 * Wait until what this client publishes satisfies the assertion.
 *
 * The throttle answers on a frame plus up to its interval floor, and under a
 * loaded suite that is longer than any fixed sleep worth writing. Polling the
 * assertion is immune to how busy the machine is; `settled` stays for the
 * cases that check a write did NOT happen, where waiting longer cannot
 * conjure one.
 * @param awareness - The awareness to read.
 * @param assert - Throws until the published state is the expected one.
 * @returns A promise resolved once the assertion passes.
 */
function untilPublished(
  awareness: Awareness,
  assert: (published: {
    activeNodeIds: readonly string[] | null;
    pointer: { x: number; y: number } | null;
  }) => void,
): Promise<void> {
  return vi.waitFor(() => assert(published(awareness)), { timeout: 2_000 });
}

/**
 * Whether this client still has an awareness entry at all.
 *
 * Withdrawal has to null the fields and leave the state standing: the collab
 * server re-encodes each frame against a scratch awareness built fresh, and a
 * frame carrying a deletion applies to a table that never had this client in
 * it — so the deletion is a no-op and the peers keep the presence forever.
 * Reading the fields alone cannot tell the two apart, because a deleted state
 * answers null for both.
 * @param awareness - The awareness to inspect.
 * @returns True while a local state object exists.
 */
function stillListed(awareness: Awareness): boolean {
  return awareness.getLocalState() !== null;
}

/**
 * Wait out the throttle: an animation frame plus the interval floor.
 * @returns A promise resolved once a scheduled write has run.
 */
function settled(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60));
}

/**
 * Send a pointer event the way a browser does, carrying screen coordinates.
 * @param target - The element to dispatch on.
 * @param type - The event name.
 * @param at - The screen point, when the event carries one.
 */
function sendPointer(
  target: HTMLElement,
  type: 'pointermove' | 'pointerleave',
  at?: { clientX: number; clientY: number },
): void {
  target.dispatchEvent(
    new MouseEvent(type, { bubbles: false, clientX: at?.clientX ?? 0, clientY: at?.clientY ?? 0 }),
  );
}

const NOTHING: ActiveNodeSources = {
  selectedIds: [],
  pickSession: null,
  focusTargetId: null,
};

/** Screen to canvas: the identity shifted, so the two are told apart. */
const SHIFTED = (screen: { x: number; y: number }): { x: number; y: number } => ({
  x: screen.x + 1000,
  y: screen.y + 2000,
});

const realResizeObserver = globalThis.ResizeObserver;

beforeEach(() => {
  globalThis.ResizeObserver =
    TriggerableResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(() => {
  globalThis.ResizeObserver = realResizeObserver;
  resizeCallbacks.clear();
  for (const { doc, awareness } of open.splice(0)) {
    awareness.destroy();
    doc.destroy();
  }
  for (const el of mounted.splice(0)) el.remove();
});

describe('usePublishPresence, the holding', () => {
  it('publishes the holding it is mounted with', async () => {
    const awareness = makeAwareness();
    const { container } = makeCanvas();
    renderHook(() =>
      usePublishPresence({
        awareness,
        sources: { ...NOTHING, selectedIds: ['a'] },
        synced: true,
        containerRef: { current: container },
        toFlowPosition: SHIFTED,
      }),
    );

    await untilPublished(awareness, (p) => {
      expect(p.activeNodeIds).toEqual(['a']);
    });
  });

  it('follows the sources when they change', async () => {
    const awareness = makeAwareness();
    const { container } = makeCanvas();
    const rendered = renderHook(
      (sources: ActiveNodeSources) =>
        usePublishPresence({
          awareness,
          sources,
          synced: true,
          containerRef: { current: container },
          toFlowPosition: SHIFTED,
        }),
      { initialProps: { ...NOTHING, selectedIds: ['a'] } },
    );
    await settled();

    rendered.rerender({ ...NOTHING, selectedIds: ['b', 'c'] });
    await untilPublished(awareness, (p) => {
      expect(p.activeNodeIds).toEqual(['b', 'c']);
    });
  });

  it('leaves the field null while nothing is held', async () => {
    const awareness = makeAwareness();
    const { container } = makeCanvas();
    renderHook(() =>
      usePublishPresence({
        awareness,
        sources: NOTHING,
        synced: true,
        containerRef: { current: container },
        toFlowPosition: SHIFTED,
      }),
    );

    await untilPublished(awareness, (p) => {
      expect(p.activeNodeIds).toBeNull();
    });
  });

  it('does not republish a holding that has not changed', async () => {
    const awareness = makeAwareness();
    const { container } = makeCanvas();
    const rendered = renderHook(
      (sources: ActiveNodeSources) =>
        usePublishPresence({
          awareness,
          sources,
          synced: true,
          containerRef: { current: container },
          toFlowPosition: SHIFTED,
        }),
      { initialProps: { ...NOTHING, selectedIds: ['a'] } },
    );
    await settled();

    let writes = 0;
    awareness.on('update', () => {
      writes += 1;
    });
    // A fresh array with the same content, the way the mirror hands one over
    // on any unrelated document change.
    rendered.rerender({ ...NOTHING, selectedIds: ['a'] });
    await settled();

    expect(writes).toBe(0);
  });

  it('republishes after the state is wiped from the outside', async () => {
    const awareness = makeAwareness();
    const { container } = makeCanvas();
    const rendered = renderHook(
      (sources: ActiveNodeSources) =>
        usePublishPresence({
          awareness,
          sources,
          synced: true,
          containerRef: { current: container },
          toFlowPosition: SHIFTED,
        }),
      { initialProps: { ...NOTHING, selectedIds: ['a'] } },
    );
    await settled();

    // What the bfcache teardown does: the whole local state goes, and the
    // sources have not moved, so nothing in React reports a change.
    awareness.setLocalState({});
    expect(published(awareness).activeNodeIds).toBeNull();

    rendered.rerender({ ...NOTHING, selectedIds: ['a'] });
    await untilPublished(awareness, (p) => {
      expect(p.activeNodeIds).toEqual(['a']);
    });
  });

  it('collapses several changes within one frame into a single write', async () => {
    const awareness = makeAwareness();
    const { container } = makeCanvas();
    const rendered = renderHook(
      (sources: ActiveNodeSources) =>
        usePublishPresence({
          awareness,
          sources,
          synced: true,
          containerRef: { current: container },
          toFlowPosition: SHIFTED,
        }),
      { initialProps: { ...NOTHING, selectedIds: ['a'] } },
    );
    await settled();

    let writes = 0;
    awareness.on('update', () => {
      writes += 1;
    });
    // What a rubber-band drag does: every pointer move flips one more node's
    // `selected`, and each one arrives as its own render.
    rendered.rerender({ ...NOTHING, selectedIds: ['a', 'b'] });
    rendered.rerender({ ...NOTHING, selectedIds: ['a', 'b', 'c'] });
    rendered.rerender({ ...NOTHING, selectedIds: ['a', 'b', 'c', 'd'] });
    await settled();

    expect(writes).toBe(1);
    expect(published(awareness).activeNodeIds).toEqual(['a', 'b', 'c', 'd']);
  });

  it('republishes on reconnect, even though nothing local changed', async () => {
    const awareness = makeAwareness();
    const { container } = makeCanvas();
    const rendered = renderHook(
      (synced: boolean) =>
        usePublishPresence({
          awareness,
          sources: { ...NOTHING, selectedIds: ['a'] },
          synced,
          containerRef: { current: container },
          toFlowPosition: SHIFTED,
        }),
      { initialProps: true },
    );
    await settled();

    let writes = 0;
    awareness.on('update', () => {
      writes += 1;
    });
    rendered.rerender(false);
    await settled();
    rendered.rerender(true);
    await settled();

    // The server drops an update whose clock it has already seen, and closing
    // the socket moves neither side's clock. Reconnecting therefore has to
    // push a fresh one or the peers never get this holding back.
    expect(writes).toBeGreaterThan(0);
    expect(published(awareness).activeNodeIds).toEqual(['a']);
  });

  it('republishes when the page comes back from the bfcache', async () => {
    const awareness = makeAwareness();
    const { container } = makeCanvas();
    renderHook(() =>
      usePublishPresence({
        awareness,
        sources: { ...NOTHING, selectedIds: ['a'] },
        synced: true,
        containerRef: { current: container },
        toFlowPosition: SHIFTED,
      }),
    );
    await settled();

    // The provider drops the local state on `pagehide` and puts back an empty
    // one on restore, while the sources sat frozen across the whole round trip.
    awareness.setLocalState({});
    const restored = new Event('pageshow');
    Object.defineProperty(restored, 'persisted', { value: true });
    window.dispatchEvent(restored);
    await untilPublished(awareness, (p) => {
      expect(p.activeNodeIds).toEqual(['a']);
    });
  });

  it('writes nothing when there is no awareness yet', async () => {
    const { container } = makeCanvas();
    const rendered = renderHook(() =>
      usePublishPresence({
        awareness: null,
        sources: { ...NOTHING, selectedIds: ['a'] },
        synced: true,
        containerRef: { current: container },
        toFlowPosition: SHIFTED,
      }),
    );

    await settled();

    expect(() => rendered.unmount()).not.toThrow();
  });
});

describe('usePublishPresence, the pointer', () => {
  it('publishes the canvas position of a pointer move', async () => {
    const awareness = makeAwareness();
    const { container } = makeCanvas();
    renderHook(() =>
      usePublishPresence({
        awareness,
        sources: NOTHING,
        synced: true,
        containerRef: { current: container },
        toFlowPosition: SHIFTED,
      }),
    );
    await settled();

    sendPointer(container, 'pointermove', { clientX: 40, clientY: 60 });
    await settled();

    // The screen point ran through the conversion; the raw one would be 40,60.
    expect(published(awareness).pointer).toEqual({ x: 1040, y: 2060 });
  });

  it('hands the conversion the screen coordinates off the event', async () => {
    const awareness = makeAwareness();
    const { container } = makeCanvas();
    const toFlowPosition = vi.fn(SHIFTED);
    renderHook(() =>
      usePublishPresence({
        awareness,
        sources: NOTHING,
        synced: true,
        containerRef: { current: container },
        toFlowPosition,
      }),
    );
    await settled();

    sendPointer(container, 'pointermove', { clientX: 7, clientY: 9 });
    await settled();

    expect(toFlowPosition).toHaveBeenCalledWith({ x: 7, y: 9 });
  });

  it('clears the pointer when it leaves the canvas', async () => {
    const awareness = makeAwareness();
    const { container } = makeCanvas();
    renderHook(() =>
      usePublishPresence({
        awareness,
        sources: NOTHING,
        synced: true,
        containerRef: { current: container },
        toFlowPosition: SHIFTED,
      }),
    );
    sendPointer(container, 'pointermove', { clientX: 40, clientY: 60 });
    await settled();

    sendPointer(container, 'pointerleave');
    await untilPublished(awareness, (p) => {
      expect(p.pointer).toBeNull();
    });
  });

  it('forgets the pointer when the window loses focus', async () => {
    // Switching to another window leaves the pointer sitting on the canvas, so
    // no `pointerleave` fires and the peers keep a frozen arrow at a spot this
    // person is no longer looking at. The text-caret presence in the same app
    // already publishes window focus for exactly this reason
    // (`use-collab-caret-presence.ts`).
    const awareness = makeAwareness();
    const { container } = makeCanvas();
    renderHook(() =>
      usePublishPresence({
        awareness,
        sources: NOTHING,
        synced: true,
        containerRef: { current: container },
        toFlowPosition: SHIFTED,
      }),
    );
    sendPointer(container, 'pointermove', { clientX: 40, clientY: 60 });
    await settled();
    expect(published(awareness).pointer).not.toBeNull();

    window.dispatchEvent(new Event('blur'));

    // Read back with no frame and no timer allowed to run. Losing focus is
    // usually the page being hidden too, and a hidden document is given no
    // animation frames — a withdrawal parked on one would never be sent, and
    // the throttle's own guard would then swallow every later attempt.
    expect(published(awareness).pointer).toBeNull();
  });

  it('recomputes the pointer when the container is resized', async () => {
    // The screen-to-canvas conversion subtracts the container's own rect, so a
    // sidebar opening or the window resizing changes the answer for a pointer
    // that never moved. Only the viewport's transform was watched, which such
    // a resize does not touch.
    const awareness = makeAwareness();
    const { container } = makeCanvas();
    let shift = 1000;
    renderHook(() =>
      usePublishPresence({
        awareness,
        sources: NOTHING,
        synced: true,
        containerRef: { current: container },
        toFlowPosition: (screen) => ({ x: screen.x + shift, y: screen.y }),
      }),
    );
    sendPointer(container, 'pointermove', { clientX: 40, clientY: 60 });
    await untilPublished(awareness, (p) => {
      expect(p.pointer).toMatchObject({ x: 1040 });
    });

    shift = 2000;
    resizeContainer(container);
    await untilPublished(awareness, (p) => {
      expect(p.pointer).toMatchObject({ x: 2040 });
    });
  });

  it('recomputes the pointer when the viewport pans', async () => {
    // Two-finger panning and the toolbar zoom buttons move the canvas under a
    // pointer that never fired an event; the same screen point is a different
    // canvas point afterwards.
    const awareness = makeAwareness();
    const { container, viewport } = makeCanvas();
    let shift = 1000;
    renderHook(() =>
      usePublishPresence({
        awareness,
        sources: NOTHING,
        synced: true,
        containerRef: { current: container },
        toFlowPosition: (screen) => ({ x: screen.x + shift, y: screen.y }),
      }),
    );
    sendPointer(container, 'pointermove', { clientX: 40, clientY: 0 });
    await untilPublished(awareness, (p) => {
      expect(p.pointer).toEqual({ x: 1040, y: 0 });
    });

    shift = 2000;
    viewport.style.transform = 'translate(50px, 0px) scale(1)';
    await untilPublished(awareness, (p) => {
      expect(p.pointer).toEqual({ x: 2040, y: 0 });
    });
  });

  it('leaves the pointer null when the viewport pans after it left', async () => {
    // Without this the arrow comes back to life at a stale spot the moment
    // anyone pans, long after the pointer left the canvas.
    const awareness = makeAwareness();
    const { container, viewport } = makeCanvas();
    renderHook(() =>
      usePublishPresence({
        awareness,
        sources: NOTHING,
        synced: true,
        containerRef: { current: container },
        toFlowPosition: SHIFTED,
      }),
    );
    sendPointer(container, 'pointermove', { clientX: 40, clientY: 60 });
    await settled();
    sendPointer(container, 'pointerleave');
    await settled();

    viewport.style.transform = 'translate(50px, 0px) scale(1)';
    await settled();

    // `settled`, not a poll: this case checks that a write did NOT happen, and
    // a poll passes at t=0 on the null that `pointerleave` already published.
    expect(published(awareness).pointer).toBeNull();
  });

  it('clears both fields when it unmounts', async () => {
    const awareness = makeAwareness();
    const { container } = makeCanvas();
    const rendered = renderHook(() =>
      usePublishPresence({
        awareness,
        sources: { ...NOTHING, selectedIds: ['a'] },
        synced: true,
        containerRef: { current: container },
        toFlowPosition: SHIFTED,
      }),
    );
    sendPointer(container, 'pointermove', { clientX: 40, clientY: 60 });
    await settled();
    expect(published(awareness).pointer).not.toBeNull();

    rendered.unmount();

    expect(published(awareness)).toEqual({ activeNodeIds: null, pointer: null });
    expect(stillListed(awareness)).toBe(true);
  });

  it('stays withdrawn when a write was already scheduled', async () => {
    // Leaving the space with a write still in flight: that write lands after
    // the withdrawal wrote null, and would put the presence back on peers'
    // screens for as long as this client's entry survives their timeout.
    const awareness = makeAwareness();
    const { container } = makeCanvas();
    const rendered = renderHook(() =>
      usePublishPresence({
        awareness,
        sources: { ...NOTHING, selectedIds: ['a'] },
        synced: true,
        containerRef: { current: container },
        toFlowPosition: SHIFTED,
      }),
    );
    await settled();

    sendPointer(container, 'pointermove', { clientX: 40, clientY: 60 });
    rendered.unmount();
    await untilPublished(awareness, (p) => {
      expect(p).toEqual({ activeNodeIds: null, pointer: null });
    });
    expect(stillListed(awareness)).toBe(true);
  });

  it('keeps the user identity the server wrote', async () => {
    // The fields are published together, which means writing the whole state
    // object; anything already in there has to survive that write.
    const awareness = makeAwareness();
    const { container } = makeCanvas();
    awareness.setLocalStateField('user', { id: 'me' });
    renderHook(() =>
      usePublishPresence({
        awareness,
        sources: { ...NOTHING, selectedIds: ['a'] },
        synced: true,
        containerRef: { current: container },
        toFlowPosition: SHIFTED,
      }),
    );

    sendPointer(container, 'pointermove', { clientX: 40, clientY: 60 });
    await settled();

    expect((awareness.getLocalState() as { user?: unknown })?.user).toEqual({ id: 'me' });
  });
});

describe('usePublishPresence, the write rate', () => {
  it('caps a streaming pointer at the interval floor', async () => {
    const awareness = makeAwareness();
    const { container } = makeCanvas();
    renderHook(() =>
      usePublishPresence({
        awareness,
        sources: NOTHING,
        synced: true,
        containerRef: { current: container },
        toFlowPosition: SHIFTED,
      }),
    );
    await settled();

    let writes = 0;
    awareness.on('update', () => {
      writes += 1;
    });
    // A pointer moving for 200ms at browser event rates. At the 33ms floor
    // that is at most 7 writes; without the floor it would be one per frame.
    const start = Date.now();
    while (Date.now() - start < 200) {
      sendPointer(container, 'pointermove', { clientX: Date.now() % 300, clientY: 0 });
      await new Promise((resolve) => setTimeout(resolve, 4));
    }
    await settled();

    expect(writes).toBeGreaterThan(0);
    expect(writes).toBeLessThanOrEqual(8);
  });
});
