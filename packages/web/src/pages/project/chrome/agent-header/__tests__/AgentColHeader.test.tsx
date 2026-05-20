import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AgentColHeader } from '@/pages/project/chrome/agent-header/AgentColHeader';

function setup(overrides: Partial<Parameters<typeof AgentColHeader>[0]> = {}) {
  const onOpenHistory = vi.fn();
  const onNewConversation = vi.fn();
  render(
    <AgentColHeader
      conversationName='Onboarding'
      messageCount={3}
      onOpenHistory={onOpenHistory}
      onNewConversation={onNewConversation}
      {...overrides}
    />,
  );
  return { onOpenHistory, onNewConversation };
}

describe('AgentColHeader', () => {
  it('renders the agent column header landmark', () => {
    setup();
    expect(screen.getByTestId('agent-col-header')).toBeInTheDocument();
  });

  it('renders the conversation name', () => {
    setup({ conversationName: 'Bug triage' });
    expect(screen.getByText('Bug triage')).toBeInTheDocument();
  });

  it('renders the message-count chip', () => {
    setup({ messageCount: 12 });
    expect(screen.getByTestId('message-chip')).toHaveTextContent('12');
  });

  it('clicking history opens it', async () => {
    const user = userEvent.setup();
    const { onOpenHistory } = setup();
    await user.click(screen.getByLabelText('Open conversation history'));
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
  });

  it('clicking + new conversation invokes the handler', async () => {
    const user = userEvent.setup();
    const { onNewConversation } = setup();
    await user.click(screen.getByTestId('new-conversation'));
    expect(onNewConversation).toHaveBeenCalledTimes(1);
  });
});
