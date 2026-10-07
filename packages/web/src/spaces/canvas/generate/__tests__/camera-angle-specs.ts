// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The three camera params of Qwen Image Multiple Angles as the catalog ships
 * them, named in English by `value_labels` (inner#830).
 */

import type { ParamDescriptor } from '@breatic/shared';

export const CAMERA_PARAMS = { azimuth: 'horizontal_angle', elevation: 'vertical_angle', distance: 'distance' };

export const CAMERA_SPECS: Record<string, ParamDescriptor> = {
  horizontal_angle: {
    description: '',
    label: 'Horizontal angle',
    min: 0,
    max: 315,
    step: 45,
    default: 0,
    fill: 'panel',
    value_labels: {
      0: 'Front',
      45: 'Front right',
      90: 'Right',
      135: 'Back right',
      180: 'Back',
      225: 'Back left',
      270: 'Left',
      315: 'Front left',
    },
  },
  vertical_angle: {
    description: '',
    label: 'Vertical angle',
    min: -30,
    max: 60,
    step: 30,
    default: 0,
    fill: 'panel',
    value_labels: { '-30': 'Low angle', 0: 'Eye level', 30: 'Elevated', 60: 'High angle' },
  },
  distance: {
    description: '',
    label: 'Distance',
    min: 0,
    max: 2,
    step: 1,
    default: 1,
    fill: 'panel',
    value_labels: { 0: 'Close-up', 1: 'Medium shot', 2: 'Wide shot' },
  },
};
