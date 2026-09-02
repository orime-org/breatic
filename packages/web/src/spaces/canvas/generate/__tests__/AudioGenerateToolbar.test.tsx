// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { AudioGenerateToolbar } from '@web/spaces/canvas/generate/AudioGenerateToolbar';

/**
 * Renders the toolbar with no-op defaults, overridable per test. Wrapped in the
 * app-level TooltipProvider (App.tsx mounts the real one) — the toolbar
 * deliberately has no provider of its own, so bare Radix Tooltips throw.
 * @param overrides - Props overriding the defaults.
 * @returns The render result.
 */
function setup(
  overrides: Partial<React.ComponentProps<typeof AudioGenerateToolbar>> = {},
): ReturnType<typeof render> {
  return render(
    <TooltipProvider delayDuration={100}>
      <AudioGenerateToolbar onReference={() => {}} {...overrides} />
    </TooltipProvider>,
  );
}

describe('AudioGenerateToolbar — Reference is the row', () => {
  it('renders the Reference tool', () => {
    setup();
    expect(screen.getByTestId('generate-audio-tool-reference')).toBeInTheDocument();
  });

  it('carries neither Focus nor Style — an audio node takes only text (connection-rules.ts:30)', () => {
    // Focus crops a region OF AN IMAGE into a standalone reference and Style
    // holds a picked image; an audio node's only accepted input is a text one,
    // so both entries would collect something this panel can never use.
    setup();
    expect(screen.queryByTestId('generate-audio-tool-focus')).toBeNull();
    expect(screen.queryByTestId('generate-audio-tool-style')).toBeNull();
  });

  it('fires onReference when Reference is clicked', () => {
    const onReference = vi.fn();
    setup({ onReference });
    fireEvent.click(screen.getByTestId('generate-audio-tool-reference'));
    expect(onReference).toHaveBeenCalledTimes(1);
  });

  it('renders the active Reference in the minimap white-fill style', () => {
    setup({ referenceActive: true });
    const btn = screen.getByTestId('generate-audio-tool-reference');
    expect(btn.className).toContain('bg-foreground');
    expect(btn.className).toContain('text-background');
    expect(btn).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders the inactive Reference without the fill', () => {
    setup();
    const btn = screen.getByTestId('generate-audio-tool-reference');
    expect(btn.className).not.toContain('bg-foreground');
    expect(btn).toHaveAttribute('aria-pressed', 'false');
  });

  it('never disables Reference — the refusal belongs on the row it produces', () => {
    // Same decision as the other two rows (#1986): a toggle only COLLECTS, and
    // a row this panel cannot use is refused in the rail, where the refusal can
    // say why. A disabled button dispatches no click and can say nothing.
    setup();
    expect(screen.getByTestId('generate-audio-tool-reference')).not.toBeDisabled();
  });

  it('suppresses the focus-opened tooltip on the tool trigger', () => {
    // Radix Tooltip opens INSTANTLY on trigger focus, bypassing delayDuration.
    // The canvas hands focus back to a pick trigger when a pick ends, so
    // without the suppression the tip sits over the canvas and eats the user's
    // first Escape (smoke 2026-07-17).
    setup();
    fireEvent.focus(screen.getByTestId('generate-audio-tool-reference'));
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
  });

  it('sends the user after text, the only thing an audio node accepts', async () => {
    // The image and video toolbars share a tip naming images. An audio node's
    // whitelist is text alone (connection-rules.ts:29), so that tip would point
    // at the one kind of node this pick greys out and then refuses.
    setup();
    fireEvent.pointerMove(screen.getByTestId('generate-audio-tool-reference'), {
      pointerType: 'mouse',
    });
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent?.toLowerCase()).toContain('text');
    expect(tip.textContent?.toLowerCase()).not.toContain('image');
  });
});
