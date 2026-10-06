// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The image settings popover of a model whose three params set one camera
 * pose (inner#830): the pill names the pose, and the sphere's card carries the
 * first image the model is sent.
 */

import type { ModelEntry, ParamDescriptor } from '@breatic/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CameraAngleSphereProps } from '@web/spaces/canvas/generate/camera-angle-sphere-props';

vi.mock('@web/spaces/canvas/generate/CameraAngleSphere', () => ({
  default: (props: CameraAngleSphereProps) => <div data-testid='fake-sphere' data-subject={props.subjectUrl ?? ''} />,
}));

import { RatioResolutionPicker } from '@web/spaces/canvas/generate/RatioResolutionPicker';

const range = (min: number, max: number, step: number, label: string, fallback: number): ParamDescriptor => ({
  description: '',
  label,
  min,
  max,
  step,
  default: fallback,
  fill: 'panel',
});

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
  params: {
    distance: range(0, 2, 1, 'Distance', 1),
    horizontal_angle: range(0, 315, 45, 'Horizontal angle', 0),
    vertical_angle: range(-30, 60, 30, 'Vertical angle', 0),
  },
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

  it('puts the first image the model is sent on the sphere\'s card', async () => {
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
