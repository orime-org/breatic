// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ModelEntry } from '@breatic/shared';

import { ModelPicker } from '@web/spaces/canvas/generate/ModelPicker';

/**
 * Builds a minimal image model entry for the picker tests.
 * @param name - The model id.
 * @param displayName - The human-facing name.
 * @returns A model entry.
 */
function model(name: string, displayName: string): ModelEntry {
  return {
    name,
    display_name: displayName,
    modality: 'image',
    mode: 'text-to-image',
    description: '',
    guide: '',
    tier: 'recommended',
    cost_per_call: 7,
    generation_time: 30,
    params: {},
    providers: [],
  };
}

const MODELS = [
  model('nano_banana_pro', 'Nano Banana Pro'),
  model('midjourney_v7', 'Midjourney V7'),
];

describe('ModelPicker — pick the generation model from the catalog', () => {
  it('shows the current model’s display name on the trigger', () => {
    render(
      <ModelPicker models={MODELS} value='nano_banana_pro' onChange={() => {}} />,
    );
    expect(screen.getByTestId('generate-model-trigger')).toHaveTextContent(
      'Nano Banana Pro',
    );
  });

  it('lists every catalog model and fires onChange with the picked model id', () => {
    const onChange = vi.fn();
    render(
      <ModelPicker models={MODELS} value='nano_banana_pro' onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId('generate-model-trigger'));
    fireEvent.click(screen.getByTestId('generate-model-option-midjourney_v7'));
    expect(onChange).toHaveBeenCalledWith('midjourney_v7');
  });

  it('falls back to the raw model id on the trigger when it is not in the catalog', () => {
    render(
      <ModelPicker models={MODELS} value='unknown_model' onChange={() => {}} />,
    );
    expect(screen.getByTestId('generate-model-trigger')).toHaveTextContent(
      'unknown_model',
    );
  });
});
