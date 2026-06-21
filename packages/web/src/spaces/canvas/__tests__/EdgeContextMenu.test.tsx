// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { EdgeContextMenu } from '@web/spaces/canvas/EdgeContextMenu';

/**
 * Force the mac branch so the delete shortcut hint is deterministic (⌫).
 * @param value - The platform string to report.
 */
function setPlatform(value: string): void {
  Object.defineProperty(window.navigator, 'platform', {
    value,
    configurable: true,
  });
}

describe('EdgeContextMenu', () => {
  afterEach(() => setPlatform(''));

  it('open: shows a Delete item that fires onDelete', () => {
    const onDelete = vi.fn();
    render(
      <EdgeContextMenu
        open
        x={10}
        y={20}
        onOpenChange={() => {}}
        onDelete={onDelete}
      />,
    );
    const item = screen.getByTestId('edge-menu-delete');
    expect(item).toBeInTheDocument();
    fireEvent.click(item);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('shows the platform-aware delete shortcut hint', () => {
    setPlatform('MacIntel');
    render(
      <EdgeContextMenu
        open
        x={0}
        y={0}
        onOpenChange={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.getByTestId('edge-menu-delete').textContent).toContain('⌫');
  });

  it('closed: renders no menu item', () => {
    render(
      <EdgeContextMenu
        open={false}
        x={0}
        y={0}
        onOpenChange={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(screen.queryByTestId('edge-menu-delete')).toBeNull();
  });
});
