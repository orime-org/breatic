// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

import { ThumbnailHoverPreview } from '@web/spaces/canvas/generate/ThumbnailHoverPreview';

// A Radix TooltipTrigger stamps `data-state` on its (asChild) trigger element;
// a short-circuited preview renders the child untouched. So `data-state` present
// ⇔ the tooltip wrapper mounted.
describe('ThumbnailHoverPreview — mount gate', () => {
  it('renders NO tooltip when there is no src/text/emptyHint/resolver (unhandled modality — batch-5 adversarial finding 2)', () => {
    const { getByTestId } = render(
      <ThumbnailHoverPreview alt='x'>
        <span data-testid='chip'>chip</span>
      </ThumbnailHoverPreview>,
    );
    // No preview content of any kind → the trigger is rendered unchanged, so an
    // audio / 3d / web / legacy chip gets no empty tooltip box on hover.
    expect(getByTestId('chip')).not.toHaveAttribute('data-state');
  });

  it('mounts the tooltip for a text chip (live resolver present)', () => {
    const { getByTestId } = render(
      <ThumbnailHoverPreview alt='x' resolveOnOpen={() => ({ text: 'hi' })}>
        <span data-testid='chip'>chip</span>
      </ThumbnailHoverPreview>,
    );
    expect(getByTestId('chip')).toHaveAttribute('data-state');
  });

  it('mounts the tooltip for the static rail path (attr-backed text / emptyHint)', () => {
    const { getByTestId } = render(
      <ThumbnailHoverPreview alt='x' text='body'>
        <span data-testid='chip'>chip</span>
      </ThumbnailHoverPreview>,
    );
    expect(getByTestId('chip')).toHaveAttribute('data-state');
  });

  it('mounts the tooltip for a visual chip with only an empty hint (image with no thumbnail)', () => {
    const { getByTestId } = render(
      <ThumbnailHoverPreview alt='x' emptyHint='not yet filled'>
        <span data-testid='chip'>chip</span>
      </ThumbnailHoverPreview>,
    );
    expect(getByTestId('chip')).toHaveAttribute('data-state');
  });

  it('seeds the live resolver at mount so it never renders before resolving', () => {
    // The resolver runs once at mount (state initializer) — proves the preview is
    // populated before the first open, not left undefined for a frame.
    const resolve = vi.fn(() => ({ text: 'seeded' }));
    render(
      <ThumbnailHoverPreview alt='x' resolveOnOpen={resolve}>
        <span data-testid='chip'>chip</span>
      </ThumbnailHoverPreview>,
    );
    expect(resolve).toHaveBeenCalled();
  });
});
