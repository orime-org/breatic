// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The sphere's chunk cannot be fetched — a tab left open across a deploy
 * names files the server no longer has. The control says so and its sliders
 * still work; nothing reloads the page (inner#830).
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@web/spaces/canvas/generate/CameraAngleSphere', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

import { CameraAngleControl } from '@web/spaces/canvas/generate/CameraAngleControl';

import { CAMERA_SPECS } from './camera-angle-specs';

describe('CameraAngleControl without its sphere', () => {
  it('says the 3D view could not load, and the sliders still write', async () => {
    const onChange = vi.fn();
    render(
      <CameraAngleControl
        params={{ azimuth: 'horizontal_angle', elevation: 'vertical_angle', distance: 'distance' }}
        specs={CAMERA_SPECS}
        value={{ horizontal_angle: 0, vertical_angle: 0, distance: 1 }}
        onChange={onChange}
        subjectUrl={undefined}
      />,
    );
    expect(await screen.findByTestId('generate-camera-angle-unavailable')).toHaveTextContent(
      'The 3D view could not load. Refresh the page to use it.',
    );
    fireEvent.click(screen.getByTestId('generate-param-vertical_angle-stop-60'));
    expect(onChange).toHaveBeenCalledWith({ horizontal_angle: 0, vertical_angle: 60, distance: 1 });
  });
});
