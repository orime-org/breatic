// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The parts of the panel that are not a message.
 *
 * The skeleton, the list of past conversations, and what an empty
 * conversation says. Each is pinned by what the reader sees rather than by
 * the classes behind it, except where the class is the measurement: a
 * skeleton bar has no text to assert on, and how tall it is was settled
 * against the rest of the app.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { ChatEmpty } from '@web/pages/project/chat/ChatEmpty';
import { MessageList } from '@web/pages/project/chat/MessageList';

afterEach(cleanup);

describe('the skeleton shown while history loads', () => {
  it('draws bars a line of text tall', () => {
    // 16px, which is the height every other placeholder for a line of text in
    // the app uses. Measured rather than derived from the type: a bar stands
    // for a line, and a line of this text is taller than its glyphs.
    render(<MessageList messages={[]} skeleton />);

    const bars = document.querySelectorAll('[data-skeleton-bar]');
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) expect(bar.className).toContain('h-4');
  });
});

describe('an empty conversation', () => {
  it('sits in the middle of the column rather than at the top of it', () => {
    render(<ChatEmpty />);

    expect(screen.getByTestId('chat-empty').className).toMatch(/justify-center/);
  });

  it('offers its openers as one row of pills, without icons', () => {
    render(<ChatEmpty />);

    const first = screen.getByTestId('chat-empty-qa-find-reference');
    expect(first.className).toContain('rounded-full');
    expect(first.querySelector('svg')).toBeNull();
    // One row, wrapping when it has to, rather than one per line.
    expect(first.parentElement?.className).toMatch(/flex-wrap/);
  });
});
