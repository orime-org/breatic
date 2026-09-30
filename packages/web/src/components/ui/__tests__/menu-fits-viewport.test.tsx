// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * #2243 — a menu taller than the room on its side of the trigger stays within
 * that room and scrolls, so every row can still be reached. Radix measures the
 * room and hands it to the surface as a CSS variable.
 */

import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@web/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';

/**
 * Check that a row sits in a scroll viewport inside a surface capped at the room Radix measured.
 * @param row - A menu row.
 * @param variable - The CSS variable Radix sets on that surface.
 */
function expectCappedAndScrolling(row: HTMLElement, variable: string): void {
  const surface = row.closest('[role="menu"]');
  expect(surface?.className).toContain(`max-h-[var(${variable})]`);
  const viewport = row.closest('[data-radix-scroll-area-viewport]');
  expect(viewport).not.toBeNull();
  expect(surface?.contains(viewport ?? null)).toBe(true);
}

describe('a dropdown menu taller than the room it opens into', () => {
  it('caps the menu at that room and scrolls its rows', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Generate</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expectCappedAndScrolling(screen.getByText('Generate'), '--radix-dropdown-menu-content-available-height');
  });

  it('does the same for a submenu', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Nested</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expectCappedAndScrolling(screen.getByText('Nested'), '--radix-dropdown-menu-content-available-height');
  });
});

describe('a context menu taller than the room it opens into', () => {
  it('caps the menu and its submenu at that room and scrolls their rows', () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>area</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>Rename</ContextMenuItem>
          <ContextMenuSub open>
            <ContextMenuSubTrigger>More</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem>Nested</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        </ContextMenuContent>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText('area'));
    expectCappedAndScrolling(screen.getByText('Rename'), '--radix-context-menu-content-available-height');
    expectCappedAndScrolling(screen.getByText('Nested'), '--radix-context-menu-content-available-height');
  });
});
