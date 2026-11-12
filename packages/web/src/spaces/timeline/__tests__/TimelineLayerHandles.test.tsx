// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The preview handles of one selected layer (breatic#1410 design §4.3, §4.4, §7.1, §7.2).
 *
 * The API this file pins, in `@web/spaces/timeline/TimelineLayerHandles` (the only module that imports
 * `react-moveable`, loaded by the preview through a dynamic `import()`):
 * - `TimelineLayerHandles` with props
 *   `{ canvas, base, transform, factor, snap, onOverride, onCommit, onDraggingChange, onPick }`:
 *   `canvas` is the document's `settings` size and `base` the layer's base box, both in canvas pixels; `transform` the
 *   stored one; `factor` display pixels per canvas pixel; `snap` the toolbar switch.
 * - It renders a transparent proxy (`data-testid="timeline-layer-proxy"`) on the layer's base box in display pixels
 *   with the layer's CSS transform, and Moveable acting on it.
 * - During a gesture `onOverride(transform)` reports the live value in canvas pixels (and the proxy follows it);
 *   `onOverride(null)` clears it. On release the value is converted, clamped, normalised and rounded (§3.1) and
 *   handed to `onCommit` once, only when it differs from the stored one. Esc, a window blur and unmounting cancel
 *   without committing. `onDraggingChange` is true from the press to the end or cancel of a gesture. A press that does
 *   not move hands its input event to `onPick` for the topmost hit test.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimelineVideoClip } from '@breatic/shared';

import { gesture, handleProps, moveableMock, resetMoveableMock } from '@web/spaces/timeline/__tests__/helpers/moveable-mock';
import { TimelineLayerHandles } from '@web/spaces/timeline/TimelineLayerHandles';

vi.mock('react-moveable', async () => (await import('@web/spaces/timeline/__tests__/helpers/moveable-mock')).moveableModule);

type Transform = TimelineVideoClip['transform'];

const CANVAS = { width: 1920, height: 1080 };
const FULL = { left: 0, top: 0, width: 1920, height: 1080 };
const IDENTITY: Transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
// The preview shows the 1920 x 1080 canvas at 960 x 540 display pixels.
const FACTOR = 0.5;

/** The callbacks a render hands the handles. */
interface Callbacks {
  onOverride: ReturnType<typeof vi.fn<(transform: Transform | null) => void>>;
  onCommit: ReturnType<typeof vi.fn<(transform: Transform) => void>>;
  onDraggingChange: ReturnType<typeof vi.fn<(dragging: boolean) => void>>;
  onPick: ReturnType<typeof vi.fn<(event: MouseEvent) => void>>;
}

/** What a render may change. */
interface Options { transform?: Transform; base?: typeof FULL; snap?: boolean }

/**
 * Render the handles of a layer filling the canvas.
 * @param options - The stored transform, base box and snap switch.
 * @returns The callbacks and a rerender with other options.
 * @throws {Error} When rendering fails.
 */
function showHandles(options: Options = {}): Callbacks & { rerender: (next: Options) => void; unmount: () => void } {
  const callbacks: Callbacks = { onOverride: vi.fn(), onCommit: vi.fn(), onDraggingChange: vi.fn(), onPick: vi.fn() };
  const element = (next: Options): React.JSX.Element => <TimelineLayerHandles canvas={CANVAS} base={next.base ?? FULL} transform={next.transform ?? IDENTITY}
    factor={FACTOR} snap={next.snap ?? true} {...callbacks} />;
  const view = render(element(options));
  return { ...callbacks, rerender: (next) => view.rerender(element(next)), unmount: view.unmount };
}

/**
 * The proxy's CSS transform.
 * @returns It.
 * @throws {Error} When the proxy is absent.
 */
function proxyTransform(): string {
  return screen.getByTestId('timeline-layer-proxy').style.transform;
}

/**
 * A pattern for `translate(x, y) rotate(r) scale(sx, sy)` in display units, spaces optional.
 * @param x - Display x in px.
 * @param y - Display y in px.
 * @param rotation - Degrees.
 * @param scaleX - Width factor.
 * @param scaleY - Height factor.
 * @returns The pattern.
 * @throws {never} Never.
 */
function layerCss(x: number, y: number, rotation: number, scaleX: number, scaleY: number): RegExp {
  const n = (value: number): string => String(value).replace('.', '\\.').replace('-', '\\-');
  return new RegExp(`translate\\(\\s*${n(x)}px,\\s*${n(y)}px\\s*\\)\\s*rotate\\(\\s*${n(rotation)}deg\\s*\\)\\s*scale\\(\\s*${n(scaleX)},\\s*${n(scaleY)}\\s*\\)`);
}

