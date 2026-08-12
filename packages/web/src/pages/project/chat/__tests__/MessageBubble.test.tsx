// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BOSL-1.0

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { MessageBubble } from '@web/pages/project/chat/MessageBubble';
import type { ChatMessage } from '@web/pages/project/chat/types';
import { expectNoA11yViolations } from '@web/test-utils/a11y';

function setup(message: ChatMessage) {
  render(<MessageBubble message={message} />);
}

describe('MessageBubble', () => {
  it('renders user role bubbles right-aligned', () => {
    setup({ id: 'm1', role: 'user', content: 'hi' });
    const b = screen.getByTestId('message-bubble');
    expect(b.className).toContain('justify-end');
    expect(b.getAttribute('data-role')).toBe('user');
  });

  it('has no a11y violations', async () => {
    setup({ id: 'm1', role: 'user', content: 'hi' });
    await expectNoA11yViolations(document.body);
  });

  it('renders assistant role bubbles left-aligned', () => {
    setup({ id: 'm1', role: 'assistant', content: 'hello' });
    expect(screen.getByTestId('message-bubble').className).toContain(
      'justify-start',
    );
  });

  it('renders the bubble text content', () => {
    setup({ id: 'm1', role: 'assistant', content: 'visible body' });
    expect(screen.getByTestId('message-bubble-content')).toHaveTextContent(
      'visible body',
    );
  });

  it('shows the streaming caret when streaming=true', () => {
    setup({ id: 'm1', role: 'assistant', content: 'x', streaming: true });
    expect(screen.getByLabelText('streaming')).toBeInTheDocument();
  });

  it('renders ThinkingFold when thinking is present', () => {
    setup({
      id: 'm1',
      role: 'assistant',
      content: 'x',
      thinking: 'step 1',
    });
    expect(screen.getByTestId('thinking-fold')).toBeInTheDocument();
  });

  it('renders tool call cards', () => {
    setup({
      id: 'm1',
      role: 'assistant',
      content: 'x',
      toolCalls: [
        { id: 't1', name: 'web_search', args: {}, status: 'success' },
      ],
    });
    expect(screen.getByTestId('tool-call-card')).toBeInTheDocument();
  });

  it('says so when the turn was stopped before it finished', () => {
    // The backend goes to the trouble of storing this mark (batch 3, item 33)
    // so the reader can tell a cut-off answer from a complete one. Carrying it
    // to the component and not drawing it wastes the whole chain.
    render(
      <MessageBubble
        message={{ id: 'm1', role: 'assistant', content: 'half a sen', interrupted: true }}
      />,
    );

    expect(screen.getByTestId('message-bubble-interrupted')).toBeInTheDocument();
  });

  it('does not say that about a reply that finished', () => {
    render(<MessageBubble message={{ id: 'm2', role: 'assistant', content: 'all of it' }} />);

    expect(screen.queryByTestId('message-bubble-interrupted')).toBeNull();
  });

  it('shows the failure in the reader\'s own language, not the server\'s', () => {
    // Acceptance item 26. What the server sends on this path is a hardcoded
    // English sentence, so the panel says it itself.
    render(
      <MessageBubble message={{ id: 'm3', role: 'assistant', content: '', failed: true }} />,
    );

    // Found by its own handle rather than by role: the mark is stated, not
    // announced, for the reason the test below pins.
    const mark = screen.getByTestId('message-bubble-error');
    expect(mark.textContent).toBe('This reply could not be finished. Try sending it again.');
  });

  it('does not announce a failure that came back with the history', () => {
    // Failure is stored, so it comes back with every reload. An assertive
    // region on all of them would read out every past failure in the
    // conversation — one after another — the moment the panel opens. What
    // tells them apart is the mark below: this one is missing it, so this
    // failure is being read about, not being lived through.
    render(
      <MessageBubble
        message={{ id: 'm1', role: 'assistant', content: 'Half a sen', failed: true }}
      />,
    );
    expect(screen.getByTestId('message-bubble-error').getAttribute('role')).toBeNull();
  });

  it('announces a failure that just happened, while the reader is waiting', () => {
    // Acceptance item 26. Someone who sent a message and is waiting for the
    // answer has no other way to learn the turn is over: the reply simply
    // stops growing and the stop button turns back into send, both of which
    // are only visible. Using a screen reader, they wait for something that
    // is never coming.
    render(
      <MessageBubble
        message={{
          id: 'm1',
          role: 'assistant',
          content: 'Half a sen',
          failed: true,
          failedJustNow: true,
        }}
      />,
    );
    expect(screen.getByTestId('message-bubble-error').getAttribute('role')).toBe('alert');
  });
});
