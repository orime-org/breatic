// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The parts of the panel that are not a message.
 *
 * The skeleton, the list of past conversations, and what an empty
 * conversation says. Each is pinned by what the reader sees rather than by
 * the classes behind it, except where the class is the measurement: a
 * skeleton bar has no text to assert on, and how tall it is was settled
 * against the drawing.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ChatEmpty } from '@web/pages/project/chat/ChatEmpty';
import { MessageList } from '@web/pages/project/chat/MessageList';

afterEach(cleanup);

describe('the skeleton shown while history loads', () => {
  it('draws bars a line of text tall', () => {
    // 16px, settled against the drawing (#133) rather than derived from the
    // type: a bar stands for a line, and a line of this text is taller than
    // its glyphs. The app's other text placeholders are shorter than this.
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

describe('a code block in a reply', () => {
  it('offers to put its contents on the clipboard', async () => {
    const { MarkdownMessage } = await import('@web/pages/project/chat/MarkdownMessage');
    render(<MarkdownMessage content={'```ts\nconst a = 1;\n```'} />);

    expect(screen.getByTestId('code-copy')).toBeInTheDocument();
  });

  it('leaves inline code alone, which has nothing worth a button', async () => {
    const { MarkdownMessage } = await import('@web/pages/project/chat/MarkdownMessage');
    render(<MarkdownMessage content={'a `const` in a sentence'} />);

    expect(screen.queryByTestId('code-copy')).not.toBeInTheDocument();
  });

  it('answers a press the way every other copy in the panel does', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    const { MarkdownMessage } = await import('@web/pages/project/chat/MarkdownMessage');
    render(<MarkdownMessage content={'```ts\nconst a = 1;\n```'} />);

    expect(screen.queryByTestId('copy-answer')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('code-copy'));

    const answer = await screen.findByTestId('copy-answer');
    expect(answer).toBeInTheDocument();
    // Above the button, where the other two put theirs.
    expect(answer.className).toMatch(/\bbottom-full\b/);
    expect(answer.className).not.toMatch(/\btop-full\b/);
  });

  it('leaves the tooltip to the browser no longer', async () => {
    const { MarkdownMessage } = await import('@web/pages/project/chat/MarkdownMessage');
    render(<MarkdownMessage content={'```ts\nconst a = 1;\n```'} />);

    expect(screen.getByTestId('code-copy')).not.toHaveAttribute('title');
  });
});