beforeEach(() => { resetMoveableMock(); });
afterEach(() => { cleanup(); });

describe('TimelineLayerHandles proxy and handles (§4.1, §4.3)', () => {
  it('draws the proxy on the base box in display pixels with the layer transform, and gives Moveable all eight handles and the rotation handle', () => {
    showHandles({ base: { left: 240, top: 0, width: 1440, height: 1080 }, transform: { x: 100, y: -50, scaleX: 0.5, scaleY: 0.5, rotation: 10 } });
    const proxy = screen.getByTestId('timeline-layer-proxy');
    expect(proxy.style.left).toBe('120px');
    expect(proxy.style.top).toBe('0px');
    expect(proxy.style.width).toBe('720px');
    expect(proxy.style.height).toBe('540px');
    expect(proxy.style.transform).toMatch(layerCss(50, -25, 10, 0.5, 0.5));
    const props = handleProps();
    const target = props.target as { current?: unknown } | Element;
    expect(target === proxy || (target as { current?: unknown }).current === proxy).toBe(true);
    expect(props.draggable).toBe(true);
    expect(props.scalable).toBe(true);
    expect(props.rotatable).toBe(true);
    expect(props.keepRatio).toBe(true);
    expect(props.renderDirections).toEqual(expect.arrayContaining(['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se']));
  });
});

describe('TimelineLayerHandles move (§4.3, §7.2)', () => {
  it('follows the drag locally without committing, then commits the canvas-pixel position once on release', () => {
    const { onOverride, onCommit, onDraggingChange } = showHandles();
    gesture.dragStart();
    expect(onDraggingChange).toHaveBeenLastCalledWith(true);
    const last = gesture.drag([100, 50]);
    expect(onOverride).toHaveBeenLastCalledWith({ x: 200, y: 100, scaleX: 1, scaleY: 1, rotation: 0 });
    expect(proxyTransform()).toMatch(layerCss(100, 50, 0, 1, 1));
    expect(onCommit).not.toHaveBeenCalled();
    gesture.dragEnd(last);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ x: 200, y: 100, scaleX: 1, scaleY: 1, rotation: 0 });
    expect(onOverride).toHaveBeenLastCalledWith(null);
    expect(onDraggingChange).toHaveBeenLastCalledWith(false);
  });

  it('rounds the committed position to 0.01 canvas pixels (§3.1)', () => {
    const { onCommit } = showHandles();
    gesture.dragStart();
    gesture.dragEnd(gesture.drag([100.123456, 50.005]));
    expect(onCommit).toHaveBeenCalledWith({ x: 200.25, y: 100.01, scaleX: 1, scaleY: 1, rotation: 0 });
  });

  it('commits nothing when the rounded result equals the stored transform', () => {
    const { onOverride, onCommit, onDraggingChange } = showHandles();
    gesture.dragStart();
    gesture.dragEnd(gesture.drag([0.002, 0.001]));
    expect(onCommit).not.toHaveBeenCalled();
    expect(onOverride).toHaveBeenLastCalledWith(null);
    expect(onDraggingChange).toHaveBeenLastCalledWith(false);
  });

  it('commits nothing and ends the gesture for a press that never moved', () => {
    const { onCommit, onDraggingChange } = showHandles();
    gesture.dragStart();
    gesture.dragEnd();
    expect(onCommit).not.toHaveBeenCalled();
    expect(onDraggingChange).toHaveBeenLastCalledWith(false);
  });
});

