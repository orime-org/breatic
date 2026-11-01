// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { CanvasShortcutsDialog } from '@web/spaces/canvas/shortcuts/CanvasShortcutsDialog';
import { CANVAS_SHORTCUT_GROUPS } from '@web/spaces/canvas/shortcuts/canvas-shortcuts';

/**
 * Override `navigator.platform` so the mac and windows key labels can both be checked.
 * @param value - The platform string to report.
 */
function setPlatform(value: string): void {
  Object.defineProperty(window.navigator, 'platform', { value, configurable: true });
}

afterEach(() => setPlatform(''));

/**
 * Render the dialog open.
 * @param readOnly - Whether the reader is a read-only member.
 * @returns The render result.
 */
function renderOpen(readOnly = false): ReturnType<typeof render> {
  return render(
    <CanvasShortcutsDialog open onOpenChange={() => {}} readOnly={readOnly} />,
  );
}

describe('CanvasShortcutsDialog', () => {
  it('shows a titled dialog with every row for an editor', () => {
    renderOpen();
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    for (const row of CANVAS_SHORTCUT_GROUPS.flatMap((g) => g.rows)) {
      expect(within(dialog).getByTestId(`shortcut-row-${row.id}`)).toBeInTheDocument();
    }
  });

  it('shows a read-only member only the rows that work for them', () => {
    renderOpen(true);
    const ids = [...document.querySelectorAll('[data-testid^="shortcut-row-"]')].map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(ids).toEqual([
      'shortcut-row-marquee',
      'shortcut-row-toggleSelect',
      'shortcut-row-pan',
      'shortcut-row-zoom',
      'shortcut-row-closePanel',
    ]);
  });

  it('writes the keys with the macOS glyphs on a Mac', () => {
    setPlatform('MacIntel');
    renderOpen();
    expect(screen.getByTestId('shortcut-keys-undo')).toHaveTextContent('⌘Z');
    expect(screen.getByTestId('shortcut-keys-redo')).toHaveTextContent('⌘⇧Z / ⌘Y');
    expect(screen.getByTestId('shortcut-keys-delete')).toHaveTextContent('⌫');
    expect(screen.getByTestId('shortcut-keys-toggleSelect')).toHaveTextContent('⌘ Click');
  });

  it('writes the keys with Ctrl and Shift on Windows', () => {
    setPlatform('Win32');
    renderOpen();
    expect(screen.getByTestId('shortcut-keys-undo')).toHaveTextContent('Ctrl+Z');
    expect(screen.getByTestId('shortcut-keys-redo')).toHaveTextContent('Ctrl+Shift+Z / Ctrl+Y');
    expect(screen.getByTestId('shortcut-keys-delete')).toHaveTextContent('Del');
    expect(screen.getByTestId('shortcut-keys-toggleSelect')).toHaveTextContent('Ctrl+Click');
  });
});
