// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

/**
 * The foldable thinking block.
 *
 * Its body goes through the same renderer as the reply itself, so the model's
 * reasoning reads as prose rather than as the characters it typed. The fold
 * itself — what is in the DOM, what the toggle announces — does not change.
 *
 * The model does not produce reasoning today (`config/agent.yaml` carries
 * `thinking_enabled: false`), so the text here is constructed rather than
 * captured from a real turn.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ThinkingFold } from '@web/pages/project/chat/ThinkingFold';

/**
 * Renders the block and opens it.
 * @param thinking - The reasoning text to show.
 * @returns The body element, once expanded.
 */
async function expand(thinking: string): Promise<HTMLElement> {
  render(<ThinkingFold thinking={thinking} />);
  await userEvent.click(screen.getByTestId('thinking-fold-toggle'));
  return screen.getByTestId('thinking-fold-body');
}

describe('ThinkingFold — the fold itself (B2)', () => {
  it('keeps the body out of the DOM while collapsed', () => {
    render(<ThinkingFold thinking='weighing the two ratios' />);

    expect(screen.queryByTestId('thinking-fold-body')).toBeNull();
    expect(screen.getByTestId('thinking-fold-toggle')).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens on one click and says so', async () => {
    render(<ThinkingFold thinking='weighing the two ratios' />);
    const toggle = screen.getByTestId('thinking-fold-toggle');

    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('thinking-fold-body')).toBeInTheDocument();
  });

  it('holds the reasoning at 11px', async () => {
    const body = await expand('weighing the two ratios');

    // The sizes in `.chat-markdown` are all em, based on this element — so the
    // size belongs on the renderer's own container, not on a wrapper.
    expect(body.querySelector('[data-testid="markdown-body"]')).toHaveClass('text-2xs');
  });
});

describe('ThinkingFold — the body reads as prose (B1, B3)', () => {
  it('renders the reasoning through the reply renderer', async () => {
    const body = await expand('the **wider** ratio wins');

    const rendered = body.querySelector('[data-testid="markdown-body"]');
    expect(rendered, 'the thinking text goes through MarkdownMessage').not.toBeNull();
    expect(rendered?.querySelector('strong')?.textContent).toBe('wider');
  });

  it('keeps reasoning written line by line on separate lines', async () => {
    // Markdown folds a single newline into a space. The reasoning is written
    // one step per line, and running it together is not what reading it as
    // markdown was for.
    const body = await expand('step one\nstep two');

    expect(body).toHaveClass('whitespace-pre-line');
    expect(body.textContent).toContain('\n');
  });
});
