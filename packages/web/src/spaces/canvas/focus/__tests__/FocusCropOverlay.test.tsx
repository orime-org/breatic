// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * FocusCropOverlay component tests (#1782): marquee draw / ratio presets /
 * confirm mapping / Esc staging, against a stubbed node img box.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import * as React from 'react';

import { FocusCropOverlay } from '@web/spaces/canvas/focus/FocusCropOverlay';

/** Screen boxes: overlay root at (0,0); node img at (100,50) — MUTABLE so
 * tests can simulate a zoom (box rescale) between measures. */
const IMG_BOX = { left: 100, top: 50, width: 400, height: 300 };

beforeEach(() => {
  IMG_BOX.width = 400;
  IMG_BOX.height = 300;
});

/**
 * Renders the fake node DOM (what the overlay queries) + the overlay.
 * @param onConfirm - Confirm spy.
 * @param onBackToPick - Back-to-pick spy (the overlay's only way out).
 * @returns Testing-library render result.
 */
function renderOverlay(
  onConfirm = vi.fn(() => true),
  onBackToPick = vi.fn(),
): ReturnType<typeof render> {
  const result = render(
    <ReactFlowProvider>
      <div className='react-flow__node' data-id='n1'>
        <img data-testid='image-node-img' src='https://cdn/original.png' alt='' />
      </div>
      <FocusCropOverlay
        nodeId='n1'
        nodePosition={{ x: 0, y: 0 }}
        onConfirm={onConfirm}
        onBackToPick={onBackToPick}
      />
    </ReactFlowProvider>,
  );
  return result;
}

