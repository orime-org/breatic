// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

/**
 * FocusCropOverlay component tests (#1782): marquee draw / ratio presets /
 * confirm mapping / Esc staging, against a stubbed node img box.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import * as React from 'react';

import { FocusCropOverlay } from '@web/spaces/canvas/focus/FocusCropOverlay';

/** Screen boxes: overlay root at (0,0); node img at (100,50) — MUTABLE so
 * tests can simulate a zoom (box rescale) between measures. */
const IMG_BOX = { left: 100, top: 50, width: 400, height: 300 };

beforeEach(() => {
  IMG_BOX.left = 100;
  IMG_BOX.top = 50;
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
      {/* The pick banner CanvasSpace renders during a session — the overlay
          hands keyboard focus to it on back-to-pick. */}
      <div data-testid='reference-pick-banner' tabIndex={-1} />
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
      // Both crop sources share the stubbed box: the overlay anchors to a
      // <video> exactly like it anchors to an <img> (#1987).
      const isTarget = this.tagName === 'IMG' || this.tagName === 'VIDEO';
      return {
        x: isTarget ? IMG_BOX.left : 0,
        y: isTarget ? IMG_BOX.top : 0,
        left: isTarget ? IMG_BOX.left : 0,
        top: isTarget ? IMG_BOX.top : 0,
        right: isTarget ? IMG_BOX.left + IMG_BOX.width : 1000,
        bottom: isTarget ? IMG_BOX.top + IMG_BOX.height : 1000,
        width: isTarget ? IMG_BOX.width : 1000,
        height: isTarget ? IMG_BOX.height : 1000,
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
    // Exact object, deliberately (#1987 §7.2): the confirm→export chain drops
    // fields silently, so this assertion must name every field and gain the
    // new one rather than loosen to objectContaining. An image target carries
    // no time point.
    expect(onConfirm).toHaveBeenCalledWith({
      crop: { x: 100, y: 100, width: 200, height: 160 },
      natural: { width: 800, height: 600 },
      sourceSrc: 'https://cdn/original.png',
      sourceTimeSeconds: null,
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

  it('an ACCEPTED confirm returns to the PICK state (hides the crop bar) exactly like cancel — the focus flow is complete (user 2026-07-20)', () => {
    const onConfirm = vi.fn(() => true);
    const onBackToPick = vi.fn();
    renderOverlay(onConfirm, onBackToPick);
    const img = screen.getByTestId('image-node-img');
    Object.defineProperty(img, 'naturalWidth', { value: 800 });
    Object.defineProperty(img, 'naturalHeight', { value: 600 });
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    fireEvent.click(screen.getByTestId('focus-crop-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    // One focus = one complete flow (pick → marquee → confirm/cancel): BOTH
    // endings leave the crop state, unmounting the overlay + its control bar.
    // Confirm used to only clear the marquee, leaving the bar floating.
    expect(onBackToPick).toHaveBeenCalledTimes(1);
  });

  it('an accepted confirm hands DOM focus to the pick banner, not <body> (WCAG 2.4.3 — adversarial ②/③ #1807)', () => {
    renderOverlay(vi.fn(() => true));
    const img = screen.getByTestId('image-node-img');
    Object.defineProperty(img, 'naturalWidth', { value: 800 });
    Object.defineProperty(img, 'naturalHeight', { value: 600 });
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    const confirmBtn = screen.getByTestId('focus-crop-confirm');
    confirmBtn.focus(); // the user clicked it → it holds focus
    expect(document.activeElement).toBe(confirmBtn);
    fireEvent.click(confirmBtn);
    // Confirm ends the crop state (overlay unmounts); the SHARED backToPick
    // hands focus to the pick banner so it never drops to <body>. Confirm used
    // to skip the hand-off that cancel + Esc both ran (the copy-paste drift the
    // adversarial ②/③ pass caught).
    expect(document.activeElement).toBe(
      screen.getByTestId('reference-pick-banner'),
    );
  });

  it('a REJECTED confirm (gate refusal) keeps the marquee and STAYS in the crop state', () => {
    const onConfirm = vi.fn(() => false);
    const onBackToPick = vi.fn();
    renderOverlay(onConfirm, onBackToPick);
    const img = screen.getByTestId('image-node-img');
    Object.defineProperty(img, 'naturalWidth', { value: 800 });
    Object.defineProperty(img, 'naturalHeight', { value: 600 });
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    fireEvent.click(screen.getByTestId('focus-crop-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    // A fixable rejection (pool full) must not end the flow — the user's
    // careful selection survives for a re-confirm (round-3 invariant).
    expect(onBackToPick).not.toHaveBeenCalled();
    expect(screen.getByTestId('focus-crop-rect')).toBeInTheDocument();
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

  it('an Esc consumed while a tooltip is open stays consumed — layered peel (adversarial r2)', () => {
    // Round-2 reversal: presence of a [role=tooltip] cannot attribute WHO
    // preventDefaulted (rename editors / the @-suggestion consume under the
    // same single bit) — the consumed press is honored, the next one peels.
    const onBackToPick = vi.fn();
    renderOverlay(vi.fn(), onBackToPick);
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    const tip = document.createElement('div');
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);
    try {
      const prevented = new KeyboardEvent('keydown', {
        key: 'Escape',
        cancelable: true,
        bubbles: true,
      });
      prevented.preventDefault();
      // fireEvent (not raw dispatchEvent) so any state update flushes.
      fireEvent(window, prevented);
      expect(screen.queryByTestId('focus-crop-rect')).not.toBeNull();
      // The next, unconsumed press peels stage one.
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
      expect(onBackToPick).not.toHaveBeenCalled();
    } finally {
      tip.remove();
    }
  });

  it('Escape yields to focus inside an open alertdialog (adversarial r2)', () => {
    const onBackToPick = vi.fn();
    const { container } = renderOverlay(vi.fn(), onBackToPick);
    const alert = document.createElement('div');
    alert.setAttribute('role', 'alertdialog');
    const btn = document.createElement('button');
    alert.appendChild(btn);
    container.appendChild(alert);
    btn.focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onBackToPick).not.toHaveBeenCalled();
    alert.remove();
  });

  it('the focus hand-off never steals focus from a surface outside the overlay (r2)', () => {
    // Esc stage-two with focus in the prompt editor: the editor keeps focus;
    // the banner hand-off only rescues focus that would be ORPHANED.
    const onBackToPick = vi.fn();
    const { container } = renderOverlay(vi.fn(), onBackToPick);
    const editor = document.createElement('input');
    container.appendChild(editor);
    editor.focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onBackToPick).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(editor);
    editor.remove();
  });

  it('Cancel / Esc back-to-pick hand keyboard focus to the pick banner (adversarial 2026-07-17)', () => {
    // The overlay unmounts on back-to-pick with focus inside it — without a
    // hand-off, document.activeElement falls to <body> and the next Tab
    // restarts from the top of the page.
    renderOverlay();
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    const cancel = screen.getByTestId('focus-crop-cancel');
    cancel.focus();
    fireEvent.click(cancel);
    expect(document.activeElement?.getAttribute('data-testid')).toBe(
      'reference-pick-banner',
    );
    // The Esc stage-two path hands off the same way.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.activeElement?.getAttribute('data-testid')).toBe(
      'reference-pick-banner',
    );
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

  it('an accepted confirm kills a second pointer’s in-flight gesture — its next move cannot resurrect the marquee (round-11)', () => {
    // The round-5 focus-to-Cancel handoff is gone with the flow change
    // (accepted confirm now leaves the crop state entirely, user 2026-07-20);
    // what must survive is the round-11 invariant: a second pointer captured
    // mid-gesture dies on confirm instead of re-drawing a cleared marquee.
    const onBackToPick = vi.fn();
    renderOverlay(vi.fn(() => true), onBackToPick);
    const img = screen.getByTestId('image-node-img');
    Object.defineProperty(img, 'naturalWidth', { value: 800 });
    Object.defineProperty(img, 'naturalHeight', { value: 600 });
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    // Second pointer grabs the RECT (a move gesture — keeps the marquee
    // valid, unlike a layer press which would start a new draw)...
    const layer = screen.getByTestId('focus-crop-layer');
    fireEvent.pointerDown(screen.getByTestId('focus-crop-rect'), {
      pointerId: 2,
      clientX: 200,
      clientY: 140,
    });
    // ...the user confirms with the first pointer.
    fireEvent.click(screen.getByTestId('focus-crop-confirm'));
    expect(onBackToPick).toHaveBeenCalledTimes(1);
    // The second pointer's next move must not resurrect a marquee.
    fireEvent.pointerMove(layer, { pointerId: 2, clientX: 260, clientY: 190 });
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
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

  it('controls bar anchors under the node and may overflow the viewport (user 2026-07-17)', () => {
    // The bar follows the picked node like the generate panel does — always
    // centered under the img box, allowed off-screen. The old viewport clamp
    // pulled it away from an edge-parked node (reported with a screenshot).
    IMG_BOX.left = -150; // node half off-screen left → center x = 50
    IMG_BOX.top = 800; // low node → bar lands below the 1000px viewport fold
    renderOverlay();
    const bar = screen.getByTestId('focus-crop-controls');
    expect(bar.style.left).toBe('50px');
    expect(bar.style.top).toBe(`${800 + 300 + 8}px`);
    expect(bar.className).toContain('-translate-x-1/2');
  });

  it('controls bar: 6px outer radius; every button no-wrap + no-shrink (user 2026-07-17 #1/#3)', () => {
    renderOverlay();
    const bar = screen.getByTestId('focus-crop-controls');
    // rounded-overlay = 6px chrome radius; rounded-md was 12px.
    expect(bar.className).toContain('rounded-overlay');
    expect(bar.className).not.toContain('rounded-md');
    // Abspos boxes near the viewport edge shrink to available width —
    // without nowrap the CJK 取消/确认 labels wrapped one char per line.
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

/** One step of the timeline: the worst-case frame duration (#1987 §4.3.2). */
const STEP_SECONDS = 1 / 24;

/**
 * Gives a jsdom <video> the media properties the overlay reads. jsdom
 * implements none of them (duration is NaN, videoWidth/videoHeight are 0,
 * currentTime is inert), so each is defined on the instance.
 * @param el - The element to stub.
 * @param opts - The media state to expose.
 * @param opts.duration - Total length in seconds; omitted means NaN.
 * @param opts.currentTime - Where the video is parked.
 * @param opts.videoWidth - Intrinsic width; 0 means metadata has not arrived.
 * @param opts.videoHeight - Intrinsic height.
 * @param opts.paused - Whether it is parked rather than playing.
 * @returns Every value written to `currentTime`, in order.
 */
function stubVideo(
  el: HTMLVideoElement,
  opts: {
    duration?: number;
    currentTime?: number;
    videoWidth?: number;
    videoHeight?: number;
    paused?: boolean;
  } = {},
): number[] {
  const writes: number[] = [];
  let time = opts.currentTime ?? 0;
  Object.defineProperty(el, 'duration', {
    configurable: true,
    get: () => opts.duration ?? NaN,
  });
  Object.defineProperty(el, 'currentTime', {
    configurable: true,
    get: () => time,
    set: (value: number) => {
      time = value;
      writes.push(value);
    },
  });
  Object.defineProperty(el, 'videoWidth', {
    configurable: true,
    get: () => opts.videoWidth ?? 0,
  });
  Object.defineProperty(el, 'videoHeight', {
    configurable: true,
    get: () => opts.videoHeight ?? 0,
  });
  Object.defineProperty(el, 'paused', { configurable: true, get: () => opts.paused ?? true });
  return writes;
}

/**
 * Renders a VIDEO node and then mounts the overlay onto it — in that order,
 * deliberately: the node's <video> is `preload='metadata'` and has long since
 * fired `loadedmetadata` by the time a user picks it, so an overlay that only
 * subscribes (never seeds) shows no handle on the path everyone walks.
 * @param opts - Media state for the stub, see {@link stubVideo}.
 * @param onConfirm - Confirm spy.
 * @param onBackToPick - Back-to-pick spy.
 * @returns The render result plus the stubbed element and its time writes.
 */
function renderVideoOverlay(
  opts: Parameters<typeof stubVideo>[1] = {},
  onConfirm = vi.fn(() => true),
  onBackToPick = vi.fn(),
): ReturnType<typeof render> & { video: HTMLVideoElement; writes: number[] } {
  /**
   * @param withOverlay - Whether the crop overlay is mounted yet.
   * @returns The tree to render.
   */
  const tree = (withOverlay: boolean): React.ReactElement => (
    <ReactFlowProvider>
      <div className='react-flow__node' data-id='n1'>
        {/* Same testid the node's MediaPlayer renders (audio shares it). */}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption -- mirrors MediaPlayer's own element, which carries no caption track either. */}
        <video data-testid='media-element' src='https://cdn/clip.mp4' />
      </div>
      <div data-testid='reference-pick-banner' tabIndex={-1} />
      {withOverlay ? (
        <FocusCropOverlay
          nodeId='n1'
          nodePosition={{ x: 0, y: 0 }}
          onConfirm={onConfirm}
          onBackToPick={onBackToPick}
        />
      ) : null}
    </ReactFlowProvider>
  );
  const result = render(tree(false));
  const video = screen.getByTestId('media-element') as HTMLVideoElement;
  const writes = stubVideo(video, opts);
  result.rerender(tree(true));
  return Object.assign(result, { video, writes });
}

describe('FocusCropOverlay：视频目标与时间轴（#1987）', () => {
  it('确认之前元数据还没到（videoWidth 为 0）：给提示、选框留着（A7a）', () => {
    const onConfirm = vi.fn(() => true);
    // Metadata absent is the OPENING state of every video, not an edge case.
    renderVideoOverlay({ duration: 10, currentTime: 0, videoWidth: 0 }, onConfirm);
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    fireEvent.click(screen.getByTestId('focus-crop-confirm'));
    expect(onConfirm).not.toHaveBeenCalled();
    // The marquee survives so the user can retry once metadata lands.
    expect(screen.getByTestId('focus-crop-rect')).toBeInTheDocument();
  });

  it('确认时交出的是元素当前停在的时间点（A9）', () => {
    const onConfirm = vi.fn(() => true);
    const { video } = renderVideoOverlay(
      { duration: 10, currentTime: 4.375, videoWidth: 800, videoHeight: 600 },
      onConfirm,
    );
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    fireEvent.click(screen.getByTestId('focus-crop-confirm'));
    // Read off the ELEMENT, not the display mirror: one source of truth.
    expect(onConfirm).toHaveBeenCalledWith({
      crop: { x: 100, y: 100, width: 200, height: 160 },
      natural: { width: 800, height: 600 },
      sourceSrc: 'https://cdn/clip.mp4',
      sourceTimeSeconds: video.currentTime,
    });
  });

  it('时间轴只在视频目标出现，图片目标那一行不存在（A8）', () => {
    renderOverlay();
    expect(screen.queryByTestId('focus-crop-timeline')).toBeNull();
    cleanup();
    renderVideoOverlay({ duration: 10, currentTime: 0, videoWidth: 800, videoHeight: 600 });
    expect(screen.getByTestId('focus-crop-timeline')).toBeInTheDocument();
  });

  it('元素在浮层打开前就已就绪：手柄立刻出现在它停的位置（A8，先播种）', () => {
    renderVideoOverlay({ duration: 10, currentTime: 4, videoWidth: 800, videoHeight: 600 });
    // Nothing fires loadedmetadata after the overlay mounts — a subscribe-only
    // implementation shows no handle at all here.
    const thumb = screen.getByRole('slider');
    expect(thumb.getAttribute('aria-valuenow')).toBe('4');
    expect(thumb.getAttribute('aria-valuemax')).toBe('10');
  });

  it('拖手柄写的是元素的 currentTime（A8）', () => {
    const { writes, video } = renderVideoOverlay({
      duration: 10,
      currentTime: 0,
      videoWidth: 800,
      videoHeight: 600,
    });
    const track = screen.getByRole('slider').parentElement!;
    // The stubbed rect makes the track 0..1000 wide: half way is 5s.
    fireEvent.pointerDown(track, { clientX: 500, clientY: 0, button: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 500, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(track, { pointerId: 1 });
    expect(writes.length).toBeGreaterThan(0);
    expect(video.currentTime).toBeCloseTo(5, 1);
  });

  it('步进是 1/24 秒：按一次方向键换一帧，不是跳一整秒（A8）', () => {
    const { video } = renderVideoOverlay({
      duration: 10,
      currentTime: 0,
      videoWidth: 800,
      videoHeight: 600,
    });
    const thumb = screen.getByRole('slider');
    thumb.focus();
    fireEvent.keyDown(thumb, { key: 'ArrowRight' });
    // Radix defaults to step=1 — that default lands on 1 and this fails.
    expect(video.currentTime).toBeCloseTo(STEP_SECONDS, 5);
  });

  it('duration 不是有限正数：整条 Slider 不渲染，两端显示 --:--（A8）', () => {
    renderVideoOverlay({ currentTime: 0, videoWidth: 800, videoHeight: 600 });
    // The shared Slider renders its Thumb unconditionally, so "no handle"
    // can only mean "no Slider".
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.getByTestId('focus-crop-timeline')).toBeInTheDocument();
    // Asserting the literal matters: formatTime's fallback for a non-finite
    // input is '0:00', which reads as "parked at the start" — a wrong fact,
    // not an unknown one.
    expect(screen.getByTestId('focus-crop-time-current')).toHaveTextContent('--:--');
    expect(screen.getByTestId('focus-crop-time-duration')).toHaveTextContent('--:--');
  });

  it('元素换了身份之后，镜像和总时长从新元素重读（A9 / §5.3）', () => {
    const { video } = renderVideoOverlay({
      duration: 10,
      currentTime: 4,
      videoWidth: 800,
      videoHeight: 600,
    });
    expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('4');
    // A culling cycle unmounts the <video> and mounts a fresh one with the
    // same src: it starts at 0 and may report a different length.
    const node = document.querySelector('.react-flow__node[data-id="n1"]')!;
    video.remove();
    const back = document.createElement('video');
    back.setAttribute('data-testid', 'media-element');
    back.setAttribute('src', 'https://cdn/clip.mp4');
    node.appendChild(back);
    stubVideo(back, { duration: 8, currentTime: 0, videoWidth: 800, videoHeight: 600 });
    fireEvent(window, new Event('resize'));
    // Without a rebind the handle stays at 4s while the picture is at 0 —
    // the screen would state two contradictory facts.
    const thumb = screen.getByRole('slider');
    expect(thumb.getAttribute('aria-valuenow')).toBe('0');
    expect(thumb.getAttribute('aria-valuemax')).toBe('8');
  });
});
