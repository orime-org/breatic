// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: LicenseRef-BSAL-1.0

import type * as React from 'react';

interface ChatNoticeProps {
  /** What to say, or nothing when there is nothing to say. */
  message: string | null;
}

/**
 * The one place the chat panel says something went wrong.
 *
 * It sits on the top edge of the composer, which is where the reader was
 * looking when they pressed send, and it belongs to this column rather than
 * to the whole window — the canvas on the right has its own concerns and a
 * message about a chat that could not be opened has nothing to do with them.
 * Every failure the panel can report comes through here: the send that never
 * left, the one the server refused, the turn it gave up on, the chat that
 * would not open. There is no second channel.
 *
 * Nothing here is a state the chat is in, so nothing here stays: each of
 * these is a thing that happened at a moment the reader was in, and the
 * panel stops saying it shortly after. A reader who was looking elsewhere is
 * not told when they come back — what they find is a conversation that
 * stopped moving, which is how a reader of a stream knows.
 *
 * Announced, because for a screen reader it is the only channel: a bubble
 * that never appears and a stop button that turns back into send are both
 * things you can only see.
 * @param root0 - The component props.
 * @param root0.message - What to say, or nothing.
 * @returns The notice, or nothing when there is nothing to say.
 */
export function ChatNotice({ message }: ChatNoticeProps): React.JSX.Element | null {
  if (message === null) return null;
  return (
    <div
      role='alert'
      data-testid='chat-notice'
      className='mx-2.5 mb-1.5 flex items-start gap-2 rounded-content-sm border border-status-error-border bg-status-error-bg px-2.5 py-2 text-xs leading-relaxed text-status-error-foreground duration-150 animate-in fade-in slide-in-from-bottom-1'
    >
      <span
        aria-hidden='true'
        className='mt-0.5 w-[3px] shrink-0 self-stretch rounded-full bg-status-error'
      />
      <span className='flex-1'>{message}</span>
    </div>
  );
}
