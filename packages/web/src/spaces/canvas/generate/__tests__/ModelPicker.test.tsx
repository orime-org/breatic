// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ModelEntry } from '@breatic/shared';

import { ModelPicker } from '@web/spaces/canvas/generate/ModelPicker';
import { panCanvasViewport } from '@web/spaces/canvas/generate/__tests__/canvas-viewport-test-utils';
import {
  expectChosenFill,
  expectHoverableSiblingFill,
} from '@web/test-utils/selection-fill';

/**
 * Builds a minimal image model entry for the picker tests.
 * @param name - The model id.
 * @param displayName - The human-facing name.
 * @param description - What the model is good at, shown under its name.
 * @returns A model entry.
 */
function model(
  name: string,
  displayName: string,
  description = '',
): ModelEntry {
  return {
    name,
    display_name: displayName,
    modality: 'image',
    mode: 'text-to-image',
    description,
    guide: '',
    tier: 'recommended',
    generation_time: 30,
    takes_prompt: true,
    params: {},
    providers: [],
  };
}

const MODELS = [
  model('nano_banana_pro', 'Nano Banana Pro'),
  model('midjourney_v7', 'Midjourney V7'),
];

describe('ModelPicker — pick the generation model from the catalog', () => {
  it('joins a variant onto a name only where the list holds two models of that name', () => {
    const t2v = { ...model('g-t2v', 'Gemini Omni 1.1 Flash'), variant: 'Text-to-Video' };
    const ref = { ...model('g-ref', 'Gemini Omni 1.1 Flash'), variant: 'Reference' };
    const kling = { ...model('kling', 'Kling 3.0 4K'), variant: 'Text-to-Video' };
    render(<ModelPicker models={[t2v, ref, kling]} value='g-ref' onChange={() => {}} />);
    expect(screen.getByTestId('generate-model-trigger')).toHaveTextContent('Gemini Omni 1.1 Flash Reference');
    fireEvent.click(screen.getByTestId('generate-model-trigger'));
    expect(screen.getByTestId('generate-model-option-g-t2v')).toHaveTextContent('Gemini Omni 1.1 Flash Text-to-Video');
    expect(screen.getByTestId('generate-model-option-kling')).toHaveTextContent('Kling 3.0 4K');
    expect(screen.getByTestId('generate-model-option-kling')).not.toHaveTextContent('Text-to-Video');
  });


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

  it('fills the current model past the fill the others take under the pointer', () => {
    render(
      <ModelPicker models={MODELS} value='nano_banana_pro' onChange={() => {}} />,
    );
    fireEvent.click(screen.getByTestId('generate-model-trigger'));
    expectChosenFill(screen.getByTestId('generate-model-option-nano_banana_pro'));
    expectHoverableSiblingFill(
      screen.getByTestId('generate-model-option-midjourney_v7'),
    );
  });

  // A check mark says "more than one of these can be on at once" (user
  // 2026-09-01, #1960 D5). Picking a model is single-choice, so the fill above
  // is the whole mark. The model icon beside the name stays — it names the
  // vendor, it does not report a choice.
  it('marks the current model with fill alone, with no check mark on any row', () => {
    render(
      <ModelPicker models={MODELS} value='nano_banana_pro' onChange={() => {}} />,
    );
    fireEvent.click(screen.getByTestId('generate-model-trigger'));
    expect(
      screen
        .getByTestId('generate-model-option-nano_banana_pro')
        .querySelector('.lucide-check'),
    ).toBeNull();
    expect(
      screen
        .getByTestId('generate-model-option-midjourney_v7')
        .querySelector('.lucide-check'),
    ).toBeNull();
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

  // #1796: the picker is a Radix Popover whose Floating-UI auto-update reacts to
  // scroll / resize but NOT to the ReactFlow viewport's CSS-transform pan/zoom,
  // so an open popover drifted off its trigger as the canvas moved. It now calls
  // useFollowCanvasViewport(open) — nudging a resize each frame the viewport
  // transforms — so it follows the node like the ratio / camera pickers.
  describe('follows the canvas viewport while open (#1796)', () => {
    afterEach(() => {
      document
        .querySelectorAll('.react-flow__viewport')
        .forEach((n) => n.remove());
    });

    it('nudges a reposition on a viewport transform ONLY while open', async () => {
      const viewport = document.createElement('div');
      viewport.className = 'react-flow__viewport';
      viewport.style.transform = 'translate(0px, 0px) scale(1)';
      document.body.appendChild(viewport);
      const onResize = vi.fn();
      window.addEventListener('resize', onResize);
      try {
        render(
          <ModelPicker
            models={MODELS}
            value='nano_banana_pro'
            onChange={() => {}}
          />,
        );
        // Closed → the follow is inert: a pan must not dispatch a reposition.
        await panCanvasViewport(viewport, 'translate(-10px, 0px) scale(1)');
        expect(onResize).not.toHaveBeenCalled();
        // Open the picker, then pan → the hook nudges a resize.
        fireEvent.click(screen.getByTestId('generate-model-trigger'));
        await panCanvasViewport(viewport, 'translate(-40px, -20px) scale(1)');
        expect(onResize).toHaveBeenCalled();
      } finally {
        window.removeEventListener('resize', onResize);
      }
    });
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

  // When one mode offers several models, the name alone does not tell a
  // reader which to pick — the catalog's `description` is what says what
  // each one is good at, so the row has to show it.
  describe('the capability line under each model name', () => {
    it('shows what the model is good at under its name', () => {
      const withBlurbs = [
        model('nano', 'Nano Banana Pro', 'Flagship quality, 4K, lens control'),
        model('mj', 'Midjourney', 'Distinct aesthetic, stylised output'),
      ];
      render(
        <ModelPicker models={withBlurbs} value='nano' onChange={() => {}} />,
      );
      fireEvent.click(screen.getByTestId('generate-model-trigger'));
      const option = screen.getByTestId('generate-model-option-nano');
      expect(option).toHaveTextContent('Nano Banana Pro');
      expect(option).toHaveTextContent('Flagship quality, 4K, lens control');
      // Muted and smaller than the name, so the name still leads the row.
      const blurb = screen.getByText('Flagship quality, 4K, lens control');
      expect(blurb.className).toContain('text-xs');
      expect(blurb.className).toContain('text-muted-foreground');
      // Every model's own line, not just the chosen one's.
      expect(
        screen.getByTestId('generate-model-option-mj'),
      ).toHaveTextContent('Distinct aesthetic, stylised output');
    });

    it('leaves the row a single line when the catalog says nothing', () => {
      // `description` is `z.string().catch("")` at the catalog boundary, so an
      // entry that declares none arrives as an empty string — an empty muted
      // line would add a blank row of whitespace under the name.
      render(
        <ModelPicker models={MODELS} value='nano_banana_pro' onChange={() => {}} />,
      );
      fireEvent.click(screen.getByTestId('generate-model-trigger'));
      const option = screen.getByTestId('generate-model-option-nano_banana_pro');
      expect(option.textContent).toBe('Nano Banana Pro');
      expect(
        option.querySelectorAll('span.text-muted-foreground'),
      ).toHaveLength(0);
    });
  });
});
