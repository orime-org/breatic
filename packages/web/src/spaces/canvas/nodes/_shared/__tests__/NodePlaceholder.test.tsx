// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { NodePlaceholder } from '@web/spaces/canvas/nodes/_shared/NodePlaceholder';

describe('NodePlaceholder', () => {
  it('text modality: two lines — "write" action + the shared right-click hint', () => {
    render(<NodePlaceholder modality='text' />);
    const ph = screen.getByTestId('node-placeholder');
    expect(ph).toHaveTextContent(/double-click to write/i);
    expect(ph).toHaveTextContent(/right-click to generate & more/i);
  });

  it('image modality: two lines — "upload" action + right-click hint, NOT "or generate"', () => {
    render(<NodePlaceholder modality='image' />);
    const ph = screen.getByTestId('node-placeholder');
    expect(ph).toHaveTextContent(/double-click to upload/i);
    expect(ph).toHaveTextContent(/right-click to generate & more/i);
    // The old copy conflated upload + generate on one line ("...or generate an
    // image"); the new model splits them — generate moved to the right-click menu.
    expect(ph.textContent).not.toMatch(/or generate/i);
  });

  it('renders custom hint when provided', () => {
    render(<NodePlaceholder modality='audio' hint='Recording…' />);
    expect(screen.getByText('Recording…')).toBeInTheDocument();
  });

  it('DOUBLE-click calls onActivate; a single click does NOT (single click selects the node)', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    render(<NodePlaceholder modality='video' onActivate={onActivate} />);
    const ph = screen.getByTestId('node-placeholder');
    await user.click(ph);
    expect(onActivate).not.toHaveBeenCalled();
    await user.dblClick(ph);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('exposes modality on data-attribute for e2e selectors', () => {
    render(<NodePlaceholder modality='audio' />);
    expect(
      screen.getByTestId('node-placeholder').getAttribute('data-modality'),
    ).toBe('audio');
  });

  // Empty state is the one node body that responds on hover, and it does so by
  // brightening its prompt text (muted → foreground), NOT by filling a bg —
  // the rest of the shell hovers its border only (9th-slice design system).
  it('hovers the TEXT color, not the background', () => {
    render(<NodePlaceholder modality='image' />);
    const btn = screen.getByTestId('node-placeholder');
    expect(btn.className).toContain('hover:text-foreground');
    expect(btn.className).not.toContain('hover:bg-');
  });
});