beforeEach(() => {
  // jsdom has no layout: stub the overlay root at origin and the img box.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      const isImg = this.tagName === 'IMG';
      return {
        x: isImg ? IMG_BOX.left : 0,
        y: isImg ? IMG_BOX.top : 0,
        left: isImg ? IMG_BOX.left : 0,
        top: isImg ? IMG_BOX.top : 0,
        right: isImg ? IMG_BOX.left + IMG_BOX.width : 1000,
        bottom: isImg ? IMG_BOX.top + IMG_BOX.height : 1000,
        width: isImg ? IMG_BOX.width : 1000,
        height: isImg ? IMG_BOX.height : 1000,
        toJSON: () => ({}),
      } as DOMRect;
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Draw a marquee from A to B on the capture layer (screen coordinates).
 * @param from - Pointer-down point.
 * @param to - Pointer-up point.
 */
function draw(from: { x: number; y: number }, to: { x: number; y: number }): void {
  const layer = screen.getByTestId('focus-crop-layer');
  fireEvent.pointerDown(layer, { clientX: from.x, clientY: from.y, button: 0 });
  fireEvent.pointerMove(layer, { clientX: to.x, clientY: to.y });
  fireEvent.pointerUp(layer);
}

describe('FocusCropOverlay', () => {
  it('aligns the capture layer to the node img box', () => {
    renderOverlay();
    const layer = screen.getByTestId('focus-crop-layer');
    expect(layer.style.left).toBe('100px');
    expect(layer.style.top).toBe('50px');
    expect(layer.style.width).toBe('400px');
    expect(layer.style.height).toBe('300px');
  });

  it('draws a marquee in img-local coordinates', () => {
    renderOverlay();
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    const rect = screen.getByTestId('focus-crop-rect');
    expect(rect.style.left).toBe('50px');
    expect(rect.style.top).toBe('50px');
    expect(rect.style.width).toBe('100px');
    expect(rect.style.height).toBe('80px');
    // Eight handles present.
    expect(screen.getByTestId('focus-crop-handle-se')).toBeInTheDocument();
  });

  it('a ratio preset constrains the drawn marquee; re-click clears it', () => {
    renderOverlay();
    fireEvent.click(screen.getByTestId('focus-ratio-1:1'));
    draw({ x: 150, y: 100 }, { x: 250, y: 120 });
    const rect = screen.getByTestId('focus-crop-rect');
    // Dominant axis 100 wide → square 100×100.
    expect(rect.style.width).toBe('100px');
    expect(rect.style.height).toBe('100px');
    expect(
      screen.getByTestId('focus-ratio-1:1').getAttribute('aria-pressed'),
    ).toBe('true');
    fireEvent.click(screen.getByTestId('focus-ratio-1:1'));
    expect(
      screen.getByTestId('focus-ratio-1:1').getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('confirm maps the marquee to natural pixels and clears it', () => {
    const onConfirm = vi.fn(() => true);
    renderOverlay(onConfirm);
    const img = screen.getByTestId('image-node-img');
    // Natural 800×600 vs 400×300 display → ×2 mapping.
    Object.defineProperty(img, 'naturalWidth', { value: 800 });
    Object.defineProperty(img, 'naturalHeight', { value: 600 });
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    fireEvent.click(screen.getByTestId('focus-crop-confirm'));
    expect(onConfirm).toHaveBeenCalledWith({
      crop: { x: 100, y: 100, width: 200, height: 160 },
      natural: { width: 800, height: 600 },
      sourceSrc: 'https://cdn/original.png',
    });
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
  });

  it('confirm is disabled without a valid marquee', () => {
    renderOverlay();
    expect(
      (screen.getByTestId('focus-crop-confirm') as HTMLButtonElement).disabled,
    ).toBe(true);
    // A sub-minimum scribble stays invalid.
    draw({ x: 150, y: 100 }, { x: 153, y: 103 });
    expect(
      (screen.getByTestId('focus-crop-confirm') as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('cancel clears the marquee and returns to the PICK state — not out of the session (user 2026-07-17, decision A)', () => {
    const onBackToPick = vi.fn();
    renderOverlay(vi.fn(), onBackToPick);
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    fireEvent.click(screen.getByTestId('focus-crop-cancel'));
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
    // Back to picking another image (the banner stays); the overlay has no
    // session-exit path at all (prop removed by construction).
    expect(onBackToPick).toHaveBeenCalledTimes(1);
  });

  it('Esc peels: marquee first, then back to the pick state (aligned with Cancel — user 2026-07-17)', () => {
    const onBackToPick = vi.fn();
    renderOverlay(vi.fn(), onBackToPick);
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
    expect(onBackToPick).not.toHaveBeenCalled();
    // Second Esc: no marquee left — back to the pick state, NOT a session
    // exit (the third Esc, in the pick state, exits via the canvas-level
    // handler once this overlay is unmounted).
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onBackToPick).toHaveBeenCalledTimes(1);
  });

  it('Esc yields by OWNERSHIP: prevented events and overlay content — not a plain focused editor (round-6)', () => {
    const onBackToPick = vi.fn();
    const { container } = renderOverlay(vi.fn(), onBackToPick);
    // A handler that already consumed Esc (Radix / the @-suggestion) wins.
    const prevented = new KeyboardEvent('keydown', {
      key: 'Escape',
      cancelable: true,
      bubbles: true,
    });
    prevented.preventDefault();
    window.dispatchEvent(prevented);
    expect(onBackToPick).not.toHaveBeenCalled();
    // Focus inside open overlay content (dialog/menu/listbox) yields.
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    const item = document.createElement('button');
    menu.appendChild(item);
    container.appendChild(menu);
    item.focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onBackToPick).not.toHaveBeenCalled();
    menu.remove();
    // A PLAIN focused editor consumes nothing — Esc must still work there
    // (the old location-based yield left it silently dead, round-6). With no
    // marquee drawn this is stage two: back to the pick state.
    const editor = document.createElement('div');
    editor.className = 'ProseMirror';
    editor.tabIndex = 0;
    container.appendChild(editor);
    editor.focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onBackToPick).toHaveBeenCalledTimes(1);
  });

  it('rescales the marquee when the image box changes size (zoom mid-marquee, adversarial)', () => {
    renderOverlay();
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    // Zoom ×2: the img box doubles; a re-measure fires (resize signal).
    IMG_BOX.width = 800;
    IMG_BOX.height = 600;
    fireEvent(window, new Event('resize'));
    const rect = screen.getByTestId('focus-crop-rect');
    expect(rect.style.left).toBe('100px');
    expect(rect.style.top).toBe('100px');
    expect(rect.style.width).toBe('200px');
    expect(rect.style.height).toBe('160px');
  });

  it('Esc mid-drag cancels the gesture — the next pointermove does not resurrect the rect (adversarial R2)', () => {
    const onBackToPick = vi.fn();
    renderOverlay(vi.fn(), onBackToPick);
    const layer = screen.getByTestId('focus-crop-layer');
    fireEvent.pointerDown(layer, { clientX: 150, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 250, clientY: 180, pointerId: 1 });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
    expect(onBackToPick).not.toHaveBeenCalled();
    // Button still held: further movement must NOT recreate the marquee.
    fireEvent.pointerMove(layer, { clientX: 300, clientY: 220, pointerId: 1 });
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
  });

  it('a bare click leaves no marquee — a degenerate draw is discarded on release (adversarial R2, HIGH)', () => {
    renderOverlay();
    const layer = screen.getByTestId('focus-crop-layer');
    fireEvent.pointerDown(layer, { clientX: 150, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerUp(layer, { pointerId: 1 });
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
    // Esc with nothing drawn exits directly (no stolen stage).
  });

  it('confirm discards the marquee when the img src changed since the measure (adversarial R2)', () => {
    const onConfirm = vi.fn();
    renderOverlay(onConfirm);
    const img = screen.getByTestId('image-node-img');
    Object.defineProperty(img, 'naturalWidth', { value: 800 });
    Object.defineProperty(img, 'naturalHeight', { value: 600 });
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    // Same-size content swap: no geometry change, only the src differs.
    img.setAttribute('src', 'https://cdn/regenerated.png');
    fireEvent.click(screen.getByTestId('focus-crop-confirm'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
  });

  it('a REJECTED confirm keeps the marquee (pool full is fixable — round-3)', () => {
    const onConfirm = vi.fn(() => false);
    renderOverlay(onConfirm);
    const img = screen.getByTestId('image-node-img');
    Object.defineProperty(img, 'naturalWidth', { value: 800 });
    Object.defineProperty(img, 'naturalHeight', { value: 600 });
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    fireEvent.click(screen.getByTestId('focus-crop-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('focus-crop-rect')).toBeInTheDocument();
  });

  it('a resize collapsed onto its anchor is discarded on release (round-3: any gesture, not just draw)', () => {
    renderOverlay();
    const layer = screen.getByTestId('focus-crop-layer');
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    const handle = screen.getByTestId('focus-crop-handle-se');
    // Drag SE onto the NW anchor: rect collapses below the minimum.
    fireEvent.pointerDown(handle, { clientX: 250, clientY: 180, button: 0, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 152, clientY: 102, pointerId: 1 });
    fireEvent.pointerUp(layer, { pointerId: 1 });
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
  });

  it('the img vanishing (node deleted / handling) aborts marquee AND gesture (round-5)', () => {
    renderOverlay();
    const layer = screen.getByTestId('focus-crop-layer');
    // Mid-drag when the img unmounts.
    fireEvent.pointerDown(layer, { clientX: 150, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 250, clientY: 180, pointerId: 1 });
    screen.getByTestId('image-node-img').remove();
    fireEvent(window, new Event('resize')); // triggers measure → img-absent path
    expect(screen.queryByTestId('focus-crop-layer')).toBeNull();
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
  });

  it('wheel over the capture layer forwards to the pane AND prevents the browser default (round-5/6)', () => {
    renderOverlay();
    const pane = document.createElement('div');
    pane.className = 'react-flow__pane';
    document.body.appendChild(pane);
    const received: WheelEvent[] = [];
    pane.addEventListener('wheel', (e) => received.push(e as WheelEvent));
    const original = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 200,
      clientY: 150,
      deltaY: -120,
      ctrlKey: true,
    });
    screen.getByTestId('focus-crop-layer').dispatchEvent(original);
    expect(received).toHaveLength(1);
    expect(received[0]!.deltaY).toBe(-120);
    expect(received[0]!.ctrlKey).toBe(true);
    // The ORIGINAL default must be suppressed — over the pane d3-zoom's
    // non-passive listener does this; unprevented, a ctrl+wheel / pinch
    // page-zoomed the whole browser on top of the canvas zoom (round-6).
    expect(original.defaultPrevented).toBe(true);
    // The CONTROLS BAR is covered too (round-7): the suppressor lives on
    // the overlay root, which every interactive child bubbles to.
    const barWheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 60,
      ctrlKey: true,
    });
    screen.getByTestId('focus-crop-controls').dispatchEvent(barWheel);
    expect(barWheel.defaultPrevented).toBe(true);
    expect(received).toHaveLength(2);
    pane.remove();
  });

  it('an accepted confirm hands focus to Cancel (Confirm disables, round-5)', () => {
    renderOverlay(vi.fn(() => true));
    const img = screen.getByTestId('image-node-img');
    Object.defineProperty(img, 'naturalWidth', { value: 800 });
    Object.defineProperty(img, 'naturalHeight', { value: 600 });
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    fireEvent.click(screen.getByTestId('focus-crop-confirm'));
    expect(document.activeElement).toBe(screen.getByTestId('focus-crop-cancel'));
  });

  it('a click on a zoom-out-shrunken but natural-valid marquee does not wipe it (round-9)', () => {
    renderOverlay();
    const img = screen.getByTestId('image-node-img');
    // Huge natural image: a 6×6 display rect selects ~120 natural px.
    Object.defineProperty(img, 'naturalWidth', { value: 8000 });
    Object.defineProperty(img, 'naturalHeight', { value: 6000 });
    fireEvent(window, new Event('resize')); // re-measure captures natural size
    draw({ x: 150, y: 100 }, { x: 156, y: 106 });
    const rect = screen.getByTestId('focus-crop-rect');
    expect(rect).toBeInTheDocument();
    // A zero-delta click on the marquee body (a move gesture) must not
    // destroy a selection Confirm accepts — the pointer-up gauge is the
    // same natural-pixel validity as Confirm now.
    fireEvent.pointerDown(rect, { clientX: 153, clientY: 103, button: 0, pointerId: 1 });
    fireEvent.pointerUp(screen.getByTestId('focus-crop-layer'), { pointerId: 1 });
    expect(screen.getByTestId('focus-crop-rect')).toBeInTheDocument();
    expect(
      (screen.getByTestId('focus-crop-confirm') as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('Esc while the target is culled returns to the pick state instead of eating the kept marquee (round-9)', () => {
    const onBackToPick = vi.fn();
    renderOverlay(vi.fn(() => true), onBackToPick);
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    // Culling: the img unmounts, the marquee is KEPT (round-8) but no
    // longer visible — stage-one Esc would be a silent no-op.
    screen.getByTestId('image-node-img').remove();
    fireEvent(window, new Event('resize'));
    expect(screen.queryByTestId('focus-crop-layer')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onBackToPick).toHaveBeenCalledTimes(1);
  });

  it('a ratio preset keeps a zoom-out-shrunken but natural-valid marquee (round-10)', () => {
    renderOverlay();
    const img = screen.getByTestId('image-node-img');
    Object.defineProperty(img, 'naturalWidth', { value: 8000 });
    Object.defineProperty(img, 'naturalHeight', { value: 6000 });
    fireEvent(window, new Event('resize'));
    draw({ x: 150, y: 100 }, { x: 156, y: 106 });
    // 6×6 display (~120 natural px) reshaped to 16:9 → ~6×3.4 display,
    // still hundreds of natural px — the preset must not discard it.
    fireEvent.click(screen.getByTestId('focus-ratio-16:9'));
    expect(screen.getByTestId('focus-crop-rect')).toBeInTheDocument();
  });

  it('a held (auto-repeat) Esc does not collapse both stages (round-10)', () => {
    const onBackToPick = vi.fn();
    renderOverlay(vi.fn(() => true), onBackToPick);
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    fireEvent.keyDown(window, { key: 'Escape' });
    // The OS auto-repeat replays with repeat=true — must be ignored.
    fireEvent.keyDown(window, { key: 'Escape', repeat: true });
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
    expect(onBackToPick).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onBackToPick).toHaveBeenCalledTimes(1);
  });

  it('Cancel aborts an in-flight second-pointer gesture — no resurrection (round-11)', () => {
    renderOverlay();
    const layer = screen.getByTestId('focus-crop-layer');
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    // A second pointer grabs a handle mid-session…
    fireEvent.pointerDown(screen.getByTestId('focus-crop-handle-se'), {
      clientX: 250,
      clientY: 180,
      button: 0,
      pointerId: 5,
    });
    // …the user clicks Cancel…
    fireEvent.click(screen.getByTestId('focus-crop-cancel'));
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
    // …and the captured pointer's next move must NOT resurrect the rect.
    fireEvent.pointerMove(layer, { clientX: 300, clientY: 220, pointerId: 5 });
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
  });

  it('an IME composition-cancel Escape never clears the marquee (round-11)', () => {
    const onBackToPick = vi.fn();
    renderOverlay(vi.fn(() => true), onBackToPick);
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    const composing = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(composing, 'isComposing', { value: true });
    window.dispatchEvent(composing);
    expect(screen.getByTestId('focus-crop-rect')).toBeInTheDocument();
    expect(onBackToPick).not.toHaveBeenCalled();
  });

  it('a lazy-load remount measuring a zero-size box must not destroy the kept marquee (round-12)', () => {
    renderOverlay();
    const img = screen.getByTestId('image-node-img');
    Object.defineProperty(img, 'naturalWidth', { value: 800 });
    Object.defineProperty(img, 'naturalHeight', { value: 600 });
    fireEvent(window, new Event('resize')); // capture the natural size
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    // Culling: the img unmounts; the marquee is KEPT (round-8).
    img.remove();
    fireEvent(window, new Event('resize'));
    expect(screen.queryByTestId('focus-crop-layer')).toBeNull();
    // Return from culling: the img REMOUNTS with the same src, but lazy
    // loading (#1772) can make its first measure a ZERO box (decode not
    // finished). Rescaling against it collapsed the marquee to 0, then the
    // post-decode measure divided by the stored zero → NaN geometry.
    const node = document.querySelector('.react-flow__node[data-id="n1"]')!;
    const back = document.createElement('img');
    back.setAttribute('data-testid', 'image-node-img');
    back.setAttribute('src', 'https://cdn/original.png');
    node.appendChild(back);
    IMG_BOX.width = 0;
    IMG_BOX.height = 0;
    fireEvent(window, new Event('resize'));
    // Decode finishes: the real box lands.
    IMG_BOX.width = 400;
    IMG_BOX.height = 300;
    Object.defineProperty(back, 'naturalWidth', { value: 800 });
    Object.defineProperty(back, 'naturalHeight', { value: 600 });
    fireEvent(window, new Event('resize'));
    const rect = screen.getByTestId('focus-crop-rect');
    expect(rect.style.left).toBe('50px');
    expect(rect.style.top).toBe('50px');
    expect(rect.style.width).toBe('100px');
    expect(rect.style.height).toBe('80px');
    expect(
      (screen.getByTestId('focus-crop-confirm') as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('controls bar: 6px outer radius; every button no-wrap + no-shrink (user 2026-07-17 #1/#3)', () => {
    renderOverlay();
    const bar = screen.getByTestId('focus-crop-controls');
    // rounded-overlay = 6px chrome radius; rounded-md was 12px.
    expect(bar.className).toContain('rounded-overlay');
    expect(bar.className).not.toContain('rounded-md');
    // Edge-clamped abspos boxes shrink to available width — without
    // nowrap the CJK 取消/确认 labels wrapped one char per line.
    for (const id of ['focus-ratio-16:9', 'focus-crop-cancel', 'focus-crop-confirm']) {
      const el = screen.getByTestId(id);
      expect(el.className).toContain('whitespace-nowrap');
      expect(el.className).toContain('shrink-0');
    }
  });

  it('a second pointer cannot hijack or end the active interaction (adversarial)', () => {
    renderOverlay();
    const layer = screen.getByTestId('focus-crop-layer');
    fireEvent.pointerDown(layer, { clientX: 150, clientY: 100, button: 0, pointerId: 1 });
    // Second finger lands + lifts mid-draw: ignored entirely.
    fireEvent.pointerDown(layer, { clientX: 400, clientY: 300, button: 0, pointerId: 2 });
    fireEvent.pointerUp(layer, { pointerId: 2 });
    // First pointer continues the SAME draw from its original anchor.
    fireEvent.pointerMove(layer, { clientX: 250, clientY: 180, pointerId: 1 });
    fireEvent.pointerUp(layer, { pointerId: 1 });
    const rect = screen.getByTestId('focus-crop-rect');
    expect(rect.style.left).toBe('50px');
    expect(rect.style.width).toBe('100px');
    expect(rect.style.height).toBe('80px');
  });
});
