// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: Elastic-2.0

/**
 * The composer while a run answers (inner#1717): the user can go on writing
 * and send, so send and stop stand side by side; while a send waits for the
 * server the box is read-only and the attached items are held still; a stop
 * waits for the server with the stop button showing it.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';

import { ChatComposer } from '@web/pages/project/chat/ChatComposer';
import { renderWithTooltips as render } from '@web/test-utils/render-with-tooltips';
import type { TrayItem } from '@web/stores/chat-attachments';

/** One item attached and ready. */
const READY: TrayItem = {
  id: 'chip-1',
  name: 'notes.txt',
  type: 'text',
  status: 'ready',
  chip: { id: 'chip-1', type: 'text', name: 'notes.txt', data_snapshot: { text: 'n' } },
};

/**
 * Render the composer.
 * @param props - What differs from an idle box with a draft.
 * @returns The handlers.
 */
function setup(props: Partial<Parameters<typeof ChatComposer>[0]> = {}): { onSubmit: ReturnType<typeof vi.fn>; onAbort: ReturnType<typeof vi.fn> } {
  const onSubmit = vi.fn();
  const onAbort = vi.fn();
  render(
    <ChatComposer
      draft='make it blue'
      attachments={[READY]}
      onChange={vi.fn()}
      onSubmit={onSubmit}
      onAbort={onAbort}
      onAttachFiles={vi.fn()}
      onRemoveAttachment={vi.fn()}
      {...props}
    />,
  );
  return { onSubmit, onAbort };
}

/**
 * Point at a button long enough for its tooltip to open.
 * @param testId - The button's test id.
 * @returns The tooltip's words.
 */
function hoverText(testId: string): string {
  vi.useFakeTimers();
  fireEvent.pointerMove(screen.getByTestId(testId), { pointerType: 'mouse' });
  act(() => {
    vi.advanceTimersByTime(1_000);
  });
  const words = [...new Set(screen.getAllByRole('tooltip').map((el) => el.textContent ?? ''))].join(' ');
  vi.useRealTimers();
  return words;
}

describe('the composer while a run answers', () => {
  it('takes input and items, and offers send and stop side by side (WB-01)', () => {
    const { onSubmit } = setup({ turnPhase: 'running' });
    const box = screen.getByTestId('chat-composer-box');
    expect(box).toHaveAttribute('contenteditable', 'true');
    expect(screen.getByTestId('chat-composer-attach')).not.toBeDisabled();
    const send = screen.getByTestId('chat-composer-send');
    expect(send).not.toBeDisabled();
    expect(screen.getByTestId('chat-composer-abort')).toBeInTheDocument();
    fireEvent.click(send);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('tells a user pointing at send that the Agent reads what is sent at its next step', () => {
    setup({ turnPhase: 'running' });
    expect(hoverText('chat-composer-send')).toBe('Send · The Agent reads it at its next step');
  });

  it('names the stop button to a user pointing at it', () => {
    setup({ turnPhase: 'running' });
    expect(hoverText('chat-composer-abort')).toBe('Stop');
  });

  it('shows the same hover label as the waiting list above, with none drawn by the browser', () => {
    setup({ turnPhase: 'running' });
    expect(screen.getByTestId('chat-composer-send')).not.toHaveAttribute('title');
    expect(screen.getByTestId('chat-composer-abort')).not.toHaveAttribute('title');
  });

  it('shows the stop waiting on the server while it does', () => {
    setup({ turnPhase: 'running', stopping: true });
    expect(screen.getByTestId('chat-composer-abort')).toHaveAttribute('aria-busy', 'true');
  });
});

describe('the send button with no reply being written', () => {
  it('says only that it sends', () => {
    setup();
    expect(hoverText('chat-composer-send')).toBe('Send');
    expect(screen.getByTestId('chat-composer-send')).not.toHaveAttribute('title');
  });
});

describe('the composer while a send waits for the server', () => {
  it('is read-only, holds the items still, and shows the wait in the button slot (WB-02)', () => {
    setup({ turnPhase: 'sending' });
    expect(screen.getByTestId('chat-composer-box')).toHaveAttribute('aria-readonly', 'true');
    expect(screen.getByTestId('chat-composer-attach')).toBeDisabled();
    expect(screen.getByTestId('chat-composer-sending')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-composer-send')).toBeNull();
  });
});
