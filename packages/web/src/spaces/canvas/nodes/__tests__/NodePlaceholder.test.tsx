// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { NodePlaceholder } from '@web/spaces/canvas/nodes/_shared/NodePlaceholder';

describe('NodePlaceholder (empty-state hover)', () => {
  it('hovers the TEXT color, not the background — the prompt brightens', () => {
    render(<NodePlaceholder modality='image' />);
    const btn = screen.getByTestId('node-placeholder');
    // Empty state is the one node body that responds on hover, and it does so
    // by brightening its prompt text (muted → foreground), NOT by filling a bg.
    expect(btn.className).toContain('hover:text-foreground');
    expect(btn.className).not.toContain('hover:bg-');
  });
});
