// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ModelEntry, ParamDescriptor } from '@breatic/shared';

import { RatioResolutionPicker } from '@web/spaces/canvas/generate/RatioResolutionPicker';
import { resolveParamsForModel } from '@web/spaces/canvas/generate/model-params';
import { expectAriaCurrentChosenFill } from '@web/test-utils/selection-fill';

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
    generation_time: 30,
    takes_prompt: true,
    params,
    providers: [],
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
  it('shows the current resolution · ratio on the trigger, in the popover\'s order', () => {
    render(
      <RatioResolutionPicker
        model={FULL}
        value={{ aspect_ratio: '16:9', resolution: '2K' }}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId('generate-ratio-trigger')).toHaveTextContent(
      '2K · 16:9',
    );
  });

  it('says on the trigger what each of the model\'s own controls stands on', () => {
    // User 2026-09-29: the pill shows every value the reader would send.
    const own = model({
      aspect_ratio: { ...RATIO, values: ['auto', '1:1'], default: 'auto' },
      resolution: RESOLUTION,
      quality: { description: '', label: 'Quality', values: ['low', 'max'], default: 'max', fill: 'panel' },
    });
    render(<RatioResolutionPicker model={own} value={resolveParamsForModel(own, { aspect_ratio: 'auto', resolution: '1K' })} onChange={() => {}} />);
    expect(screen.getByTestId('generate-ratio-trigger')).toHaveTextContent('1K · Auto · Max');
  });

  it('caps the pill at 150px, like the video and audio params pills', () => {
    render(<RatioResolutionPicker model={FULL} value={{ aspect_ratio: '16:9', resolution: '2K' }} onChange={() => {}} />);
    expect(screen.getByTestId('generate-ratio-trigger').className).toContain('max-w-[150px]');
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

  it('fills the current ratio past the fill the others take under the pointer', () => {
    render(
      <RatioResolutionPicker
        model={FULL}
        value={{ aspect_ratio: '1:1', resolution: '1K' }}
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('generate-ratio-trigger'));
    const chosen = screen.getByTestId('generate-ratio-option-1:1');
    expect(chosen).toHaveAttribute('aria-current', 'true');
    expectAriaCurrentChosenFill(chosen);
    expect(screen.getByTestId('generate-ratio-option-16:9')).toHaveAttribute(
      'aria-current',
      'false',
    );
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
