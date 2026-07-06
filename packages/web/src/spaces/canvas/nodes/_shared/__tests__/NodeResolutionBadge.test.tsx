// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  NodeResolutionBadge,
  formatResolution,
} from '@web/spaces/canvas/nodes/_shared/NodeResolutionBadge';

describe('formatResolution', () => {
  it('joins width and height with the × multiplication sign (U+00D7)', () => {
    expect(formatResolution(1920, 1080)).toBe('1920×1080');
  });

  it('handles a square resolution', () => {
    expect(formatResolution(1080, 1080)).toBe('1080×1080');
  });
});

describe('NodeResolutionBadge', () => {
  it('renders the pixel resolution text', () => {
    render(<NodeResolutionBadge width={1920} height={1080} />);
    expect(screen.getByTestId('node-resolution-badge')).toHaveTextContent(
      '1920×1080',
    );
  });

  it('unselected: dims to the muted foreground (matching the node name)', () => {
    render(<NodeResolutionBadge width={1920} height={1080} />);
    const badge = screen.getByTestId('node-resolution-badge');
    expect(badge).toHaveClass('text-muted-foreground');
    expect(badge).toHaveClass('text-xs');
  });

  it('selected: deepens to the strong foreground (matching the node name)', () => {
    render(<NodeResolutionBadge width={1920} height={1080} selected />);
    expect(screen.getByTestId('node-resolution-badge')).toHaveClass(
      'text-foreground',
    );
  });
});
