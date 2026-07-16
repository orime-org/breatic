// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ModelEntry, ParamDescriptor } from '@breatic/shared';

import { RatioResolutionPicker } from '@web/spaces/canvas/generate/RatioResolutionPicker';

/**
 * Builds an image model with the given params for the picker tests.
 * @param params - The model's param descriptors.
 * @returns A model entry.
 */
function model(params: Record<string, ParamDescriptor>): ModelEntry {
  return {
    name: 'm',
    display_name: 'M',
    modality: 'image',
    mode: 'text-to-image',
    description: '',
    guide: '',
    tier: 'recommended',
    cost_per_call: 7,
    generation_time: 30,
    params,
    providers: [],
    sourcesByMode: {},
  };
}

const RATIO: ParamDescriptor = {
  description: 'Aspect ratio',
  values: ['1:1', '16:9', '4:3'],
  default: '1:1',
};
const RESOLUTION: ParamDescriptor = {
  description: 'Resolution',
  values: ['1K', '2K'],
  default: '1K',
};
const FULL = model({ aspect_ratio: RATIO, resolution: RESOLUTION });

describe('RatioResolutionPicker — ratio + resolution from the current model params', () => {
  it('shows the current ratio · resolution on the trigger', () => {
    render(
      <RatioResolutionPicker
        model={FULL}
        value={{ aspect_ratio: '16:9', resolution: '2K' }}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId('generate-ratio-trigger')).toHaveTextContent(
      '16:9 · 2K',
    );
  });

  it('picking a ratio fires onChange with the aspect_ratio', () => {
    const onChange = vi.fn();
    render(
      <RatioResolutionPicker
        model={FULL}
        value={{ aspect_ratio: '1:1', resolution: '1K' }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('generate-ratio-trigger'));
    fireEvent.click(screen.getByTestId('generate-ratio-option-16:9'));
    expect(onChange).toHaveBeenCalledWith({ aspect_ratio: '16:9' });
  });

  // Malformed-catalog robustness (non-array param values) is now enforced ONCE
  // at the API boundary — see sanitizeModelCatalog + model-catalog.schema.test.ts.
  // The picker consumes the sanitized, trusted ModelEntry, so that
  // impossible-after-boundary state is no longer re-tested here.

  it('picking a resolution fires onChange with the resolution', () => {
    const onChange = vi.fn();
    render(
      <RatioResolutionPicker
        model={FULL}
        value={{ aspect_ratio: '1:1', resolution: '1K' }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('generate-ratio-trigger'));
    fireEvent.click(screen.getByTestId('generate-resolution-option-2K'));
    expect(onChange).toHaveBeenCalledWith({ resolution: '2K' });
  });

  it('omits the ratio section for a model with no aspect_ratio param', () => {
    render(
      <RatioResolutionPicker
        model={model({ resolution: RESOLUTION })}
        value={{ resolution: '2K' }}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('generate-ratio-trigger'));
    expect(screen.queryByTestId('generate-ratio-option-16:9')).toBeNull();
    expect(screen.getByTestId('generate-resolution-option-1K')).toBeInTheDocument();
  });
});
