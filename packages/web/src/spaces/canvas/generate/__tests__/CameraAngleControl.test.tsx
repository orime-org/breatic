// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The camera-angle control (inner#830): one pose, three sliders and a sphere,
 * written to the node once per gesture through one exit.
 *
 * The sphere is three.js and loads lazily; here it is a stand-in that records
 * the props it was last drawn with and lets a case drive its drag callbacks.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CameraAngleSphereProps } from '@web/spaces/canvas/generate/camera-angle-sphere-props';

const sphere = vi.hoisted(() => ({ last: null as CameraAngleSphereProps | null }));

vi.mock('@web/spaces/canvas/generate/CameraAngleSphere', () => ({
  default: (props: CameraAngleSphereProps) => {
    sphere.last = props;
    return <div data-testid='fake-sphere' data-azimuth={props.pose.azimuth} data-subject={props.subjectUrl ?? ''} />;
  },
}));

import { CameraAngleControl } from '@web/spaces/canvas/generate/CameraAngleControl';

import { CAMERA_PARAMS as PARAMS, CAMERA_SPECS } from './camera-angle-specs';


/**
 * Draws the control on a stored pose and waits for the sphere to load.
 * @param stored - What the node holds.
 * @param subjectUrl - The first image the model is sent, if any.
 * @returns The write spy and the rerender handle.
 */
async function draw(
  stored: Record<string, number> = { horizontal_angle: 0, vertical_angle: 0, distance: 1 },
  subjectUrl?: string,
): Promise<{ onChange: ReturnType<typeof vi.fn>; rerender: (next: Record<string, number>) => void; unmount: () => void }> {
  const onChange = vi.fn();
  const view = render(<CameraAngleControl params={PARAMS} specs={CAMERA_SPECS} value={stored} onChange={onChange} subjectUrl={subjectUrl} />);
  await screen.findByTestId('fake-sphere');
  return {
    onChange,
    rerender: (next) =>
      view.rerender(<CameraAngleControl params={PARAMS} specs={CAMERA_SPECS} value={next} onChange={onChange} subjectUrl={subjectUrl} />),
    unmount: view.unmount,
  };
}

/**
 * Lets a pointer drag a Radix slider in jsdom: every element is 200px wide
 * from the left edge, and pointer capture always holds.
 * @returns Undoes the stubs.
 */
function stubPointerSliders(): () => void {
  const proto = HTMLElement.prototype;
  const saved = {
    rect: proto.getBoundingClientRect,
    set: proto.setPointerCapture,
    has: proto.hasPointerCapture,
    release: proto.releasePointerCapture,
  };
  proto.getBoundingClientRect = () => ({ left: 0, top: 0, right: 200, bottom: 24, width: 200, height: 24, x: 0, y: 0, toJSON: () => ({}) });
  proto.setPointerCapture = () => {};
  proto.hasPointerCapture = () => true;
  proto.releasePointerCapture = () => {};
  return () => {
    proto.getBoundingClientRect = saved.rect;
    proto.setPointerCapture = saved.set;
    proto.hasPointerCapture = saved.has;
    proto.releasePointerCapture = saved.release;
  };
}

/**
 * The control's keyboard surface.
 * @returns The focusable group around the sphere.
 */
const group = (): HTMLElement => screen.getByTestId('generate-camera-angle');

