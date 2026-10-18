// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The relight tool's light sphere (inner#1304): the camera-angle control on
 * the light's grid, two axes and its own reset pose, with no distance.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LIGHT_ANGLE_GRID } from '@breatic/shared';

import type { CameraAngleSphereProps } from '@web/spaces/canvas/generate/camera-angle-sphere-props';

const sphere = vi.hoisted(() => ({ last: null as CameraAngleSphereProps | null }));

vi.mock('@web/spaces/canvas/generate/CameraAngleSphere', () => ({
  default: (props: CameraAngleSphereProps) => {
    sphere.last = props;
    return <div data-testid='fake-sphere' />;
  },
}));

import { LIGHT_SPHERE } from '@web/spaces/canvas/generate/angle-spheres';
import { CameraAngleControl } from '@web/spaces/canvas/generate/CameraAngleControl';

import { LIGHT_PARAMS, LIGHT_SPECS } from './camera-angle-specs';

/**
 * Draws the light control on a stored direction and waits for the sphere.
 * @param stored - What the draft holds.
 * @returns The write spy.
 */
async function draw(stored: Record<string, number> = { light_azimuth: 315, light_elevation: 30 }): Promise<ReturnType<typeof vi.fn>> {
  const onChange = vi.fn();
  render(
    <CameraAngleControl
      sphere={LIGHT_SPHERE}
      params={LIGHT_PARAMS}
      specs={LIGHT_SPECS}
      value={stored}
      onChange={onChange}
      subjectUrl={undefined}
    />,
  );
  await screen.findByTestId('fake-sphere');
  return onChange;
}

beforeEach(() => {
  sphere.last = null;
});

describe('the light sphere', () => {
  it('names itself as the light and its direction in two words', async () => {
    await draw({ light_azimuth: 90, light_elevation: 60 });
    expect(screen.getByText('Light source', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByTestId('generate-camera-angle-pose')).toHaveTextContent('Right · High');
  });

  it('hands the sphere the light grid and the light marker', async () => {
    await draw();
    expect(sphere.last?.grid).toEqual(LIGHT_ANGLE_GRID);
    expect(sphere.last?.marker).toBe('light');
  });

  it('draws two sliders, the height reaching straight overhead', async () => {
    await draw();
    expect(screen.getByTestId('generate-param-light_azimuth-value')).toBeInTheDocument();
    expect(screen.getByTestId('generate-param-light_elevation-stop-90')).toBeInTheDocument();
    expect(screen.queryByTestId('generate-param-distance-value')).toBeNull();
  });

  it('writes only its two params, and takes no distance key', async () => {
    const onChange = await draw();
    const group = screen.getByTestId('generate-camera-angle');
    fireEvent.keyDown(group, { key: 'ArrowUp' });
    fireEvent.keyUp(group, { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith({ light_azimuth: 315, light_elevation: 60 });
    onChange.mockClear();
    fireEvent.keyDown(group, { key: '+' });
    fireEvent.keyUp(group, { key: '+' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('resets to the front left, above', async () => {
    const onChange = await draw({ light_azimuth: 90, light_elevation: 0 });
    fireEvent.click(screen.getByTestId('generate-camera-angle-reset'));
    expect(onChange).toHaveBeenCalledWith({ light_azimuth: 315, light_elevation: 30 });
  });

  // Straight overhead is one point, where every azimuth meets; the light keeps the side it came from.
  it('keeps the last azimuth when dragged straight overhead', async () => {
    const onChange = await draw({ light_azimuth: 90, light_elevation: 30 });
    act(() => sphere.last?.onDragStart());
    act(() => sphere.last?.onDrag({ azimuth: 0, elevation: 90, distance: 1 }));
    act(() => sphere.last?.onDragEnd());
    expect(onChange).toHaveBeenCalledWith({ light_azimuth: 90, light_elevation: 90 });
  });
});
