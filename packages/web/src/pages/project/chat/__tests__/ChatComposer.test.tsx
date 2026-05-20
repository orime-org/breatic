import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ChatComposer } from '@/pages/project/chat/ChatComposer';

function setup(props: Partial<Parameters<typeof ChatComposer>[0]> = {}) {
  const onChange = vi.fn();
  const onSubmit = vi.fn();
  const onAbort = vi.fn();
  render(
    <ChatComposer
      draft=''
      onChange={onChange}
      onSubmit={onSubmit}
      onAbort={onAbort}
      {...props}
    />,
  );
  return { onChange, onSubmit, onAbort };
}

describe('ChatComposer', () => {
  it('renders textarea + send button when not streaming', () => {
    setup();
    expect(screen.getByTestId('chat-composer-textarea')).toBeInTheDocument();
    expect(screen.getByTestId('chat-composer-send')).toBeInTheDocument();
  });

  it('renders the abort button while streaming', () => {
    setup({ streaming: true });
    expect(screen.getByTestId('chat-composer-abort')).toBeInTheDocument();
  });

  it('send is disabled while the draft is empty', () => {
    setup();
    expect(
      (screen.getByTestId('chat-composer-send') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('Enter without Shift submits', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup({ draft: 'hello' });
    const ta = screen.getByTestId('chat-composer-textarea');
    ta.focus();
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('Shift+Enter does NOT submit', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup({ draft: 'hello' });
    const ta = screen.getByTestId('chat-composer-textarea');
    ta.focus();
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('clicking abort fires onAbort while streaming', async () => {
    const user = userEvent.setup();
    const { onAbort } = setup({ streaming: true });
    await user.click(screen.getByTestId('chat-composer-abort'));
    expect(onAbort).toHaveBeenCalledTimes(1);
  });
});
