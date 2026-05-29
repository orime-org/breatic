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
});
