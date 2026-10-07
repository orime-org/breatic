// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The focus crop (#1782, videos #1987, presets #1991): the marquee drawn
 * inside the picked node and the controls bar under it (inner#888 §7.4.1),
 * on a real canvas whose media layout is stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import * as React from 'react';

import { FocusCropControls } from '@web/spaces/canvas/focus/FocusCropControls';
import { CROP_PRESETS } from '@web/lib/crop-math';
import { toast } from '@web/lib/toast';
import { canvasSessions } from '@web/stores/canvas-session';
import { useUIStore } from '@web/stores/ui';
import {
  IMG_BOX,
  LAYOUT,
  cropCanvas,
  draw,
  installLayout,
  rectSize,
  relayout,
  type MediaNodeData,
} from '@web/spaces/canvas/crop/__tests__/crop-harness';
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

type CropNode = { id: string } & MediaNodeData;

const IMAGE: CropNode = { id: 'n1', kind: 'img', src: 'https://cdn/original.png' };
const VIDEO: CropNode = { id: 'n1', kind: 'video', src: 'https://cdn/clip.mp4' };

beforeEach(() => {
  installLayout();
  canvasSessions.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useUIStore.getState().setActiveRegion('space');
});

/**
 * The canvas with its nodes and the focus controls.
 * @param nodes - The media nodes.
 * @param onConfirm - Confirm spy.
 * @param onBackToPick - Back-to-pick spy (the controls' only way out).
 * @param opts - Zoom and whether the Space is shown.
 * @param opts.zoom - The canvas zoom.
 * @param opts.mode - Whether the Space is shown.
 * @returns The tree.
 */
function focusTree(
  nodes: readonly CropNode[],
  onConfirm: () => boolean,
  onBackToPick: () => void,
  opts: { zoom?: number; mode?: 'visible' | 'hidden' } = {},
): React.JSX.Element {
  return (
    <React.Activity mode={opts.mode ?? 'visible'}>
      {cropCanvas(nodes, <FocusCropControls onConfirm={onConfirm} onBackToPick={onBackToPick} />, opts.zoom)}
    </React.Activity>
  );
}

/**
 * Pick a node as the crop target, as a click on it in a focus pick does.
 * @param node - The node.
 */
function pick(node: CropNode): void {
  act(() => {
    const store = canvasSessions.of('').getState();
    if (store.pickSession?.purpose !== 'focus') store.startFocusPick('host');
    store.setFocusTarget({ nodeId: node.id, content: node.src });
  });
}

/**
 * Renders the canvas and picks its first node.
 * @param onConfirm - Confirm spy.
 * @param onBackToPick - Back-to-pick spy.
 * @param nodes - The nodes; an image by default.
 * @returns Testing-library render result.
 */
function renderOverlay(
  onConfirm = vi.fn(() => true),
  onBackToPick = vi.fn(),
  nodes: readonly CropNode[] = [IMAGE],
): ReturnType<typeof render> {
  const view = render(focusTree(nodes, onConfirm, onBackToPick));
  pick(nodes[0]!);
  return view;
}

/**
 * Give an element its intrinsic size, which jsdom leaves at 0.
 * @param el - The image.
 * @param width - Natural width.
 * @param height - Natural height.
 */
function natural(el: HTMLElement, width: number, height: number): void {
  Object.defineProperty(el, 'naturalWidth', { configurable: true, value: width });
  Object.defineProperty(el, 'naturalHeight', { configurable: true, value: height });
}

describe('FocusCropControls', () => {
  it('lays the capture layer over the picture inside the node', () => {
    renderOverlay();
    const layer = screen.getByTestId('focus-crop-layer');
    expect(layer.closest('.react-flow__node')?.getAttribute('data-id')).toBe('n1');
    expect(layer.style.left).toBe('0px');
    expect(layer.style.top).toBe('0px');
    expect(layer.style.width).toBe('400px');
    expect(layer.style.height).toBe('300px');
  });

  // A Space switched away from is hidden and shown again, which runs the
  // effects once more (inner#1235 C8). The target did not change, so the
  // marquee the reader drew is still theirs.
  it('keeps a drawn marquee across a hide and a show', () => {
    const confirm = vi.fn(() => true);
    const back = vi.fn();
    const view = render(focusTree([IMAGE], confirm, back));
    pick(IMAGE);
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });

    act(() => view.rerender(focusTree([IMAGE], confirm, back, { mode: 'hidden' })));
    act(() => view.rerender(focusTree([IMAGE], confirm, back, { mode: 'visible' })));

    const rect = screen.getByTestId('focus-crop-rect');
    expect(rect.style.left).toBe('50px');
    expect(rect.style.width).toBe('100px');
  });

  it('draws a marquee in the picture own coordinates', () => {
    renderOverlay();
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    const rect = screen.getByTestId('focus-crop-rect');
    expect(rect.style.left).toBe('50px');
    expect(rect.style.top).toBe('50px');
    expect(rect.style.width).toBe('100px');
    expect(rect.style.height).toBe('80px');
    expect(screen.getByTestId('focus-crop-handle-se')).toBeInTheDocument();
  });

  // The canvas is zoomed: the picture is 800×600 on screen and 400×300 in the
  // node. The marquee lives in the node's pixels, so a pan or zoom moves it
  // with the picture and never needs recomputing.
  it('reads the pointer into the node own pixels at any zoom', () => {
    IMG_BOX.width = 800;
    IMG_BOX.height = 600;
    LAYOUT.width = 400;
    LAYOUT.height = 300;
    render(focusTree([IMAGE], vi.fn(() => true), vi.fn(), { zoom: 2 }));
    pick(IMAGE);
    draw({ x: 200, y: 150 }, { x: 400, y: 310 });
    expect(rectSize()).toEqual({ left: 50, top: 50, width: 100, height: 80 });
  });

  // The handles are what the reader drags, so they hold their screen size at
  // every zoom (user 2026-10-07).
  it('keeps the handles at their screen size at every zoom', () => {
    for (const zoom of [0.1, 0.25, 1, 4]) {
      render(focusTree([IMAGE], vi.fn(() => true), vi.fn(), { zoom }));
      pick(IMAGE);
      draw({ x: 150, y: 100 }, { x: 250, y: 180 });
      const scale = Number(screen.getByTestId('focus-crop-handle-se').style.scale);
      expect(scale * zoom).toBeCloseTo(1, 10);
      cleanup();
      canvasSessions.clear();
    }
  });

  it('a lit preset constrains a freshly drawn marquee; re-click unlights it', () => {
    renderOverlay();
    fireEvent.click(screen.getByTestId('focus-ratio-1:1'));
    // The click draws a 300×300 marquee at x 50..350 (#1991), so the press
    // starts on the bare strip at screen x 100..150 or it would be a move.
    draw({ x: 110, y: 100 }, { x: 310, y: 250 });
    const rect = screen.getByTestId('focus-crop-rect');
    expect(rect.style.width).toBe('200px');
    expect(rect.style.height).toBe('200px');
    expect(screen.getByTestId('focus-ratio-1:1').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('focus-ratio-1:1'));
    expect(screen.getByTestId('focus-ratio-1:1').getAttribute('aria-pressed')).toBe('false');
  });

  it('confirm maps the marquee to natural pixels and clears it', () => {
    const onConfirm = vi.fn(() => true);
    renderOverlay(onConfirm);
    natural(screen.getByTestId('image-node-img'), 800, 600);
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    fireEvent.click(screen.getByTestId('focus-crop-confirm'));
    // Exact object, deliberately (#1987 §7.2): the confirm-to-export chain
    // drops fields silently. An image target carries no time point.
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
    expect((screen.getByTestId('focus-crop-confirm') as HTMLButtonElement).disabled).toBe(true);
    draw({ x: 150, y: 100 }, { x: 153, y: 103 });
    expect((screen.getByTestId('focus-crop-confirm') as HTMLButtonElement).disabled).toBe(true);
  });

  it('an ACCEPTED confirm returns to the PICK state exactly like cancel (user 2026-07-20)', () => {
    const onConfirm = vi.fn(() => true);
    const onBackToPick = vi.fn();
    renderOverlay(onConfirm, onBackToPick);
    natural(screen.getByTestId('image-node-img'), 800, 600);
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    fireEvent.click(screen.getByTestId('focus-crop-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onBackToPick).toHaveBeenCalledTimes(1);
  });

  it('an accepted confirm hands DOM focus to the pick banner, not <body> (#1807)', () => {
    renderOverlay(vi.fn(() => true));
    natural(screen.getByTestId('image-node-img'), 800, 600);
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    const confirmBtn = screen.getByTestId('focus-crop-confirm');
    confirmBtn.focus();
    expect(document.activeElement).toBe(confirmBtn);
    fireEvent.click(confirmBtn);
    expect(document.activeElement).toBe(screen.getByTestId('reference-pick-banner'));
  });

  it('a REJECTED confirm (gate refusal) keeps the marquee and stays in the crop state', () => {
    const onConfirm = vi.fn(() => false);
    const onBackToPick = vi.fn();
    renderOverlay(onConfirm, onBackToPick);
    natural(screen.getByTestId('image-node-img'), 800, 600);
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    fireEvent.click(screen.getByTestId('focus-crop-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onBackToPick).not.toHaveBeenCalled();
    expect(screen.getByTestId('focus-crop-rect')).toBeInTheDocument();
  });

  it('cancel clears the marquee and returns to the PICK state (user 2026-07-17, decision A)', () => {
    const onBackToPick = vi.fn();
    renderOverlay(vi.fn(), onBackToPick);
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    fireEvent.click(screen.getByTestId('focus-crop-cancel'));
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
    expect(onBackToPick).toHaveBeenCalledTimes(1);
  });

  it('Esc peels: marquee first, then back to the pick state (user 2026-07-17)', () => {
    const onBackToPick = vi.fn();
    renderOverlay(vi.fn(), onBackToPick);
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
    expect(onBackToPick).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onBackToPick).toHaveBeenCalledTimes(1);
  });

  // After a drag the keyboard focus sits on the node, outside the bar; the
  // keys still reach the crop because it listens on the window.
  it('Esc reaches the crop with focus on the node after a drag', () => {
    const onBackToPick = vi.fn();
    renderOverlay(vi.fn(), onBackToPick);
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    const node = screen.getByTestId('focus-crop-layer').closest('.react-flow__node') as HTMLElement;
    node.focus();
    fireEvent.keyDown(node, { key: 'Escape' });
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
  });

  it('Esc yields by OWNERSHIP: prevented events and overlay content (round-6)', () => {
    const onBackToPick = vi.fn();
    const { container } = renderOverlay(vi.fn(), onBackToPick);
    const prevented = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
    prevented.preventDefault();
    window.dispatchEvent(prevented);
    expect(onBackToPick).not.toHaveBeenCalled();
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    const item = document.createElement('button');
    menu.appendChild(item);
    container.appendChild(menu);
    item.focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onBackToPick).not.toHaveBeenCalled();
    menu.remove();
    const editor = document.createElement('div');
    editor.className = 'ProseMirror';
    editor.tabIndex = 0;
    container.appendChild(editor);
    editor.focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onBackToPick).not.toHaveBeenCalled();
    editor.remove();
    screen.getByTestId('reference-pick-banner').focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onBackToPick).toHaveBeenCalledTimes(1);
  });

  it('an Esc consumed while a tooltip is open stays consumed — layered peel (r2)', () => {
    const onBackToPick = vi.fn();
    renderOverlay(vi.fn(), onBackToPick);
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    const tip = document.createElement('div');
    tip.setAttribute('role', 'tooltip');
    document.body.appendChild(tip);
    try {
      const prevented = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
      prevented.preventDefault();
      fireEvent(window, prevented);
      expect(screen.queryByTestId('focus-crop-rect')).not.toBeNull();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
      expect(onBackToPick).not.toHaveBeenCalled();
    } finally {
      tip.remove();
    }
  });

  it('Escape leaves the session alone while the agent region is active', () => {
    const onBackToPick = vi.fn();
    renderOverlay(vi.fn(), onBackToPick);
    useUIStore.getState().setActiveRegion('agent');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onBackToPick).not.toHaveBeenCalled();
  });

  it('Escape peels the marquee with the caret in a field inside the space', () => {
    const onBackToPick = vi.fn();
    const { container } = renderOverlay(vi.fn(), onBackToPick);
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    const prompt = document.createElement('div');
    Object.defineProperty(prompt, 'isContentEditable', { value: true });
    prompt.tabIndex = 0;
    (container.querySelector('[data-region=space]') as HTMLElement).append(prompt);
    prompt.focus();
    try {
      fireEvent.keyDown(prompt, { key: 'Escape' });
      expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
      expect(onBackToPick).not.toHaveBeenCalled();
    } finally {
      prompt.remove();
    }
  });

  it('Escape yields to focus inside an open alertdialog (r2)', () => {
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

  it('the focus hand-off never steals focus from a surface outside the crop (r2)', () => {
    const onBackToPick = vi.fn();
    const { container } = renderOverlay(vi.fn(), onBackToPick);
    const elsewhere = document.createElement('button');
    (container.querySelector('[data-region=space]') as HTMLElement).append(elsewhere);
    elsewhere.focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onBackToPick).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('Cancel / Esc back-to-pick hand keyboard focus to the pick banner', () => {
    renderOverlay();
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    const cancel = screen.getByTestId('focus-crop-cancel');
    cancel.focus();
    fireEvent.click(cancel);
    expect(document.activeElement?.getAttribute('data-testid')).toBe('reference-pick-banner');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.activeElement?.getAttribute('data-testid')).toBe('reference-pick-banner');
  });

  it('follows the box when the shown picture changes size', async () => {
    renderOverlay();
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    IMG_BOX.width = 800;
    IMG_BOX.height = 600;
    await relayout();
    expect(rectSize()).toEqual({ left: 100, top: 100, width: 200, height: 160 });
  });

  it('a box that dips to the video placeholder height and back restores a locked ratio exactly', async () => {
    renderOverlay();
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    fireEvent.click(screen.getByTestId('focus-ratio-1:1'));
    /**
     * @returns The marquee's inline geometry.
     */
    const read = (): string[] => {
      const s = screen.getByTestId('focus-crop-rect').style;
      return [s.left, s.top, s.width, s.height];
    };
    const before = read();
    // A remounted <video> reports the placeholder height until its metadata
    // arrives, while `w-full` keeps the width.
    IMG_BOX.height = 150;
    await relayout();
    expect(parseFloat(read()[3]!)).toBeCloseTo(parseFloat(before[3]!) / 2);
    IMG_BOX.height = 300;
    await relayout();
    expect(read()).toEqual(before);
    expect(screen.getByTestId('focus-ratio-1:1').getAttribute('aria-pressed')).toBe('true');
  });

  it('Esc mid-drag cancels the gesture — the next pointermove does not resurrect the rect (R2)', () => {
    const onBackToPick = vi.fn();
    renderOverlay(vi.fn(), onBackToPick);
    const layer = screen.getByTestId('focus-crop-layer');
    fireEvent.pointerDown(layer, { clientX: 150, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 250, clientY: 180, pointerId: 1 });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
    expect(onBackToPick).not.toHaveBeenCalled();
    fireEvent.pointerMove(layer, { clientX: 300, clientY: 220, pointerId: 1 });
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
  });

  it('a bare click leaves no marquee — a degenerate draw is discarded on release (R2)', () => {
    renderOverlay();
    const layer = screen.getByTestId('focus-crop-layer');
    fireEvent.pointerDown(layer, { clientX: 150, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerUp(layer, { pointerId: 1 });
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
  });

  it('confirm discards the marquee when the src changed since it was picked (R2)', () => {
    const onConfirm = vi.fn();
    renderOverlay(onConfirm);
    const img = screen.getByTestId('image-node-img');
    natural(img, 800, 600);
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    img.setAttribute('src', 'https://cdn/regenerated.png');
    fireEvent.click(screen.getByTestId('focus-crop-confirm'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
  });

  it('a REJECTED confirm keeps the marquee (pool full is fixable — round-3)', () => {
    const onConfirm = vi.fn(() => false);
    renderOverlay(onConfirm);
    natural(screen.getByTestId('image-node-img'), 800, 600);
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    fireEvent.click(screen.getByTestId('focus-crop-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('focus-crop-rect')).toBeInTheDocument();
  });

  it('a resize collapsed onto its anchor is discarded on release (round-3)', () => {
    renderOverlay();
    const layer = screen.getByTestId('focus-crop-layer');
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    const handle = screen.getByTestId('focus-crop-handle-se');
    fireEvent.pointerDown(handle, { clientX: 250, clientY: 180, button: 0, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 152, clientY: 102, pointerId: 1 });
    fireEvent.pointerUp(layer, { pointerId: 1 });
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
  });

  it('the picture vanishing (handling, culling) takes the crop box and the bar with it', async () => {
    renderOverlay();
    const layer = screen.getByTestId('focus-crop-layer');
    fireEvent.pointerDown(layer, { clientX: 150, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 250, clientY: 180, pointerId: 1 });
    screen.getByTestId('image-node-img').remove();
    await relayout();
    expect(screen.queryByTestId('focus-crop-layer')).toBeNull();
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
    expect(screen.queryByTestId('focus-crop-controls')).toBeNull();
  });

  // The box sits inside the node, so the canvas's own wheel handling zooms
  // over it; it only has to keep a press on it from dragging the node or
  // panning the canvas.
  it('the crop box keeps node drags and pans off itself and leaves the wheel to the canvas', () => {
    renderOverlay();
    const layer = screen.getByTestId('focus-crop-layer');
    expect(layer.className).toContain('nodrag');
    expect(layer.className).toContain('nopan');
    const reached: Event[] = [];
    const listen = (e: Event): void => {
      reached.push(e);
    };
    const node = layer.closest('.react-flow__node') as HTMLElement;
    node.addEventListener('wheel', listen);
    layer.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120 }));
    expect(reached).toHaveLength(1);
  });

  it('an accepted confirm kills a second pointer in-flight gesture (round-11)', () => {
    const onBackToPick = vi.fn();
    renderOverlay(vi.fn(() => true), onBackToPick);
    natural(screen.getByTestId('image-node-img'), 800, 600);
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    const layer = screen.getByTestId('focus-crop-layer');
    fireEvent.pointerDown(screen.getByTestId('focus-crop-rect'), { pointerId: 2, clientX: 200, clientY: 140 });
    fireEvent.click(screen.getByTestId('focus-crop-confirm'));
    expect(onBackToPick).toHaveBeenCalledTimes(1);
    fireEvent.pointerMove(layer, { pointerId: 2, clientX: 260, clientY: 190 });
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
  });

  it('a click on a small but natural-valid marquee does not wipe it (round-9)', async () => {
    renderOverlay();
    // A 6×6 rect on an 8000×6000 material selects about 120 natural px.
    natural(screen.getByTestId('image-node-img'), 8000, 6000);
    await relayout();
    draw({ x: 150, y: 100 }, { x: 156, y: 106 });
    const rect = screen.getByTestId('focus-crop-rect');
    fireEvent.pointerDown(rect, { clientX: 153, clientY: 103, button: 0, pointerId: 1 });
    fireEvent.pointerUp(screen.getByTestId('focus-crop-layer'), { pointerId: 1 });
    expect(screen.getByTestId('focus-crop-rect')).toBeInTheDocument();
    expect((screen.getByTestId('focus-crop-confirm') as HTMLButtonElement).disabled).toBe(false);
  });

  it('Esc while the target is off screen returns to the pick state instead of eating the kept marquee (round-9)', async () => {
    const onBackToPick = vi.fn();
    renderOverlay(vi.fn(() => true), onBackToPick);
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    screen.getByTestId('image-node-img').remove();
    await relayout();
    expect(screen.queryByTestId('focus-crop-layer')).toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onBackToPick).toHaveBeenCalledTimes(1);
  });

  it('a ratio preset keeps a small but natural-valid marquee (round-10)', async () => {
    renderOverlay();
    natural(screen.getByTestId('image-node-img'), 8000, 6000);
    await relayout();
    draw({ x: 150, y: 100 }, { x: 156, y: 106 });
    fireEvent.click(screen.getByTestId('focus-ratio-16:9'));
    expect(screen.getByTestId('focus-crop-rect')).toBeInTheDocument();
  });

  it('a held (auto-repeat) Esc does not collapse both stages (round-10)', () => {
    const onBackToPick = vi.fn();
    renderOverlay(vi.fn(() => true), onBackToPick);
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    fireEvent.keyDown(window, { key: 'Escape' });
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
    fireEvent.pointerDown(screen.getByTestId('focus-crop-handle-se'), {
      clientX: 250,
      clientY: 180,
      button: 0,
      pointerId: 5,
    });
    fireEvent.click(screen.getByTestId('focus-crop-cancel'));
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
    fireEvent.pointerMove(layer, { clientX: 300, clientY: 220, pointerId: 5 });
    expect(screen.queryByTestId('focus-crop-rect')).toBeNull();
  });

  it('an IME composition-cancel Escape never clears the marquee (round-11)', () => {
    const onBackToPick = vi.fn();
    renderOverlay(vi.fn(() => true), onBackToPick);
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    const composing = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    Object.defineProperty(composing, 'isComposing', { value: true });
    window.dispatchEvent(composing);
    expect(screen.getByTestId('focus-crop-rect')).toBeInTheDocument();
    expect(onBackToPick).not.toHaveBeenCalled();
  });

  it('a lazy-load remount whose first box is zero keeps the marquee (round-12)', async () => {
    renderOverlay();
    const img = screen.getByTestId('image-node-img');
    natural(img, 800, 600);
    await relayout();
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    const wrapper = img.parentElement!;
    img.remove();
    await relayout();
    expect(screen.queryByTestId('focus-crop-layer')).toBeNull();
    // Back in view: the picture remounts and its first box is zero until it decodes.
    const back = document.createElement('img');
    back.setAttribute('data-testid', 'image-node-img');
    back.setAttribute('src', 'https://cdn/original.png');
    wrapper.prepend(back);
    IMG_BOX.width = 0;
    IMG_BOX.height = 0;
    await relayout();
    IMG_BOX.width = 400;
    IMG_BOX.height = 300;
    natural(back, 800, 600);
    await relayout();
    expect(rectSize()).toEqual({ left: 50, top: 50, width: 100, height: 80 });
    expect((screen.getByTestId('focus-crop-confirm') as HTMLButtonElement).disabled).toBe(false);
  });

  // The bar follows the picked node like the generate panel does (user
  // 2026-07-17), as the node's own toolbar under it.
  it('the controls bar hangs under the picked node as its toolbar', () => {
    renderOverlay();
    const bar = screen.getByTestId('focus-crop-controls');
    expect(bar.closest('.react-flow__node-toolbar')?.getAttribute('data-id')).toBe('n1');
  });

  it('controls bar: 6px outer radius; every button no-wrap + no-shrink (user 2026-07-17)', () => {
    renderOverlay();
    const bar = screen.getByTestId('focus-crop-controls');
    expect(bar.className).toContain('rounded-overlay');
    expect(bar.className).not.toContain('rounded-md');
    for (const id of ['focus-ratio-16:9', 'focus-crop-cancel', 'focus-crop-confirm']) {
      const el = screen.getByTestId(id);
      expect(el.className).toContain('whitespace-nowrap');
      expect(el.className).toContain('shrink-0');
    }
  });

  it('a second pointer cannot hijack or end the active interaction', () => {
    renderOverlay();
    const layer = screen.getByTestId('focus-crop-layer');
    fireEvent.pointerDown(layer, { clientX: 150, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerDown(layer, { clientX: 400, clientY: 300, button: 0, pointerId: 2 });
    fireEvent.pointerUp(layer, { pointerId: 2 });
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

/** What a stubbed <video> records, per element. */
interface VideoStub {
  /** Every value written to `currentTime`, in order. */
  writes: number[];
  /** This element's own `pause()`. */
  pause: ReturnType<typeof vi.fn>;
  /** This element's own `play()`. */
  play: ReturnType<typeof vi.fn>;
}

/**
 * Gives a jsdom <video> the media properties the crop reads, per element.
 * @param el - The element to stub.
 * @param opts - The media state to expose.
 * @param opts.duration - Total length in seconds; omitted means NaN.
 * @param opts.currentTime - Where the video is parked.
 * @param opts.videoWidth - Intrinsic width; 0 means metadata has not arrived.
 * @param opts.videoHeight - Intrinsic height.
 * @param opts.paused - Whether it is parked rather than playing.
 * @param opts.quantize - Round a written `currentTime` as a browser does.
 * @param opts.announceSeeked - Fire `seeked` after each write, later, as a browser does.
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
  Object.defineProperty(el, 'duration', { configurable: true, get: () => opts.duration ?? NaN });
  Object.defineProperty(el, 'currentTime', {
    configurable: true,
    get: () => time,
    set: (value: number) => {
      time = opts.quantize ? Math.floor(value * 1e6) / 1e6 : value;
      writes.push(value);
      if (opts.announceSeeked) setTimeout(() => el.dispatchEvent(new Event('seeked')), 0);
    },
  });
  Object.defineProperty(el, 'videoWidth', { configurable: true, get: () => opts.videoWidth ?? 0 });
  Object.defineProperty(el, 'videoHeight', { configurable: true, get: () => opts.videoHeight ?? 0 });
  Object.defineProperty(el, 'paused', { configurable: true, get: () => opts.paused ?? true });
  const pause = vi.fn();
  const play = vi.fn();
  Object.defineProperty(el, 'pause', { configurable: true, value: pause });
  Object.defineProperty(el, 'play', { configurable: true, value: play });
  return { writes, pause, play };
}

/**
 * Renders a VIDEO node and then picks it — in that order, deliberately: the
 * node's <video> has long since fired `loadedmetadata` by the time a user
 * picks it, so a crop that only subscribes shows no handle.
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
  const result = render(focusTree([VIDEO], onConfirm, onBackToPick));
  const video = screen.getByTestId('media-element') as HTMLVideoElement;
  const stub = stubVideo(video, opts);
  pick(VIDEO);
  return Object.assign(result, { video, stub });
}

describe('FocusCropControls: a video target and its timeline (#1987)', () => {
  it('metadata not yet arrived at confirm (videoWidth 0): says so, keeps the marquee (A7a)', () => {
    const onConfirm = vi.fn(() => true);
    renderVideoOverlay({ duration: 10, currentTime: 0, videoWidth: 0 }, onConfirm);
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    const said = vi.spyOn(toast, 'error');
    fireEvent.click(screen.getByTestId('focus-crop-confirm'));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(said).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('focus-crop-rect')).toBeInTheDocument();
  });

  it('confirm hands over the time the element is parked on (A9)', () => {
    const onConfirm = vi.fn(() => true);
    const { video } = renderVideoOverlay(
      { duration: 10, currentTime: 4.375, videoWidth: 800, videoHeight: 600 },
      onConfirm,
    );
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    fireEvent.click(screen.getByTestId('focus-crop-confirm'));
    expect(onConfirm).toHaveBeenCalledWith({
      crop: { x: 100, y: 100, width: 200, height: 160 },
      natural: { width: 800, height: 600 },
      sourceSrc: 'https://cdn/clip.mp4',
      sourceTimeSeconds: video.currentTime,
    });
  });

  it('the timeline row exists for a video target only (A8)', () => {
    renderOverlay();
    expect(screen.queryByTestId('focus-crop-timeline')).toBeNull();
    cleanup();
    canvasSessions.clear();
    renderVideoOverlay({ duration: 10, currentTime: 0, videoWidth: 800, videoHeight: 600 });
    expect(screen.getByTestId('focus-crop-timeline')).toBeInTheDocument();
  });

  it('an element ready before the pick shows the handle where it is parked (A8, seeded)', () => {
    renderVideoOverlay({ duration: 10, currentTime: 4, videoWidth: 800, videoHeight: 600 });
    const thumb = screen.getByRole('slider');
    expect(thumb.getAttribute('aria-valuenow')).toBe('4');
    expect(thumb.getAttribute('aria-valuemax')).toBe('10');
  });

  it('dragging the handle writes the element currentTime (A8)', () => {
    const { stub, video } = renderVideoOverlay({ duration: 10, currentTime: 0, videoWidth: 800, videoHeight: 600 });
    const track = screen.getByRole('slider').parentElement!;
    // The stubbed rect makes the track 0..1000 wide: half way is 5s.
    fireEvent.pointerDown(track, { clientX: 500, clientY: 0, button: 0, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 500, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(track, { pointerId: 1 });
    expect(stub.writes.length).toBeGreaterThan(0);
    expect(video.currentTime).toBeCloseTo(5, 1);
  });

  it('one arrow press steps 1/24 s — one frame, not a whole second (A8)', () => {
    const { video } = renderVideoOverlay({ duration: 10, currentTime: 0, videoWidth: 800, videoHeight: 600 });
    const thumb = screen.getByRole('slider');
    thumb.focus();
    fireEvent.keyDown(thumb, { key: 'ArrowRight' });
    expect(video.currentTime).toBeCloseTo(STEP_SECONDS, 5);
  });

  it('held arrow presses keep advancing although the element reads back off the grid (A8/A9)', async () => {
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
    expect(new Set(stub.writes).size).toBe(stub.writes.length);
  });

  it('a duration that is not a finite positive number: no Slider, --:-- at both ends (A8)', () => {
    renderVideoOverlay({ currentTime: 0, videoWidth: 800, videoHeight: 600 });
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.getByTestId('focus-crop-timeline')).toBeInTheDocument();
    expect(screen.getByTestId('focus-crop-time-current')).toHaveTextContent('--:--');
    expect(screen.getByTestId('focus-crop-time-duration')).toHaveTextContent('--:--');
  });

  it('late metadata: the handle appears after loadedmetadata and the placeholder gives way (A8)', () => {
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

  it('with a known duration the current time reads to the hundredth (A8)', () => {
    renderVideoOverlay({ duration: 10, currentTime: 2.5, videoWidth: 800, videoHeight: 600 });
    expect(screen.getByTestId('focus-crop-time-current')).toHaveTextContent('0:02.50');
    expect(screen.getByTestId('focus-crop-time-duration')).toHaveTextContent('0:10');
    expect(screen.queryByTestId('focus-crop-timeline-placeholder')).toBeNull();
  });

  it('with an unknown duration the track is faded (A8)', () => {
    renderVideoOverlay({ currentTime: 0, videoWidth: 800, videoHeight: 600 });
    expect(screen.getByTestId('focus-crop-timeline-placeholder').className).toContain('opacity-50');
  });

  it('after the element is replaced, the mirror and duration are read off the new one (A9 / §5.3)', async () => {
    const { video } = renderVideoOverlay({ duration: 10, currentTime: 4, videoWidth: 800, videoHeight: 600 });
    expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('4');
    // A handling cycle unmounts the <video> and mounts a fresh one with the same src.
    const wrapper = video.parentElement!;
    video.remove();
    const back = document.createElement('video');
    back.setAttribute('data-testid', 'media-element');
    back.setAttribute('src', 'https://cdn/clip.mp4');
    stubVideo(back, { duration: 8, currentTime: 0, videoWidth: 800, videoHeight: 600 });
    wrapper.prepend(back);
    await relayout();
    const thumb = screen.getByRole('slider');
    expect(thumb.getAttribute('aria-valuenow')).toBe('0');
    expect(thumb.getAttribute('aria-valuemax')).toBe('8');
  });
});

/** Two video nodes on one canvas. */
const TWO_VIDEOS: readonly CropNode[] = [
  { id: 'n1', kind: 'video', src: 'https://cdn/n1.mp4' },
  { id: 'n2', kind: 'video', src: 'https://cdn/n2.mp4' },
];

/**
 * Renders two video nodes, the first playing and the second parked, nothing picked yet.
 * @returns Both elements with their recorders.
 */
function renderTwoVideos(): { first: VideoStub; second: VideoStub } {
  render(focusTree(TWO_VIDEOS, vi.fn(() => true), vi.fn()));
  const [firstEl, secondEl] = screen.getAllByTestId('media-element') as HTMLVideoElement[];
  return {
    first: stubVideo(firstEl!, { duration: 10, currentTime: 3, videoWidth: 800, videoHeight: 600, paused: false }),
    second: stubVideo(secondEl!, { duration: 10, currentTime: 6, videoWidth: 800, videoHeight: 600, paused: false }),
  };
}

describe('FocusCropControls: judging the marquee after a change of target (#1987)', () => {
  it('from an image to a video without metadata: the new target is judged by its own size (A7a)', async () => {
    const nodes: CropNode[] = [
      { id: 'small-image', kind: 'img', src: 'https://cdn/tiny.png' },
      { id: 'fresh-video', kind: 'video', src: 'https://cdn/clip.mp4' },
    ];
    render(focusTree(nodes, vi.fn(() => true), vi.fn()));
    // A 64×64 asset shown in a 400×300 box demands a LARGE rect.
    natural(screen.getByTestId('image-node-img'), 64, 64);
    pick(nodes[0]!);
    await relayout();
    stubVideo(screen.getByTestId('media-element') as HTMLVideoElement, {
      duration: 10,
      currentTime: 0,
      videoWidth: 0,
      videoHeight: 0,
    });
    pick(nodes[1]!);
    // A 30×30 drag: under what the 64×64 yardstick would demand, far over the video's own.
    draw({ x: 150, y: 100 }, { x: 180, y: 130 });
    expect(screen.getByTestId('focus-crop-rect')).toBeInTheDocument();
  });
});

describe('FocusCropControls: pausing on pick (#1987)', () => {
  it('picking a playing video stops it alone (A3)', () => {
    const { first, second } = renderTwoVideos();
    pick(TWO_VIDEOS[0]!);
    expect(first.pause).toHaveBeenCalledTimes(1);
    expect(second.pause).not.toHaveBeenCalled();
  });

  it('a parked video is left alone (user 2026-08-20)', () => {
    const { stub } = renderVideoOverlay({ duration: 10, currentTime: 2, videoWidth: 800, videoHeight: 600, paused: true });
    expect(stub.pause).not.toHaveBeenCalled();
  });

  it('picking two videos in one session stops the second and leaves the first parked (A3)', () => {
    const { first, second } = renderTwoVideos();
    pick(TWO_VIDEOS[0]!);
    first.pause.mockClear();
    pick(TWO_VIDEOS[1]!);
    expect(second.pause).toHaveBeenCalledTimes(1);
    expect(first.play).not.toHaveBeenCalled();
  });

  it('neither confirm nor cancel calls play() (A4)', () => {
    const { stub } = renderVideoOverlay({ duration: 10, currentTime: 4, videoWidth: 800, videoHeight: 600, paused: false });
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    fireEvent.click(screen.getByTestId('focus-crop-confirm'));
    expect(stub.play).not.toHaveBeenCalled();
    cleanup();
    canvasSessions.clear();
    const cancelled = renderVideoOverlay({ duration: 10, currentTime: 4, videoWidth: 800, videoHeight: 600, paused: false });
    draw({ x: 150, y: 100 }, { x: 250, y: 180 });
    fireEvent.click(screen.getByTestId('focus-crop-cancel'));
    expect(cancelled.stub.play).not.toHaveBeenCalled();
    expect(cancelled.video.currentTime).toBe(4);
  });
});

/**
 * Renders an IMAGE node whose intrinsic size is already known, then picks it.
 * @param size - The material's intrinsic pixel size.
 * @param onConfirm - Confirm spy.
 * @returns The render result plus the img element.
 */
function renderImageOverlayReady(
  size: { width: number; height: number },
  onConfirm = vi.fn(() => true),
): ReturnType<typeof render> & { img: HTMLImageElement } {
  const result = render(focusTree([IMAGE], onConfirm, vi.fn()));
  const img = screen.getByTestId('image-node-img') as HTMLImageElement;
  natural(img, size.width, size.height);
  pick(IMAGE);
  return Object.assign(result, { img });
}

describe('FocusCropControls — the Original preset, and a click that draws (#1991)', () => {
  it('the row gains a leftmost item labelled with the literal Original (A6)', () => {
    renderImageOverlayReady({ width: 800, height: 600 });
    const original = screen.getByTestId('focus-ratio-original');
    expect(original.textContent).toBe('Original');
    expect((original.parentElement as HTMLElement).firstElementChild).toBe(original);
  });

  it('neither guidance string tells the user to drag (A8)', () => {
    const DRAG_WORDS = /drag|marquee|拖|框选|框選|ドラッグ|드래그/i;
    for (const [name, catalog] of Object.entries(CATALOGS)) {
      const panel = catalog.canvas?.generatePanel as Record<string, string>;
      expect(panel.selectFocusFromCanvas, `${name} banner`).not.toMatch(DRAG_WORDS);
      expect(panel.focusSourceChanged, `${name} source changed`).not.toMatch(DRAG_WORDS);
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
      expect(values(catalog), `${name} should not carry ${label}`).not.toContain(label);
    }
  });

  it('a video source behaves the same: Original draws at the material aspect (A7)', () => {
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
    const layer = screen.getByTestId('focus-crop-layer');
    fireEvent.pointerDown(layer, { clientX: 110, clientY: 100, button: 0, pointerId: 7 });
    fireEvent.pointerMove(layer, { clientX: 260, clientY: 180, pointerId: 7 });
    const mid = rectSize();
    expect(mid.width).toBe(mid.height);
    expect(mid.width).toBe(150);
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
    expect(screen.getByTestId('focus-ratio-1:1').getAttribute('aria-pressed')).toBe('true');
  });

  it('Original is the material own aspect: a 5:2 source drags out 5:2 (A1)', () => {
    IMG_BOX.width = 400;
    IMG_BOX.height = 160;
    renderImageOverlayReady({ width: 500, height: 200 });
    fireEvent.click(screen.getByTestId('focus-ratio-original'));
    draw({ x: 150, y: 80 }, { x: 250, y: 200 });
    const r = rectSize();
    expect(r.width / r.height).toBeCloseTo(2.5, 2);
  });

  it('Original reads the intrinsic size, not the display box (A1)', () => {
    renderImageOverlayReady({ width: 500, height: 200 });
    fireEvent.click(screen.getByTestId('focus-ratio-original'));
    const r = rectSize();
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
    expect(r.width).toBe(169);
  });

  it('Original with no marquee fills both axes, its ratio being the material own (A2)', () => {
    renderImageOverlayReady({ width: 800, height: 600 });
    fireEvent.click(screen.getByTestId('focus-ratio-original'));
    expect(rectSize()).toEqual({ width: 400, height: 300, left: 0, top: 0 });
  });

  it('with a marquee in hand, a click reshapes around its centre (A3)', () => {
    renderImageOverlayReady({ width: 800, height: 600 });
    draw({ x: 160, y: 90 }, { x: 280, y: 180 });
    fireEvent.click(screen.getByTestId('focus-ratio-1:1'));
    const r = rectSize();
    expect(r.width).toBe(120);
    expect(r.height).toBe(120);
    expect(r.left + r.width / 2).toBe(120);
    expect(r.top + r.height / 2).toBe(85);
  });

  it('a material whose aspect equals a preset still lights exactly one (A4.1)', () => {
    renderImageOverlayReady({ width: 800, height: 600 });
    fireEvent.click(screen.getByTestId('focus-ratio-original'));
    expect(screen.getByTestId('focus-ratio-original').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('focus-ratio-4:3').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByTestId('focus-ratio-4:3'));
    expect(screen.getByTestId('focus-ratio-4:3').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('focus-ratio-original').getAttribute('aria-pressed')).toBe('false');
  });

  it('handles are round when free and square while a ratio is locked (A9)', () => {
    renderImageOverlayReady({ width: 800, height: 600 });
    draw({ x: 160, y: 90 }, { x: 280, y: 180 });
    expect(screen.getByTestId('focus-crop-handle-se').className).toContain('rounded-full');
    fireEvent.click(screen.getByTestId('focus-ratio-1:1'));
    expect(screen.getByTestId('focus-crop-handle-se').className).not.toContain('rounded-full');
    fireEvent.click(screen.getByTestId('focus-ratio-1:1'));
    expect(screen.getByTestId('focus-crop-handle-se').className).toContain('rounded-full');
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
 * The lit preset and the marquee are two pieces of state; each path that
 * clears one gets its own test.
 */
describe('FocusCropControls — lit implies a marquee (#1991 invariant)', () => {
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
    const layer = screen.getByTestId('focus-crop-layer');
    fireEvent.pointerDown(layer, { clientX: 110, clientY: 100, button: 0 });
    fireEvent.pointerUp(layer);
    expectClearedAndUnlit('focus-ratio-9:16');
  });

  it('content swapped under the marquee takes the lit item with it', async () => {
    const { img } = renderImageOverlayReady({ width: 800, height: 600 });
    fireEvent.click(screen.getByTestId('focus-ratio-1:1'));
    img.setAttribute('src', 'https://cdn/other.png');
    await relayout();
    expectClearedAndUnlit('focus-ratio-1:1');
  });

  it('a gesture cut off by the picture going away, whose marquee fails the gauge, leaves nothing lit', async () => {
    const { img } = renderImageOverlayReady({ width: 800, height: 600 });
    fireEvent.click(screen.getByTestId('focus-ratio-1:1'));
    const layer = screen.getByTestId('focus-crop-layer');
    fireEvent.pointerDown(layer, { clientX: 150, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 151, clientY: 101, pointerId: 1 });
    const wrapper = img.parentElement!;
    img.remove();
    await relayout();
    expect(screen.queryByTestId('focus-crop-layer')).toBeNull();
    const back = document.createElement('img');
    back.setAttribute('data-testid', 'image-node-img');
    back.setAttribute('src', 'https://cdn/original.png');
    natural(back, 800, 600);
    wrapper.prepend(back);
    await relayout();
    expectClearedAndUnlit('focus-ratio-1:1');
  });

  it('a source swap caught at confirm time clears the marquee and the light', () => {
    const { img } = renderImageOverlayReady({ width: 800, height: 600 });
    fireEvent.click(screen.getByTestId('focus-ratio-1:1'));
    img.setAttribute('src', 'https://cdn/swapped.png');
    fireEvent.click(screen.getByTestId('focus-crop-confirm'));
    expectClearedAndUnlit('focus-ratio-1:1');
  });

  it('the source remounted as a different element with different content clears both', async () => {
    const { img } = renderImageOverlayReady({ width: 800, height: 600 });
    fireEvent.click(screen.getByTestId('focus-ratio-1:1'));
    const wrapper = img.parentElement!;
    img.remove();
    const fresh = document.createElement('img');
    fresh.setAttribute('data-testid', 'image-node-img');
    fresh.setAttribute('src', 'https://cdn/regenerated.png');
    natural(fresh, 800, 600);
    wrapper.prepend(fresh);
    await relayout();
    expectClearedAndUnlit('focus-ratio-1:1');
  });

  it('Cancel takes the marquee and the lit item together', () => {
    renderImageOverlayReady({ width: 800, height: 600 });
    fireEvent.click(screen.getByTestId('focus-ratio-16:9'));
    fireEvent.click(screen.getByTestId('focus-crop-cancel'));
    expectClearedAndUnlit('focus-ratio-16:9');
  });

  it('switching the crop target clears the marquee and the light', async () => {
    const nodes: CropNode[] = [
      { id: 'n1', kind: 'img', src: 'https://cdn/a.png' },
      { id: 'n2', kind: 'img', src: 'https://cdn/b.png' },
    ];
    render(focusTree(nodes, vi.fn(() => true), vi.fn()));
    for (const img of screen.getAllByTestId('image-node-img')) natural(img, 800, 600);
    pick(nodes[0]!);
    fireEvent.click(screen.getByTestId('focus-ratio-4:3'));
    expect(screen.getByTestId('focus-crop-rect')).toBeInTheDocument();
    pick(nodes[1]!);
    await relayout();
    expectClearedAndUnlit('focus-ratio-4:3');
  });

  // A click that lands on the target node itself (its frame, its name) is the
  // same target picked again; the marquee stays.
  it('picking the target again keeps the marquee and the light', () => {
    renderImageOverlayReady({ width: 800, height: 600 });
    fireEvent.click(screen.getByTestId('focus-ratio-4:3'));
    pick(IMAGE);
    expect(screen.getByTestId('focus-crop-rect')).toBeInTheDocument();
    expect(screen.getByTestId('focus-ratio-4:3').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('FocusCropControls — an item that cannot draw is disabled (#1991)', () => {
  it('before the source reports its size, only Original is disabled', () => {
    renderOverlay();
    expect(screen.getByTestId('focus-ratio-original')).toBeDisabled();
    expect(screen.getByTestId('focus-ratio-16:9')).toBeEnabled();
    expect(screen.getByTestId('focus-ratio-1:1')).toBeEnabled();
  });

  it('a ratio the material is too small to hold is disabled; the others are not', () => {
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
    expect(screen.getByTestId('focus-ratio-original').getAttribute('aria-pressed')).toBe('false');
    expect(warned).not.toHaveBeenCalled();
    expect(errored).not.toHaveBeenCalled();
  });

  it('a disabled item drops the hover response the others carry', () => {
    renderOverlay();
    expect(screen.getByTestId('focus-ratio-original').className).not.toContain('hover:bg-accent');
    expect(screen.getByTestId('focus-ratio-16:9').className).toContain('hover:bg-accent');
  });

  it('Original becomes available once the size arrives', async () => {
    renderOverlay();
    natural(screen.getByTestId('image-node-img'), 800, 600);
    await relayout();
    const original = screen.getByTestId('focus-ratio-original');
    expect(original).toBeEnabled();
    fireEvent.click(original);
    expect(screen.getByTestId('focus-crop-rect')).toBeInTheDocument();
  });
});
