// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

import { TooltipProvider } from '@web/components/ui/tooltip';
import { GenerateToolbar } from '@web/spaces/canvas/generate/GenerateToolbar';

/**
 * Renders the toolbar with no-op defaults, overridable per test. Wrapped in
 * the app-level TooltipProvider (App.tsx mounts the real one) — the toolbar
 * deliberately has no provider of its own, so bare Radix Tooltips throw.
 * @param overrides - Props overriding the defaults.
 * @returns The render result.
 */
function setup(
  overrides: Partial<React.ComponentProps<typeof GenerateToolbar>> = {},
): ReturnType<typeof render> {
  return render(
    <TooltipProvider delayDuration={100}>
      <GenerateToolbar
        onReference={() => {}}
        onFocus={() => {}}
        {...overrides}
      />
    </TooltipProvider>,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('GenerateToolbar — Reference / Focus are the live tools', () => {
  it('renders exactly the two live tool buttons — Mark was cut (user 2026-07-17, decision C)', () => {
    setup();
    expect(screen.getByTestId('generate-tool-focus')).toBeInTheDocument();
    expect(screen.getByTestId('generate-tool-reference')).toBeInTheDocument();
    expect(screen.queryByTestId('generate-tool-mark')).toBeNull();
  });

  it('leaves Reference and Focus enabled (#1986)', () => {
    // Not a default the caller can flip: since #1986 the toolbar accepts no
    // flag for either of these two, so nothing it renders can turn them off.
    // The refusal for what a mode cannot use lives on the reference row.
    setup();
    expect(screen.getByTestId('generate-tool-focus')).not.toBeDisabled();
    expect(screen.getByTestId('generate-tool-reference')).not.toBeDisabled();
  });

  it('fires onFocus when Focus is clicked; highlights while active (#1782)', () => {
    const onFocus = vi.fn();
    setup({ onFocus, focusActive: true });
    const btn = screen.getByTestId('generate-tool-focus');
    fireEvent.click(btn);
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  it('fires onReference when Reference is clicked', () => {
    const onReference = vi.fn();
    setup({ onReference });
    fireEvent.click(screen.getByTestId('generate-tool-reference'));
    expect(onReference).toHaveBeenCalledTimes(1);
  });

  it('Reference is available in both modes — the button never disables (#1788 batch-3 #1)', () => {
    // Text-to-image scopes the reference PICK to text sources (the canvas pick
    // rejects image nodes), but the button itself stays enabled so you can
    // always enter the pick. (It was disabled in t2i before #1788 batch-3.)
    setup();
    expect(screen.getByTestId('generate-tool-reference')).not.toBeDisabled();
  });

  it('tooltips inherit the surrounding provider timing — no nested TooltipProvider (user 2026-07-17)', () => {
    // The app mounts ONE TooltipProvider (App.tsx, delayDuration 100) — the
    // calibrated timing every chrome tooltip shares (left floating menu & co).
    // A nested per-button provider overrides it, so the toolbar tips showed
    // up on their own schedule. Repro: under a fast outer provider, a hover
    // must open the tip on the OUTER delay; a nested 300ms provider keeps it
    // closed at this point.
    vi.useFakeTimers();
    render(
      <TooltipProvider delayDuration={5}>
        <GenerateToolbar
          onReference={() => {}}
          onFocus={() => {}}
        />
      </TooltipProvider>,
    );
    const btn = screen.getByTestId('generate-tool-focus');
    fireEvent.pointerMove(btn, { pointerType: 'mouse' });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(screen.queryAllByRole('tooltip').length).toBeGreaterThan(0);
  });

  it('suppresses the focus-opened tooltip on every tool trigger (smoke 2026-07-17)', () => {
    // Radix Tooltip opens INSTANTLY on trigger focus (bypassing delayDuration).
    // Real-browser smoke caught the consequence: with a tool button focused
    // after a click, its tooltip is open and the user's first Escape dismisses
    // the tooltip instead of the pick session. The shipped pattern for every
    // tooltip-wrapped chrome button is suppressTooltipFocusOpen on the
    // trigger (ViewportToolbar & co) — hover still opens the tip.
    setup();
    for (const id of ['generate-tool-focus', 'generate-tool-reference']) {
      fireEvent.focus(screen.getByTestId(id));
      expect(screen.queryByRole('tooltip')).toBeNull();
      expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
    }
  });

  it('renders the active Reference in the minimap white-fill style (not bg-accent)', () => {
    setup({ referenceActive: true });
    const btn = screen.getByTestId('generate-tool-reference');
    expect(btn.className).toContain('bg-foreground');
    expect(btn.className).toContain('text-background');
    expect(btn.className).not.toContain('bg-accent');
    expect(btn).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders the inactive Reference without the fill', () => {
    setup();
    const btn = screen.getByTestId('generate-tool-reference');
    expect(btn.className).not.toContain('bg-foreground');
    expect(btn).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('GenerateToolbar — the style area (inner#826)', () => {
  it('draws no style area for a model that takes no style images', () => {
    setup({ styleCap: undefined, styleImages: [] });
    expect(screen.queryByTestId('generate-tool-style')).toBeNull();
  });

  it('draws one Style button while the slot is empty', () => {
    setup({ styleCap: 3, styleImages: [] });
    expect(screen.getByTestId('generate-tool-style')).toBeInTheDocument();
    expect(screen.queryByTestId('generate-style-thumbnail-0')).toBeNull();
  });

  it('draws each style image and one more place while there is room', () => {
    const onStylePick = vi.fn();
    setup({ styleCap: 3, styleImages: ['https://cdn/a.png', 'https://cdn/b.png'], onStylePick });
    expect(screen.getByTestId('generate-style-thumbnail-0')).toHaveAttribute('src', 'https://cdn/a.png');
    expect(screen.getByTestId('generate-style-thumbnail-1')).toHaveAttribute('src', 'https://cdn/b.png');
    const add = screen.getByTestId('generate-tool-style');
    expect(add).toHaveTextContent('2/3');
    fireEvent.click(add);
    expect(onStylePick).toHaveBeenCalled();
  });

  it('drops the extra place once the slot is full', () => {
    setup({ styleCap: 3, styleImages: ['a', 'b', 'c'] });
    expect(screen.queryByTestId('generate-tool-style')).toBeNull();
    expect(screen.getByTestId('generate-style-thumbnail-2')).toBeInTheDocument();
  });

  it('names the empty slot with a palette and turns the extra place into a plus', () => {
    const { unmount } = setup({ styleCap: 3, styleImages: [] });
    expect(screen.getByTestId('generate-tool-style').querySelector('svg.lucide-palette')).not.toBeNull();
    unmount();
    setup({ styleCap: 3, styleImages: ['a'] });
    const add = screen.getByTestId('generate-tool-style');
    expect(add.querySelector('svg.lucide-plus')).not.toBeNull();
    expect(add.querySelector('svg.lucide-palette')).toBeNull();
  });

  it('shows the running pick on the extra place only, never on a held image', () => {
    setup({ styleCap: 3, styleImages: ['a', 'b'], styleActive: true });
    expect(screen.getByTestId('generate-tool-style')).toHaveAttribute('aria-pressed', 'true');
    for (const i of [0, 1]) {
      const held = screen.getByTestId(`generate-tool-style-item-${i}`);
      expect(held).toHaveAttribute('aria-pressed', 'false');
      expect(held.className).not.toContain('ring-foreground');
    }
  });

  it('removes exactly the image whose ✕ is pressed', () => {
    const onRemoveStyle = vi.fn();
    setup({ styleCap: 3, styleImages: ['a', 'b'], onRemoveStyle });
    fireEvent.click(screen.getByTestId('generate-style-clear-1'));
    expect(onRemoveStyle).toHaveBeenCalledWith('b');
  });
});
