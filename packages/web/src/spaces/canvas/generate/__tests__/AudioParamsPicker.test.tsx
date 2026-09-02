// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ModelEntry, ParamDescriptor } from '@breatic/shared';
import type * as React from 'react';

// Pass the tooltip primitives through: real Radix Tooltip throws without the
// app-level provider, and this trigger is both a TooltipTrigger and a
// PopoverTrigger.
vi.mock('@web/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children?: React.ReactNode }) => children,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children?: React.ReactNode }) => children,
}));

import { AudioParamsPicker } from '@web/spaces/canvas/generate/AudioParamsPicker';

/**
 * A tts model declaring the given params.
 * @param params - The model's param descriptors.
 * @returns A model entry.
 */
function model(params: Record<string, ParamDescriptor>): ModelEntry {
  return {
    name: 'm',
    display_name: 'M',
    modality: 'tts',
    mode: 'tts',
    description: '',
    guide: '',
    tier: 'recommended',
    cost_per_call: 10,
    generation_time: 30,
    takes_prompt: true,
    params,
    providers: [],
    sourcesByMode: {},
  };
}

const ELEVENLABS = model({
  voice_id: { description: '', default: 'Alice', remote_source: 'voices' },
  stability: { description: '', values: [0, 0.5, 1], default: 0.5 },
  similarity: { description: '', min: 0, max: 1, step: 0.05, default: 0.75 },
});
const FISH = model({
  speed: { description: '', min: 0.5, max: 2, step: 0.05, default: 1 },
  volume: { description: '', min: -20, max: 20, step: 1, default: 0 },
});

/**
 * Renders the picker and opens its popover.
 * @param entry - The active model.
 * @param value - The current values.
 * @param onChange - Change handler.
 */
function open(
  entry: ModelEntry,
  value: Record<string, number>,
  onChange: (partial: Record<string, number>) => void = () => {},
): void {
  render(<AudioParamsPicker model={entry} value={value} onChange={onChange} />);
  fireEvent.click(screen.getByTestId('generate-audio-params-trigger'));
}

describe('AudioParamsPicker — the speaking params the active model declares', () => {
  it('offers ElevenLabs\' stability stops by the vendor\'s own names', () => {
    // The vendor documents v3's three stops as Creative / Natural / Robust and
    // never as numbers.
    open(ELEVENLABS, { stability: 0.5, similarity: 0.75 });
    expect(screen.getByTestId('generate-audio-stability-option-0')).toHaveTextContent(
      'Creative',
    );
    expect(screen.getByTestId('generate-audio-stability-option-0.5')).toHaveTextContent(
      'Natural',
    );
    expect(screen.getByTestId('generate-audio-stability-option-1')).toHaveTextContent(
      'Robust',
    );
  });

  it('offers similarity as a slider carrying the model\'s own bounds', () => {
    open(ELEVENLABS, { stability: 0.5, similarity: 0.75 });
    const slider = screen.getByRole('slider', { name: 'Similarity' });
    expect(slider).toHaveAttribute('aria-valuemin', '0');
    expect(slider).toHaveAttribute('aria-valuemax', '1');
    expect(slider).toHaveAttribute('aria-valuenow', '0.75');
  });

  it('shows Fish\'s pair and neither of ElevenLabs\'', () => {
    open(FISH, { speed: 1, volume: 0 });
    expect(screen.getByRole('slider', { name: 'Speed' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Volume' })).toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: 'Similarity' })).toBeNull();
    expect(screen.queryByTestId('generate-audio-stability-option-0')).toBeNull();
  });

  it('reads each value in its own unit beside its label', () => {
    open(FISH, { speed: 1.25, volume: -5 });
    expect(screen.getByTestId('generate-audio-speed-value')).toHaveTextContent('1.25x');
    expect(screen.getByTestId('generate-audio-volume-value')).toHaveTextContent('-5 dB');
  });

  it('picking a stability stop fires onChange with the NUMBER', () => {
    // The catalog states these as numbers and the vendor expects numbers; a
    // display string would reach the provider as "1" and be rejected.
    const onChange = vi.fn();
    open(ELEVENLABS, { stability: 0.5, similarity: 0.75 }, onChange);
    fireEvent.click(screen.getByTestId('generate-audio-stability-option-1'));
    expect(onChange).toHaveBeenCalledWith({ stability: 1 });
  });

  it('moving a slider fires onChange with the stepped value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    open(FISH, { speed: 1, volume: 0 }, onChange);
    screen.getByRole('slider', { name: 'Speed' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith({ speed: 1.05 });
  });

  it('falls back to the model default when the node holds no value yet', () => {
    // A node generated before this control existed has nothing stored; the
    // control must show what the model would use, not an empty slider.
    open(ELEVENLABS, {});
    expect(screen.getByRole('slider', { name: 'Similarity' })).toHaveAttribute(
      'aria-valuenow',
      '0.75',
    );
  });

  it('renders nothing at all for a model declaring no such param', () => {
    // No empty pill that opens onto nothing.
    render(
      <AudioParamsPicker
        model={model({ voice_id: { description: '', default: null, remote_source: 'voices' } })}
        value={{}}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByTestId('generate-audio-params-trigger')).toBeNull();
  });
});
