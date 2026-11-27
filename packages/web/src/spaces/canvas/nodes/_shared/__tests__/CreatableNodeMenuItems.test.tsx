// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-Breatic-Source-Available-2.0

/**
 * The shared creatable-node rows (inner#2216 design 4.3): a type listed in
 * `disabledTypes` stays in the menu but greys out and cannot be picked, the
 * way `NodeContextMenu` draws a disabled row.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@web/components/ui/dropdown-menu';
import type { CreatableNodeType } from '@web/spaces/canvas/node-factory';
import { CreatableNodeMenuItems } from '@web/spaces/canvas/nodes/_shared/CreatableNodeMenuItems';

/**
 * Renders the rows inside an open menu.
 * @param disabledTypes - The types to grey out, or undefined for none.
 * @returns The pick callback.
 */
function setup(disabledTypes?: readonly CreatableNodeType[]): ReturnType<typeof vi.fn> {
  const onPick = vi.fn();
  render(
    <DropdownMenu open>
      <DropdownMenuTrigger asChild>
        <span />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <CreatableNodeMenuItems onPick={onPick} {...(disabledTypes ? { disabledTypes } : {})} />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  return onPick;
}

describe('CreatableNodeMenuItems — disabledTypes', () => {
  it('greys out a listed type as a disabled row with the not-allowed cursor', () => {
    setup(['image']);
    const row = screen.getByTestId('create-node-image');
    expect(row).toHaveAttribute('data-disabled');
    expect(row).toHaveAttribute('aria-disabled', 'true');
    expect(row.className).toContain('data-[disabled]:pointer-events-auto');
    expect(row.className).toContain('data-[disabled]:cursor-not-allowed');
  });

  it('keeps every unlisted type enabled', () => {
    setup(['image']);
    for (const type of ['text', 'audio', 'video']) {
      const row = screen.getByTestId(`create-node-${type}`);
      expect(row).not.toHaveAttribute('data-disabled');
      expect(row).not.toHaveAttribute('aria-disabled');
    }
  });

  it('does not pick a disabled type when it is clicked', () => {
    const onPick = setup(['image', 'audio']);
    fireEvent.click(screen.getByTestId('create-node-image'));
    fireEvent.click(screen.getByTestId('create-node-audio'));
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('create-node-text'));
    expect(onPick).toHaveBeenCalledWith('text');
  });

  // Guard: the connect-create menu and the node library pass no
  // disabledTypes, and their rows must stay exactly as they are.
  it('disables nothing without the prop', () => {
    const onPick = setup();
    expect(document.querySelectorAll('[data-disabled]')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('create-node-image'));
    expect(onPick).toHaveBeenCalledWith('image');
  });
});
