// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { GenerateToolbar } from '@web/spaces/canvas/generate/GenerateToolbar';

describe('GenerateToolbar — Reference is live; Style / Mark / Focus are disabled placeholders (slice 1, 岔路二 B)', () => {
  it('renders all four tool buttons', () => {
    render(<GenerateToolbar onReference={() => {}} />);
    expect(screen.getByTestId('generate-tool-style')).toBeInTheDocument();
    expect(screen.getByTestId('generate-tool-mark')).toBeInTheDocument();
    expect(screen.getByTestId('generate-tool-focus')).toBeInTheDocument();
    expect(screen.getByTestId('generate-tool-reference')).toBeInTheDocument();
  });

  it('disables Style / Mark / Focus (unbuilt slices) and enables Reference', () => {
    render(<GenerateToolbar onReference={() => {}} />);
    expect(screen.getByTestId('generate-tool-style')).toBeDisabled();
    expect(screen.getByTestId('generate-tool-mark')).toBeDisabled();
    expect(screen.getByTestId('generate-tool-focus')).toBeDisabled();
    expect(screen.getByTestId('generate-tool-reference')).not.toBeDisabled();
  });

  it('fires onReference when Reference is clicked', () => {
    const onReference = vi.fn();
    render(<GenerateToolbar onReference={onReference} />);
    fireEvent.click(screen.getByTestId('generate-tool-reference'));
    expect(onReference).toHaveBeenCalledTimes(1);
  });

  it('disables Reference when referenceDisabled is set (text-to-image, §2.5)', () => {
    render(<GenerateToolbar onReference={() => {}} referenceDisabled />);
    expect(screen.getByTestId('generate-tool-reference')).toBeDisabled();
  });

  // I4 (batch-5, user 2026-07-12): the active Reference button used bg-accent,
  // which looked different from the minimap toggle (ViewportToolbar VtButton),
  // whose pressed state is the white-fill `bg-foreground text-background`. The
  // two toggles must read identically. Active must NOT keep the accent-hover
  // override either — a solid fill, like the minimap.
  it('renders the active Reference in the minimap white-fill style (not bg-accent)', () => {
    render(<GenerateToolbar onReference={() => {}} referenceActive />);
    const btn = screen.getByTestId('generate-tool-reference');
    expect(btn.className).toContain('bg-foreground');
    expect(btn.className).toContain('text-background');
    expect(btn.className).not.toContain('bg-accent');
    expect(btn).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders the inactive Reference without the fill', () => {
    render(<GenerateToolbar onReference={() => {}} />);
    const btn = screen.getByTestId('generate-tool-reference');
    expect(btn.className).not.toContain('bg-foreground');
    expect(btn).toHaveAttribute('aria-pressed', 'false');
  });
});
