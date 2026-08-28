// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * FocusCropOverlay component tests (#1782): marquee draw / ratio presets /
 * confirm mapping / Esc staging, against a stubbed node img box.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import * as React from 'react';

import { FocusCropOverlay } from '@web/spaces/canvas/focus/FocusCropOverlay';
import { CROP_PRESETS } from '@web/spaces/canvas/focus/crop-math';
import { toast } from '@web/lib/toast';
import { useUIStore } from '@web/stores/ui';
import en from '../../../../../../../locales/en.json';
import ja from '../../../../../../../locales/ja.json';
import ko from '../../../../../../../locales/ko.json';
import zhCN from '../../../../../../../locales/zh-CN.json';
import zhTW from '../../../../../../../locales/zh-TW.json';

/** The five shipped catalogs, for the assertions that compare across locales. */
const CATALOGS: Record<string, Record<string, Record<string, unknown>>> = {
  en,
  ja,
  ko,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
};

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
      {/* The space column marks the region root; the overlay renders inside
          it on the page, which is what makes its keys the space's. */}
      <div data-region='space'>
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
      </div>
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

  it('a lit preset constrains a freshly drawn marquee; re-click unlights it', () => {
    renderOverlay();
    fireEvent.click(screen.getByTestId('focus-ratio-1:1'));
    // The click now draws a 300×300 marquee at img-local x 50..350 (#1991), so
    // the press has to start on capture layer the marquee does NOT cover or
    // this gesture is a MOVE. jsdom does no hit-testing and would run the draw
    // branch either way — the coordinates keep the test on a gesture a real
    // pointer can produce. Screen x 100..150 is the bare left strip.
    draw({ x: 110, y: 100 }, { x: 310, y: 250 });
    const rect = screen.getByTestId('focus-crop-rect');
    // Dominant axis 200 wide → square 200×200.
    expect(rect.style.width).toBe('200px');
    expect(rect.style.height).toBe('200px');
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
    // An editor outside both regions is nobody's, so the press stays there.
    const editor = document.createElement('div');
    editor.className = 'ProseMirror';
    editor.tabIndex = 0;
    container.appendChild(editor);
    editor.focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onBackToPick).not.toHaveBeenCalled();
    // Focus back inside the space and the session's Esc works again.
    editor.remove();
    (
      container.querySelector('[data-testid=reference-pick-banner]') as
        | HTMLElement
        | undefined
    )?.focus();
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

  // The overlay is not modal — it holds no focus trap, so a reader can click
  // into the agent panel while it is open. From that moment the keys are the
  // agent's, exactly as they are for Delete and the canvas Escape.
  it('Escape leaves the session alone while the agent region is active', () => {
    const onBackToPick = vi.fn();
    renderOverlay(vi.fn(), onBackToPick);
    useUIStore.getState().setActiveRegion('agent');
    try {
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onBackToPick).not.toHaveBeenCalled();
    } finally {
      useUIStore.getState().setActiveRegion('space');
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
    // Esc stage-two with focus on another control in the space: that control
    // keeps focus; the banner hand-off only rescues focus that would be
    // ORPHANED.
    const onBackToPick = vi.fn();
    const { container } = renderOverlay(vi.fn(), onBackToPick);
    const elsewhere = document.createElement('button');
    (container.querySelector('[data-region=space]') as HTMLElement).append(
      elsewhere,
    );
    elsewhere.focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onBackToPick).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
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

  it('a box that dips to the video placeholder height and back restores a locked ratio exactly', () => {
    renderOverlay();
    // Draw first: the rescale branch needs both a marquee and a measured
    // baseline, and drawing is what establishes them.
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    fireEvent.click(screen.getByTestId('focus-ratio-1:1'));
    const read = (): string[] => {
      const s = screen.getByTestId('focus-crop-rect').style;
      return [s.left, s.top, s.width, s.height];
    };
    const before = read();

    // A remounted <video> reports the replaced element's placeholder height
    // until its metadata arrives, while `w-full` keeps the width — a
    // non-uniform box change, which rescales the two axes by different
    // factors and so cannot preserve the ratio on its own.
    IMG_BOX.height = 150;
    fireEvent(window, new Event('resize'));
    // Half the box height means half the marquee height: the dip is real, and
    // asserting it is what separates a working rescale from one that leaves
    // the vertical axis alone — both of which return to the same place.
    expect(parseFloat(read()[3])).toBeCloseTo(parseFloat(before[3]) / 2);
    // Metadata lands and the box returns to its real height.
    IMG_BOX.height = 300;
    fireEvent(window, new Event('resize'));

    expect(read()).toEqual(before);
    expect(
      screen.getByTestId('focus-ratio-1:1').getAttribute('aria-pressed'),
    ).toBe('true');
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

/** What a stubbed <video> records, per element (never on the prototype). */
interface VideoStub {
  /** Every value written to `currentTime`, in order. */
  writes: number[];
  /** This element's own `pause()`. */
  pause: ReturnType<typeof vi.fn>;
  /** This element's own `play()`. */
  play: ReturnType<typeof vi.fn>;
}

/**
 * Gives a jsdom <video> the media properties the overlay reads. jsdom
 * implements none of them (duration is NaN, videoWidth/videoHeight are 0,
 * currentTime is inert, play/pause throw "not implemented"), so each is
 * defined on the instance — per element, so "which video was paused" is
 * answerable.
 * @param el - The element to stub.
 * @param opts - The media state to expose.
 * @param opts.duration - Total length in seconds; omitted means NaN.
 * @param opts.currentTime - Where the video is parked.
 * @param opts.videoWidth - Intrinsic width; 0 means metadata has not arrived.
 * @param opts.videoHeight - Intrinsic height.
 * @param opts.paused - Whether it is parked rather than playing.
 * @param opts.quantize - Reproduce the browser's own rounding of a written
 *   `currentTime` (measured in Chrome: writing 1/24 reads back as 0.041666).
 *   A real element NEVER stores what you wrote, and that difference is what
 *   broke the keyboard.
 * @param opts.announceSeeked - Fire `seeked` after each write, as a real
 *   element does.
 * @returns The element's recorders.
 */
function stubVideo(
  el: HTMLVideoElement,
  opts: {
    duration?: number;
    currentTime?: number;
    videoWidth?: number;
    videoHeight?: number;
    paused?: boolean;
    quantize?: boolean;
    announceSeeked?: boolean;
  } = {},
): VideoStub {
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
      // Six decimals is what Chrome was measured to keep (#1987 smoke).
      time = opts.quantize ? Math.floor(value * 1e6) / 1e6 : value;
      writes.push(value);
      // ASYNCHRONOUSLY, like the real thing: a seek completes on a later task,
      // so anything the write handler does after assigning `currentTime`
      // happens FIRST and the seek's own notification lands last. Announcing
      // it synchronously reverses that order and hides the bug entirely —
      // this stub did, and the test passed while the browser was broken.
      if (opts.announceSeeked) {
        setTimeout(() => el.dispatchEvent(new Event('seeked')), 0);
      }
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
  const pause = vi.fn();
  const play = vi.fn();
  Object.defineProperty(el, 'pause', { configurable: true, value: pause });
  Object.defineProperty(el, 'play', { configurable: true, value: play });
  return { writes, pause, play };
}

/**
 * Renders a VIDEO node and then mounts the overlay onto it — in that order,
 * deliberately: the node's <video> is `preload='metadata'` and has long since
 * fired `loadedmetadata` by the time a user picks it, so an overlay that only
 * subscribes (never seeds) shows no handle on the path everyone walks.
 * @param opts - Media state for the stub, see {@link stubVideo}.
 * @param onConfirm - Confirm spy.
 * @param onBackToPick - Back-to-pick spy.
 * @returns The render result plus the stubbed element and its recorders.
 */
function renderVideoOverlay(
  opts: Parameters<typeof stubVideo>[1] = {},
  onConfirm = vi.fn(() => true),
  onBackToPick = vi.fn(),
): ReturnType<typeof render> & { video: HTMLVideoElement; stub: VideoStub } {
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
  const stub = stubVideo(video, opts);
  result.rerender(tree(true));
  return Object.assign(result, { video, stub });
}

describe('FocusCropOverlay：视频目标与时间轴（#1987）', () => {
  it('确认之前元数据还没到（videoWidth 为 0）：给提示、选框留着（A7a）', () => {
    const onConfirm = vi.fn(() => true);
    // Metadata absent is the OPENING state of every video, not an edge case.
    renderVideoOverlay({ duration: 10, currentTime: 0, videoWidth: 0 }, onConfirm);
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    const said = vi.spyOn(toast, 'error');
    fireEvent.click(screen.getByTestId('focus-crop-confirm'));
    expect(onConfirm).not.toHaveBeenCalled();
    // BOTH halves of A7a. Asserting only the marquee let the message be
    // deleted with the test still green (round-2 measured exactly that), and
    // a dead button that says nothing is the round-2-of-#1782 bug returning.
    expect(said).toHaveBeenCalledTimes(1);
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
    const { stub, video } = renderVideoOverlay({
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
    expect(stub.writes.length).toBeGreaterThan(0);
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

  it('连按方向键要一直往前走：元素读回来的值跟步进网格对不齐也不许卡住（A8/A9）', async () => {
    // A real <video> never stores what you write: Chrome quantised 1/24 to
    // 0.041666 (measured in the smoke run). Radix computes the next keyboard
    // step from the CONTROLLED value, and its "not on the grid" branch only
    // snaps to the nearest grid point — so a controlled value taken from the
    // element lands off-grid, snaps back to where it already is, and every
    // further press is a no-op. Measured: the handle froze after ONE press
    // and neither arrows nor PageUp could move it again.
    const { stub, video } = renderVideoOverlay({
      duration: 10,
      currentTime: 0,
      videoWidth: 800,
      videoHeight: 600,
      quantize: true,
      announceSeeked: true,
    });
    const thumb = screen.getByRole('slider');
    thumb.focus();
    /**
     * Press a key and let the pending seek notification land.
     * @returns The element's position afterwards.
     */
    const press = async (): Promise<number> => {
      fireEvent.keyDown(thumb, { key: 'ArrowRight' });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      return video.currentTime;
    };
    const afterFirst = await press();
    const afterSecond = await press();
    const afterThird = await press();
    expect(afterFirst).toBeGreaterThan(0);
    expect(afterSecond).toBeGreaterThan(afterFirst);
    expect(afterThird).toBeGreaterThan(afterSecond);
    // Three presses, three frames — not three writes of the same number.
    expect(new Set(stub.writes).size).toBe(stub.writes.length);
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

  it('元数据晚到：手柄在 loadedmetadata 之后才出现，占位轨道让位（A8）', () => {
    // The seed reads whatever the element has when the overlay attaches. When
    // that is nothing yet, the ONLY route to a working timeline is the
    // subscription — and deleting both listeners left the whole suite green.
    const { video } = renderVideoOverlay({ videoWidth: 800, videoHeight: 600 });
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.getByTestId('focus-crop-timeline-placeholder')).toBeInTheDocument();
    Object.defineProperty(video, 'duration', { configurable: true, value: 7.5 });
    act(() => {
      video.dispatchEvent(new Event('loadedmetadata'));
    });
    const thumb = screen.getByRole('slider');
    expect(thumb.getAttribute('aria-valuemax')).toBe('7.5');
    expect(screen.queryByTestId('focus-crop-timeline-placeholder')).toBeNull();
  });

  it('已知时长时，当前时间读到百分之一秒，占位轨道不再出现（A8）', () => {
    // The whole point of this timeline is landing on ONE frame; a m:ss readout
    // cannot tell 2.00s from 2.50s, so the sub-second digits are the feedback.
    renderVideoOverlay({
      duration: 10,
      currentTime: 2.5,
      videoWidth: 800,
      videoHeight: 600,
    });
    expect(screen.getByTestId('focus-crop-time-current')).toHaveTextContent('0:02.50');
    expect(screen.getByTestId('focus-crop-time-duration')).toHaveTextContent('0:10');
    expect(screen.queryByTestId('focus-crop-timeline-placeholder')).toBeNull();
  });

  it('时长未知时，轨道变淡（A8）', () => {
    renderVideoOverlay({ currentTime: 0, videoWidth: 800, videoHeight: 600 });
    const track = screen.getByTestId('focus-crop-timeline-placeholder');
    expect(track.className).toContain('opacity-50');
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

/** A two-video canvas plus a way to move the crop target between them. */
interface TwoVideoOverlay {
  /** The node rendered first (`n1`). */
  first: { el: HTMLVideoElement; stub: VideoStub };
  /** The node rendered second (`n2`). */
  second: { el: HTMLVideoElement; stub: VideoStub };
  /** Point the overlay at a node — or move it to the other one. */
  pick: (nodeId: string) => void;
}

/**
 * Renders TWO video nodes with the overlay pointed at one of them.
 * Changing the target does NOT remount the overlay (`CanvasSpace` renders it
 * without a `key`), so anything hung on mount runs for the first video only.
 * @returns Both elements with their recorders, and a way to move the target.
 */
function renderTwoVideoOverlay(): TwoVideoOverlay {
  const onConfirm = vi.fn(() => true);
  /**
   * @param targetId - Which node the overlay is cropping, null before any.
   * @returns The tree to render.
   */
  const tree = (targetId: string | null): React.ReactElement => (
    <ReactFlowProvider>
      {['n1', 'n2'].map((id) => (
        <div key={id} className='react-flow__node' data-id={id}>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- mirrors MediaPlayer's own element. */}
          <video data-testid='media-element' src={`https://cdn/${id}.mp4`} />
        </div>
      ))}
      <div data-testid='reference-pick-banner' tabIndex={-1} />
      {targetId === null ? null : (
        <FocusCropOverlay
          nodeId={targetId}
          nodePosition={{ x: 0, y: 0 }}
          onConfirm={onConfirm}
          onBackToPick={vi.fn()}
        />
      )}
    </ReactFlowProvider>
  );
  const result = render(tree(null));
  const [firstEl, secondEl] = screen.getAllByTestId(
    'media-element',
  ) as HTMLVideoElement[];
  // The first is mid-playback, the second is parked — the two cases the
  // pause rule distinguishes.
  const firstStub = stubVideo(firstEl!, {
    duration: 10,
    currentTime: 3,
    videoWidth: 800,
    videoHeight: 600,
    paused: false,
  });
  const secondStub = stubVideo(secondEl!, {
    duration: 10,
    currentTime: 6,
    videoWidth: 800,
    videoHeight: 600,
    paused: false,
  });
  return {
    first: { el: firstEl!, stub: firstStub },
    second: { el: secondEl!, stub: secondStub },
    pick: (nodeId) => result.rerender(tree(nodeId)),
  };
}

describe('FocusCropOverlay：换目标之后的选框判定（#1987）', () => {
  it('从图片换到元数据还没到的视频：选框按新目标判，不按上一个目标的分辨率（A7a）', () => {
    // The pointer-up gauge asks "does this rect select at least 8 source
    // pixels" and needs the SOURCE's own size to answer. A video reports 0×0
    // until its metadata lands — the opening state of every video, and the
    // state A7a is written for — so if the previous target's size is still
    // sitting there, the gauge answers with the wrong yardstick and throws
    // away a marquee the user could have retried with.
    const onConfirm = vi.fn(() => true);
    /**
     * @param targetId - Which node the overlay is cropping.
     * @returns The tree to render.
     */
    const tree = (targetId: string): React.ReactElement => (
      <ReactFlowProvider>
        <div className='react-flow__node' data-id='small-image'>
          <img data-testid='image-node-img' src='https://cdn/tiny.png' alt='' />
        </div>
        <div className='react-flow__node' data-id='fresh-video'>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- mirrors MediaPlayer's own element. */}
          <video data-testid='media-element' src='https://cdn/clip.mp4' />
        </div>
        <div data-testid='reference-pick-banner' tabIndex={-1} />
        <FocusCropOverlay
          nodeId={targetId}
          nodePosition={{ x: 0, y: 0 }}
          onConfirm={onConfirm}
          onBackToPick={vi.fn()}
        />
      </ReactFlowProvider>
    );
    const result = render(tree('small-image'));
    // A 64×64 asset shown in a 400×300 box: every display pixel is a fraction
    // of a source pixel, so the gauge demands a LARGE rect.
    const img = screen.getByTestId('image-node-img');
    Object.defineProperty(img, 'naturalWidth', { value: 64, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 64, configurable: true });
    fireEvent(window, new Event('resize'));
    // Same session, second target: a video that has not reported its size yet.
    const video = screen.getByTestId('media-element') as HTMLVideoElement;
    stubVideo(video, { duration: 10, currentTime: 0, videoWidth: 0, videoHeight: 0 });
    result.rerender(tree('fresh-video'));
    // A 30×30 drag — deliberately UNDER what the stale 64×64 yardstick would
    // demand (50 display px across, 37.5 down), and far over what the video's own size
    // asks for. A 60×60 drag clears both yardsticks, so it could not fail.
    draw({ x: 150, y: 100 }, { x: 180, y: 130 });
    expect(screen.getByTestId('focus-crop-rect')).toBeInTheDocument();
  });
});

describe('FocusCropOverlay：聚焦时的暂停（#1987）', () => {
  it('点中正在播的视频：只有它停下，别的照播（A3）', () => {
    const { first, second, pick } = renderTwoVideoOverlay();
    pick('n1');
    expect(first.stub.pause).toHaveBeenCalledTimes(1);
    expect(second.stub.pause).not.toHaveBeenCalled();
  });

  it('点中没在播的视频：不去碰它（user 2026-08-20）', () => {
    // It is already parked — there is nothing to pause, and calling pause()
    // on it is an action nobody asked for.
    const { stub } = renderVideoOverlay({
      duration: 10,
      currentTime: 2,
      videoWidth: 800,
      videoHeight: 600,
      paused: true,
    });
    expect(stub.pause).not.toHaveBeenCalled();
  });

  it('一次会话里连点两个视频：第二个也停，第一个不被放回去（A3）', () => {
    const { first, second, pick } = renderTwoVideoOverlay();
    pick('n1');
    first.stub.pause.mockClear();
    pick('n2');
    // The overlay does not remount on a target change, so a pause hung on
    // mount would leave this at zero.
    expect(second.stub.pause).toHaveBeenCalledTimes(1);
    // Leaving a video is not a reason to start it again — it stays where the
    // user parked it (user 2026-08-20).
    expect(first.stub.play).not.toHaveBeenCalled();
  });

  it('确认之后与取消之后都不曾调 play()（A4）', () => {
    const { stub } = renderVideoOverlay({
      duration: 10,
      currentTime: 4,
      videoWidth: 800,
      videoHeight: 600,
      paused: false,
    });
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    fireEvent.click(screen.getByTestId('focus-crop-confirm'));
    expect(stub.play).not.toHaveBeenCalled();
    cleanup();
    const cancelled = renderVideoOverlay({
      duration: 10,
      currentTime: 4,
      videoWidth: 800,
      videoHeight: 600,
      paused: false,
    });
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    fireEvent.click(screen.getByTestId('focus-crop-cancel'));
    expect(cancelled.stub.play).not.toHaveBeenCalled();
    // And it is still parked on the frame the user chose.
    expect(cancelled.video.currentTime).toBe(4);
  });
});

/**
 * Renders an IMAGE node whose intrinsic size is already known, then mounts the
 * overlay — in that order, like {@link renderVideoOverlay}. `renderOverlay`
 * mounts both at once, so the mount measure reads jsdom's default
 * `naturalWidth` of 0 and the overlay's `naturalSize` stays null — the state
 * where `Original` has no ratio yet and its button is disabled.
 * @param natural - The material's intrinsic pixel size.
 * @param onConfirm - Confirm spy.
 * @returns The render result plus the img element.
 */
function renderImageOverlayReady(
  natural: { width: number; height: number },
  onConfirm = vi.fn(() => true),
): ReturnType<typeof render> & { img: HTMLImageElement } {
  /**
   * @param withOverlay - Whether the crop overlay is mounted yet.
   * @returns The tree to render.
   */
  const tree = (withOverlay: boolean): React.ReactElement => (
    <ReactFlowProvider>
      <div className='react-flow__node' data-id='n1'>
        <img data-testid='image-node-img' src='https://cdn/original.png' alt='' />
      </div>
      <div data-testid='reference-pick-banner' tabIndex={-1} />
      {withOverlay ? (
        <FocusCropOverlay
          nodeId='n1'
          nodePosition={{ x: 0, y: 0 }}
          onConfirm={onConfirm}
          onBackToPick={vi.fn()}
        />
      ) : null}
    </ReactFlowProvider>
  );
  const result = render(tree(false));
  const img = screen.getByTestId('image-node-img') as HTMLImageElement;
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: natural.width });
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: natural.height });
  result.rerender(tree(true));
  return Object.assign(result, { img });
}

/**
 * The marquee's current geometry, rounded to whole display px.
 * @returns Width and height parsed off the rect's inline style.
 * @throws {Error} When no marquee is on screen.
 */
function rectSize(): { width: number; height: number; left: number; top: number } {
  const el = screen.getByTestId('focus-crop-rect');
  return {
    width: Math.round(parseFloat(el.style.width)),
    height: Math.round(parseFloat(el.style.height)),
    left: Math.round(parseFloat(el.style.left)),
    top: Math.round(parseFloat(el.style.top)),
  };
}

describe('FocusCropOverlay — the Original preset, and a click that draws (#1991)', () => {
  it('the row gains a leftmost item labelled with the literal Original (A6)', () => {
    renderImageOverlayReady({ width: 800, height: 600 });
    const original = screen.getByTestId('focus-ratio-original');
    expect(original.textContent).toBe('Original');
    // It sits ahead of the seven ratios
    const row = original.parentElement as HTMLElement;
    expect(row.firstElementChild).toBe(original);
  });

  it('neither guidance string tells the user to drag (A8)', () => {
    // The banner is on screen from the moment picking starts, before any ratio
    // row exists, so the copy can name neither the row nor a drag — a click on a
    // ratio now draws. Both strings are checked together: focusSourceChanged sits
    // on the clearing path this PR touched.
    const DRAG_WORDS = /drag|marquee|拖|框选|框選|ドラッグ|드래그/i;
    for (const [name, catalog] of Object.entries(CATALOGS)) {
      const panel = catalog.canvas?.generatePanel as Record<string, string>;
      expect(panel.selectFocusFromCanvas, `${name} 横幅`).not.toMatch(DRAG_WORDS);
      expect(panel.focusSourceChanged, `${name} 源变更提示`).not.toMatch(DRAG_WORDS);
      // Both must carry text; an empty string would pass the word check
      expect(panel.selectFocusFromCanvas.length).toBeGreaterThan(0);
      expect(panel.focusSourceChanged.length).toBeGreaterThan(0);
    }
  });

  it('the controls bar hugs its content instead of carrying a fixed width (A5)', () => {
    renderImageOverlayReady({ width: 800, height: 600 });
    const bar = screen.getByTestId('focus-crop-controls');
    expect(bar.className).not.toMatch(/\bw-\[\d+px\]/);
    expect(bar.className).toContain('w-max');
  });

  it('the label bypasses i18n: no catalog carries it as a string (A6)', () => {
    // Guards against someone routing the label through t() later, which would
    // put the eight buttons back on two different footings. What is pinned is
    // that the word comes from no catalog at all, whatever key it might use.
    /**
     * @param node - Any level of a catalog.
     * @returns Every string at or below it.
     */
    const values = (node: unknown): string[] =>
      typeof node === 'string'
        ? [node]
        : typeof node === 'object' && node !== null
          ? Object.values(node).flatMap(values)
          : [];
    const label = CROP_PRESETS.find((p) => p.key === 'original')!.label;
    for (const [name, catalog] of Object.entries(CATALOGS)) {
      expect(values(catalog), `${name} 里不该有 ${label} 这条文案`).not.toContain(label);
    }
  });

  it('a video source behaves the same: Original draws at the material aspect (A7)', () => {
    // A video box carries the material's aspect (w-full + intrinsic); 1600x900
    IMG_BOX.width = 400;
    IMG_BOX.height = 225;
    renderVideoOverlay({ duration: 10, currentTime: 0, videoWidth: 1600, videoHeight: 900 });
    fireEvent.click(screen.getByTestId('focus-ratio-original'));
    const r = rectSize();
    expect(r.width).toBe(400);
    expect(r.height).toBe(225);
  });

  it('a marquee dragged out under a lit preset carries that ratio throughout (A4)', () => {
    renderImageOverlayReady({ width: 800, height: 600 });
    fireEvent.click(screen.getByTestId('focus-ratio-1:1'));
    // Press and move without releasing: what is pinned is the marquee mid-drag
    const layer = screen.getByTestId('focus-crop-layer');
    fireEvent.pointerDown(layer, { clientX: 110, clientY: 100, button: 0, pointerId: 7 });
    fireEvent.pointerMove(layer, { clientX: 260, clientY: 180, pointerId: 7 });
    const mid = rectSize();
    expect(mid.width).toBe(mid.height);
    expect(mid.width).toBe(150); // 主导轴 150 宽
  });

  it('pulling a handle under a lit preset keeps that ratio (A4)', () => {
    renderImageOverlayReady({ width: 800, height: 600 });
    fireEvent.click(screen.getByTestId('focus-ratio-1:1'));
    const before = rectSize();
    const handle = screen.getByTestId('focus-crop-handle-se');
    fireEvent.pointerDown(handle, {
      clientX: 100 + before.left + before.width,
      clientY: 50 + before.top + before.height,
      button: 0,
      pointerId: 3,
    });
    fireEvent.pointerMove(screen.getByTestId('focus-crop-layer'), {
      clientX: 100 + before.left + before.width - 80,
      clientY: 50 + before.top + before.height - 20,
      pointerId: 3,
    });
    fireEvent.pointerUp(screen.getByTestId('focus-crop-layer'), { pointerId: 3 });
    const after = rectSize();
    expect(after.width).toBe(after.height);
    expect(after.width).toBeLessThan(before.width);
    expect(
      screen.getByTestId('focus-ratio-1:1').getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('Original is the material own aspect: a 5:2 source drags out 5:2 (A1)', () => {
    // The box follows at 5:2, as it renders (h-auto makes box aspect = material)
    IMG_BOX.width = 400;
    IMG_BOX.height = 160;
    renderImageOverlayReady({ width: 500, height: 200 });
    fireEvent.click(screen.getByTestId('focus-ratio-original'));
    // A marquee already exists (A2); dragging a smaller one stays locked at 2.5
    draw({ x: 150, y: 80 }, { x: 250, y: 200 });
    const r = rectSize();
    expect(r.width / r.height).toBeCloseTo(2.5, 2);
  });

  it('Original reads the intrinsic size, not the display box (A1)', () => {
    // Box 4:3 against a 5:2 material — deliberately unequal
    IMG_BOX.width = 400;
    IMG_BOX.height = 300;
    renderImageOverlayReady({ width: 500, height: 200 });
    fireEvent.click(screen.getByTestId('focus-ratio-original'));
    const r = rectSize();
    // Reading the intrinsic size gives 2.5; reading the box would give 1.333
    expect(r.width / r.height).toBeCloseTo(2.5, 2);
  });

  it('1:1 with no marquee: a marquee appears, Y filled and centred in X (A2)', () => {
    renderImageOverlayReady({ width: 800, height: 600 });
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
    fireEvent.click(screen.getByTestId('focus-ratio-1:1'));
    expect(rectSize()).toEqual({ width: 300, height: 300, left: 50, top: 0 });
  });

  it('9:16 with no marquee: Y filled, the other axis follows the ratio (A2)', () => {
    renderImageOverlayReady({ width: 800, height: 600 });
    fireEvent.click(screen.getByTestId('focus-ratio-9:16'));
    const r = rectSize();
    expect(r.height).toBe(300);
    expect(r.width).toBe(169); // 300 × 9/16 = 168.75
  });

  it('Original with no marquee fills both axes, its ratio being the material own (A2)', () => {
    renderImageOverlayReady({ width: 800, height: 600 });
    fireEvent.click(screen.getByTestId('focus-ratio-original'));
    expect(rectSize()).toEqual({ width: 400, height: 300, left: 0, top: 0 });
  });

  it('with a marquee in hand, a click reshapes around its centre (A3)', () => {
    renderImageOverlayReady({ width: 800, height: 600 });
    draw({ x: 160, y: 90 }, { x: 280, y: 180 }); // 120×90，中心在素材坐标 (120, 85)
    fireEvent.click(screen.getByTestId('focus-ratio-1:1'));
    // applyRatioPreset keeps the width and the centre: 120x120 centred at (120, 85)
    const r = rectSize();
    expect(r.width).toBe(120);
    expect(r.height).toBe(120);
    expect(r.left + r.width / 2).toBe(120);
    expect(r.top + r.height / 2).toBe(85);
  });

  it('a material whose aspect equals a preset still lights exactly one (A4.1)', () => {
    // A 4:3 material, equal to the value behind focus-ratio-4:3
    renderImageOverlayReady({ width: 800, height: 600 });
    fireEvent.click(screen.getByTestId('focus-ratio-original'));
    expect(
      screen.getByTestId('focus-ratio-original').getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.getByTestId('focus-ratio-4:3').getAttribute('aria-pressed'),
    ).toBe('false');
    // Clicking 4:3 the other way round moves the light to it
    fireEvent.click(screen.getByTestId('focus-ratio-4:3'));
    expect(
      screen.getByTestId('focus-ratio-4:3').getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.getByTestId('focus-ratio-original').getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('handles are round while a ratio is locked and square when free (A9)', () => {
    renderImageOverlayReady({ width: 800, height: 600 });
    draw({ x: 160, y: 90 }, { x: 280, y: 180 });
    // A hand-drawn marquee never locked a ratio, so the handles are square
    expect(screen.getByTestId('focus-crop-handle-se').className).not.toContain(
      'rounded-full',
    );
    fireEvent.click(screen.getByTestId('focus-ratio-1:1'));
    expect(screen.getByTestId('focus-crop-handle-se').className).toContain(
      'rounded-full',
    );
    // Un-lighting returns them to square
    fireEvent.click(screen.getByTestId('focus-ratio-1:1'));
    expect(screen.getByTestId('focus-crop-handle-se').className).not.toContain(
      'rounded-full',
    );
  });

  it('after un-lighting the marquee stays and drags to any shape (A4.2)', () => {
    renderImageOverlayReady({ width: 800, height: 600 });
    fireEvent.click(screen.getByTestId('focus-ratio-1:1'));
    fireEvent.click(screen.getByTestId('focus-ratio-1:1'));
    expect(screen.getByTestId('focus-crop-rect')).toBeInTheDocument();
    draw({ x: 150, y: 100 }, { x: 350, y: 150 });
    const r = rectSize();
    expect(r.width).toBe(200);
    expect(r.height).toBe(50);
  });
});

/**
 * The lit preset and the marquee are two pieces of state. With clearing
 * collapsed onto a single writer, the only failure mode left is a call site
 * that did not go through it — so each call site gets its own test.
 */
describe('FocusCropOverlay — lit implies a marquee (#1991 invariant)', () => {
  /**
   * Asserts the marquee is gone and that item is no longer lit.
   * @param testId - The preset button that was lit.
   */
  function expectClearedAndUnlit(testId: string): void {
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
    expect(screen.getByTestId(testId).getAttribute('aria-pressed')).toBe('false');
  }

  it('Esc strips the marquee and the lit item goes out with it', () => {
    renderImageOverlayReady({ width: 800, height: 600 });
    fireEvent.click(screen.getByTestId('focus-ratio-16:9'));
    expect(screen.getByTestId('focus-crop-rect')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expectClearedAndUnlit('focus-ratio-16:9');
  });

  it('a discarded degenerate gesture takes the lit item with it', () => {
    renderImageOverlayReady({ width: 800, height: 600 });
    fireEvent.click(screen.getByTestId('focus-ratio-9:16'));
    // 9:16 on 400x300 gives a centred 169x300 rect, leaving 116px of bare
    // capture layer on each side
    const layer = screen.getByTestId('focus-crop-layer');
    fireEvent.pointerDown(layer, { clientX: 110, clientY: 100, button: 0 });
    fireEvent.pointerUp(layer);
    expectClearedAndUnlit('focus-ratio-9:16');
  });

  it('content swapped under the marquee takes the lit item with it', () => {
    const { img } = renderImageOverlayReady({ width: 800, height: 600 });
    fireEvent.click(screen.getByTestId('focus-ratio-1:1'));
    act(() => {
      img.setAttribute('src', 'https://cdn/other.png');
      IMG_BOX.width = 400;
      IMG_BOX.height = 300;
      window.dispatchEvent(new Event('resize'));
    });
    expectClearedAndUnlit('focus-ratio-1:1');
  });

  it('a gesture culled mid-flight whose marquee fails the gauge leaves nothing lit', () => {
    const { img } = renderImageOverlayReady({ width: 800, height: 600 });
    fireEvent.click(screen.getByTestId('focus-ratio-1:1'));
    // Start a gesture without dragging it out: the marquee is degenerate at
    // this instant while 1:1 is lit
    const layer = screen.getByTestId('focus-crop-layer');
    fireEvent.pointerDown(layer, { clientX: 150, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 151, clientY: 101, pointerId: 1 });
    // Culled: the gesture dies mid-flight and the absent-source branch re-runs
    // the gauge, discarding the marquee when it fails
    img.remove();
    fireEvent(window, new Event('resize'));
    expect(screen.queryByTestId('focus-crop-layer')).toBeNull();
    // Back in view: the same src remounts and the interaction layer returns
    const node = document.querySelector('.react-flow__node[data-id="n1"]')!;
    const back = document.createElement('img');
    back.setAttribute('data-testid', 'image-node-img');
    back.setAttribute('src', 'https://cdn/original.png');
    Object.defineProperty(back, 'naturalWidth', { configurable: true, value: 800 });
    Object.defineProperty(back, 'naturalHeight', { configurable: true, value: 600 });
    node.appendChild(back);
    fireEvent(window, new Event('resize'));
    expectClearedAndUnlit('focus-ratio-1:1');
  });

  it('a source swap caught at confirm time clears the marquee and the light', () => {
    const { img } = renderImageOverlayReady({ width: 800, height: 600 });
    fireEvent.click(screen.getByTestId('focus-ratio-1:1'));
    // Change src without triggering a re-measure, so confirm meets a baseline
    // that no longer matches
    img.setAttribute('src', 'https://cdn/swapped.png');
    fireEvent.click(screen.getByTestId('focus-crop-confirm'));
    expectClearedAndUnlit('focus-ratio-1:1');
  });

  it('the source remounted as a different element with different content clears both', () => {
    const { img } = renderImageOverlayReady({ width: 800, height: 600 });
    fireEvent.click(screen.getByTestId('focus-ratio-1:1'));
    const node = document.querySelector('.react-flow__node[data-id="n1"]')!;
    act(() => {
      img.remove();
      const fresh = document.createElement('img');
      fresh.setAttribute('data-testid', 'image-node-img');
      fresh.setAttribute('src', 'https://cdn/regenerated.png');
      Object.defineProperty(fresh, 'naturalWidth', { configurable: true, value: 800 });
      Object.defineProperty(fresh, 'naturalHeight', { configurable: true, value: 600 });
      node.appendChild(fresh);
      window.dispatchEvent(new Event('resize'));
    });
    expectClearedAndUnlit('focus-ratio-1:1');
  });

  it('Cancel takes the marquee and the lit item together', () => {
    renderImageOverlayReady({ width: 800, height: 600 });
    fireEvent.click(screen.getByTestId('focus-ratio-16:9'));
    expect(screen.getByTestId('focus-crop-rect')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('focus-crop-cancel'));
    expectClearedAndUnlit('focus-ratio-16:9');
  });

  it('switching the crop target clears the marquee and the light', () => {
    /**
     * @param nodeId - The current crop target.
     * @returns Both nodes on the canvas, the overlay mounted on one of them.
     */
    const tree = (nodeId: string): React.ReactElement => (
      <ReactFlowProvider>
        <div className='react-flow__node' data-id='n1'>
          <img data-testid='image-node-img' src='https://cdn/a.png' alt='' />
        </div>
        <div className='react-flow__node' data-id='n2'>
          <img data-testid='image-node-img' src='https://cdn/b.png' alt='' />
        </div>
        <div data-testid='reference-pick-banner' tabIndex={-1} />
        <FocusCropOverlay
          nodeId={nodeId}
          nodePosition={{ x: 0, y: 0 }}
          onConfirm={vi.fn(() => true)}
          onBackToPick={vi.fn()}
        />
      </ReactFlowProvider>
    );
    const { rerender } = render(tree('n1'));
    for (const img of screen.getAllByTestId('image-node-img')) {
      Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 800 });
      Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 600 });
    }
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    fireEvent.click(screen.getByTestId('focus-ratio-4:3'));
    expect(screen.getByTestId('focus-crop-rect')).toBeInTheDocument();
    rerender(tree('n2'));
    expectClearedAndUnlit('focus-ratio-4:3');
  });
});

/**
 * An item is available exactly when clicking it right now would produce a
 * usable marquee (user 2026-08-22).
 *
 * The reasons it would not are known at render time: the ratio is unknown
 * (`Original` on a source that has not reported its own size), or the material
 * is too small for the shape this ratio produces. Both are real `disabled`:
 * the item does not respond to a click and says nothing.
 */
describe('FocusCropOverlay — an item that cannot draw is disabled (#1991)', () => {
  it('before the source reports its size, only Original is disabled', () => {
    // renderOverlay mounts both at once, so the mount measure reads jsdom's
    // default naturalWidth of 0
    renderOverlay();
    expect(screen.getByTestId('focus-ratio-original')).toBeDisabled();
    expect(screen.getByTestId('focus-ratio-16:9')).toBeEnabled();
    expect(screen.getByTestId('focus-ratio-1:1')).toBeEnabled();
  });

  it('a ratio the material is too small to hold is disabled; the others are not', () => {
    // A 400x10 material: 9:16 shapes to 5.6 natural px wide, under the gauge
    IMG_BOX.width = 400;
    IMG_BOX.height = 10;
    renderImageOverlayReady({ width: 400, height: 10 });
    expect(screen.getByTestId('focus-ratio-9:16')).toBeDisabled();
    expect(screen.getByTestId('focus-ratio-16:9')).toBeEnabled();
    expect(screen.getByTestId('focus-ratio-original')).toBeEnabled();
  });

  it('a disabled item does nothing on click: no marquee, no light, no message', () => {
    const warned = vi.spyOn(toast, 'warning');
    const errored = vi.spyOn(toast, 'error');
    renderOverlay();
    fireEvent.click(screen.getByTestId('focus-ratio-original'));
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
    expect(
      screen.getByTestId('focus-ratio-original').getAttribute('aria-pressed'),
    ).toBe('false');
    expect(warned).not.toHaveBeenCalled();
    expect(errored).not.toHaveBeenCalled();
  });

  it('a disabled item drops the hover response the others carry', () => {
    // `Button`'s base deliberately omits `disabled:pointer-events-none`, so a
    // disabled one still receives hover and would light up like a live item
    // unless the class is withheld.
    renderOverlay();
    expect(
      screen.getByTestId('focus-ratio-original').className,
    ).not.toContain('hover:bg-accent');
    expect(screen.getByTestId('focus-ratio-16:9').className).toContain('hover:bg-accent');
  });

  it('Original becomes available once the size arrives', () => {
    renderOverlay();
    const img = screen.getByTestId('image-node-img');
    act(() => {
      Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 800 });
      Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 600 });
      window.dispatchEvent(new Event('resize'));
    });
    const original = screen.getByTestId('focus-ratio-original');
    expect(original).toBeEnabled();
    fireEvent.click(original);
    expect(screen.getByTestId('focus-crop-rect')).toBeInTheDocument();
  });
});
