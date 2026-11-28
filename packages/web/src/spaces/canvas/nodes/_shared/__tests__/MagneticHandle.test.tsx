// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

import { describe, it, expect } from 'vitest';
import { act, render } from '@testing-library/react';
import { ReactFlowProvider, useStoreApi } from '@xyflow/react';
import * as React from 'react';

import { MagneticHandle } from '@web/spaces/canvas/nodes/_shared/MagneticHandle';
import { NodeScaleContext } from '@web/spaces/canvas/nodes/_shared/node-scale';

/** Captures the xyflow store api so a test can drive connection state. */
let storeApi: ReturnType<typeof useStoreApi> | null = null;

/**
 * Grabs the xyflow store api into `storeApi` (rendered inside the provider).
 * @returns Nothing.
 */
function StoreGrabber(): null {
  storeApi = useStoreApi();
  return null;
}

/**
 * Flips xyflow's connection.inProgress so a test can simulate an active
 * connection drag (the magnetic zone must stand down during one).
 * @param inProgress - The connection-in-progress flag.
 */
function setConnecting(inProgress: boolean): void {
  const state = storeApi?.getState();
  if (!state) return;
  act(() => {
    storeApi?.setState({
      connection: { ...state.connection, inProgress },
    } as Parameters<NonNullable<typeof storeApi>['setState']>[0]);
  });
}

/**
 * Mounts a MagneticHandle inside the ReactFlow context the Handle needs.
 * @param connectable - Whether the handle is connectable.
 * @returns The handle element and its visible dot.
 */
function mount(connectable = true): {
  handle: HTMLElement;
  dot: HTMLElement;
  rerender: (next: boolean) => void;
} {
  storeApi = null;
  const { container, rerender: rerenderRaw } = render(
    <ReactFlowProvider>
      <StoreGrabber />
      <MagneticHandle type='source' isConnectable={connectable} />
    </ReactFlowProvider>,
  );
  const handle = container.querySelector('.react-flow__handle') as HTMLElement;
  const dot = handle.querySelector(
    '[data-testid="handle-dot"]',
  ) as HTMLElement;
  const rerender = (next: boolean): void => {
    act(() => {
      rerenderRaw(
        <ReactFlowProvider>
          <StoreGrabber />
          <MagneticHandle type='source' isConnectable={next} />
        </ReactFlowProvider>,
      );
    });
  };
  return { handle, dot, rerender };
}

/**
 * Stubs the handle's layout rect (jsdom has no layout) as the 8px anchor
 * element at 100% zoom, centered at (100, 100).
 * @param handle - The handle element.
 */
function stubAnchorRect(handle: HTMLElement): void {
  handle.getBoundingClientRect = () =>
    ({
      left: 96,
      top: 96,
      right: 104,
      bottom: 104,
      width: 8,
      height: 8,
      x: 96,
      y: 96,
      toJSON: () => ({}),
    }) as DOMRect;
}

/**
 * Fires a pointer event with coordinates through React's event system.
 * @param el - The element to dispatch on.
 * @param type - The pointer event type.
 * @param x - clientX.
 * @param y - clientY.
 */
function firePointer(
  el: HTMLElement,
  type: string,
  x = 0,
  y = 0,
): void {
  act(() => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    });
    el.dispatchEvent(event);
  });
}

/**
 * Simulates the pointer leaving the element. React synthesizes onPointerLeave
 * from a native pointerout whose relatedTarget lies outside the element, so a
 * bare 'pointerleave' dispatch does not map — this drives the real path.
 * @param el - The element the pointer leaves.
 */
