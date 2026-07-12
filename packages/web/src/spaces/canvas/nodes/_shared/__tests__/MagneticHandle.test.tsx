// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { act, render } from '@testing-library/react';
import { ReactFlowProvider, useStoreApi } from '@xyflow/react';
import * as React from 'react';

import { MagneticHandle } from '@web/spaces/canvas/nodes/_shared/MagneticHandle';

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
    // Cursor 20px right / 6px down of the anchor center (100,100).
    firePointer(handle, 'pointermove', 120, 106);
    expect(dot.style.transform).toBe('translate(20px, 6px)');
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
    expect(dot.style.transform).toBe('translate(20px, 6px)');
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
    expect(dot.style.transform).toBe('translate(20px, 6px)');
    setConnecting(true);
    expect(dot.style.transform).toBe('');
  });
});
