// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * What the composer takes up when there is nothing in it.
 *
 * It sits at the foot of the column and everything above it is the
 * conversation, so every row it keeps for itself is a row of the conversation
 * the reader does not get. Empty, it is one line of box and one row of
 * controls; the row that carries references appears when there are references
 * to carry.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { ChatComposer } from '@web/pages/project/chat/ChatComposer';

/** What the composer needs to render at all. */
const BASICS = {
  draft: '',
  onChange: (): void => undefined,
  onSubmit: (): void => undefined,
  onToggleSelectMode: (): void => undefined,
  onPickSkill: (): void => undefined,
  onRemoveChip: (): void => undefined,
};

afterEach(cleanup);

describe('the row that carries references', () => {
  it('is not there at all when there are none', () => {
    render(<ChatComposer {...BASICS} />);

    expect(screen.queryByTestId('chat-composer-chips')).not.toBeInTheDocument();
  });

  it('appears once a reference is picked up', () => {
    render(<ChatComposer {...BASICS} chips={[{ id: 'n1', label: 'A node' }]} />);

    expect(screen.getByTestId('chat-composer-chips')).toBeInTheDocument();
  });

  it('leaves the button that picks them up in the row below', () => {
    // The row above holds references, and holding a control in it is what
    // made it a row that could never go away.
    render(<ChatComposer {...BASICS} chips={[{ id: 'n1', label: 'A node' }]} />);

    const picker = screen.getByTestId('chat-composer-select-mode');
    const chips = screen.getByTestId('chat-composer-chips');
    expect(chips.contains(picker)).toBe(false);
  });

  it('keeps the picker reachable when there are no references yet', () => {
    render(<ChatComposer {...BASICS} />);

    expect(screen.getByTestId('chat-composer-select-mode')).toBeInTheDocument();
  });
});

describe('the box the reader types in', () => {
  it('starts one line tall', () => {
    render(<ChatComposer {...BASICS} />);

    const box = screen.getByTestId('chat-composer-textarea');
    expect(box).toHaveAttribute('rows', '1');
    expect(box.className).not.toMatch(/min-h-/);
  });

  it('grows with what is typed, and scrolls in the panel rather than in itself', () => {
    render(<ChatComposer {...BASICS} />);

    const box = screen.getByTestId('chat-composer-textarea');
    // The box takes the height of its content; the ceiling belongs to the
    // wrapper, whose scrollbar is the panel's own rather than the browser's.
    expect(box.className).toContain('overflow-hidden');
    // Radix marks its own viewport, which only exists inside a ScrollArea.
    expect(box.closest('[data-radix-scroll-area-viewport]')).not.toBeNull();
  });
});
