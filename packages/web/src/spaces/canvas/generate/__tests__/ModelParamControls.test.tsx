// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The controls only one model has, as a params popover draws them (#2156).
 */

import type { ModelEntry, ParamDescriptor } from '@breatic/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { ModelParamControls } from '@web/spaces/canvas/generate/ModelParamControls';

/**
 * A model declaring the given params.
 * @param params - What it declares.
 * @returns The catalog entry.
 */
function model(params: Record<string, ParamDescriptor>): ModelEntry {
  return {
    name: 'a-model',
    display_name: 'A Model',
    modality: 'image',
    mode: 't2i',
    description: '',
    guide: '',
    tier: 'optional',
    generation_time: 10,
    takes_prompt: true,
    params,
    providers: [],
  };
}

const MIXED = model({
  transparency: {
    description: '',
    label: 'Transparent background',
    values: [true, false],
    default: false,
    fill: 'panel',
  },
  quality: {
    description: '',
    label: 'Quality',
    values: ['low', 'xhigh'],
    value_labels: { xhigh: 'XHigh' },
    default: 'low',
    fill: 'panel',
  },
  chaos: { description: '', label: 'Chaos', min: 0, max: 100, step: 1, default: 20, fill: 'panel' },
  negative_prompt: {
    description: '',
    label: 'Negative prompt',
    type: 'text',
    default: null,
    fill: 'panel',
  },
});

describe('ModelParamControls', () => {
  it('draws each control with its English label, reading the model default when the node holds nothing', () => {
    render(<ModelParamControls model={MIXED} value={{}} onChange={() => {}} />);

    expect(screen.getByText('Transparent background')).toBeInTheDocument();
    expect(screen.getByTestId('generate-param-transparency-toggle')).toHaveAttribute(
      'data-state',
      'unchecked',
    );
    expect(screen.getByTestId('generate-param-quality-option-low')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('generate-param-quality-option-xhigh')).toHaveTextContent('XHigh');
    expect(screen.getByTestId('generate-param-chaos-value')).toHaveTextContent('20');
    expect(screen.getByLabelText('Negative prompt')).toHaveValue('');
  });

  it('reports a flipped switch and a picked option under the param name', () => {
    const onChange = vi.fn();
    render(<ModelParamControls model={MIXED} value={{}} onChange={onChange} />);

    fireEvent.click(screen.getByTestId('generate-param-transparency-toggle'));
    fireEvent.click(screen.getByTestId('generate-param-quality-option-xhigh'));

    expect(onChange).toHaveBeenCalledWith({ transparency: true });
    expect(onChange).toHaveBeenCalledWith({ quality: 'xhigh' });
  });

  it('writes the text once the reader leaves the box, not on every key', () => {
    const onChange = vi.fn();
    render(<ModelParamControls model={MIXED} value={{}} onChange={onChange} />);
    const box = screen.getByLabelText('Negative prompt');

    fireEvent.change(box, { target: { value: 'blur, text' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(box);

    expect(onChange).toHaveBeenCalledWith({ negative_prompt: 'blur, text' });
  });

  it('draws nothing for a model with no controls of its own', () => {
    const { container } = render(
      <ModelParamControls model={model({})} value={{}} onChange={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
