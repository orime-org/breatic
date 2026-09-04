// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ModelIcon, MODEL_ICON_NAMES } from '@web/spaces/canvas/generate/ModelIcon';

describe('ModelIcon — per-vendor brand marks for the model picker', () => {
  it('renders a distinct mark for every generatable-model icon name', () => {
    // The generate picker only shows generation models (t2i / i2i). Every one
    // of their config `icon` names MUST resolve to a real self-drawn mark —
    // there is no "unknown model" fallback (user 2026-07-09).
    for (const name of MODEL_ICON_NAMES) {
      const { unmount } = render(<ModelIcon name={name} />);
      expect(screen.getByTestId(`model-icon-${name}`)).toBeInTheDocument();
      unmount();
    }
  });

  it('covers every picker vendor, image and audio alike', () => {
    // Exact rather than containing: a name dropped from the registry while a
    // model's yaml still declares it draws nothing at all, and nothing else
    // would say so.
    expect([...MODEL_ICON_NAMES].sort()).toEqual([
      'elevenlabs',
      'qwen',
      'fish-audio',
      'midjourney',
      'nano-banana',
      'seedream',
    ]);
  });

  it('renders nothing for an absent icon name (undefined) rather than a fallback', () => {
    const { container } = render(<ModelIcon name={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('forwards a className onto the svg so the picker can size it', () => {
    render(<ModelIcon name='midjourney' className='h-4 w-4' />);
    const svg = screen.getByTestId('model-icon-midjourney');
    expect(svg).toHaveClass('h-4', 'w-4');
  });
});
