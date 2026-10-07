// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The image settings popover of a model whose three params set one camera
 * pose (inner#830): the pill names the pose, and the sphere's card carries the
 * picture the panel hands it (chosen in GeneratePanelContainer).
 */

import type { ModelEntry } from '@breatic/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CameraAngleSphereProps } from '@web/spaces/canvas/generate/camera-angle-sphere-props';

vi.mock('@web/spaces/canvas/generate/CameraAngleSphere', () => ({
  default: (props: CameraAngleSphereProps) => <div data-testid='fake-sphere' data-subject={props.subjectUrl ?? ''} />,
}));

import { RatioResolutionPicker } from '@web/spaces/canvas/generate/RatioResolutionPicker';

import { CAMERA_SPECS } from './camera-angle-specs';

const QWEN: ModelEntry = {
  name: 'qwen-image-edit-multiple-angles',
  display_name: 'Qwen Image Multiple Angles',
  modality: 'image',
  mode: 'i2i',
  description: '',
  guide: '',
  tier: 'optional',
  generation_time: 120,
  takes_prompt: true,
  params: CAMERA_SPECS,
  providers: [],
  camera_angle: { azimuth: 'horizontal_angle', elevation: 'vertical_angle', distance: 'distance' },
};

describe('RatioResolutionPicker on a camera-angle model', () => {
  it('names the pose on the pill', () => {
    render(
      <RatioResolutionPicker
        mode='i2i'
        model={QWEN}
        value={{ horizontal_angle: 90, vertical_angle: 30, distance: 2 }}
        onChange={() => {}}
        subjectImageUrl={undefined}
      />,
    );
    expect(screen.getByTestId('generate-ratio-trigger')).toHaveTextContent('Right · Elevated · Wide shot');
  });

  it('hands the sphere the picture it is given for the card', async () => {
    render(
      <RatioResolutionPicker
        mode='i2i'
        model={QWEN}
        value={{ horizontal_angle: 0, vertical_angle: 0, distance: 1 }}
        onChange={() => {}}
        subjectImageUrl='https://resource.test/image/second.png'
      />,
    );
    fireEvent.click(screen.getByTestId('generate-ratio-trigger'));
    expect((await screen.findByTestId('fake-sphere')).dataset.subject).toBe(
      'https://resource.test/image/second.png?cors=1',
    );
  });
});
