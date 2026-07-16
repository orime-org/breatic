// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { GenerateToolbar } from '@web/spaces/canvas/generate/GenerateToolbar';

/**
 * Renders the toolbar with no-op defaults, overridable per test.
 * @param overrides - Props overriding the defaults.
 * @returns The render result.
 */
function setup(
  overrides: Partial<React.ComponentProps<typeof GenerateToolbar>> = {},
): ReturnType<typeof render> {
  return render(
    <GenerateToolbar
      onReference={() => {}}
      onStyle={() => {}}
      onClearStyle={() => {}}
      {...overrides}
    />,
  );
}

describe('GenerateToolbar — Style + Reference are live; Mark / Focus are disabled placeholders', () => {
  it('renders all four tool buttons', () => {
    setup();
    expect(screen.getByTestId('generate-tool-style')).toBeInTheDocument();
    expect(screen.getByTestId('generate-tool-mark')).toBeInTheDocument();
    expect(screen.getByTestId('generate-tool-focus')).toBeInTheDocument();
    expect(screen.getByTestId('generate-tool-reference')).toBeInTheDocument();
  });

  it('disables Mark / Focus (unbuilt slices) and enables Style + Reference', () => {
    setup();
    expect(screen.getByTestId('generate-tool-style')).not.toBeDisabled();
    expect(screen.getByTestId('generate-tool-mark')).toBeDisabled();
    expect(screen.getByTestId('generate-tool-focus')).toBeDisabled();
    expect(screen.getByTestId('generate-tool-reference')).not.toBeDisabled();
  });

  it('fires onReference when Reference is clicked', () => {
    const onReference = vi.fn();
    setup({ onReference });
    fireEvent.click(screen.getByTestId('generate-tool-reference'));
    expect(onReference).toHaveBeenCalledTimes(1);
  });

  it('fires onStyle when Style is clicked (#1664)', () => {
    const onStyle = vi.fn();
    setup({ onStyle });
    fireEvent.click(screen.getByTestId('generate-tool-style'));
    expect(onStyle).toHaveBeenCalledTimes(1);
  });

  it('disables Reference when referenceDisabled is set (text-to-image, §2.5)', () => {
    setup({ referenceDisabled: true });
    expect(screen.getByTestId('generate-tool-reference')).toBeDisabled();
  });

  it('Style is gated on the MODEL capability, not the mode (#1664)', () => {
    // Reference is disabled in t2i, but style survives every mode — only a
    // model without style_images disables the Style pick.
    setup({ referenceDisabled: true, styleDisabled: true });
    expect(screen.getByTestId('generate-tool-reference')).toBeDisabled();
    expect(screen.getByTestId('generate-tool-style')).toBeDisabled();
  });

  // ── Style slot: picked thumbnail + ✕ badge (#1664, one style image max) ──
  it('shows the picked style thumbnail in the Style slot with a ✕ badge', () => {
    setup({ styleThumbnail: 'https://cdn/style.png' });
    const img = screen.getByTestId('generate-style-thumbnail') as HTMLImageElement;
    expect(img.src).toContain('style.png');
    expect(screen.getByTestId('generate-style-clear')).toBeInTheDocument();
  });

  it('the FILLED slot covers the button with the image at the SAME footprint (no layout shift)', () => {
    // User 2026-07-16: once picked, the whole button reads as the image — but
    // the original icon + label keep laying out INVISIBLY underneath so the
    // button footprint is identical in both states (no toolbar shift), and
    // the a11y name stays via aria-label.
    setup({ styleThumbnail: 'https://cdn/style.png' });
    const btn = screen.getByTestId('generate-tool-style');
    expect(btn).toHaveAttribute('aria-label');
    // The image is an absolute cover, not an inline child (inline would resize).
    const img = screen.getByTestId('generate-style-thumbnail');
    expect(img.className).toContain('absolute');
    expect(img.className).toContain('inset-0');
    // The footprint-preserving label is still in the layout, just invisible.
    const label = btn.querySelector('span');
    expect(label?.className).toContain('invisible');
  });

  it('renders no thumbnail and no ✕ while the slot is empty', () => {
    setup();
    expect(screen.queryByTestId('generate-style-thumbnail')).toBeNull();
    expect(screen.queryByTestId('generate-style-clear')).toBeNull();
  });

  it('✕ fires onClearStyle without firing onStyle (sibling, not nested)', () => {
    // The ✕ must be a SIBLING of the slot button — nesting a button inside a
    // button gets silently reparented by the browser (HTML validity trap).
    const onStyle = vi.fn();
    const onClearStyle = vi.fn();
    setup({ styleThumbnail: 'https://cdn/style.png', onStyle, onClearStyle });
    fireEvent.click(screen.getByTestId('generate-style-clear'));
    expect(onClearStyle).toHaveBeenCalledTimes(1);
    expect(onStyle).not.toHaveBeenCalled();
  });

  it('clicking a FILLED slot still fires onStyle (re-pick replaces the copy)', () => {
    const onStyle = vi.fn();
    setup({ styleThumbnail: 'https://cdn/style.png', onStyle });
    fireEvent.click(screen.getByTestId('generate-tool-style'));
    expect(onStyle).toHaveBeenCalledTimes(1);
  });

  it('the ✕ stays active even when style picking is model-disabled', () => {
    // A stale copy (picked under a style-capable model, then switched) must
    // always be removable.
    const onClearStyle = vi.fn();
    setup({
      styleThumbnail: 'https://cdn/style.png',
      styleDisabled: true,
      onClearStyle,
    });
    expect(screen.getByTestId('generate-tool-style')).toBeDisabled();
    fireEvent.click(screen.getByTestId('generate-style-clear'));
    expect(onClearStyle).toHaveBeenCalledTimes(1);
  });

  it('renders the active Style in the minimap white-fill style', () => {
    setup({ styleActive: true });
    const btn = screen.getByTestId('generate-tool-style');
    expect(btn.className).toContain('bg-foreground');
    expect(btn.className).toContain('text-background');
    expect(btn).toHaveAttribute('aria-pressed', 'true');
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