beforeEach(() => {
  sphere.last = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CameraAngleControl', () => {
  it('names the stored pose and draws the sphere on it', async () => {
    await draw({ horizontal_angle: 90, vertical_angle: 30, distance: 2 });
    expect(screen.getByTestId('generate-camera-angle-pose')).toHaveTextContent('Right · Elevated · Wide shot');
    expect(sphere.last?.pose).toEqual({ azimuth: 90, elevation: 30, distance: 2 });
  });

  it('hands the sphere the first image the model is sent, fetched fresh in CORS mode', async () => {
    await draw(undefined, 'https://resource.test/image/a.png');
    expect(sphere.last?.subjectUrl).toBe('https://resource.test/image/a.png?cors=1');
  });

  it('hands the sphere no picture when no image is sent', async () => {
    await draw();
    expect(sphere.last?.subjectUrl).toBeUndefined();
  });

  it('shows the nearest pose on the sliders while the sphere is dragged, and writes once on release', async () => {
    const { onChange } = await draw();
    act(() => sphere.last?.onDragStart());
    act(() => sphere.last?.onDrag({ azimuth: 100, elevation: 20, distance: 1 }));
    expect(screen.getByTestId('generate-param-horizontal_angle-value')).toHaveTextContent('90');
    expect(screen.getByTestId('generate-param-vertical_angle-value')).toHaveTextContent('30');
    expect(onChange).not.toHaveBeenCalled();
    act(() => sphere.last?.onDragEnd());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ horizontal_angle: 90, vertical_angle: 30, distance: 1 });
  });

  it('writes nothing when a drag ends on the pose already stored', async () => {
    const { onChange } = await draw();
    act(() => sphere.last?.onDragStart());
    act(() => sphere.last?.onDrag({ azimuth: 10, elevation: 5, distance: 1 }));
    act(() => sphere.last?.onDragEnd());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('steps one pose per arrow or plus/minus key, writing all three values each time', async () => {
    const { onChange } = await draw();
    fireEvent.keyDown(group(), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith({ horizontal_angle: 45, vertical_angle: 0, distance: 1 });
    fireEvent.keyDown(group(), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith({ horizontal_angle: 315, vertical_angle: 0, distance: 1 });
    fireEvent.keyDown(group(), { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith({ horizontal_angle: 0, vertical_angle: 30, distance: 1 });
    fireEvent.keyDown(group(), { key: '-' });
    expect(onChange).toHaveBeenLastCalledWith({ horizontal_angle: 0, vertical_angle: 0, distance: 2 });
    fireEvent.keyDown(group(), { key: '+' });
    expect(onChange).toHaveBeenLastCalledWith({ horizontal_angle: 0, vertical_angle: 0, distance: 0 });
    expect(onChange).toHaveBeenCalledTimes(5);
  });

  it('moves one distance step per wheel gesture however many events it sends, writing it as the step is taken', async () => {
    const { onChange } = await draw();
    vi.useFakeTimers();
    for (let i = 0; i < 20; i += 1) fireEvent.wheel(group(), { deltaY: 8 });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ horizontal_angle: 0, vertical_angle: 0, distance: 2 });
    act(() => vi.advanceTimersByTime(300));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('takes the next step only once the wheel has settled', async () => {
    const { onChange, rerender } = await draw();
    vi.useFakeTimers();
    fireEvent.wheel(group(), { deltaY: -60 });
    rerender({ horizontal_angle: 0, vertical_angle: 0, distance: 0 });
    fireEvent.wheel(group(), { deltaY: 60 });
    expect(onChange).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(150));
    fireEvent.wheel(group(), { deltaY: 60 });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith({ horizontal_angle: 0, vertical_angle: 0, distance: 1 });
  });

  it('keeps the page from zooming when a pinch lands on the sphere', async () => {
    await draw();
    const event = new WheelEvent('wheel', { deltaY: 4, ctrlKey: true, cancelable: true, bubbles: true });
    group().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('keeps a wheel step it showed when the control goes away right after', async () => {
    const { onChange, unmount } = await draw();
    vi.useFakeTimers();
    fireEvent.wheel(group(), { deltaY: 60 });
    unmount();
    act(() => vi.advanceTimersByTime(300));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ horizontal_angle: 0, vertical_angle: 0, distance: 2 });
  });

  it('writes a held arrow key once when pressed and once when let go, following each repeat on screen', async () => {
    const { onChange, rerender } = await draw();
    fireEvent.keyDown(group(), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({ horizontal_angle: 45, vertical_angle: 0, distance: 1 });
    rerender({ horizontal_angle: 45, vertical_angle: 0, distance: 1 });
    for (let i = 0; i < 3; i += 1) fireEvent.keyDown(group(), { key: 'ArrowRight', repeat: true });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('generate-camera-angle-pose')).toHaveTextContent('Back · Eye level');
    expect(sphere.last?.pose.azimuth).toBe(180);
    fireEvent.keyUp(group(), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith({ horizontal_angle: 180, vertical_angle: 0, distance: 1 });
  });

  it('writes a held key where it reached when focus leaves before the key is let go', async () => {
    const { onChange, rerender } = await draw();
    fireEvent.keyDown(group(), { key: 'ArrowRight' });
    rerender({ horizontal_angle: 45, vertical_angle: 0, distance: 1 });
    fireEvent.keyDown(group(), { key: 'ArrowRight', repeat: true });
    fireEvent.keyDown(group(), { key: 'ArrowRight', repeat: true });
    fireEvent.blur(group());
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith({ horizontal_angle: 135, vertical_angle: 0, distance: 1 });
  });

  it('follows a collaborator after a slider is dragged away and back to where it was', async () => {
    const restore = stubPointerSliders();
    try {
      const { onChange, rerender } = await draw();
      const slider = screen.getByTestId('generate-param-distance-slider');
      fireEvent.pointerDown(slider, { pointerId: 1, button: 0, clientX: 200 });
      fireEvent.pointerMove(slider, { pointerId: 1, clientX: 100 });
      fireEvent.pointerUp(slider, { pointerId: 1, clientX: 100 });
      expect(onChange).not.toHaveBeenCalled();
      rerender({ horizontal_angle: 0, vertical_angle: 0, distance: 0 });
      expect(screen.getByTestId('generate-camera-angle-pose')).toHaveTextContent('Close-up');
      expect(sphere.last?.pose.distance).toBe(0);
      expect(screen.getByTestId('generate-param-distance-value')).toHaveTextContent('Close-up');
    } finally {
      restore();
    }
  });

  it('drops a drag that is still going when the control goes away', async () => {
    const { onChange, unmount } = await draw();
    act(() => sphere.last?.onDragStart());
    act(() => sphere.last?.onDrag({ azimuth: 180, elevation: 0, distance: 1 }));
    unmount();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('writes a wheel step taken during a drag together with the angle on release', async () => {
    const { onChange } = await draw();
    act(() => sphere.last?.onDragStart());
    act(() => sphere.last?.onDrag({ azimuth: 180, elevation: 0, distance: 1 }));
    fireEvent.wheel(group(), { deltaY: 60 });
    act(() => sphere.last?.onDragEnd());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ horizontal_angle: 180, vertical_angle: 0, distance: 2 });
  });

  it('resets to the front, at eye level, at the medium distance, writing only when that changes something', async () => {
    const { onChange, rerender } = await draw({ horizontal_angle: 135, vertical_angle: 60, distance: 0 });
    fireEvent.click(screen.getByTestId('generate-camera-angle-reset'));
    expect(onChange).toHaveBeenCalledWith({ horizontal_angle: 0, vertical_angle: 0, distance: 1 });
    rerender({ horizontal_angle: 0, vertical_angle: 0, distance: 1 });
    fireEvent.click(screen.getByTestId('generate-camera-angle-reset'));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('writes all three values when a slider stop is clicked', async () => {
    const { onChange } = await draw({ horizontal_angle: 0, vertical_angle: 30, distance: 2 });
    fireEvent.click(screen.getByTestId('generate-param-horizontal_angle-stop-270'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ horizontal_angle: 270, vertical_angle: 30, distance: 2 });
  });

  it('follows a collaborator who changes the stored pose', async () => {
    const { rerender } = await draw();
    rerender({ horizontal_angle: 225, vertical_angle: -30, distance: 0 });
    expect(sphere.last?.pose).toEqual({ azimuth: 225, elevation: -30, distance: 0 });
    expect(screen.getByTestId('generate-camera-angle-pose')).toHaveTextContent('Back left · Low angle · Close-up');
  });

  it('says the 3D view could not load when the sphere reports it cannot draw, and keeps the sliders', async () => {
    const { onChange } = await draw();
    act(() => sphere.last?.onUnavailable());
    expect(screen.getByTestId('generate-camera-angle-unavailable')).toHaveTextContent(
      'The 3D view could not load. Refresh the page to use it.',
    );
    fireEvent.click(screen.getByTestId('generate-param-distance-stop-0'));
    expect(onChange).toHaveBeenCalledWith({ horizontal_angle: 0, vertical_angle: 0, distance: 0 });
  });
});
