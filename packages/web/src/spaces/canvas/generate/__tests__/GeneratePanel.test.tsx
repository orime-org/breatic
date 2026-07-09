// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ModelEntry } from '@breatic/shared';

import { GeneratePanel } from '@web/spaces/canvas/generate/GeneratePanel';

const MODEL: ModelEntry = {
  name: 'nano_banana_pro',
  display_name: 'Nano Banana Pro',
  modality: 'image',
  mode: 'text-to-image',
  description: '',
  guide: '',
  tier: 'recommended',
  cost_per_call: 7,
  generation_time: 30,
  params: {
    aspect_ratio: { description: '', values: ['1:1', '16:9'], default: '1:1' },
    resolution: { description: '', values: ['1K', '2K'], default: '1K' },
  },
  providers: [],
};

/**
 * Renders the panel with sensible defaults, overridable per test.
 * @param overrides - Props overriding the defaults.
 * @returns The render result.
 */
function setup(
  overrides: Partial<React.ComponentProps<typeof GeneratePanel>> = {},
): ReturnType<typeof render> {
  return render(
    <GeneratePanel
      models={[MODEL]}
      model='nano_banana_pro'
      params={{ aspect_ratio: '16:9', resolution: '2K' }}
      references={[]}
      creditEstimate={7}
      canExecute
      promptSlot={<div data-testid='prompt-slot'>prompt</div>}
      onExit={() => {}}
      onSelectModel={() => {}}
      onChangeParams={() => {}}
      onAddReference={() => {}}
      onRemoveReference={() => {}}
      onExecute={() => {}}
      {...overrides}
    />,
  );
}

describe('GeneratePanel — the collaborative image-node Generate panel shell (slice 1)', () => {
  it('renders the exit button, prompt slot, model picker and credit estimate', () => {
    setup();
    expect(screen.getByTestId('generate-exit')).toBeInTheDocument();
    expect(screen.getByTestId('prompt-slot')).toBeInTheDocument();
    expect(screen.getByTestId('generate-model-trigger')).toHaveTextContent(
      'Nano Banana Pro',
    );
    expect(screen.getByTestId('generate-credit')).toHaveTextContent('7');
  });

  it('renders the unbuilt footer controls as disabled placeholders (岔路二 B)', () => {
    setup();
    expect(screen.getByTestId('generate-presets')).toBeDisabled();
    expect(screen.getByTestId('generate-camera')).toBeDisabled();
    expect(screen.getByTestId('generate-online')).toBeDisabled();
    expect(screen.getByTestId('generate-translate')).toBeDisabled();
  });

  it('fires onExit when the exit button is clicked', () => {
    const onExit = vi.fn();
    setup({ onExit });
    fireEvent.click(screen.getByTestId('generate-exit'));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('disables the execute button when canExecute is false', () => {
    setup({ canExecute: false });
    expect(screen.getByTestId('generate-execute')).toBeDisabled();
  });

  it('fires onExecute when execute is clicked and enabled', () => {
    const onExecute = vi.fn();
    setup({ canExecute: true, onExecute });
    fireEvent.click(screen.getByTestId('generate-execute'));
    expect(onExecute).toHaveBeenCalledTimes(1);
  });

  it('does not render a count control (count is fixed to 1)', () => {
    setup();
    expect(screen.queryByTestId('generate-count')).toBeNull();
  });
});
