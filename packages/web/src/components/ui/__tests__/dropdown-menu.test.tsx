// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  DropdownMenuShortcut,
  DropdownMenuTrailing,
} from '@web/components/ui/dropdown-menu';

describe('the mark at the right end of a menu row', () => {
  it('pushes itself to the end and stays quiet', () => {
    render(<DropdownMenuTrailing>298,352.65</DropdownMenuTrailing>);
    const cls = screen.getByText('298,352.65').className;
    expect(cls).toContain('ml-auto');
    expect(cls).toContain('text-xs');
    expect(cls).toContain('text-muted-foreground');
  });

  it('lets a row ask for more without restating the rest', () => {
    render(<DropdownMenuTrailing className='font-medium'>Base</DropdownMenuTrailing>);
    const cls = screen.getByText('Base').className;
    expect(cls).toContain('font-medium');
    expect(cls).toContain('ml-auto');
  });

  it('spaces a shortcut out, and nothing else does', () => {
    // The wide tracking is the shortcut's alone: a balance or a tier set in it
    // would read as a key combination.
    render(
      <>
        <DropdownMenuShortcut>⌘C</DropdownMenuShortcut>
        <DropdownMenuTrailing>298,352.65</DropdownMenuTrailing>
      </>,
    );
    expect(screen.getByText('⌘C').className).toContain('tracking-widest');
    expect(screen.getByText('298,352.65').className).not.toContain('tracking-widest');
  });

  it('gives a shortcut everything the plain mark has', () => {
    // The shortcut is built from the plain mark, so the eleven context-menu
    // rows using it keep what they had when the two were separate spans.
    render(<DropdownMenuShortcut>⌘C</DropdownMenuShortcut>);
    const cls = screen.getByText('⌘C').className;
    for (const token of ['ml-auto', 'text-xs', 'text-muted-foreground']) {
      expect(cls).toContain(token);
    }
  });
});
