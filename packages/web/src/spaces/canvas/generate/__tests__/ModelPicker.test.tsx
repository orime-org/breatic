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

  // Popover item consistency (spec §9.4, user-ratified: copy the language /
  // theme switcher exactly). Their pattern is a gap-0.5 column of ghost
  // Buttons — the gap keeps the hover and selected highlights from gluing
  // into one block (user's screenshot); role=listbox / <li> were a semantics
  // lie (no listbox keyboard model), so the plain button column replaces them.
  it('marks the selected model (aria-pressed) and lays options out like the language switcher', () => {
    render(
      <ModelPicker models={MODELS} value='nano_banana_pro' onChange={() => {}} />,
    );
    fireEvent.click(screen.getByTestId('generate-model-trigger'));
    const selected = screen.getByTestId('generate-model-option-nano_banana_pro');
    const other = screen.getByTestId('generate-model-option-midjourney_v7');
    expect(selected).toHaveAttribute('aria-pressed', 'true');
    expect(other).toHaveAttribute('aria-pressed', 'false');
    expect(selected.parentElement?.className).toContain('gap-0.5');
    expect(selected.className).toContain('py-1.5');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.querySelector('[role="option"]')).toBeNull();
  });

  // Round-2 adversarial: the catalog boundary puts NO length cap on
  // display_name, and Button's base cva carries whitespace-nowrap while
  // Radix's popper wrapper enforces min-width:max-content — one long name
  // would stretch the popover past the viewport. The label must truncate
  // inside a bounded popover instead.
  it('truncates a pathologically long display name inside a bounded popover', () => {
    const long = [model('long', 'A'.repeat(300))];
    render(<ModelPicker models={long} value='long' onChange={() => {}} />);
    fireEvent.click(screen.getByTestId('generate-model-trigger'));
    const option = screen.getByTestId('generate-model-option-long');
    const label = option.querySelector('span.truncate');
    expect(label).not.toBeNull();
    expect(label?.textContent).toBe('A'.repeat(300));
  });
});