describe('TimelineLayerHandles scale and stretch (§4.3)', () => {
  it('scales proportionally from a corner, moving the centre so the opposite corner stays', () => {
    const { onCommit } = showHandles();
    gesture.scaleStart([-1, -1]);
    expect(handleProps().keepRatio).toBe(true);
    gesture.scaleEnd(gesture.scale([0.5, 0.5], [-1, -1], [120, 67.5]));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ x: 240, y: 135, scaleX: 0.5, scaleY: 0.5, rotation: 0 });
  });

  it('stretches one axis from an edge handle with the ratio unlocked for that gesture only', () => {
    const { onCommit } = showHandles();
    gesture.scaleStart([1, 0]);
    expect(handleProps().keepRatio).toBe(false);
    gesture.scaleEnd(gesture.scale([1.5, 1], [1, 0], [120, 0]));
    expect(onCommit).toHaveBeenCalledWith({ x: 240, y: 0, scaleX: 1.5, scaleY: 1, rotation: 0 });
    expect(handleProps().keepRatio).toBe(true);
  });

  it('clamps the scale to 0.01 and 100 while scaling and on release', () => {
    const { onOverride, onCommit } = showHandles();
    gesture.scaleStart([1, 1]);
    gesture.scale([0.001, 0.001], [1, 1]);
    expect(onOverride).toHaveBeenLastCalledWith({ x: 0, y: 0, scaleX: 0.01, scaleY: 0.01, rotation: 0 });
    expect(proxyTransform()).toMatch(layerCss(0, 0, 0, 0.01, 0.01));
    gesture.scaleEnd(gesture.scale([250, 250], [1, 1]));
    expect(onCommit).toHaveBeenCalledWith({ x: 0, y: 0, scaleX: 100, scaleY: 100, rotation: 0 });
  });

  it('rounds the committed scale to 0.0001', () => {
    const { onCommit } = showHandles();
    gesture.scaleStart([1, 1]);
    gesture.scaleEnd(gesture.scale([0.123456, 0.123456], [1, 1]));
    expect(onCommit).toHaveBeenCalledWith({ x: 0, y: 0, scaleX: 0.1235, scaleY: 0.1235, rotation: 0 });
  });
});

describe('TimelineLayerHandles rotate (§4.3, §3.1)', () => {
  it('commits the angle normalised to -180..180 and rounded to 0.01 degree', () => {
    const { onCommit } = showHandles();
    gesture.rotateStart();
    gesture.rotateEnd(gesture.rotate(200));
    expect(onCommit).toHaveBeenLastCalledWith({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: -160 });
    gesture.rotateStart();
    gesture.rotateEnd(gesture.rotate(33.3333));
    expect(onCommit).toHaveBeenLastCalledWith({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 33.33 });
    expect(onCommit).toHaveBeenCalledTimes(2);
  });
});

describe('TimelineLayerHandles cancels without writing (§4.3, §7.1)', () => {
  it('restores the stored transform on Escape and commits nothing when Moveable later ends the gesture', () => {
    const { onOverride, onCommit, onDraggingChange } = showHandles();
    const before = proxyTransform();
    gesture.dragStart();
    const last = gesture.drag([100, 50]);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onOverride).toHaveBeenLastCalledWith(null);
    expect(onDraggingChange).toHaveBeenLastCalledWith(false);
    expect(proxyTransform()).toBe(before);
    gesture.dragEnd(last);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('restores the stored transform when the window loses focus mid-scale', () => {
    const { onOverride, onCommit, onDraggingChange } = showHandles();
    gesture.scaleStart([1, 1]);
    const last = gesture.scale([2, 2], [1, 1]);
    fireEvent.blur(window);
    expect(onOverride).toHaveBeenLastCalledWith(null);
    expect(onDraggingChange).toHaveBeenLastCalledWith(false);
    gesture.scaleEnd(last);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('clears the override and the dragging flag without committing when unmounted mid-rotation', () => {
    const { onOverride, onCommit, onDraggingChange, unmount } = showHandles();
    gesture.rotateStart();
    gesture.rotate(45);
    expect(onDraggingChange).toHaveBeenLastCalledWith(true);
    unmount();
    expect(onOverride).toHaveBeenLastCalledWith(null);
    expect(onDraggingChange).toHaveBeenLastCalledWith(false);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('ignores Escape when no gesture is held', () => {
    const { onOverride, onDraggingChange } = showHandles();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onOverride).not.toHaveBeenCalled();
    expect(onDraggingChange).not.toHaveBeenCalled();
  });
});

describe('TimelineLayerHandles click without movement (§4.2)', () => {
  it('hands the press to the topmost hit test and commits nothing', () => {
    const { onPick, onCommit } = showHandles();
    const event = gesture.click(720, 135);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]?.[0]).toBe(event);
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('TimelineLayerHandles snapping (§4.4)', () => {
  it('snaps to the frame edges and centre lines within 6 display pixels while the switch is on, and not when it is off', () => {
    const { rerender } = showHandles({ snap: true });
    expect(handleProps().snappable).toBe(true);
    expect(handleProps().snapThreshold).toBe(6);
    expect(handleProps().verticalGuidelines).toEqual(expect.arrayContaining([0, 480, 960]));
    expect(handleProps().horizontalGuidelines).toEqual(expect.arrayContaining([0, 270, 540]));
    rerender({ snap: false });
    expect(handleProps().snappable).toBeFalsy();
    expect(moveableMock.mounted).toBe(1);
  });
});
