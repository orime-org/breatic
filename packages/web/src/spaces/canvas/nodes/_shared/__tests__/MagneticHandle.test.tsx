// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { act, render } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import * as React from 'react';

import { MagneticHandle } from '@web/spaces/canvas/nodes/_shared/MagneticHandle';

/**
 * Mounts a MagneticHandle inside the ReactFlow context the Handle needs.
 * @param connectable - Whether the handle is connectable.
 * @returns The handle element and its visible dot.
 */
function mount(connectable = true): { handle: HTMLElement; dot: HTMLElement } {
  const { container } = render(
    <ReactFlowProvider>
      <MagneticHandle type='source' isConnectable={connectable} />
    </ReactFlowProvider>,
  );
  const handle = container.querySelector('.react-flow__handle') as HTMLElement;
  const dot = handle.querySelector(
    '[data-testid="handle-dot"]',
  ) as HTMLElement;
  return { handle, dot };
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
  it('keeps the anchor element 8px (edge anchor stays on the border) with a 36px outside-only zone', () => {
    const { handle } = mount();
    expect(handle.className).toContain('!h-2');
    expect(handle.className).toContain('!w-2');
    // Zone: 36x36 (w-9/h-9) starting AT the border and reaching outward —
    // for a source (right) handle the element spans border±4, so the zone's
    // left edge sits at +4px from the element (before:left-1).
    expect(handle.className).toContain('before:h-9');
    expect(handle.className).toContain('before:w-9');
    expect(handle.className).toContain('before:left-1');
    expect(handle.className).toContain('before:absolute');
    // The element itself is invisible — the visual lives in the dot child.
    expect(handle.className).toContain('!bg-transparent');
  });

  it('mirrors the zone for a target (left) handle', () => {
    const { container } = render(
      <ReactFlowProvider>
        <MagneticHandle type='target' isConnectable />
      </ReactFlowProvider>,
    );
    const handle = container.querySelector(
      '.react-flow__handle',
    ) as HTMLElement;
    // Element spans border±4; a fully-outside 36px zone ends at the border =
    // element left + 4 → left = 4 - 36 = -32px (before:-left-8).
    expect(handle.className).toContain('before:-left-8');
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
});