function firePointerLeave(el: HTMLElement): void {
  act(() => {
    const event = new MouseEvent('pointerout', {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, 'relatedTarget', { value: document.body });
    el.dispatchEvent(event);
  });
}

// Magnetic handle (user 2026-07-11): the ANCHOR (8px element, center on the
// node border — the edge attachment point), the HIT ZONE (::before, 36x36
// fully OUTSIDE the border), and the VISIBLE DOT (a child, spring-following
// the cursor inside the zone) are three decoupled layers. Moving the dot must
// never move the wire anchor.
describe('MagneticHandle — anchor / zone / dot decoupling', () => {
  it('keeps the anchor element 8px, pins its outer edge to the border (!right-1), with a 36px outside-only zone', () => {
    const { handle } = mount();
    expect(handle.className).toContain('!h-2');
    expect(handle.className).toContain('!w-2');
    // Border-pinned anchor (P1): shifted 4px inward so its OUTER edge — where
    // xyflow attaches the wire — sits ON the border (no gap). The element then
    // spans border-8..border, so the fully-outside 36px zone starts at the
    // border = element left + 8px (before:left-2).
    expect(handle.className).toContain('!right-1');
    expect(handle.className).toContain('before:h-9');
    expect(handle.className).toContain('before:w-9');
    expect(handle.className).toContain('before:left-2');
    expect(handle.className).toContain('before:absolute');
    // The element itself is invisible — the visual lives in the dot child.
    expect(handle.className).toContain('!bg-transparent');
  });

  it('mirrors the border-pinned anchor + zone for a target (left) handle', () => {
    const { container } = render(
      <ReactFlowProvider>
        <MagneticHandle type='target' isConnectable />
      </ReactFlowProvider>,
    );
    const handle = container.querySelector(
      '.react-flow__handle',
    ) as HTMLElement;
    // Shifted 4px inward (!left-1) so the outer (left) edge sits on the border;
    // element spans border..border+8, so a fully-outside 36px zone ends at the
    // border = element left - 36px (before:-left-9).
    expect(handle.className).toContain('!left-1');
    expect(handle.className).toContain('before:-left-9');
    expect(handle.className).toContain('before:w-9');
  });

  it('renders the visible dot as a spring-transitioned child, at rest by default', () => {
    const { dot } = mount();
    expect(dot).not.toBeNull();
    expect(dot.className).toContain('transition-transform');
    expect(dot.className).toContain('pointer-events-none');
    expect(dot.style.transform).toBe('');
  });

  it('the dot chases the cursor inside the zone (outward offset, zoom-normalized)', () => {
    const { handle, dot } = mount();
    stubAnchorRect(handle);
    // Cursor 16px right of the BORDER (a source's border = the anchor's right
    // edge = 104) / 6px down of the vertical centre (100). The dot springs from
    // the border it straddles, not the anchor centre (A, user 2026-07-12).
    firePointer(handle, 'pointermove', 120, 106);
    expect(dot.style.transform).toBe('translate(16px, 6px)');
  });

  it('clamps the chase so the dot stays inside the zone', () => {
    const { handle, dot } = mount();
    stubAnchorRect(handle);
    // Way beyond the zone's outer edge / top edge.
    firePointer(handle, 'pointermove', 300, 0);
    expect(dot.style.transform).toBe('translate(32px, -14px)');
  });

  it('never chases inward past the border (source dot cannot enter the node)', () => {
    const { handle, dot } = mount();
    stubAnchorRect(handle);
    firePointer(handle, 'pointermove', 60, 100);
    expect(dot.style.transform).toBe('translate(0px, 0px)');
  });

  it('springs back to rest on pointer leave', () => {
    const { handle, dot } = mount();
    stubAnchorRect(handle);
    firePointer(handle, 'pointermove', 120, 106);
    firePointerLeave(handle);
    expect(dot.style.transform).toBe('');
  });

  it('springs back to rest the moment a connection drag starts (wire draws from the border)', () => {
    const { handle, dot } = mount();
    stubAnchorRect(handle);
    firePointer(handle, 'pointermove', 120, 106);
    firePointer(handle, 'pointerdown', 120, 106);
    expect(dot.style.transform).toBe('');
  });

  it('does not chase while not connectable (viewer / pick session)', () => {
    const { handle, dot } = mount(false);
    stubAnchorRect(handle);
    firePointer(handle, 'pointermove', 120, 106);
    expect(dot.style.transform).toBe('');
  });

  // Adversarial round-3: the imperatively-written transform is NOT reset by a
  // re-render, so a dot sprung out when isConnectable flips true→false (a pick
  // arms / the viewer downgrades mid-hover) would freeze off the border. A
  // dead handle must sit on the border.
  it('springs the dot back when isConnectable flips true→false while displaced', () => {
    const { handle, dot, rerender } = mount(true);
    stubAnchorRect(handle);
    firePointer(handle, 'pointermove', 120, 106);
    expect(dot.style.transform).toBe('translate(16px, 6px)');
    rerender(false);
    expect(dot.style.transform).toBe('');
  });
});

// Adversarial round-3: the 36px zone must STAND DOWN during a connection drag.
// xyflow resolves the wire's target via elementFromPoint (topmost handle
// wins); a 36px zone painting over a neighbor would hijack targeting and could
// silently wire the wrong node. During a drag the ::before hit expansion is
// disabled so target resolution falls back to the 8px anchor + connectionRadius,
// and the dot rests (it must not chase mid-drag).
describe('MagneticHandle — dot rests during a connection drag', () => {
  it('does not chase the cursor while a connection is in progress', () => {
    const { handle, dot } = mount(true);
    stubAnchorRect(handle);
    setConnecting(true);
    firePointer(handle, 'pointermove', 120, 106);
    expect(dot.style.transform).toBe('');
  });

  it('springs a displaced dot back to rest the moment a connection starts', () => {
    const { handle, dot } = mount(true);
    stubAnchorRect(handle);
    firePointer(handle, 'pointermove', 120, 106);
    expect(dot.style.transform).toBe('translate(16px, 6px)');
    setConnecting(true);
    expect(dot.style.transform).toBe('');
  });
});

/**
 * Mounts a handle at a node counter-scale (1 at 100% zoom and above, 2 at 50%
 * and below).
 * @param scale - The NodeScaleContext value.
 * @param emphasized - Whether the handle shows the plus.
 * @param type - Which side the handle is on.
 * @returns The handle element and its visible dot.
 */
function mountEmphasized(
  scale: number,
  emphasized = true,
  type: 'source' | 'target' = 'source',
): { handle: HTMLElement; dot: HTMLElement } {
  const { container } = render(
    <ReactFlowProvider>
      <NodeScaleContext.Provider value={scale}>
        <MagneticHandle type={type} isConnectable emphasized={emphasized} />
      </NodeScaleContext.Provider>
    </ReactFlowProvider>,
  );
  const handle = container.querySelector('.react-flow__handle') as HTMLElement;
  const dot = handle.querySelector('[data-testid="handle-dot"]') as HTMLElement;
  return { handle, dot };
}

/**
 * Stubs the 8px anchor's rect at a canvas zoom, centred on (100, 100).
 * @param handle - The handle element.
 * @param zoom - The canvas zoom; the anchor measures 8 × zoom on screen.
 */
function stubAnchorRectAt(handle: HTMLElement, zoom: number): void {
  const half = 4 * zoom;
  handle.getBoundingClientRect = () =>
    ({
      left: 100 - half,
      top: 100 - half,
      right: 100 + half,
      bottom: 100 + half,
      width: 2 * half,
      height: 2 * half,
      x: 100 - half,
      y: 100 - half,
      toJSON: () => ({}),
    }) as DOMRect;
}

/**
 * The classes of an element, as a list.
 * @param el - The element.
 * @returns Its classes.
 */
function classesOf(el: Element): string[] {
  return [...el.classList];
}

const PLAIN_DOT = ['rounded-full', 'border', 'border-border', 'bg-muted'];

// inner#2216 design 4.1: on a lone selected node the dot becomes a 20px
// screen-size plus standing wholly outside the node, its near edge 4 screen
// px past the border at rest and vertically centred, while the wire still
// attaches at the border. The press zone is the plain 36px on screen (handed
// over as `--handle-zone`), the handle rises above the video error layer
// (z-20) as z-21, nothing reaches into the node, and the plus follows the
// pointer inside the zone without ever crossing the border.
describe('MagneticHandle — emphasized (the plus on a lone selected node)', () => {
  it('draws a plus inside the visible dot', () => {
    const { dot } = mountEmphasized(1);
    const plus = dot.querySelector('[data-testid="handle-plus"]');
    expect(plus).not.toBeNull();
    expect(dot.contains(plus)).toBe(true);
  });

  it('keeps the press zone 36px on screen: 36 canvas px at 100% zoom, 72 at 50%', () => {
    expect(mountEmphasized(1).handle.style.getPropertyValue('--handle-zone')).toBe('36px');
    expect(mountEmphasized(2).handle.style.getPropertyValue('--handle-zone')).toBe('72px');
  });

  it('lifts a source handle above the video error layer (z-20) with only the variable-sized zone, reaching nothing inward', () => {
    const classes = classesOf(mountEmphasized(1).handle);
    expect(classes).toContain('z-21');
    expect(classes.filter((c) => c.startsWith('before:h-'))).toEqual(['before:h-[var(--handle-zone)]']);
    expect(classes.filter((c) => c.startsWith('before:w-'))).toEqual(['before:w-[var(--handle-zone)]']);
    expect(classes).toContain('before:left-2');
    expect(classes.filter((c) => c.startsWith('before:-left-') || c.startsWith('before:left-['))).toEqual([]);
    expect(classes.filter((c) => c.startsWith('after:'))).toEqual([]);
  });

  it('starts a target handle\'s zone its own width left of the border', () => {
    const classes = classesOf(mountEmphasized(1, true, 'target').handle);
    expect(classes).toContain('z-21');
    expect(classes).toContain('before:left-[calc(var(--handle-zone)*-1)]');
    expect(classes).not.toContain('before:-left-9');
    expect(classes.filter((c) => c.startsWith('before:h-'))).toEqual(['before:h-[var(--handle-zone)]']);
    expect(classes.filter((c) => c.startsWith('after:'))).toEqual([]);
  });

  it('rests the plus 4 + 10 screen px out from a source border at 100% zoom', () => {
    const plus = mountEmphasized(1).dot.querySelector<HTMLElement>('[data-testid="handle-plus"]');
    expect(plus?.style.transform).toBe('translate(calc(-50% + 14px), -50%) scale(1)');
  });

  it('rests the plus out to the left of a target border, in canvas px at 50% zoom', () => {
    const plus = mountEmphasized(2, true, 'target').dot.querySelector<HTMLElement>('[data-testid="handle-plus"]');
    // (4 + 10) screen px at a 2x counter-scale, leftward.
    expect(plus?.style.transform).toBe('translate(calc(-50% + -28px), -50%) scale(2)');
  });

  it('draws nothing on the emphasized dot itself: the plus is the visual', () => {
    const { dot } = mountEmphasized(1);
    for (const plain of PLAIN_DOT) expect(dot.classList.contains(plain), plain).toBe(false);
    expect(dot.querySelector('[data-testid="handle-plus"]')).not.toBeNull();
  });

  it('keeps the handle connectable, so press, drag and click-connect stay as they are', () => {
    const { handle, dot } = mountEmphasized(1);
    expect(dot.querySelector('[data-testid="handle-plus"]')).not.toBeNull();
    expect(handle.classList.contains('connectable')).toBe(true);
    expect(handle.classList.contains('connectablestart')).toBe(true);
    expect(handle.classList.contains('connectableend')).toBe(true);
    expect(handle.className).toContain('!right-1');
  });

  // Rest centre 14 out; it may go from 10 (near edge on the border) to 26
  // (far edge at the zone's end), and 8 up or down.
  it('chases toward a far pointer at 100% zoom: 12 further out, 8 down', () => {
    const { handle, dot } = mountEmphasized(1);
    stubAnchorRectAt(handle, 1);
    firePointer(handle, 'pointermove', 400, 400);
    expect(dot.style.transform).toBe('translate(12px, 8px)');
  });

  it('stops with the near edge on the border when the pointer is at the border', () => {
    const { handle, dot } = mountEmphasized(1);
    stubAnchorRectAt(handle, 1);
    // The source border is the anchor's right edge, x 104.
    firePointer(handle, 'pointermove', 104, 100);
    expect(dot.style.transform).toBe('translate(-4px, 0px)');
    // Further into the node it goes no further.
    firePointer(handle, 'pointermove', 0, 100);
    expect(dot.style.transform).toBe('translate(-4px, 0px)');
  });

  it('mirrors the chase for a target: out is left, and never past its border', () => {
    const { handle, dot } = mountEmphasized(1, true, 'target');
    stubAnchorRectAt(handle, 1);
    firePointer(handle, 'pointermove', 0, 100);
    expect(dot.style.transform).toBe('translate(-12px, 0px)');
    firePointer(handle, 'pointermove', 400, 100);
    expect(dot.style.transform).toBe('translate(4px, 0px)');
  });

  it('chases in canvas px at 50% zoom: 24 out, 16 down', () => {
    const { handle, dot } = mountEmphasized(2);
    stubAnchorRectAt(handle, 0.5);
    firePointer(handle, 'pointermove', 400, 400);
    expect(dot.style.transform).toBe('translate(24px, 16px)');
  });

  it('springs back to rest when the pointer leaves', () => {
    const { handle, dot } = mountEmphasized(1);
    stubAnchorRectAt(handle, 1);
    firePointer(handle, 'pointermove', 400, 400);
    expect(dot.style.transform).not.toBe('');
    firePointerLeave(handle);
    expect(dot.style.transform).toBe('');
  });

  // Guard: every other node keeps today's dot and zone.
  it('keeps the plain zone and dot classes without emphasis', () => {
    const { handle, dot } = mountEmphasized(1, false);
    const classes = classesOf(handle);
    expect(classes).toContain('before:h-9');
    expect(classes).toContain('before:w-9');
    expect(classes).not.toContain('z-21');
    expect(classes.filter((c) => c.startsWith('after:'))).toEqual([]);
    expect(handle.style.getPropertyValue('--handle-zone')).toBe('');
    for (const plain of PLAIN_DOT) expect(dot.classList.contains(plain), plain).toBe(true);
  });

  it('keeps a plain target zone 36px left of the border', () => {
    const classes = classesOf(mountEmphasized(1, false, 'target').handle);
    expect(classes).toContain('before:-left-9');
    expect(classes).toContain('before:h-9');
    expect(classes).toContain('before:w-9');
    expect(classes.filter((c) => c.startsWith('before:left-['))).toEqual([]);
  });

  it('keeps a hidden handle plain even when emphasized', () => {
    const { container } = render(
      <ReactFlowProvider>
        <MagneticHandle type='source' isConnectable emphasized hidden />
      </ReactFlowProvider>,
    );
    const handle = container.querySelector('.react-flow__handle') as HTMLElement;
    const classes = classesOf(handle);
    expect(classes).toContain('!invisible');
    expect(classes).toContain('before:h-9');
    expect(classes).not.toContain('z-21');
    expect(classes.filter((c) => c.startsWith('after:'))).toEqual([]);
    expect(handle.style.getPropertyValue('--handle-zone')).toBe('');
    expect(container.querySelector('[data-testid="handle-plus"]')).toBeNull();
  });

  it('keeps the plain dot chasing with its old clamps without emphasis', () => {
    const { handle, dot } = mountEmphasized(1, false);
    expect(dot.querySelector('[data-testid="handle-plus"]')).toBeNull();
    stubAnchorRectAt(handle, 1);
    firePointer(handle, 'pointermove', 400, 400);
    expect(dot.style.transform).toBe('translate(32px, 14px)');
  });
});
