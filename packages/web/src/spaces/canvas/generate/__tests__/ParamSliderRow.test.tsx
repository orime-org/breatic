// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The slider row's two ways of showing a value it does not write (inner#830):
 * a draft another control hands it, and a draft it reports out while dragged;
 * and stop words placed at the value they name.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { ParamSliderRow, type SliderStop } from '@web/spaces/canvas/generate/ParamSliderRow';

const AZIMUTH_STOPS: SliderStop[] = [
  { value: 0, label: 'Front' },
  { value: 90, label: 'Right' },
  { value: 180, label: 'Back' },
  { value: 270, label: 'Left' },
];

/**
 * The horizontal-angle row as the camera-angle control draws it.
 * @param props - What varies between cases.
 * @param props.value - The stored value.
 * @param props.draft - A value to show without writing it.
 * @param props.onDraft - Called with the value while the thumb is moved.
 * @param props.onChange - Called with the committed value.
 * @returns The rendered row.
 */
function row({
  value = 0,
  draft,
  onDraft,
  onChange = vi.fn(),
}: {
  value?: number;
  draft?: number;
  onDraft?: (value: number) => void;
  onChange?: (partial: Record<string, number>) => void;
}): ReturnType<typeof render> {
  return render(
    <ParamSliderRow
      name='horizontal_angle'
      label='Horizontal angle'
      min={0}
      max={315}
      step={45}
      stops={AZIMUTH_STOPS}
      value={value}
      draft={draft}
      onDraft={onDraft}
      format={String}
      onChange={onChange}
      testIdPrefix='generate-param'
      className={undefined}
    />,
  );
}

describe('ParamSliderRow', () => {
  it('shows a draft it is handed over the stored value, and writes nothing', () => {
    const onChange = vi.fn();
    row({ value: 0, draft: 135, onChange });
    expect(screen.getByTestId('generate-param-horizontal_angle-value')).toHaveTextContent('135');
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '135');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows the stored value again once the draft is gone', () => {
    const { rerender } = row({ value: 90, draft: 135 });
    rerender(
      <ParamSliderRow
        name='horizontal_angle'
        label='Horizontal angle'
        min={0}
        max={315}
        step={45}
        stops={AZIMUTH_STOPS}
        value={90}
        format={String}
        onChange={vi.fn()}
        testIdPrefix='generate-param'
        className={undefined}
      />,
    );
    expect(screen.getByTestId('generate-param-horizontal_angle-value')).toHaveTextContent('90');
  });

  it('reports the value it is moved to while the thumb moves', () => {
    const onDraft = vi.fn();
    row({ value: 0, onDraft });
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' });
    expect(onDraft).toHaveBeenCalledWith(45);
  });

  it('ends a pointer drag that comes back to where it began: the stored value shows again and the draft is over', () => {
    const proto = HTMLElement.prototype;
    const saved = [proto.getBoundingClientRect, proto.setPointerCapture, proto.hasPointerCapture, proto.releasePointerCapture] as const;
    proto.getBoundingClientRect = () => ({ left: 0, top: 0, right: 315, bottom: 24, width: 315, height: 24, x: 0, y: 0, toJSON: () => ({}) });
    proto.setPointerCapture = () => {};
    proto.hasPointerCapture = () => true;
    proto.releasePointerCapture = () => {};
    try {
      const onChange = vi.fn();
      const onDraftEnd = vi.fn();
      const props = {
        name: 'horizontal_angle',
        label: 'Horizontal angle',
        min: 0,
        max: 315,
        step: 45,
        stops: AZIMUTH_STOPS,
        format: String,
        onChange,
        onDraftEnd,
        testIdPrefix: 'generate-param',
        className: undefined,
      };
      const { rerender } = render(<ParamSliderRow {...props} value={0} />);
      const slider = screen.getByTestId('generate-param-horizontal_angle-slider');
      fireEvent.pointerDown(slider, { pointerId: 1, button: 0, clientX: 90 });
      fireEvent.pointerMove(slider, { pointerId: 1, clientX: 0 });
      onDraftEnd.mockClear();
      fireEvent.pointerUp(slider, { pointerId: 1, clientX: 0 });
      expect(onChange).not.toHaveBeenCalled();
      expect(onDraftEnd).toHaveBeenCalledTimes(1);
      rerender(<ParamSliderRow {...props} value={180} />);
      expect(screen.getByTestId('generate-param-horizontal_angle-value')).toHaveTextContent('180');
    } finally {
      [proto.getBoundingClientRect, proto.setPointerCapture, proto.hasPointerCapture, proto.releasePointerCapture] = saved;
    }
  });

  it('places each stop word at the value it names, pinning only the ends of the range', () => {
    row({});
    const at = (value: number): HTMLElement => screen.getByTestId(`generate-param-horizontal_angle-stop-${value}`);
    expect(at(0).style.left).toBe('0%');
    expect(at(0).dataset.edge).toBe('start');
    expect(parseFloat(at(90).style.left)).toBeCloseTo((90 / 315) * 100, 3);
    expect(at(90).dataset.edge).toBeUndefined();
    // 270 is not the range's end (315 is), so it is centred on its value.
    expect(parseFloat(at(270).style.left)).toBeCloseTo((270 / 315) * 100, 3);
    expect(at(270).dataset.edge).toBeUndefined();
  });

  it('pins a stop at the top of the range to the end of the track', () => {
    render(
      <ParamSliderRow
        name='distance'
        label='Distance'
        min={0}
        max={2}
        step={1}
        stops={[
          { value: 0, label: 'Close-up' },
          { value: 1, label: 'Medium' },
          { value: 2, label: 'Wide' },
        ]}
        value={1}
        format={String}
        onChange={vi.fn()}
        testIdPrefix='generate-param'
        className={undefined}
      />,
    );
    expect(screen.getByTestId('generate-param-distance-stop-2').dataset.edge).toBe('end');
    expect(parseFloat(screen.getByTestId('generate-param-distance-stop-1').style.left)).toBeCloseTo(50, 3);
  });
});
